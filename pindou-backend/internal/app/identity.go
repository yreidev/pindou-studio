package app

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"unicode/utf8"

	identityapp "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/identity/application"
)

// BootstrapOwner 把这个已注册账号任命为老板（还没有任何任命时），记审计。测试夹具也用它。
func (s *Server) BootstrapOwner(userID string) error {
	return s.writeTx(context.Background(), func(q *txn) error {
		return bootstrapOwner(q, userID)
	})
}

func bootstrapOwner(q *txn, userID string) error {
	u := q.user(userID)
	if u == nil {
		return errNotFound
	}
	if len(q.rolesOf(userID)) > 0 {
		return nil
	}
	a := &roleAssignment{ID: id(), UserID: userID, Role: Owner, AssignedAt: q.now()}
	q.addRole(a)
	u.Roles = []Role{Owner}
	q.audit("system", "role.bootstrap-owner", userID, "", id())
	return nil
}

// BootstrapFirstOwner 是新环境受控初始化首位老板（启动时的 PINDOU_BOOTSTRAP_OWNER_ID）：只在还没有任何老板时，
// 把这个已注册账号任命为老板、记审计并落库，返回 true；已有老板时什么都不做，返回 false。之后的任命都在后台办理。
// 开发者体验身份不能高于真实任命，所以不能再靠「切到老板身份给自己任命」来初始化。
func (s *Server) BootstrapFirstOwner(ctx context.Context, userID string) (bool, error) {
	applied := false
	err := s.writeTx(ctx, func(q *txn) error {
		applied = false
		for _, a := range q.activeRoles() {
			if a.Role == Owner && q.user(a.UserID) != nil {
				return nil
			}
		}
		if err := bootstrapOwner(q, userID); err != nil {
			return err
		}
		if !hasRole(q.user(userID), Owner) {
			return errors.New("PINDOU_BOOTSTRAP_OWNER_ID 的账号已有其他员工任命，请在后台调整")
		}
		applied = true
		return nil
	})
	return applied && err == nil, err
}

func id() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%s-%s-%s-%s-%s", hex.EncodeToString(b[:4]), hex.EncodeToString(b[4:6]), hex.EncodeToString(b[6:8]), hex.EncodeToString(b[8:10]), hex.EncodeToString(b[10:]))
}

func token() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

func identityKey(code string) string {
	sum := sha256.Sum256([]byte(code))
	return hex.EncodeToString(sum[:])
}

func maskPhone(p string) string {
	if len(p) <= 4 {
		return strings.Repeat("*", len(p))
	}
	if len(p) < 7 {
		return p[:1] + strings.Repeat("*", len(p)-3) + p[len(p)-2:]
	}
	return p[:3] + strings.Repeat("*", len(p)-7) + p[len(p)-4:]
}

func cloneUser(u *User) User {
	v := *u
	v.DeveloperMode = ""
	v.MemberOpening = nil
	v.Roles = append([]Role(nil), u.Roles...)
	if v.Roles == nil {
		v.Roles = []Role{}
	}
	v.PhoneMasked = maskPhone(u.Phone)
	return v
}

func hasRole(u *User, roles ...Role) bool {
	for _, a := range u.Roles {
		for _, b := range roles {
			if a == b {
				return true
			}
		}
	}
	return false
}

func canManage(u *User, target Role) bool {
	if hasRole(u, Owner) {
		return true
	}
	return hasRole(u, Manager) && target != Owner
}

type registrationInput struct {
	WechatLoginCode        string `json:"wechatLoginCode"`
	Nickname               string `json:"nickname"`
	AvatarDataURL          string `json:"avatarDataUrl"`
	PhoneCode              string `json:"phoneCode"`
	Phone                  string `json:"phone"`
	PrivacyContractVersion string `json:"privacyContractVersion"`
}

func (s *Server) createUser(w http.ResponseWriter, r *http.Request) {
	var in registrationInput
	if err := decode(r, &in); err != nil {
		s.writeError(w, r, 400, "invalid_request", err)
		return
	}
	if !validRegistration(in) {
		s.writeError(w, r, 400, "invalid_request", errors.New("wechatLoginCode, nickname, privacyContractVersion and exactly one phone source are required"))
		return
	}
	avatar, err := identityapp.NormalizeAvatar(in.AvatarDataURL)
	if err != nil {
		s.writeError(w, r, 400, "invalid_avatar", err)
		return
	}
	wechatID, phone := in.WechatLoginCode, in.Phone
	if s.wechat != nil {
		var err error
		wechatID, err = s.wechat.ExchangeLogin(r.Context(), in.WechatLoginCode)
		if err != nil {
			s.writeError(w, r, 502, "wechat_unavailable", errors.New("微信登录失败，请重试"))
			return
		}
		if in.PhoneCode != "" {
			phone, err = s.wechat.ExchangePhone(r.Context(), in.PhoneCode)
			if err != nil {
				s.writeError(w, r, 502, "wechat_unavailable", errors.New("微信手机号获取失败，请重新授权"))
				return
			}
		}
	}
	key := identityKey(wechatID)
	s.serveTx(w, r, true, "accounts", func(w http.ResponseWriter, r *http.Request) {
		q := s.tx(r)
		if q.userByWechat(key) != nil {
			s.writeError(w, r, 409, "already_registered", errors.New("该微信已注册，请直接登录"))
			return
		}
		if normalized, ok := identityapp.NormalizePhone(phone); ok {
			if must(q.db().PhoneNeedsClaim(q.ctx, normalized)) {
				s.writeError(w, r, 409, "claim_required", errors.New("这个手机号已有会员账户，请找店员要临时密码，点下面的「去认领会员」认领"))
				return
			}
		}
		now := q.now()
		u := &User{ID: id(), Nickname: in.Nickname, AvatarDataURL: avatar, Phone: phone, PhoneVerificationStatus: "unverified", PrivacyContractVersion: in.PrivacyContractVersion, PrivacyAcceptedAt: now, CreatedAt: now}
		if in.PhoneCode != "" {
			u.PhoneVerificationStatus = "verified"
		}
		q.addUser(u)
		q.addWechatIdentity(key, u.ID)
		accessToken := token()
		sess := authSession{UserID: u.ID, ExpiresAt: now.Add(sessionTTL)}
		q.putAuthSession(identityKey(accessToken), sess)
		writeJSON(w, 201, map[string]any{"accessToken": accessToken, "expiresAt": sess.ExpiresAt, "user": s.sessionUser(u, sess)})
	})
}

func validRegistration(in registrationInput) bool {
	return in.WechatLoginCode != "" && utf8.RuneCountInString(in.WechatLoginCode) <= 2048 && utf8.RuneCountInString(in.Nickname) >= 1 && utf8.RuneCountInString(in.Nickname) <= 50 && utf8.RuneCountInString(in.PrivacyContractVersion) >= 1 && utf8.RuneCountInString(in.PrivacyContractVersion) <= 100 && ((in.PhoneCode != "" && utf8.RuneCountInString(in.PhoneCode) <= 2048 && in.Phone == "") || (in.Phone != "" && utf8.RuneCountInString(in.Phone) <= 30 && in.PhoneCode == ""))
}

func (s *Server) createAuth(w http.ResponseWriter, r *http.Request) {
	var in struct {
		WechatLoginCode string `json:"wechatLoginCode"`
	}
	if err := decode(r, &in); err != nil {
		s.writeError(w, r, 400, "invalid_request", err)
		return
	}
	if in.WechatLoginCode == "" || utf8.RuneCountInString(in.WechatLoginCode) > 2048 {
		s.writeError(w, r, 400, "invalid_request", errors.New("wechatLoginCode is required"))
		return
	}
	wechatID := in.WechatLoginCode
	if s.wechat != nil {
		var err error
		wechatID, err = s.wechat.ExchangeLogin(r.Context(), in.WechatLoginCode)
		if err != nil {
			s.writeError(w, r, 502, "wechat_unavailable", errors.New("微信登录失败，请重试"))
			return
		}
	}
	// 会话和别的写入一样在事务里落库，写库失败就不发令牌。登录只发凭证、不改业务数据，不推送。
	s.serveTx(w, r, true, "", func(w http.ResponseWriter, r *http.Request) {
		q := s.tx(r)
		u := q.userByWechat(identityKey(wechatID))
		if u == nil {
			s.writeError(w, r, 404, "not_registered", errors.New("该微信尚未注册"))
			return
		}
		// 过期的会话再也用不上，登录时顺手清掉，表不会一直长。
		q.purgeExpiredSessions()
		accessToken := token()
		sess := authSession{UserID: u.ID, ExpiresAt: q.now().Add(sessionTTL)}
		q.putAuthSession(identityKey(accessToken), sess)
		writeJSON(w, 201, map[string]any{"accessToken": accessToken, "expiresAt": sess.ExpiresAt, "user": s.sessionUser(u, sess)})
	})
}

// listAccounts 是员工看的账户列表。
func (s *Server) listAccounts(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.staffMember(w, r); !ok {
		return
	}
	query := r.URL.Query()
	page, size, err := pageParams(query)
	if err != nil {
		s.writeError(w, r, 400, "invalid_request", err)
		return
	}
	if size == 0 {
		size = defaultPageSize
	}
	q := s.tx(r)
	accounts, total := q.accountsPage(query.Get("q"), newestAccountsFirst, page, size)
	setPageHeaders(w, page, size, total)
	out := make([]User, 0, len(accounts))
	for _, x := range accounts {
		value := cloneUser(&x)
		value.AvatarDataURL = ""
		out = append(out, value)
	}
	writeJSON(w, 200, out)
}

// accountTarget 认出登录者和网址里的目标账户：没登录回 401，编号不对或账户不存在回 404。
// 改资料要先调微信（见 routes.go），不在请求事务里，另开只读事务查目标账户。
func (s *Server) accountTarget(w http.ResponseWriter, r *http.Request) (u, target *User, ok bool) {
	u, ok = s.signedIn(w, r)
	if !ok {
		return nil, nil, false
	}
	uid := r.PathValue("id")
	if !validID(uid) {
		s.writeError(w, r, 404, "not_found", errNotFound)
		return nil, nil, false
	}
	if q := txnOf(r); q != nil {
		target = q.user(uid)
	} else if err := s.read(r.Context(), func(q *txn) { target = q.user(uid) }); err != nil {
		s.writeError(w, r, 503, "persistence_failed", errors.New("数据暂时读不出来，请重试"))
		return nil, nil, false
	}
	if target == nil {
		s.writeError(w, r, 404, "not_found", errNotFound)
		return nil, nil, false
	}
	return u, target, true
}

// accountOrders 是一位顾客的订单：本人或员工能看。
func (s *Server) accountOrders(w http.ResponseWriter, r *http.Request) {
	u, _, ok := s.accountTarget(w, r)
	if !ok {
		return
	}
	uid := r.PathValue("id")
	if uid != u.ID && !hasRole(u, Clerk, Manager, Owner) {
		s.writeError(w, r, 403, "forbidden", errForbidden)
		return
	}
	q := s.tx(r)
	orders := q.ordersOf(uid)
	view := s.orderViews(q, orders...)
	out := make([]orderResponse, 0, len(orders))
	for _, o := range orders {
		out = append(out, view(*o))
	}
	writeJSON(w, 200, out)
}

// getAccount 是一个账户的资料：本人看自己（带体验身份），员工看别人。
func (s *Server) getAccount(w http.ResponseWriter, r *http.Request) {
	u, target, ok := s.accountTarget(w, r)
	if !ok {
		return
	}
	uid := r.PathValue("id")
	if uid != u.ID && !hasRole(u, Clerk, Manager, Owner) {
		s.writeError(w, r, 403, "forbidden", errForbidden)
		return
	}
	if uid == u.ID {
		writeJSON(w, 200, u)
	} else {
		writeJSON(w, 200, cloneUser(target))
	}
}

// updateAccount 改资料：本人改自己的，店长、老板代改别人的（店长不能改老板的）。
func (s *Server) updateAccount(w http.ResponseWriter, r *http.Request) {
	u, target, ok := s.accountTarget(w, r)
	if !ok {
		return
	}
	uid := r.PathValue("id")
	if uid != u.ID && !hasRole(u, Manager, Owner) {
		s.writeError(w, r, 403, "forbidden", errForbidden)
		return
	}
	// 店长不能管理老板：也不能代改老板的昵称、手机号
	if uid != u.ID && hasRole(target, Owner) && !hasRole(u, Owner) {
		s.writeError(w, r, 403, "forbidden", errors.New("店长不能修改老板的资料"))
		return
	}
	var in struct {
		Nickname      string  `json:"nickname"`
		AvatarDataURL *string `json:"avatarDataUrl"`
		Phone         string  `json:"phone"`
		PhoneCode     string  `json:"phoneCode"`
	}
	if err := decode(r, &in); err != nil {
		s.writeError(w, r, 400, "invalid_request", err)
		return
	}
	if (in.Nickname != "" && (utf8.RuneCountInString(in.Nickname) > 50)) || utf8.RuneCountInString(in.Phone) > 30 || utf8.RuneCountInString(in.PhoneCode) > 2048 {
		s.writeError(w, r, 400, "invalid_request", errors.New("填写内容过长，请精简后重试"))
		return
	}
	// 手动填号与微信授权二选一，和注册一样（validRegistration）。两个都给就说不清该信哪个。
	if in.Phone != "" && in.PhoneCode != "" {
		s.writeError(w, r, 400, "invalid_request", errors.New("手机号与微信授权只能二选一"))
		return
	}
	// 改别人的资料（店长/老板代改）不能走微信授权：那张 code 是本人微信给的，
	// 拿它换出来的号会被写到别人账上。
	if in.PhoneCode != "" && uid != u.ID {
		s.writeError(w, r, 403, "forbidden", errForbidden)
		return
	}
	// 换号在开事务之前做（见 routes.go）：这是一次外部网络请求，不能占着事务等它。
	// s.wechat 为 nil（本地/测试）时跳过换取，这一点与注册（createUser）保持一致 ——
	// 两处若走不同规则，本地能改的线上改不了，或者反过来。
	phone, verified := in.Phone, false
	if in.PhoneCode != "" {
		verified = true
		if s.wechat != nil {
			var err error
			phone, err = s.wechat.ExchangePhone(r.Context(), in.PhoneCode)
			if err != nil {
				s.writeError(w, r, 502, "wechat_unavailable", errors.New("微信手机号获取失败，请重新授权"))
				return
			}
		}
	}
	var avatar string
	if in.AvatarDataURL != nil {
		if uid != u.ID {
			s.writeError(w, r, 403, "forbidden", errForbidden)
			return
		}
		var err error
		avatar, err = identityapp.NormalizeAvatar(*in.AvatarDataURL)
		if err != nil {
			s.writeError(w, r, 400, "invalid_avatar", err)
			return
		}
	}
	s.serveTx(w, r, true, "accounts", func(w http.ResponseWriter, r *http.Request) {
		// 换号期间不在事务里，操作者的权限和目标账户都可能变了，开事务后重新核对。
		q := s.tx(r)
		u, err := s.userFor(r)
		if err != nil {
			s.writeError(w, r, 401, "unauthorized", err)
			return
		}
		if uid != u.ID && !hasRole(u, Manager, Owner) {
			s.writeError(w, r, 403, "forbidden", errForbidden)
			return
		}
		target := q.user(uid)
		if target == nil {
			s.writeError(w, r, 404, "not_found", errNotFound)
			return
		}
		if uid != u.ID && hasRole(target, Owner) && !hasRole(u, Owner) {
			s.writeError(w, r, 403, "forbidden", errors.New("店长不能修改老板的资料"))
			return
		}
		if in.Nickname != "" {
			target.Nickname = in.Nickname
		}
		if in.AvatarDataURL != nil {
			target.AvatarDataURL = avatar
		}
		if phone != "" {
			// 有认领密码的账户：认领用的号随资料一起换，换之前核对格式与没被别人用过
			normalized, ok := s.syncLoginPhone(w, r, q, uid, phone)
			if !ok {
				return
			}
			target.Phone = normalized
		}
		if verified {
			// 微信换出来的号是微信核过的
			target.PhoneVerificationStatus = "verified"
		} else if phone != "" {
			// 手动填的号没人核过
			target.PhoneVerificationStatus = "unverified"
		}
		v := cloneUser(target)
		if uid == u.ID {
			v.Roles, v.DeveloperMode = u.Roles, u.DeveloperMode
		}
		writeJSON(w, 200, v)
	})
}

// listRoleAssignments 是现在有效的员工任命（带被任命人的称呼），店长、老板能看。
func (s *Server) listRoleAssignments(w http.ResponseWriter, r *http.Request) {
	u, ok := s.signedIn(w, r)
	if !ok {
		return
	}
	q := s.tx(r)
	if !hasRole(u, Manager, Owner) {
		s.writeError(w, r, 403, "forbidden", errForbidden)
		return
	}
	roles := q.activeRoles()
	ids := make([]string, 0, len(roles))
	for _, a := range roles {
		ids = append(ids, a.UserID)
	}
	labels := q.accountLabels(ids)
	out := make([]map[string]any, 0, len(roles))
	for _, a := range roles {
		out = append(out, map[string]any{"id": a.ID, "accountId": a.UserID, "account": labelOf(labels, a.UserID), "role": a.Role, "assignedAt": a.AssignedAt})
	}
	writeJSON(w, 200, out)
}

// assignRole 任命员工：替换此人原有的任命。店长不能任命或替换老板，不能替换最后一位老板。
func (s *Server) assignRole(w http.ResponseWriter, r *http.Request) {
	u, ok := s.signedIn(w, r)
	if !ok {
		return
	}
	q := s.tx(r)
	var in struct {
		UserID string `json:"accountId"`
		Role   Role   `json:"role"`
	}
	if e := decode(r, &in); e != nil {
		s.writeError(w, r, 400, "invalid_request", e)
		return
	}
	if in.Role != Clerk && in.Role != Manager && in.Role != Owner {
		s.writeError(w, r, 400, "invalid_role", errors.New("角色无效"))
		return
	}
	if !canManage(u, in.Role) {
		s.writeError(w, r, 403, "forbidden", errForbidden)
		return
	}
	target := q.user(in.UserID)
	if target == nil {
		s.writeError(w, r, 404, "not_found", errNotFound)
		return
	}
	for _, a := range q.rolesOf(in.UserID) {
		if !canManage(u, a.Role) {
			s.writeError(w, r, 403, "forbidden", errForbidden)
			return
		}
		if a.Role == Owner && in.Role != Owner && countOwners(q) <= 1 {
			s.writeError(w, r, 409, "last_owner", errors.New("不能替换最后一位老板"))
			return
		}
		q.revokeRole(a)
	}
	a := &roleAssignment{ID: id(), UserID: in.UserID, Role: in.Role, AssignedAt: q.now()}
	q.addRole(a)
	target.Roles = []Role{in.Role}
	q.audit(u.ID, "role.assigned", in.UserID, "", requestID(r))
	writeJSON(w, 201, map[string]any{"id": a.ID, "accountId": a.UserID, "role": a.Role, "assignedAt": a.AssignedAt})
}

// revokeRoleAssignment 撤销任命。店长不能撤销老板，不能撤销最后一位老板。
func (s *Server) revokeRoleAssignment(w http.ResponseWriter, r *http.Request) {
	u, ok := s.signedIn(w, r)
	if !ok {
		return
	}
	q := s.tx(r)
	if !hasRole(u, Manager, Owner) {
		s.writeError(w, r, 403, "forbidden", errForbidden)
		return
	}
	a := q.role(r.PathValue("id"))
	if a == nil {
		s.writeError(w, r, 404, "not_found", errNotFound)
		return
	}
	if !canManage(u, a.Role) {
		s.writeError(w, r, 403, "forbidden", errForbidden)
		return
	}
	if a.Role == Owner && countOwners(q) <= 1 {
		s.writeError(w, r, 409, "last_owner", errors.New("不能撤销最后一位老板"))
		return
	}
	q.revokeRole(a)
	if x := q.user(a.UserID); x != nil {
		x.Roles = nil
	}
	q.audit(u.ID, "role.revoked", a.UserID, "", requestID(r))
	w.WriteHeader(204)
}

// countOwners 是现在有效的老板任命数。
func countOwners(q *txn) int {
	n := 0
	for _, a := range q.activeRoles() {
		if a.Role == Owner {
			n++
		}
	}
	return n
}
