package app

import (
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"time"

	calls "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/servicecalls/domain"
)

// 呼叫店员（docs/plan-live-board.md 第 2 节）。
//
// 有进行中计时会话（计时中、暂停中，含停止计时等结账的）的顾客在小程序「本次手作」页点「呼叫店员」；
// 店员在小程序工作台、网页后台看到「B3 桌 2 号座 · 3 分钟前」，去了之后点「已处理」。
//
//   - 一个会话同时只有一条未处理的呼叫：再叫原样返回那一条（200），不新建。不用幂等键：重复点、重发都无害。
//   - 店员处理后 1 分钟内不能再叫（429 service_call_cooldown，Retry-After 给秒数）。
//   - 没人处理的呼叫 30 分钟后显示为已过期（读时算，同入座申请），顾客可以再叫；员工列表不再列它。
//   - 新建、处理都推送 service-calls：员工收全店事件，顾客只收自己的（呼叫记在顾客名下，写回时自动收集）。
//   - 处理记审计（谁、何时）；处理过的再点不改、不重复记审计，先点的那位算数。
//   - 店员可以先点「我去处理」（认领）：谁先认领算谁，别的员工那里显示「XX 正在处理」、不再振动响铃，顾客页显示
//     「XX 正在过来」；认领满 10 分钟还没处理就失效、重新提醒所有人。认领也推送 service-calls、记审计。

type ServiceCall = calls.Call

// 顾客发起呼叫按账户限流（rate_limit_windows）：规则本身已经限住了能建出几条，这里挡的是脚本或连点
// 把同一个写请求刷成一串事务。按账户计而不按来源：店里的顾客连同一个 Wi-Fi，出口地址是同一个。
const (
	serviceCallRateLimit  = 10
	serviceCallRateWindow = time.Minute
)

var errNoActiveSession = errors.New("你现在没有进行中的计时，不能呼叫店员")

// callableSession 报告顾客能不能为这次计时呼叫店员：计时中或暂停中（停止计时、等结账的会话状态仍是计时中）。
func callableSession(x *TableSession) bool { return x.Status == "active" || x.Status == "paused" }

// serviceCallInput 是顾客呼叫的请求；omitzero 的用意同 loyaltyInput。
type serviceCallInput struct {
	SessionID string `json:"venueSessionId,omitzero"`
}

// createServiceCall 是顾客呼叫店员：会话必须是本人的、还在计时或暂停中。
func (s *Server) createServiceCall(w http.ResponseWriter, r *http.Request) {
	u, ok := s.signedIn(w, r)
	if !ok {
		return
	}
	var in serviceCallInput
	if err := decode(r, &in); err != nil {
		s.writeError(w, r, 400, "invalid_request", err)
		return
	}
	if !validID(in.SessionID) {
		s.writeError(w, r, 400, "invalid_request", errors.New("请指明是哪一次计时"))
		return
	}
	q := s.tx(r)
	now := q.now()
	// 别人的会话和不存在的一样回 no_active_session：不让人借此确认某个会话是否存在
	x := q.session(in.SessionID)
	if x == nil || x.UserID != u.ID || !callableSession(x) {
		s.writeError(w, r, 409, "no_active_session", errNoActiveSession)
		return
	}
	if last := q.latestServiceCalls([]string{x.ID})[x.ID]; last != nil {
		if last.Open(now) {
			writeJSON(w, 200, s.serviceCallViews(q, []*ServiceCall{last}, false)[0])
			return
		}
		if wait := last.CooldownLeft(now); wait > 0 {
			seconds := int((wait + time.Second - 1) / time.Second)
			w.Header().Set("Retry-After", strconv.Itoa(seconds))
			s.writeError(w, r, 429, "service_call_cooldown", fmt.Errorf("店员刚处理过你的呼叫，%d 秒后可以再叫", seconds))
			return
		}
	}
	c := &ServiceCall{ID: id(), SessionID: x.ID, AccountID: u.ID, Status: calls.Pending, CreatedAt: now}
	q.addServiceCall(c)
	writeJSON(w, 201, s.serviceCallViews(q, []*ServiceCall{c}, false)[0])
}

// myServiceCalls 是顾客自己每个进行中会话最近的一条呼叫（「本次手作」页据此显示已呼叫、已处理、冷却）。
func (s *Server) myServiceCalls(w http.ResponseWriter, r *http.Request) {
	u, ok := s.signedIn(w, r)
	if !ok {
		return
	}
	q := s.tx(r)
	var sessions []string
	for _, x := range q.liveSessionsOf(u.ID) {
		if callableSession(x) {
			sessions = append(sessions, x.ID)
		}
	}
	latest := q.latestServiceCalls(sessions)
	list := make([]*ServiceCall, 0, len(latest))
	for _, c := range latest {
		list = append(list, c)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].CreatedAt.Before(list[j].CreatedAt) })
	writeJSON(w, 200, s.serviceCallViews(q, list, false))
}

// listServiceCalls 是员工要去处理的呼叫（scope=open）：还没处理、没过期、顾客还在的，先叫的在前。
// 全部历史会越积越大，不提供。
func (s *Server) listServiceCalls(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.staffMember(w, r); !ok {
		return
	}
	if r.URL.Query().Get("scope") != "open" {
		s.writeError(w, r, 400, "invalid_request", errors.New("scope 只能是 open"))
		return
	}
	q := s.tx(r)
	writeJSON(w, 200, s.serviceCallViews(q, q.openServiceCalls(q.now()), true))
}

// handleServiceCall 是店员标记已处理：记下谁、何时，写审计。已经处理过的原样返回，不改处理人、不重复记审计。
func (s *Server) handleServiceCall(w http.ResponseWriter, r *http.Request) {
	u, ok := s.staffMember(w, r)
	if !ok {
		return
	}
	q := s.tx(r)
	c := q.serviceCall(r.PathValue("id"))
	if c == nil {
		s.writeError(w, r, 404, "not_found", errNotFound)
		return
	}
	if c.Handle(u.ID, q.now()) {
		q.audit(u.ID, "service_call.handled", c.ID, "", requestID(r))
	}
	writeJSON(w, 200, s.serviceCallViews(q, []*ServiceCall{c}, true)[0])
}

// claimServiceCall 是店员点「我去处理」：谁先认领算谁，记下谁、何时，写审计。认领着的呼叫员工端不再振动、响铃，
// 「已处理」照旧谁都能点。
//
//   - 别人认领着（不到 10 分钟）：409 service_call_claimed「XX 已在处理」，什么都不改；
//   - 同一人再点：原样返回，不重复记审计（重复点、重发都无害，所以不用幂等键）；
//   - 认领满 10 分钟还没处理：认领失效、重新提醒所有人，谁都能再认领（calls.ClaimHold）；
//   - 已处理、已过期、顾客已经结账离开的不用再去：409 service_call_closed。
func (s *Server) claimServiceCall(w http.ResponseWriter, r *http.Request) {
	u, ok := s.staffMember(w, r)
	if !ok {
		return
	}
	q := s.tx(r)
	c := q.serviceCall(r.PathValue("id"))
	if c == nil {
		s.writeError(w, r, 404, "not_found", errNotFound)
		return
	}
	now := q.now()
	switch {
	case c.Status == calls.Handled:
		s.writeError(w, r, 409, "service_call_closed", fmt.Errorf("这条呼叫已经由 %s 处理了", staffLabel(q, c.HandledBy)))
		return
	case !c.Open(now):
		s.writeError(w, r, 409, "service_call_closed", errors.New("这条呼叫已过期（叫了满 30 分钟没人处理），顾客还需要帮忙会再叫"))
		return
	}
	if x := q.session(c.SessionID); x == nil || !callableSession(x) {
		s.writeError(w, r, 409, "service_call_closed", errors.New("顾客已经结账离开，不用再去了"))
		return
	}
	changed, err := c.Claim(u.ID, now)
	if errors.Is(err, calls.ErrClaimedByOther) {
		s.writeError(w, r, 409, "service_call_claimed", fmt.Errorf("%s 已在处理", staffLabel(q, c.ClaimedBy)))
		return
	}
	if err != nil {
		panic(err) // 上面已经挡掉了处理过、过期的
	}
	if changed {
		q.audit(u.ID, "service_call.claimed", c.ID, "", requestID(r))
	}
	writeJSON(w, 200, s.serviceCallViews(q, []*ServiceCall{c}, true)[0])
}

// staffLabel 是给员工看的另一位员工的称呼：昵称，没有时用打码手机号；账户不在了写「其他店员」。
func staffLabel(q *txn, account string) string {
	if l := labelOf(q.accountLabels([]string{account}), account); l != nil {
		if l.Nickname != "" {
			return l.Nickname
		}
		if l.PhoneMasked != "" {
			return l.PhoneMasked
		}
	}
	return "其他店员"
}

// serviceCallViews 是呼叫的展示视图：在哪张桌、哪个座（按会话现在的位置，顾客换了座也不会找错）、此刻的状态、
// 有没有员工说了「我去处理」。staff 时带上顾客、处理人与认领人的称呼；顾客自己看的不带任何员工的称呼。
func (s *Server) serviceCallViews(q *txn, list []*ServiceCall, staff bool) []map[string]any {
	now := q.now()
	sessionIDs := make([]string, 0, len(list))
	accounts := make([]string, 0, 3*len(list))
	for _, c := range list {
		sessionIDs = append(sessionIDs, c.SessionID)
		if staff {
			accounts = append(accounts, c.AccountID, c.HandledBy, c.ClaimedBy)
		}
	}
	sessions := q.sessionsByIDs(sessionIDs)
	labels := q.accountLabels(accounts)
	out := make([]map[string]any, 0, len(list))
	for _, c := range list {
		v := map[string]any{
			"id":             c.ID,
			"venueSessionId": c.SessionID,
			"status":         c.Status,
			"displayStatus":  c.Display(now),
			"createdAt":      c.CreatedAt,
			"handledAt":      c.HandledAt,
			// 还要等几秒才能再叫（读的时候算好，前端在两次刷新之间按它倒数，不看手机时钟）
			"cooldownSeconds": int64((c.CooldownLeft(now) + time.Second - 1) / time.Second),
			// 「我去处理」：认领着的员工端不再提醒，满 10 分钟没处理变回 lapsed、重新提醒（读的时候按时间算）
			"claimStatus": c.ClaimState(now),
			"claimedAt":   c.ClaimedAt,
		}
		// 会话有外键，一定在；桌位编码是布局里的（A1、B3…）
		x := sessions[c.SessionID]
		v["serviceTableId"], v["seatNumber"], v["tableCode"] = x.TableID, x.SeatNumber, ""
		if t := q.table(x.TableID); t != nil {
			v["tableCode"] = t.Code
		}
		// 顾客只看 claimStatus（认领着就显示「店员正在过来」），不给是哪位员工：2026-10-06 业主定不让顾客看到员工昵称
		if staff {
			v["customer"] = labelOf(labels, c.AccountID)
			v["handledBy"] = labelOf(labels, c.HandledBy)
			v["claimedBy"] = labelOf(labels, c.ClaimedBy)
		}
		out = append(out, v)
	}
	return out
}
