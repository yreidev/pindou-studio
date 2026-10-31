package app

import (
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/yreidev/pindou-studio/pindou-backend/internal/storage/queries"
)

// 电脑网页后台的扫码登录。
//
// 网页向后端要一个挑战，再拿 pollToken 换一张小程序码（webLoginCode）：员工用微信扫一扫直接打开小程序的
// 批准页，看清是哪台设备后批准；网页拿着只有自己知道的 pollToken 轮询，批准后领到一张网页会话。
// 小程序码生成不了时（没配微信、微信出错），网页退回把 qrText 画成普通二维码，员工在小程序里用「扫码」扫。
// 挑战只活几分钟，存在 web_logins 表里（只存 pollToken 的哈希）：轮询可能落到任何一个副本上。
//
// ★ 网页会话与小程序会话分开（Client=web）、有效期更短，员工能在小程序里一键注销自己所有的网页会话。
// ★ 不恢复密码登录：网页登录的唯一凭据是一位已登录员工的当面批准。
const (
	webLoginTTL          = 3 * time.Minute
	webSessionTTL        = 12 * time.Hour
	maxPendingWebLogins  = 200
	webLoginQRPrefix     = "pindou-web-login:"
	webLoginUserAgentMax = 200
)

const (
	webLoginPending  = "pending"
	webLoginApproved = "approved"
	webLoginRejected = "rejected"
	webLoginUsed     = "used"
	webLoginExpired  = "expired" // 只是读的时候按时间算出来的展示状态，不存
)

type webLoginChallenge struct {
	ID         string
	PollHash   string
	Status     string
	CreatedAt  time.Time
	ExpiresAt  time.Time
	UserAgent  string
	IP         string
	ApprovedBy string
}

func (c *webLoginChallenge) state(now time.Time) string {
	if c.Status == webLoginPending && !now.Before(c.ExpiresAt) {
		return webLoginExpired
	}
	return c.Status
}

var errChallengeClosed = errors.New("这次扫码登录已失效，请在电脑上刷新二维码")

func (s *Server) createWebLogin(w http.ResponseWriter, r *http.Request) {
	q := s.tx(r)
	userAgent := r.UserAgent()
	for utf8.RuneCountInString(userAgent) > webLoginUserAgentMax {
		userAgent = string([]rune(userAgent)[:webLoginUserAgentMax])
	}
	now := q.now()
	// 过期一小时以上的挑战没有任何用处了，顺手清掉，表不会一直长。
	q.fail(q.dbWrite().PurgeWebLogins(q.ctx, now.Add(-time.Hour)))
	if pending := must(q.db().CountWebLogins(q.ctx, queries.CountWebLoginsParams{Status: webLoginPending, ExpiresAt: now})); pending >= maxPendingWebLogins {
		s.writeError(w, r, 503, "too_many_challenges", errors.New("扫码登录请求太多，请稍后再试"))
		return
	}
	pollToken := token()
	challenge := &webLoginChallenge{ID: id(), PollHash: identityKey(pollToken), Status: webLoginPending, CreatedAt: now, ExpiresAt: now.Add(webLoginTTL), UserAgent: userAgent, IP: clientKey(r)}
	q.fail(q.dbWrite().InsertWebLogin(q.ctx, queries.InsertWebLoginParams{ID: challenge.ID, PollHash: challenge.PollHash, Status: challenge.Status,
		CreatedAt: challenge.CreatedAt, ExpiresAt: challenge.ExpiresAt, UserAgent: challenge.UserAgent, Ip: challenge.IP}))
	writeJSON(w, 201, map[string]any{"id": challenge.ID, "pollToken": pollToken, "qrText": webLoginQRPrefix + challenge.ID, "expiresAt": challenge.ExpiresAt})
}

// webLogin 按编号读一个挑战，没有返回 nil。
func (q *txn) webLogin(challengeID string) *webLoginChallenge {
	if !validID(challengeID) {
		return nil
	}
	r, err := q.db().WebLogin(q.ctx, challengeID)
	if isNoRows(err) {
		return nil
	}
	q.fail(err)
	c := &webLoginChallenge{ID: r.ID, PollHash: r.PollHash, Status: r.Status, CreatedAt: r.CreatedAt, ExpiresAt: r.ExpiresAt, UserAgent: r.UserAgent, IP: r.Ip}
	if r.ApprovedBy != nil {
		c.ApprovedBy = *r.ApprovedBy
	}
	return c
}

// setWebLoginStatus 改挑战的状态；from 不对（被别的请求抢先改了）返回 false。
func (q *txn) setWebLoginStatus(c *webLoginChallenge, from, to, approvedBy string) bool {
	var by *string
	if approvedBy != "" {
		by = &approvedBy
	}
	if must(q.db().SetWebLoginStatus(q.ctx, queries.SetWebLoginStatusParams{ID: c.ID, FromStatus: from, ToStatus: to, ApprovedBy: by})) != 1 {
		return false
	}
	c.Status = to
	if approvedBy != "" {
		c.ApprovedBy = approvedBy
	}
	return true
}

func webLoginView(c *webLoginChallenge, now time.Time) map[string]any {
	return map[string]any{"id": c.ID, "status": c.state(now), "createdAt": c.CreatedAt, "expiresAt": c.ExpiresAt, "userAgent": c.UserAgent, "ip": c.IP}
}

// viewWebLogin 给扫了码的员工看：是哪台设备、什么时候发起的，确认是自己的电脑再批准。
func (s *Server) viewWebLogin(w http.ResponseWriter, r *http.Request) {
	challengeID := r.PathValue("id")
	u, err := s.userFor(r)
	if err != nil {
		s.writeError(w, r, 401, "unauthorized", err)
		return
	}
	if !hasRole(u, Clerk, Manager, Owner) {
		s.writeError(w, r, 403, "forbidden", errForbidden)
		return
	}
	q := s.tx(r)
	c := q.webLogin(challengeID)
	if c == nil {
		s.writeError(w, r, 404, "not_found", errNotFound)
		return
	}
	writeJSON(w, 200, webLoginView(c, q.now()))
}

// decideWebLogin 在请求事务里改挑战状态、记审计，要么一起提交，要么一起回滚。
func (s *Server) decideWebLogin(w http.ResponseWriter, r *http.Request) {
	challengeID := r.PathValue("id")
	u, err := s.userFor(r)
	if err != nil {
		s.writeError(w, r, 401, "unauthorized", err)
		return
	}
	if !hasRole(u, Clerk, Manager, Owner) {
		s.writeError(w, r, 403, "forbidden", errForbidden)
		return
	}
	q := s.tx(r)
	// 只认小程序会话批准：否则一张网页令牌就能自己发起、自己批准、换一张新令牌，12 小时上限形同虚设
	if q.currentSession(r).Client == clientWeb {
		s.writeError(w, r, 403, "forbidden", errors.New("请用小程序扫码批准登录"))
		return
	}
	var in struct {
		Approve *bool `json:"approve"`
	}
	if err := decode(r, &in); err != nil || in.Approve == nil {
		s.writeError(w, r, 400, "invalid_request", errors.New("approve is required"))
		return
	}
	c := q.webLogin(challengeID)
	if c == nil {
		s.writeError(w, r, 404, "not_found", errNotFound)
		return
	}
	if c.state(q.now()) != webLoginPending {
		s.writeError(w, r, 409, "challenge_not_pending", errChallengeClosed)
		return
	}
	action, status, by := "web_login.rejected", webLoginRejected, ""
	if *in.Approve {
		action, status, by = "web_login.approved", webLoginApproved, u.ID
	}
	if !q.setWebLoginStatus(c, webLoginPending, status, by) {
		s.writeError(w, r, 409, "challenge_not_pending", errChallengeClosed)
		return
	}
	q.audit(u.ID, action, c.ID, c.UserAgent, requestID(r))
	writeJSON(w, 200, map[string]any{"id": c.ID, "status": c.Status})
}

// webLoginCode 给发起登录的网页一张小程序码：微信扫一扫直接打开小程序的批准页，scene 是去掉连字符的挑战编号
// （正好 32 位，是微信的上限）。只认 pollToken（放在请求体里，不进网址日志），挑战不存在和令牌不对一样回 404。
// 先调微信、不占数据库事务（见 routes.go）；按来源限流（rateLimited），每次都会调一次微信。
func (s *Server) webLoginCode(w http.ResponseWriter, r *http.Request) {
	challengeID := r.PathValue("id")
	var in struct {
		PollToken string `json:"pollToken"`
	}
	if err := decode(r, &in); err != nil || in.PollToken == "" {
		s.writeError(w, r, 400, "invalid_request", errors.New("pollToken is required"))
		return
	}
	var c *webLoginChallenge
	var now time.Time
	var env string
	if err := s.read(r.Context(), func(q *txn) { c, now, env = q.webLogin(challengeID), q.now(), q.codeSettings().Env }); err != nil {
		s.writeError(w, r, 503, "persistence_failed", errors.New("数据暂时读不出来，请重试"))
		return
	}
	if c == nil || subtle.ConstantTimeCompare([]byte(c.PollHash), []byte(identityKey(in.PollToken))) != 1 {
		s.writeError(w, r, 404, "not_found", errNotFound)
		return
	}
	if c.state(now) != webLoginPending {
		s.writeError(w, r, 410, "challenge_closed", errChallengeClosed)
		return
	}
	if s.wechat == nil {
		s.writeError(w, r, 503, "wechat_unavailable", errors.New("尚未配置微信小程序码服务"))
		return
	}
	code, err := s.wechat.WebLoginCode(r.Context(), strings.ReplaceAll(c.ID, "-", ""), env)
	if err != nil {
		s.writeError(w, r, 503, "wechat_unavailable", err)
		return
	}
	writeJSON(w, 200, map[string]string{"imageDataUrl": "data:" + http.DetectContentType(code) + ";base64," + base64.StdEncoding.EncodeToString(code)})
}

// claimWebSession 是网页的轮询：批准了就领一张网页会话。占住挑战和发会话在同一个事务里，
// 并发的两次轮询只有一次能领到。
func (s *Server) claimWebSession(w http.ResponseWriter, r *http.Request) {
	challengeID := r.PathValue("id")
	var in struct {
		PollToken string `json:"pollToken"`
	}
	if err := decode(r, &in); err != nil || in.PollToken == "" {
		s.writeError(w, r, 400, "invalid_request", errors.New("pollToken is required"))
		return
	}
	q := s.tx(r)
	now := q.now()
	c := q.webLogin(challengeID)
	// 挑战不存在和 pollToken 不对一样回 404：不让人用猜的方式确认某个挑战是否存在。
	if c == nil || subtle.ConstantTimeCompare([]byte(c.PollHash), []byte(identityKey(in.PollToken))) != 1 {
		s.writeError(w, r, 404, "not_found", errNotFound)
		return
	}
	switch c.state(now) {
	case webLoginPending:
		writeJSON(w, 202, map[string]any{"status": webLoginPending, "expiresAt": c.ExpiresAt})
		return
	case webLoginApproved:
	default:
		s.writeError(w, r, 410, "challenge_closed", errChallengeClosed)
		return
	}
	user := q.user(c.ApprovedBy)
	if user == nil || !q.setWebLoginStatus(c, webLoginApproved, webLoginUsed, "") {
		s.writeError(w, r, 410, "challenge_closed", errChallengeClosed)
		return
	}
	// 网页会话按批准人的真实任命算角色，不带小程序里选的体验身份
	sess := authSession{UserID: c.ApprovedBy, ExpiresAt: now.Add(webSessionTTL), Client: clientWeb}
	accessToken := token()
	q.putAuthSession(identityKey(accessToken), sess)
	writeJSON(w, 201, map[string]any{"accessToken": accessToken, "expiresAt": sess.ExpiresAt, "user": s.sessionUser(user, sess)})
}

// revokeCurrentSession 退出当前登录：作废这次请求所用的令牌。
func (s *Server) revokeCurrentSession(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.signedIn(w, r); !ok {
		return
	}
	s.tx(r).deleteAuthSession(identityKey(bearerCredential(r)))
	w.WriteHeader(http.StatusNoContent)
}

// revokeWebSessions 注销自己所有的网页登录。
func (s *Server) revokeWebSessions(w http.ResponseWriter, r *http.Request) {
	u, ok := s.signedIn(w, r)
	if !ok {
		return
	}
	q := s.tx(r)
	revoked := q.deleteWebSessions(u.ID)
	if revoked > 0 {
		q.audit(u.ID, "web_sessions.revoked", u.ID, "", requestID(r))
	}
	writeJSON(w, 200, map[string]any{"revoked": revoked})
}

// bearerCredential 取请求里的令牌：Authorization: Bearer；浏览器的 WebSocket 设不了这个头，
// 事件流额外接受子协议 Sec-WebSocket-Protocol: pindou.v1, bearer.<令牌>。
// ★ 不接受网址参数：网址会进代理的访问日志，令牌不能出现在日志里。
func bearerCredential(r *http.Request) string {
	if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
		return strings.TrimSpace(strings.TrimPrefix(h, "Bearer "))
	}
	if r.URL.Path != "/api/v2/event-streams" {
		return ""
	}
	protocols := webSocketProtocols(r)
	if !protocols[webSocketProtocol] {
		return ""
	}
	for protocol := range protocols {
		if strings.HasPrefix(protocol, "bearer.") {
			return strings.TrimPrefix(protocol, "bearer.")
		}
	}
	return ""
}

const webSocketProtocol = "pindou.v1"

func webSocketProtocols(r *http.Request) map[string]bool {
	out := map[string]bool{}
	for _, header := range r.Header.Values("Sec-WebSocket-Protocol") {
		for _, protocol := range strings.Split(header, ",") {
			if protocol = strings.TrimSpace(protocol); protocol != "" {
				out[protocol] = true
			}
		}
	}
	return out
}
