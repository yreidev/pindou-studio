package app

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"sort"
	"strings"
	"time"

	member "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/membership/application"
	ordersapp "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/orders/application"
	ordersdomain "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/orders/domain"
	reserve "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/reservations/domain"
	"github.com/yreidev/pindou-studio/pindou-backend/internal/storetime"
)

// loyaltyInput 是会员动作的请求。omitzero 只影响编码：测试用它发请求时和客户端一样不带没填的字段
// （契约里 accountId 这类字段要么不给、要么是合法的值，空串不合契约；解码时不给与零值一样）。
type loyaltyInput struct {
	Action           string           `json:"action"`
	AccountID        string           `json:"accountId,omitzero"`
	TargetID         string           `json:"targetId,omitzero"`
	ExpectedVersion  string           `json:"expectedVersion,omitzero"`
	QuoteVersion     string           `json:"quoteVersion,omitzero"`
	Rule             member.Rule      `json:"rule,omitzero"`
	Birthday         string           `json:"birthday,omitzero"`
	Reason           string           `json:"reason,omitzero"`
	Method           string           `json:"method,omitzero"`
	Points           int64            `json:"points,omitzero"`
	PrincipalCents   int64            `json:"principalCents,omitzero"`
	GiftCents        int64            `json:"giftCents,omitzero"`
	UseBalance       bool             `json:"useBalance,omitzero"`
	TableID          string           `json:"serviceTableId,omitzero"`
	SeatNumber       int              `json:"seatNumber,omitzero"`
	ReturnedProducts map[string]int64 `json:"returnedProducts,omitzero"`
	// AmountCents 是会员退款（refund、refund_quote）这次退的金额，不带为剩余全部（整单退款）；带了就得是正数，
	// 所以用指针分开「没带」和「带了 0」。omitzero：不带时幂等指纹与加这个字段之前一样，升级前发出的整单退款
	// 重试不会变成 idempotency_conflict。
	AmountCents *int64 `json:"amountCents,omitzero"`
	// CashReceivedCents 只用于 checkout：线下补付走现金时员工可选填的实收现金（整数分），后端据此记找零。
	// 指针分得清没填和填了 0；不带时请求的编码与加字段之前一样，幂等指纹不变。
	CashReceivedCents *int64 `json:"cashReceivedCents,omitzero"`
	// OfflineCents 只用于 checkout：这次随会员结账收多少线下补付（0 到报价的 offlineCents），余下的分笔收（多人合付）。
	// 不带就是报价的线下补付全部、一次收齐，和以前一样；指针分得清没带和 0。不带时请求的编码不变，幂等指纹不变。
	OfflineCents *int64 `json:"offlineCents,omitzero"`
	// BalanceCents 只用于 quote、checkout：这次最多用多少储值（本金 + 赠送，整数分），会员只用储值付自己那份时填；
	// 不带照旧能用多少用多少。要和 useBalance 一起带。指针分得清没带和 0；不带时编码不变，幂等指纹不变。
	BalanceCents *int64 `json:"balanceCents,omitzero"`
	// Coupon 是团购记录，只用于 request（顾客扫码入座时填，选填）和 confirm（员工确认时改：不带是保留申请里的，
	// 带了平台和券码都空的是清掉）。不带时编码不变，幂等指纹不变。
	Coupon      *reserve.Coupon          `json:"coupon,omitzero"`
	ServiceDate *string                  `json:"serviceDate,omitzero"`
	Consumption *loyaltyConsumptionInput `json:"consumption,omitzero"`
	BoardUses   *int64                   `json:"boardUses,omitzero"`
}

// loyaltyPublic 是已发布的会员规则，不用登录。
func (s *Server) loyaltyPublic(w http.ResponseWriter, r *http.Request) {
	q := s.tx(r)
	writeJSON(w, 200, map[string]any{"rules": offeredRules(q, q.membership().Rules())})
}

// loyaltyMe 是登录者自己的会员资产。
func (s *Server) loyaltyMe(w http.ResponseWriter, r *http.Request) {
	u, ok := s.signedIn(w, r)
	if !ok {
		return
	}
	q := s.tx(r)
	writeJSON(w, 200, s.memberView(q, u.ID))
}

// loyaltyMembers 是会员列表的一页：按昵称拼音排，可按昵称、打码手机号、编号开头或完整手机号找。余额只算这一页的。
func (s *Server) loyaltyMembers(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.staffMember(w, r); !ok {
		return
	}
	q := s.tx(r)
	query := r.URL.Query()
	page, size, err := pageParams(query)
	if err != nil {
		s.writeError(w, r, 400, "invalid_request", err)
		return
	}
	if size == 0 {
		size = defaultPageSize
	}
	accounts, total := q.accountsPage(query.Get("q"), accountsByNickname, page, size)
	setPageHeaders(w, page, size, total)
	ids := make([]string, 0, len(accounts))
	for _, a := range accounts {
		ids = append(ids, a.ID)
	}
	balances := q.balancesOf(ids, q.now())
	unclaimed := q.unclaimedMembers(ids)
	out := make([]map[string]any, 0, len(accounts))
	for _, a := range accounts {
		balance, ok := balances[a.ID]
		if !ok {
			balance = member.EmptyBalance()
		}
		out = append(out, loyaltyMemberSummary(&a, balance, unclaimed[a.ID]))
	}
	writeJSON(w, 200, out)
}

// loyaltySettings 是规则设置页：草稿、生效规则、发布记录（带发布人的称呼）和设置版本。
func (s *Server) loyaltySettings(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.staffMember(w, r); !ok {
		return
	}
	q := s.tx(r)
	m := q.membership()
	writeJSON(w, 200, map[string]any{"drafts": m.Drafts, "rules": m.Rules(), "publications": s.publicationViews(q), "version": s.settingsVersion(q)})
}

// loyaltyShift 是员工这一班要看的入座申请（带顾客称呼）与桌位占用。
func (s *Server) loyaltyShift(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.staffMember(w, r); !ok {
		return
	}
	q := s.tx(r)
	writeJSON(w, 200, map[string]any{"admissions": s.admissionViews(q, ""), "tables": s.loyaltyTables(q)})
}

// loyaltyAccount 是员工看的一位顾客的会员资产（?accountId=）。
func (s *Server) loyaltyAccount(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.staffMember(w, r); !ok {
		return
	}
	q := s.tx(r)
	target := r.URL.Query().Get("accountId")
	if q.user(target) == nil {
		s.writeError(w, r, 404, "not_found", errNotFound)
		return
	}
	writeJSON(w, 200, s.memberView(q, target))
}

// loyaltyTableList 是桌位占用（登录后都能看）。
func (s *Server) loyaltyTableList(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.signedIn(w, r); !ok {
		return
	}
	q := s.tx(r)
	writeJSON(w, 200, s.loyaltyTables(q))
}

// loyaltyActionTx 按动作挑事务：报价、计算示例只算不写，走只读事务、不推送（见 readOnlyLoyaltyAction）；
// 其余动作可写，提交后推送 loyalty。
func (s *Server) loyaltyActionTx(w http.ResponseWriter, r *http.Request) {
	if readOnlyLoyaltyAction(r) {
		s.serveTx(w, r, false, "", s.postLoyaltyAction)
		return
	}
	s.serveTx(w, r, true, "loyalty", s.postLoyaltyAction)
}

// postLoyaltyAction 执行一个会员动作，权限按动作核对。
func (s *Server) postLoyaltyAction(w http.ResponseWriter, r *http.Request) {
	u, ok := s.signedIn(w, r)
	if !ok {
		return
	}
	staff := hasRole(u, Clerk, Manager, Owner)
	q := s.tx(r)
	var in loyaltyInput
	if err := decode(r, &in); err != nil {
		s.writeError(w, r, 400, "invalid_request", err)
		return
	}
	if idemKey(r) == "" {
		s.writeError(w, r, 400, "idempotency_required", errors.New("缺少幂等键"))
		return
	}
	// Authorization is checked before idempotent replay.
	allowed := staff
	switch in.Action {
	case "birthday", "claim", "request", "cancel_request":
		allowed = true
	case "save_rule", "preview_rule":
		allowed = hasRole(u, Manager, Owner)
	// adjust（手动加减储值和积分）不在下面：所有员工都能办（2026-10-10 业主定：结账先不用，储值、积分由员工手动加减），写原因、记审计
	case "publish", "disable", "recharge_refund":
		allowed = hasRole(u, Owner)
	case "refund", "refund_quote", "consume_reverse":
		allowed = hasRole(u, Manager, Owner)
	}
	if !allowed {
		s.writeError(w, r, 403, "forbidden", errForbidden)
		return
	}
	if in.ServiceDate != nil && (in.Action == "consume" || in.Action == "recharge") {
		if _, err := loyaltyServiceDate(*in.ServiceDate, u, q.now()); errors.Is(err, errForbidden) {
			s.writeError(w, r, 403, "forbidden", errors.New("超过 7 天的补录只有店长、老板能登记"))
			return
		}
	}
	key := "loyalty:" + u.ID + ":" + in.Action + ":" + idemKey(r)
	fingerprint := member.Version(in)
	// 报价、计算示例只算不写（走只读路径，见 readOnlyLoyaltyAction）：不存幂等记录，重放也无害
	readOnly := readOnlyLoyaltyActions[in.Action]
	if prev := q.idemGet(key); prev != nil && !readOnly {
		if prev.Fingerprint != fingerprint {
			s.writeError(w, r, 409, "idempotency_conflict", errors.New("相同幂等键的内容已改变"))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(prev.Status)
		_, _ = w.Write(prev.Body)
		return
	}
	out, err := s.loyaltyAction(q, u, in, requestID(r))
	if err != nil {
		// 无权和不存在不是业务冲突：以前一律 409 loyalty_conflict，页面照原文显示出英文的
		// "forbidden"、"not_found"。
		var refusal loyaltyRefusal
		switch {
		case errors.Is(err, errForbidden):
			s.writeError(w, r, 403, "forbidden", errors.New("当前账号无权执行此操作"))
		case errors.Is(err, errNotFound):
			s.writeError(w, r, 404, "not_found", errors.New("要操作的记录不存在，请刷新后重试"))
		case errors.Is(err, ordersapp.ErrVersionConflict):
			s.writeError(w, r, 409, "order_version_conflict", err)
		case errors.As(err, new(invalidInput)):
			s.writeError(w, r, 400, "invalid_request", err)
		case errors.As(err, &refusal):
			s.writeError(w, r, refusal.status, refusal.code, err)
		default:
			s.writeError(w, r, 409, "loyalty_conflict", err)
		}
		return
	}
	if readOnly {
		writeJSON(w, 200, out)
		return
	}
	if in.Action != "consume" && in.Action != "consume_reverse" {
		q.audit(u.ID, "loyalty."+in.Action, loyaltyAuditObject(u, in, out), in.Reason, requestID(r))
	}
	b, _ := json.Marshal(out)
	q.rememberIdem(key, idemResponse{Fingerprint: fingerprint, Status: 200, ContentType: "application/json", Body: b})
	writeJSON(w, 200, out)
}

// loyaltyAuditObject 是这次动作作用的对象：员工替顾客操作记顾客；申请记申请本身；
// 针对规则、计时或订单的记那条记录；顾客自己的其余动作记本人。
// 以前一律记操作者，老板在审计里看不出一笔充值或调整落在了谁的账上。
//
// 员工确认、拒绝入座和计时操作记那次申请、那段计时的顾客，按记录认定，不看请求里的 accountId：
// 小程序「会员与计时」页曾把「会员」标签选中的人合进所有动作，审计就记到了不相干的人名下。
func loyaltyAuditObject(u *User, in loyaltyInput, out any) string {
	switch in.Action {
	case "confirm", "reject":
		if a, ok := out.(member.Admission); ok && validID(a.AccountID) {
			return a.AccountID
		}
		return in.TargetID
	case "pause", "resume", "stop", "renew", "move", "end":
		if view, ok := out.(map[string]any); ok {
			if x, ok := view["session"].(*TableSession); ok && validID(x.UserID) {
				return x.UserID
			}
		}
		return in.TargetID
	}
	if validID(in.AccountID) {
		return in.AccountID
	}
	if a, ok := out.(member.Admission); ok && validID(a.ID) {
		return a.ID
	}
	if validID(in.TargetID) {
		return in.TargetID
	}
	if rule, ok := out.(member.Rule); ok && validID(rule.ID) {
		return rule.ID
	}
	return u.ID
}

// tableCode 生成桌码。请求微信时不占数据库事务（见 routes.go），只在读桌位时开一个只读事务。
func (s *Server) tableCode(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.staffMember(w, r); !ok {
		return
	}
	tableID, env := "", ""
	if err := s.read(r.Context(), func(q *txn) {
		if t := q.table(r.URL.Query().Get("tableId")); t != nil && t.Enabled {
			tableID = t.ID
		}
		env = q.codeSettings().Env
	}); err != nil {
		s.writeError(w, r, 503, "persistence_failed", errors.New("数据暂时读不出来，请重试"))
		return
	}
	if tableID == "" {
		s.writeError(w, r, 404, "not_found", errNotFound)
		return
	}
	if s.wechat == nil {
		s.writeError(w, r, 503, "wechat_unavailable", errors.New("尚未配置微信小程序码服务"))
		return
	}
	code, err := s.wechat.TableCode(r.Context(), strings.ReplaceAll(tableID, "-", ""), env)
	if err != nil {
		s.writeError(w, r, 503, "wechat_unavailable", err)
		return
	}
	writeJSON(w, 200, map[string]string{"imageDataUrl": "data:" + http.DetectContentType(code) + ";base64," + base64.StdEncoding.EncodeToString(code)})
}

func (s *Server) memberView(q *txn, user string) map[string]any {
	m := q.memberAccount(user)
	return map[string]any{"balance": m.Balance(user, q.now()), "profile": m.Profiles[user], "entries": m.History(user), "rules": offeredRules(q, m.Rules()), "admissions": s.admissionViews(q, user), "version": s.accountVersion(q, user)}
}

// accountVersion 是一位顾客据以确认的会员状态：已发布规则，加上他自己的资产流水、
// 生日资料和入座申请。充值、兑换、领取、申请、调整只比对这一份。
//
// ★ 以前比对的是整个会员状态：任何一位顾客提交申请或领取福利，都会让正在给另一位
//
//	顾客充值的店员收到「规则或资产已变化」，高峰期互相踩。
func (s *Server) accountVersion(q *txn, user string) string {
	m := q.memberAccount(user)
	admissions := map[string]member.Admission{}
	for key, a := range m.Admissions {
		if a.AccountID == user {
			admissions[key] = a
		}
	}
	return member.Version(struct {
		Rules      []member.Rule
		Entries    []member.Entry
		Profile    member.Profile
		Admissions map[string]member.Admission
	}{m.Rules(), m.History(user), m.Profiles[user], admissions})
}

// settingsVersion 是规则草稿与发布记录的版本；保存、发布、停用规则只比对它，
// 不因顾客的资产变动而冲突。
func (s *Server) settingsVersion(q *txn) string {
	m := q.membership()
	return member.Version(struct {
		Drafts       map[string]member.Rule
		Publications map[string]member.Publication
	}{m.Drafts, m.Publications})
}

// invalidInput 标出请求本身就不合法的错误（与数据此刻的状态无关，刷新重读也没用）：回 400 invalid_request。
// 其余会员动作的错误多半是数据变了（规则停用、余额不够、会话已不在暂停），回 409 让人刷新后重新确认。
type invalidInput struct{ error }

func (e invalidInput) Unwrap() error { return e.error }

// loyaltyRefusal 是会员动作里说得清原因的拒绝，带自己的状态码和错误码（登记在 docs/api.yaml 的 /loyalty/actions），
// 说明是给员工看的中文原话。没有专门错误码的冲突仍回 409 loyalty_conflict。
type loyaltyRefusal struct {
	status int
	code   string
	error
}

func (e loyaltyRefusal) Unwrap() error { return e.error }

// 生日礼物核销被拒的几种原因。以前除「礼物已核销」外都回笼统的「请检查规则、金额、积分及有效期设置」，
// 过期的礼物（页面不按日期预先拦，过没过期以后端为准）再点核销，员工看不出是过期了。
var (
	errGiftNotFound = loyaltyRefusal{404, "not_found", errors.New("这位顾客名下没有这份生日礼物，请刷新后重新选择")}
	errNotAGift     = invalidInput{errors.New("这条记录不是生日礼物，不用核销")}
	errGiftDone     = loyaltyRefusal{409, "birthday_gift_fulfilled", errors.New("这份生日礼物已经核销过了，不能重复核销")}
	errGiftExpired  = loyaltyRefusal{409, "birthday_gift_expired", errors.New("这份生日礼物已过期，不能再核销")}
)

// fulfillableGift 是这位顾客名下现在能核销的那份生日礼物；不能核销时说清原因：不在这位顾客名下（含别人领的）、
// 不是生日礼物（积分、折扣类生日福利领取即生效，没有核销）、已经核销过、过了有效期（领取后 validDays 天）。
// 已核销的先报已核销，不管过没过期。领取后规则停用不影响核销：礼物领取时已归顾客，有效期内照样交付。
func fulfillableGift(m *member.State, id, account string, now time.Time) (member.Entry, error) {
	original, ok := m.Entries[id]
	if !ok || original.AccountID != account {
		return member.Entry{}, errGiftNotFound
	}
	if original.Kind != "birthday" || original.Rule == nil || original.Rule.Scope != "gift" {
		return member.Entry{}, errNotAGift
	}
	for _, e := range m.Entries {
		if e.Kind == "fulfill_gift" && e.SourceID == original.ID {
			return member.Entry{}, errGiftDone
		}
	}
	if !now.Before(original.CreatedAt.AddDate(0, 0, original.Rule.ValidDays)) {
		return member.Entry{}, errGiftExpired
	}
	return original, nil
}

// publicationView 是发布记录加上发布人的称呼（查不到时为 null）。
type publicationView struct {
	member.Publication
	Actor *accountLabel `json:"actor"`
}

func (s *Server) publicationViews(q *txn) []publicationView {
	history := s.publicationHistory(q)
	ids := make([]string, 0, len(history))
	for _, p := range history {
		ids = append(ids, p.ActorID)
	}
	labels := q.accountLabels(ids)
	out := make([]publicationView, 0, len(history))
	for _, p := range history {
		out = append(out, publicationView{p, labelOf(labels, p.ActorID)})
	}
	return out
}

// publicationHistory 是规则的发布与停用记录，新的在前：何时、谁、当时的规则内容、填写的影响说明。
// 记录只追加不改写；网页后台的「发布历史」据此列出，不另建表。
func (s *Server) publicationHistory(q *txn) []member.Publication {
	m := q.membership()
	out := make([]member.Publication, 0, len(m.Publications))
	for _, p := range m.Publications {
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].CreatedAt.Equal(out[j].CreatedAt) {
			return out[i].CreatedAt.After(out[j].CreatedAt)
		}
		return out[i].ID > out[j].ID
	})
	return out
}
func (s *Server) loyaltyTables(q *txn) []map[string]any {
	out := []map[string]any{}
	live := map[string][]*TableSession{}
	for _, x := range q.liveSessions() {
		live[x.TableID] = append(live[x.TableID], x)
	}
	areas := map[string]*FloorArea{}
	for _, a := range q.allAreas() {
		areas[a.ID] = a
	}
	for _, t := range q.allTables() {
		if !t.Enabled {
			continue
		}
		occupied := []int{}
		for _, x := range live[t.ID] {
			// 不分座的整桌会话，和论桌卖的整桌单位，都要把整张桌标成已占，
			// 否则员工端显示「已占 1/2 座」，店员会以为还能再安排一个人进来。
			if x.SeatNumber == 0 || t.WholeTable {
				for n := 1; n <= t.SeatCount; n++ {
					occupied = append(occupied, n)
				}
			} else {
				occupied = append(occupied, x.SeatNumber)
			}
		}
		areaName := ""
		if area := areas[t.AreaID]; area != nil {
			areaName = area.Name
		}
		out = append(out, map[string]any{"id": t.ID, "code": t.Code, "zone": zoneKeyOf(t.Code), "number": t.Number, "seatCount": t.SeatCount, "wholeTable": t.WholeTable, "occupiedSeats": occupied, "floorAreaId": t.AreaID, "floorAreaName": areaName})
	}
	// 桌号只在区域内唯一，单按 number 排序时同号桌之间没有确定次序：tables 是 map，
	// 迭代顺序随机，sort.Slice 又不稳定，于是同一份数据每次请求的排列都可能不同。
	// 按区域名加桌号排，顺序才是确定的。
	sort.Slice(out, func(i, j int) bool {
		if a, b := out[i]["floorAreaName"].(string), out[j]["floorAreaName"].(string); a != b {
			return a < b
		}
		if a, b := out[i]["floorAreaId"].(string), out[j]["floorAreaId"].(string); a != b {
			return a < b
		}
		return out[i]["number"].(int) < out[j]["number"].(int)
	})
	return out
}
func liveSession(x *TableSession) bool {
	return x.Status == "active" || x.Status == "paused" || x.Status == "companion"
}

// unitSeats 返回「占掉这个座就等于占掉的那些座号」。
//
// ★ 整桌单位（Table.WholeTable）上任何一个座被占，整张桌就不能再卖给别人 ——
//
//	顾客在平面图上点的是一张桌，不是一把椅子。非整桌的桌位照旧按座号各算各的。
func unitSeats(t *Table, seat int) []int {
	if t == nil || !t.WholeTable {
		return []int{seat}
	}
	out := make([]int, 0, t.SeatCount)
	for n := 1; n <= t.SeatCount; n++ {
		out = append(out, n)
	}
	return out
}

func (s *Server) seatAvailable(q *txn, table string, seat int, except string) bool {
	t := q.table(table)
	if t == nil || !t.Enabled || seat < 1 || seat > t.SeatCount {
		return false
	}
	for _, x := range q.liveSessionsOnTable(table) {
		// SeatNumber == 0 是不分座的整桌会话；t.WholeTable 则是这张桌本来就论桌卖。
		if x.ID != except && (x.SeatNumber == 0 || x.SeatNumber == seat || t.WholeTable) {
			return false
		}
	}
	return true
}

// admissionViews 是入座申请的展示视图。user 为空是员工总览：只给当班要处理的——待确认的、计时还在进行的、
// 今天申请或今天结束的；更早的历史不再每次下发（员工端每 5 秒、每条事件都会重读，全部历史会越积越大）。
// 顾客读自己的（user 非空）仍是全部。
func (s *Server) admissionViews(q *txn, user string) []map[string]any {
	out := []map[string]any{}
	now := q.now()
	var admissions []member.Admission
	if user != "" {
		for _, a := range q.memberAccount(user).Admissions {
			if a.AccountID == user {
				admissions = append(admissions, a)
			}
		}
	} else {
		admissions = q.shiftAdmissions(now)
	}
	sessionIDs := make([]string, 0, len(admissions))
	for _, a := range admissions {
		if a.SessionID != "" {
			sessionIDs = append(sessionIDs, a.SessionID)
		}
	}
	sessions := q.sessionsByIDs(sessionIDs)
	orderBySession := q.ordersOfSessions(sessionIDs)
	orders := make([]*Order, 0, len(orderBySession))
	for _, o := range orderBySession {
		orders = append(orders, o)
	}
	orderView := s.orderViews(q, orders...)
	accounts := make([]string, 0, len(admissions))
	for _, a := range admissions {
		accounts = append(accounts, a.AccountID)
	}
	labels := q.accountLabels(accounts)
	for _, a := range admissions {
		x := sessions[a.SessionID]
		if user == "" && !onShift(a, x, now) {
			continue
		}
		// displayStatus 才是此刻的真状态：过期是时间到了自然发生的，没人点过，
		// 所以 a.Status 会一直停在 pending。前端一律看这个字段。
		v := map[string]any{"admission": a, "displayStatus": a.Display(now), "customer": labelOf(labels, a.AccountID)}
		// 待确认的申请到这一刻没人确认就失效：两端按它倒数、写「几点前确认」，不自己记时限
		if a.Status == "pending" {
			v["expiresAt"] = a.CreatedAt.Add(member.AdmissionWindow)
		}
		if x != nil {
			end := now
			if x.StoppedAt != nil {
				end = *x.StoppedAt
			}
			elapsed := int64(end.Sub(x.StartedAt)/time.Second) - x.PausedSeconds
			if x.PausedAt != nil {
				elapsed -= min(max(int64(0), int64(a.Package.PauseLimitMinutes)*60-x.PausedSeconds), int64(end.Sub(*x.PausedAt)/time.Second))
			}
			if elapsed < 0 {
				elapsed = 0
			}
			v["session"] = x
			v["sessionVersion"] = member.Version(x)
			v["elapsedSeconds"] = elapsed
			v["remainingSeconds"] = max(int64(0), int64(x.DurationMinutes)*60-elapsed)
			v["overdueSeconds"] = max(int64(0), elapsed-int64(x.DurationMinutes)*60)
			if o := orderBySession[x.ID]; o != nil {
				v["order"] = orderView(*o)
			}
		}
		out = append(out, v)
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i]["admission"].(member.Admission).CreatedAt.After(out[j]["admission"].(member.Admission).CreatedAt)
	})
	return out
}
func (s *Server) loyaltyAction(q *txn, u *User, in loyaltyInput, reqID string) (any, error) {
	m := q.membership()
	now := q.now()
	if len([]rune(in.Reason)) > 200 {
		return nil, invalidInput{member.ErrInvalid}
	}
	if (in.Action == "save_rule" || in.Action == "preview_rule") && (in.Rule.BoardUses < 0 || in.Rule.BoardUses > 1000 || in.Rule.Kind != "recharge" && in.Rule.BoardUses != 0) {
		return nil, invalidInput{errors.New("只有充值方案能送智能豆板次数，须在 0～1000 次之间")}
	}
	if in.CashReceivedCents != nil && in.Action != "checkout" {
		return nil, invalidInput{errors.New("只有会员结账能带实收现金")}
	}
	if in.OfflineCents != nil && in.Action != "checkout" {
		return nil, invalidInput{errors.New("只有会员结账能指定这次收多少线下款")}
	}
	if in.BalanceCents != nil && in.Action != "checkout" && in.Action != "quote" {
		return nil, invalidInput{errors.New("只有会员结账能指定这次用多少储值")}
	}
	if in.Coupon != nil && in.Action != "request" && in.Action != "confirm" {
		return nil, invalidInput{errors.New("只有扫码入座和确认入座能带团购记录")}
	}
	if in.ServiceDate != nil && in.Action != "consume" && in.Action != "recharge" {
		return nil, invalidInput{errors.New("只有消费登记和充值登记能带日期")}
	}
	if in.Consumption != nil && in.Action != "consume" {
		return nil, invalidInput{errors.New("只有消费登记能带消费内容")}
	}
	if in.BoardUses != nil && in.Action != "adjust" {
		return nil, invalidInput{errors.New("只有手动加减能直接调整智能豆板次数")}
	}
	target := in.AccountID
	switch in.Action {
	case "recharge", "adjust", "recharge_refund", "exchange", "fulfill_gift", "consume", "consume_reverse":
		if target == "" {
			return nil, errors.New("请明确选择顾客")
		}
	}
	if target == "" {
		target = u.ID
	}
	if q.user(target) == nil {
		return nil, errNotFound
	}
	// 记账前先把这位顾客（和操作者本人，领取生日福利时记在他自己名下）的全部会员数据装进来：
	// 余额核对要用到全部流水。
	q.memberAccount(target, u.ID)
	if in.Action == "recharge" || in.Action == "exchange" || in.Action == "claim" || in.Action == "request" {
		if in.ExpectedVersion != s.accountVersion(q, target) {
			return nil, errors.New("规则或资产已变化，请刷新后重新确认")
		}
	}
	rule, found := m.Rule(in.TargetID)
	entry := member.Entry{ID: id(), AccountID: target, Kind: in.Action, SourceID: in.TargetID, Reason: in.Reason, CreatedAt: now, Points: []member.PointChange{}}
	switch in.Action {
	case "preview_rule":
		preview, err := member.Preview(in.Rule)
		return map[string]string{"preview": preview}, err
	case "save_rule":
		if in.ExpectedVersion != s.settingsVersion(q) {
			return nil, errors.New("设置已变化，请刷新后重新确认")
		}
		rule = in.Rule
		if err := member.Validate(rule); err != nil {
			return nil, err
		}
		if rule.ID == "" {
			rule.ID = id()
		} else {
			if _, ok := m.Drafts[rule.ID]; !ok {
				return nil, errNotFound
			}
		}
		if old, ok := m.Drafts[rule.ID]; ok && old.Kind != rule.Kind {
			return nil, errors.New("规则类型不能修改")
		}
		m.Drafts[rule.ID] = rule
		return rule, nil
	case "publish", "disable":
		if in.ExpectedVersion != s.settingsVersion(q) {
			return nil, errors.New("设置已变化，请刷新后重新确认")
		}
		if strings.TrimSpace(in.Reason) == "" || len([]rune(in.Reason)) > 200 {
			return nil, errors.New("请填写生效影响说明")
		}
		if in.Action == "disable" {
			// 停用的是正在生效的那一版：历史里记下停掉了什么，而不是草稿里还没发布的修改。
			live, ok := m.Rule(in.TargetID)
			if !ok {
				if _, exists := m.Drafts[in.TargetID]; !exists {
					return nil, errNotFound
				}
				return nil, errors.New("这条规则没有生效，无需停用")
			}
			live.Enabled = false
			for _, p := range m.Publications {
				if !now.After(p.CreatedAt) {
					now = p.CreatedAt.Add(time.Nanosecond)
				}
			}
			pub := member.Publication{ID: id(), Rule: live, ActorID: u.ID, CreatedAt: now, Impact: in.Reason}
			m.Publications[pub.ID] = pub
			if draft, ok := m.Drafts[live.ID]; ok {
				draft.Enabled = false
				m.Drafts[live.ID] = draft
			}
			return pub, nil
		}
		var ok bool
		rule, ok = m.Drafts[in.TargetID]
		if !ok {
			return nil, errNotFound
		}
		if err := member.Validate(rule); err != nil {
			return nil, err
		}
		rule.Enabled = true
		// 消费积分、积分抵扣、自由计时价、陪客费全店同时只能有一项生效：两项同时生效时结账不知道按哪个算
		if label, single := member.SingleKinds[rule.Kind]; single {
			for _, r := range m.Rules() {
				if r.Kind == rule.Kind && r.ID != rule.ID {
					return nil, fmt.Errorf("已有生效的%s「%s」，请先停用它再发布这一条", label, r.Name)
				}
			}
		}
		if rule.ProductID != "" {
			if q.catalogItem(rule.ProductID) == nil {
				return nil, errors.New("请选择已有商品")
			}
		}
		for _, p := range m.Publications {
			if !now.After(p.CreatedAt) {
				now = p.CreatedAt.Add(time.Nanosecond)
			}
		}
		pub := member.Publication{ID: id(), Rule: rule, ActorID: u.ID, CreatedAt: now, Impact: in.Reason}
		m.Publications[pub.ID] = pub
		m.Drafts[rule.ID] = rule
		return pub, nil
	case "birthday":
		if target != u.ID {
			return nil, errForbidden
		}
		p := m.Profiles[u.ID]
		year := now.In(storetime.Location).Year()
		if p.BirthdayYear == year {
			return nil, errors.New("生日每个自然年只能设置一次")
		}
		if _, err := time.Parse("2006-01-02", "2000-"+in.Birthday); err != nil || len(in.Birthday) != 5 {
			return nil, errors.New("生日格式为 MM-DD")
		}
		p.Birthday = in.Birthday
		p.BirthdayYear = year
		m.Profiles[u.ID] = p
		return p, nil
	case "recharge":
		if !offlineMethod(in.Method) {
			return nil, invalidInput{member.ErrInvalid}
		}
		if !found || rule.Kind != "recharge" {
			return nil, member.ErrInvalid
		}
		entry.PrincipalCents = rule.AmountCents
		entry.GiftCents = rule.GiftCents
		entry.Points = member.Grant(entry.ID, rule.Points, rule.ValidDays, now)
		entry.Rule = &rule
		entry.Method = in.Method
		entry.BoardUses = rule.BoardUses
		date := now.In(storetime.Location).Format("2006-01-02")
		if in.ServiceDate != nil {
			date = *in.ServiceDate
		}
		var err error
		entry.ServiceDate, err = loyaltyServiceDate(date, u, now)
		if err != nil {
			return nil, err
		}
		if err := m.Append(entry, now); err != nil {
			return nil, err
		}
		for _, r := range m.Rules() {
			if r.Kind == "tier" {
				total, single := int64(0), int64(0)
				reversed := map[string]bool{}
				for _, e := range m.History(target) {
					if e.Kind == "recharge_refund" {
						reversed[e.SourceID] = true
					}
				}
				for _, e := range m.History(target) {
					if e.Kind == "recharge" && !reversed[e.ID] {
						total += e.PrincipalCents
						single = max(single, e.PrincipalCents)
					}
				}
				basis := total
				if r.Mode == "single" {
					basis = single
				}
				if basis < r.AmountCents {
					continue
				}
				tier := member.Entry{ID: id(), AccountID: target, Kind: "tier", SourceID: entry.ID, Rule: &r, CreatedAt: now}
				m.Entries[tier.ID] = tier
			}
		}
		return s.memberView(q, target), nil
	case "consume":
		if in.ExpectedVersion != s.accountVersion(q, target) {
			return nil, errors.New("资产已变化，请刷新后重新确认")
		}
		if in.ServiceDate == nil || in.Consumption == nil {
			return nil, invalidInput{errors.New("请填写消费日期和消费内容")}
		}
		var err error
		entry.ServiceDate, err = loyaltyServiceDate(*in.ServiceDate, u, now)
		if err != nil {
			return nil, err
		}
		c := in.Consumption
		if c.AmountCents == nil || c.BoardUses == nil || *c.AmountCents < 0 || *c.AmountCents > member.Limit || *c.BoardUses < 0 || *c.BoardUses > 100 || (*c.AmountCents == 0 && *c.BoardUses == 0) || (c.Headcount != 1 && c.Headcount != 2) || (c.DayType != "workday" && c.DayType != "holiday") {
			return nil, invalidInput{errors.New("请检查消费金额、人数、日期类型和智能豆板次数")}
		}
		name := "其他"
		if c.PackageID != "" {
			pack, ok := m.Rule(c.PackageID)
			if !ok || pack.Kind != "package" {
				return nil, invalidInput{errors.New("请选择已发布启用的套餐")}
			}
			name = pack.Name
		} else if strings.TrimSpace(in.Reason) == "" {
			return nil, invalidInput{errors.New("选其他消费内容时请填写备注")}
		}
		balance := m.Balance(target, now)
		if *c.BoardUses > balance.BoardUses {
			return nil, errors.New("智能豆板剩余次数不足")
		}
		entry.PrincipalCents = -min(*c.AmountCents, balance.PrincipalCents)
		entry.GiftCents = -min(*c.AmountCents+entry.PrincipalCents, balance.GiftCents)
		entry.BoardUses = -*c.BoardUses
		entry.Consumption = &member.Consumption{PackageID: c.PackageID, PackageName: name, Headcount: c.Headcount, DayType: c.DayType, AmountCents: *c.AmountCents, ExtraCents: *c.AmountCents + entry.PrincipalCents + entry.GiftCents}
	case "consume_reverse":
		if in.ExpectedVersion != s.accountVersion(q, target) {
			return nil, errors.New("资产已变化，请刷新后重新确认")
		}
		if strings.TrimSpace(in.Reason) == "" {
			return nil, invalidInput{errors.New("请填写撤销原因")}
		}
		original, ok := m.Entries[in.TargetID]
		if !ok || original.AccountID != target || original.Kind != "consume" {
			return nil, invalidInput{errors.New("请选择这位顾客的消费流水")}
		}
		for _, e := range m.History(target) {
			if e.Kind == "consume_reverse" && e.SourceID == original.ID {
				return nil, errors.New("这笔消费已撤销")
			}
		}
		entry.PrincipalCents, entry.GiftCents, entry.BoardUses = -original.PrincipalCents, -original.GiftCents, -original.BoardUses
		entry.Consumption = original.Consumption
	case "adjust":
		if in.BoardUses != nil {
			if *in.BoardUses < -1000 || *in.BoardUses > 1000 {
				return nil, invalidInput{errors.New("智能豆板次数调整须在 -1000～1000 次之间")}
			}
			entry.BoardUses = *in.BoardUses
		}
		if in.ExpectedVersion != s.accountVersion(q, target) {
			return nil, errors.New("资产已变化，请刷新后重新确认")
		}
		if strings.TrimSpace(in.Reason) == "" || len([]rune(in.Reason)) > 200 {
			return nil, errors.New("请填写调整原因")
		}
		if in.PrincipalCents < -member.Limit || in.PrincipalCents > member.Limit || in.GiftCents < -member.Limit || in.GiftCents > member.Limit || in.Points < -member.Limit || in.Points > member.Limit {
			return nil, invalidInput{member.ErrInvalid}
		}
		entry.PrincipalCents = in.PrincipalCents
		entry.GiftCents = in.GiftCents
		if in.Points < 0 {
			var err error
			entry.Points, err = m.SpendPoints(target, -in.Points, now)
			if err != nil {
				return nil, err
			}
		} else {
			entry.Points = member.Grant(entry.ID, in.Points, 0, now)
		}
	case "recharge_refund":
		original, ok := m.Entries[in.TargetID]
		if !ok || original.AccountID != target || original.Kind != "recharge" || strings.TrimSpace(in.Reason) == "" {
			return nil, member.ErrInvalid
		}
		for _, e := range m.Entries {
			if e.Kind == "recharge_refund" && e.SourceID == original.ID {
				return nil, errors.New("该充值已退款")
			}
		}
		entry.PrincipalCents = -original.PrincipalCents
		entry.GiftCents = -original.GiftCents
		entry.Method = original.Method
		entry.BoardUses = -original.BoardUses
		for _, p := range original.Points {
			p.Delta = -p.Delta
			entry.Points = append(entry.Points, p)
		}
	case "exchange", "claim":
		if in.Action == "claim" {
			target = u.ID
			entry.AccountID = target
		}
		if !found {
			return nil, member.ErrInvalid
		}
		entry.Rule = &rule
		if in.Action == "exchange" {
			if rule.Kind != "exchange" || m.Count(target, "exchange", rule.ID, 0) >= rule.PerUserLimit {
				return nil, errors.New("兑换次数已达上限")
			}
			// 兑换总量是全店的：数的是所有顾客对这条规则的兑换。
			if must(q.db().CountExchanges(q.ctx, rule.ID)) >= int64(rule.Quantity) {
				return nil, errors.New("兑换数量已用完")
			}
			var err error
			entry.Points, err = m.SpendPoints(target, rule.Points, now)
			if err != nil {
				return nil, err
			}
			if err = s.loyaltyStock(q, rule.ProductID, -1, entry.ID, u.ID); err != nil {
				return nil, err
			}
		} else {
			if rule.Kind != "birthday" || !m.BirthdayEligible(target, rule, now) {
				return nil, errors.New("当前不符合生日福利领取条件")
			}
			entry.Kind = "birthday"
			if rule.Scope == "points" {
				entry.Points = member.Grant(entry.ID, rule.Points, rule.ValidDays, now)
			}
		}
	case "fulfill_gift":
		original, err := fulfillableGift(m, in.TargetID, target, now)
		if err != nil {
			return nil, err
		}
		if err := s.loyaltyStock(q, original.Rule.ProductID, -1, entry.ID, u.ID); err != nil {
			return nil, err
		}
	case "request":
		if target != u.ID || !found || rule.Kind != "package" || !s.seatAvailable(q, in.TableID, in.SeatNumber, "") {
			return nil, errors.New("座位或套餐不可用，请刷新")
		}
		if err := packageUsable(q, rule); err != nil {
			return nil, err
		}
		minutes, err := packageMinutes(q, rule, now)
		if err != nil {
			return nil, err
		}
		coupon, err := couponOf(in.Coupon)
		if err != nil {
			return nil, invalidInput{err}
		}
		if s.reservationHold(q, in.TableID, in.SeatNumber, now, now.Add(time.Duration(minutes)*time.Minute), u.ID) != nil {
			return nil, errors.New("该座位已被其他顾客预约，请另选座位")
		}
		for _, a := range m.Admissions {
			if a.AccountID != u.ID {
				continue
			}
			// 看派生状态：30 分钟没人确认的申请已过期，Status 却一直停在 pending。
			if x := q.session(a.SessionID); a.Display(now) == "pending" || (x != nil && liveSession(x)) {
				return nil, errors.New("你已有待确认或进行中的体验")
			}
		}
		// 没填团购记录、约过这个时段的（不论约的哪一座）：带上预约里填的，员工确认时看到
		if coupon == nil {
			coupon = reservationCoupon(s.reservationForSeating(q, in.TableID, in.SeatNumber, u.ID, now, minutes, now))
		}
		a := member.Admission{ID: id(), AccountID: u.ID, TableID: in.TableID, SeatNumber: in.SeatNumber, Package: rule, Status: "pending", CreatedAt: now, Coupon: coupon}
		m.Admissions[a.ID] = a
		return a, nil
	case "cancel_request", "confirm", "reject":
		a, ok := q.admission(in.TargetID)
		if !ok || a.Status != "pending" {
			return nil, errors.New("申请状态已变化")
		}
		if in.Action == "cancel_request" {
			if a.AccountID != u.ID {
				return nil, errForbidden
			}
			a.Status = "cancelled"
		} else if in.Action == "reject" {
			a.Status = "rejected"
		} else {
			if !s.seatAvailable(q, a.TableID, a.SeatNumber, "") {
				return nil, errors.New("该座位已被占用")
			}
			if a.Display(now) == "expired" {
				return nil, errors.New("申请已过期，请顾客重新申请")
			}
			if len(q.liveSessionsOf(a.AccountID)) > 0 {
				return nil, errors.New("顾客已有进行中的体验")
			}
			if err := packageUsable(q, a.Package); err != nil {
				return nil, err
			}
			// 「到打烊」的套餐按确认这一刻算到打烊还有多久
			minutes, err := packageMinutes(q, a.Package, now)
			if err != nil {
				return nil, err
			}
			if in.Coupon != nil {
				if a.Coupon, err = couponOf(in.Coupon); err != nil {
					return nil, invalidInput{err}
				}
			}
			if s.reservationHold(q, a.TableID, a.SeatNumber, now, now.Add(time.Duration(minutes)*time.Minute), a.AccountID) != nil {
				return nil, errors.New("该座位已被其他顾客预约，请安排其他座位")
			}
			x := &TableSession{ID: id(), TableID: a.TableID, UserID: a.AccountID, SeatNumber: a.SeatNumber, AdmissionID: a.ID, Status: "active", StartedAt: now, TimingMode: "timed", DurationMinutes: minutes, UntilClose: a.Package.UntilClose}
			q.addSession(x)
			// 顾客到店入座，把自己这个时段的预约结掉（坐的不是约的那一座也算，见 reservationForSeating）
			if booked := s.reservationForSeating(q, a.TableID, a.SeatNumber, a.AccountID, now, minutes, now); booked != nil {
				booked.Status, booked.SessionID, booked.DecidedAt = "seated", x.ID, &now
				s.reservationNoticesAfter(q, booked, "")
				if a.Coupon == nil && in.Coupon == nil {
					a.Coupon = reservationCoupon(booked)
				}
			}
			a.Status = "confirmed"
			a.SessionID = x.ID
			// 系统内收费开着才建单（关着时店员点「结束」放座，见 session_end.go）。
			// 套餐一行，记为系统生成（AutoLines）：续时、超时加收跟着计时重算
			if q.billingEnabled() {
				o := &Order{ID: id(), TableSessionID: x.ID, UserID: a.AccountID, Status: "draft", CreatedAt: now, ReceivableCents: a.Package.AmountCents, Lines: []OrderLine{{Name: a.Package.Name, Quantity: 1, UnitPriceCents: a.Package.AmountCents}}, AutoLines: autoLines(1)}
				q.addOrder(o)
			}
		}
		m.Admissions[a.ID] = a
		return a, nil
	case "pause", "resume", "stop", "move", "renew":
		return s.loyaltySession(q, in)
	case "end":
		return s.loyaltyEnd(q, u, in, reqID)
	case "quote", "checkout":
		return s.loyaltyCheckout(q, u, in, reqID)
	case "refund":
		return s.loyaltyRefund(q, u, in)
	case "refund_quote":
		return s.loyaltyRefundQuote(q, in)
	default:
		return nil, invalidInput{member.ErrInvalid}
	}
	if err := m.Append(entry, now); err != nil {
		return nil, err
	}
	if in.Action == "consume" || in.Action == "consume_reverse" {
		note := fmt.Sprintf("本金变动 %d 分，赠送变动 %d 分，智能豆板变动 %d 次", entry.PrincipalCents, entry.GiftCents, entry.BoardUses)
		if entry.Consumption != nil {
			note += fmt.Sprintf("，另付 %d 分", entry.Consumption.ExtraCents)
		}
		if in.Reason != "" {
			note += "；" + in.Reason
		}
		q.audit(u.ID, "loyalty."+in.Action, target, note, reqID)
	}
	return s.memberView(q, target), nil
}
func offlineMethod(v string) bool { return v == "cash" || v == "wechat" || v == "alipay" }
func (s *Server) loyaltyStock(q *txn, product string, delta int64, source, actorID string) error {
	it := q.stockByProduct(product)
	if it == nil || it.Quantity+delta < 0 {
		return errors.New("商品库存不足，请先登记实际入库")
	}
	it.Quantity += delta
	addMovement(q, it.ID, delta, "loyalty", source, actorID)
	return nil
}
func (s *Server) loyaltySession(q *txn, in loyaltyInput) (any, error) {
	x := q.session(in.TargetID)
	if x == nil || x.AdmissionID == "" || !liveSession(x) {
		return nil, errors.New("体验已结束或不存在")
	}
	if in.ExpectedVersion != member.Version(x) {
		return nil, errors.New("计时已变化，请刷新后重新确认")
	}
	a, _ := q.admission(x.AdmissionID)
	now := q.now()
	switch in.Action {
	case "move":
		if !s.seatAvailable(q, in.TableID, in.SeatNumber, x.ID) {
			return nil, errors.New("目标座位不可用")
		}
		// 「到打烊」的套餐没有固定时长，按这一台确认时算出的时长衡量
		minutes := a.Package.DurationMinutes
		if a.Package.UntilClose {
			minutes = x.DurationMinutes
		}
		if s.reservationHold(q, in.TableID, in.SeatNumber, now, now.Add(time.Duration(minutes)*time.Minute), x.UserID) != nil {
			return nil, errors.New("目标座位已被预约")
		}
		x.TableID = in.TableID
		x.SeatNumber = in.SeatNumber
	case "pause":
		if x.StoppedAt != nil || x.Status != "active" || a.Package.PauseLimitMinutes == 0 || x.PausedSeconds >= int64(a.Package.PauseLimitMinutes)*60 {
			return nil, errors.New("当前不能暂停")
		}
		x.Transition("paused", now)
	case "resume":
		if x.Status != "paused" || x.StoppedAt != nil {
			return nil, member.ErrInvalid
		}
		s.resumeLoyalty(x, a, now)
	case "stop":
		if x.StoppedAt != nil {
			return nil, errors.New("已停止计时")
		}
		if x.Status == "paused" {
			s.resumeLoyalty(x, a, now)
		}
		x.StoppedAt = &now
		// 停止计时后计价冻结在这一刻：草稿的计时明细（超时加收）按停止时刻重算一次存下
		q.ordersOfSession(x.ID)
	case "renew":
		if x.StoppedAt != nil || a.Package.RenewalMinutes < 1 {
			return nil, errors.New("套餐未配置续时或计时已停止")
		}
		// 续上的这一段不能压到这个座位后面别人的预约。现在的结束时间和桌位视图的 endsAt 同一套算法（sessionEndsAt）
		end, _ := sessionEndsAt(q, x, now)
		from := end
		if from.Before(now) {
			from = now
		}
		until := end.Add(time.Duration(a.Package.RenewalMinutes) * time.Minute)
		if hold := s.reservationHold(q, x.TableID, x.SeatNumber, from, until, x.UserID); until.After(from) && hold != nil {
			return nil, fmt.Errorf("续时 %d 分钟会坐到 %s，压到%s：请先处理那个预约，或为顾客换座", a.Package.RenewalMinutes, until.In(storetime.Location).Format("15:04"), s.reservationText(q, hold))
		}
		drafts := q.ordersOfSession(x.ID)
		for _, o := range drafts {
			if o.Status != "draft" || o.ReceivableCents+a.Package.RenewalCents > member.Limit {
				return nil, member.ErrInvalid
			}
			if o.AutoLines == nil {
				// 0.0.18 及更早确认的入座：照旧在末尾追加一行续时
				o.Lines = append(o.Lines, OrderLine{Name: a.Package.Name + " · 续时", Quantity: 1, UnitPriceCents: a.Package.RenewalCents})
				o.ReceivableCents += a.Package.RenewalCents
			}
		}
		x.DurationMinutes += a.Package.RenewalMinutes
		// 新确认的入座：按续过的时长重算系统生成的明细（套餐、每次续时一行，续上之后超时加收随之减少或没有）
		lines := chargeLines(s.sessionCharge(q, x))
		for _, o := range drafts {
			if o.AutoLines != nil && *o.AutoLines > 0 && !replaceAutoLines(o, lines) && !slices.Equal(o.Lines[:min(*o.AutoLines, len(o.Lines))], lines) {
				return nil, member.ErrInvalid
			}
		}
	}
	return map[string]any{"session": x, "version": member.Version(x)}, nil
}

// loyaltyEnd 结束一台按座会话并放座（系统内收费关着时，见 session_end.go）：带读到的会话版本，变了就拒绝。
func (s *Server) loyaltyEnd(q *txn, u *User, in loyaltyInput, reqID string) (any, error) {
	x := q.session(in.TargetID)
	if x == nil || x.AdmissionID == "" || !liveSession(x) {
		return nil, errors.New("体验已结束或不存在")
	}
	if in.ExpectedVersion != member.Version(x) {
		return nil, errors.New("计时已变化，请刷新后重新确认")
	}
	if err := s.endSession(q, u, reqID, x); err != nil {
		return nil, err
	}
	return map[string]any{"session": x, "version": member.Version(x)}, nil
}

func (s *Server) resumeLoyalty(x *TableSession, a member.Admission, now time.Time) {
	old := x.PausedSeconds
	x.Transition("active", now)
	x.PausedSeconds = min(x.PausedSeconds, int64(a.Package.PauseLimitMinutes)*60)
	if x.PausedSeconds < old {
		x.PausedSeconds = old
	}
}
func (s *Server) loyaltyCheckout(q *txn, u *User, in loyaltyInput, reqID string) (any, error) {
	o := q.order(in.TargetID)
	if o == nil || o.UserID == "" || o.Status != "draft" {
		return nil, errors.New("请先选择顾客的待结账订单")
	}
	if in.ExpectedVersion != o.Version() {
		return nil, errors.New("订单已变化，请重新读取")
	}
	goods, service := int64(0), int64(0)
	for _, l := range o.Lines {
		if l.Quantity < 1 || l.UnitPriceCents < 0 || l.UnitPriceCents > member.Limit/int64(l.Quantity) {
			return nil, member.ErrInvalid
		}
		v := l.UnitPriceCents * int64(l.Quantity)
		if l.ProductID == "" {
			service += v
		} else {
			goods += v
		}
	}
	if goods > member.Limit || service > member.Limit || goods+service > member.Limit {
		return nil, member.ErrInvalid
	}
	m := q.memberAccount(o.UserID)
	now := q.now()
	quote, err := m.QuoteConsumption(o.UserID, o.ReceivableCents, goods, service, in.Points, in.UseBalance, in.BalanceCents, now)
	if capErr := (member.ErrBalanceCap{}); errors.As(err, &capErr) {
		return nil, invalidInput{err}
	}
	if err != nil {
		return nil, err
	}
	if in.Action == "quote" {
		return quote, nil
	}
	if in.QuoteVersion != quote.Version {
		return nil, errors.New("会员资产或权益已变化，请重新预览结账")
	}
	// 这次随会员结账收多少线下补付：不带就是全部（一次收齐）。少收的部分订单记为部分付款，余下的分笔收（多人合付）。
	offlineNow := quote.OfflineCents
	if in.OfflineCents != nil {
		if *in.OfflineCents < 0 || *in.OfflineCents > quote.OfflineCents {
			return nil, invalidInput{fmt.Errorf("这次收的线下款须在 ¥0.00 到 ¥%s（报价的线下补付）之间", yuanText(quote.OfflineCents))}
		}
		offlineNow = *in.OfflineCents
	}
	split := offlineNow < quote.OfflineCents
	if split && quote.PrincipalCents+quote.GiftCents+offlineNow == 0 {
		// 会员这一笔一分钱都没收：分不出哪笔是会员的，退款没法按原付款比例拆。至少用储值或收一部分线下款
		return nil, invalidInput{errors.New("会员结账这一笔要收到钱：用储值，或这次至少收一部分线下款，余下的再分笔收")}
	}
	if offlineNow > 0 && !offlineMethod(in.Method) {
		return nil, errors.New("请选择线下收款方式")
	}
	// 线下补付走现金时可附实收现金，找零记在这笔补付的付款记录上（规则同普通收款）。
	// 这次不收线下款时没有现金付款，带了实收是请求不对。
	offline := Payment{ID: id(), Method: in.Method, AmountCents: offlineNow, CreatedAt: now, Member: split}
	if in.CashReceivedCents != nil {
		if offlineNow == 0 {
			return nil, invalidInput{errors.New("这次不收线下款，不能填实收现金")}
		}
		if err = ordersapp.CashTender(&offline, in.CashReceivedCents); err != nil {
			return nil, invalidInput{err}
		}
	}
	if x := q.session(o.TableSessionID); x != nil && !liveSession(x) {
		return nil, errors.New("体验已结束")
	}
	// 会员积分只按会员这一笔收到的钱送（储值和随会员结账收的线下款）；一次收齐时就是报价里的数
	earnedPoints := quote.EarnedPoints
	if split {
		if earnedPoints, _, err = m.EarnedPoints(quote.PrincipalCents+quote.GiftCents+offlineNow, goods, service); err != nil {
			return nil, err
		}
	}
	for _, l := range o.Lines {
		if l.ProductID != "" {
			if err = s.loyaltyStock(q, l.ProductID, -int64(l.Quantity), o.ID, u.ID); err != nil {
				return nil, err
			}
		}
	}
	debit := member.Entry{ID: id(), AccountID: o.UserID, Kind: "checkout", SourceID: o.ID, PrincipalCents: -quote.PrincipalCents, GiftCents: -quote.GiftCents, CreatedAt: now}
	debit.Points, err = m.SpendPoints(o.UserID, quote.PointsUsed, now)
	if err != nil {
		return nil, err
	}
	if err = m.Append(debit, now); err != nil {
		return nil, err
	}
	earned := member.Entry{ID: id(), AccountID: o.UserID, Kind: "earned", SourceID: o.ID, CreatedAt: now}
	earned.Points = member.Grant(earned.ID, earnedPoints, quote.PointsValidDays, now)
	if err = m.Append(earned, now); err != nil {
		return nil, err
	}
	if quote.BirthdayEntryID != "" {
		e := member.Entry{ID: id(), AccountID: o.UserID, Kind: "birthday_used", SourceID: quote.BirthdayEntryID, Reason: o.ID, CreatedAt: now}
		m.Entries[e.ID] = e
	}
	if quote.DiscountCents > 0 {
		o.Discounts = append(o.Discounts, Discount{ID: id(), Kind: "fixed", AmountCents: quote.DiscountCents, Reason: "会员权益", CreatedAt: now})
	}
	if quote.PointsCents > 0 {
		o.Discounts = append(o.Discounts, Discount{ID: id(), Kind: "fixed", AmountCents: quote.PointsCents, Reason: fmt.Sprintf("积分抵扣 %d 积分", quote.PointsUsed), CreatedAt: now})
	}
	// 会员价（会员优惠、积分抵扣）按整单定在这里，之后分笔收的照这个应收收；会员结账只能是第一笔（草稿才能会员结账）
	o.ReceivableCents = quote.PrincipalCents + quote.GiftCents + quote.OfflineCents
	o.PaidCents = quote.PrincipalCents + quote.GiftCents + offlineNow
	o.Status = ordersdomain.StatusPaid
	if split {
		o.Status = ordersdomain.StatusPartiallyPaid
	}
	if quote.PrincipalCents+quote.GiftCents > 0 {
		o.Payments = append(o.Payments, Payment{ID: id(), Method: "balance", AmountCents: quote.PrincipalCents + quote.GiftCents, CreatedAt: now, Member: split})
	}
	if offlineNow > 0 {
		o.Payments = append(o.Payments, offline)
	}
	if x := q.session(o.TableSessionID); x != nil && !split {
		s.settleSession(q, x, now)
	}
	quote.EarnedPoints = earnedPoints
	if split {
		s.afterCollect(q, u, reqID, o, now)
		q.audit(u.ID, "order.payment.partial", o.ID, fmt.Sprintf("会员结账（储值 ¥%s，线下 ¥%s），还差 ¥%s", yuanText(quote.PrincipalCents+quote.GiftCents), yuanText(offlineNow), yuanText(ordersapp.OutstandingCents(*o))), reqID)
	}
	return map[string]any{"order": s.orderView(q, *o), "quote": quote}, nil
}

// settleSession 结清计时会话（会员结账、免单）：暂停中的先恢复（按座会话的暂停只算到上限），停在这一刻。
func (s *Server) settleSession(q *txn, x *TableSession, now time.Time) {
	s.endPause(q, x, now)
	x.Status = "settled"
	if x.StoppedAt == nil {
		x.StoppedAt = &now
	}
}

// endPause 结束暂停：整桌会话暂停的时间全部不计，按座会话只算到套餐允许的上限。
func (s *Server) endPause(q *txn, x *TableSession, now time.Time) {
	if x.Status != "paused" {
		return
	}
	if x.AdmissionID == "" {
		x.Transition("active", now)
		return
	}
	a, _ := q.admission(x.AdmissionID)
	s.resumeLoyalty(x, a, now)
}

// freezeSession 是分笔付款收第一笔（还没收齐）时的计时：停在这一刻，同「停止计时」——计价与明细冻结在收第一笔的金额上，
// 座位保留到收齐或对剩余免单，桌位写「待结账」，不再提醒快到点、超时；暂停中的先结束暂停。已经停了的不动。
// 陪客照旧显示待结账（陪客费是固定的，停不停金额都一样）。审计 venue_session.stopped。
func (s *Server) freezeSession(q *txn, u *User, reqID string, x *TableSession, now time.Time) {
	if x.StoppedAt != nil {
		return
	}
	s.endPause(q, x, now)
	x.StoppedAt = &now
	q.audit(u.ID, "venue_session.stopped", x.ID, fmt.Sprintf("收了第一笔款、还没收齐，计时停在这一刻（已用 %d 分钟）", x.UsedSeconds(now, -1)/60), reqID)
}

// onShift 判断一条入座申请当班是否还要看：待确认、计时进行中，或今天（门店日期）申请、今天结束。
func onShift(a member.Admission, x *TableSession, now time.Time) bool {
	if a.Display(now) == "pending" || x != nil && liveSession(x) {
		return true
	}
	today := now.In(storetime.Location).Format("2006-01-02")
	if a.CreatedAt.In(storetime.Location).Format("2006-01-02") == today {
		return true
	}
	return x != nil && x.StoppedAt != nil && x.StoppedAt.In(storetime.Location).Format("2006-01-02") == today
}
