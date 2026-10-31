package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"sort"
	"time"

	ordersdomain "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/orders/domain"
	tables "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/tables/domain"
	"github.com/yreidev/pindou-studio/pindou-backend/internal/storetime"
)

// maxSessionMinutes 是定时计时的时长上限（时长列是 integer，超出范围要到落库才失败）。
const maxSessionMinutes = 24 * 60

// listAreas 是门店的区域（登录后都能看）。
func (s *Server) listAreas(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.signedIn(w, r); !ok {
		return
	}
	areas := s.tx(r).allAreas()
	out := make([]FloorArea, 0, len(areas))
	for _, a := range areas {
		out = append(out, *a)
	}
	writeJSON(w, 200, out)
}

// areaLayoutFixed 回答已经删掉的区域写接口：登录后一律 405。
//
// 布局是固定的（layout/store-layout.json，启动时由 ReconcileLayout 校正）。
// 建区域 / 改名 / 改网格 / 锁定这些端点都已删除：它们存在的唯一用途是让店里
// 自己拼出一套和平面图对得上的布局，而那套对账机器正是 2026-09-19 门店卡死的根源。
func (s *Server) areaLayoutFixed(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.signedIn(w, r); !ok {
		return
	}
	s.writeError(w, r, 405, "method_not_allowed", errLayoutFixed)
}

// listTables 是全部桌位及其占用（登录后都能看）。
func (s *Server) listTables(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.signedIn(w, r); !ok {
		return
	}
	q := s.tx(r)
	writeJSON(w, 200, s.tableViews(q, q.allTables()))
}

// tableLayoutFixed 回答建桌：店长、老板也只得到 405。
// 桌位由布局决定，不能凭空加。要加桌 = 改 layout/store-layout.json 重新部署。
func (s *Server) tableLayoutFixed(w http.ResponseWriter, r *http.Request) {
	u, ok := s.signedIn(w, r)
	if !ok {
		return
	}
	if !hasRole(u, Manager, Owner) {
		s.writeError(w, r, 403, "forbidden", errForbidden)
		return
	}
	s.writeError(w, r, 405, "method_not_allowed", errLayoutFixed)
}

// updateTable 停用或启用一张桌（店长、老板）。
func (s *Server) updateTable(w http.ResponseWriter, r *http.Request) {
	u, ok := s.signedIn(w, r)
	if !ok {
		return
	}
	q := s.tx(r)
	if !hasRole(u, Manager, Owner) {
		s.writeError(w, r, 403, "forbidden", errForbidden)
		return
	}
	tableID := r.PathValue("id")
	if !validID(tableID) {
		s.writeError(w, r, 404, "not_found", errNotFound)
		return
	}
	// ★ 只剩停用/启用。桌号、座位数、整桌单位、格子坐标全部由布局决定，
	//   带这些字段过来一律拒绝 —— 静默忽略会让店员以为改成功了，
	//   下次重启 ReconcileLayout 又把它改回去，看起来像系统在跟人捣乱。
	var raw map[string]json.RawMessage
	if e := decode(r, &raw); e != nil {
		s.writeError(w, r, 400, "invalid_request", e)
		return
	}
	for key := range raw {
		if key != "enabled" {
			s.writeError(w, r, 400, "layout_fixed", errLayoutFixed)
			return
		}
	}
	var in struct {
		Enabled *bool `json:"enabled"`
	}
	if len(raw["enabled"]) > 0 {
		if e := json.Unmarshal(raw["enabled"], &in.Enabled); e != nil {
			s.writeError(w, r, 400, "invalid_request", e)
			return
		}
	}
	t := q.table(tableID)
	if t == nil {
		s.writeError(w, r, 404, "not_found", errNotFound)
		return
	}
	if in.Enabled != nil && !*in.Enabled {
		if len(q.liveSessionsOnTable(t.ID)) > 0 {
			s.writeError(w, r, 409, "table_occupied", errors.New("使用中的桌位不能停用"))
			return
		}
		// 停用一张还有人预约的桌，顾客到店时开台会失败，而他已经白跑一趟了。
		// 先取消或改期那些预约，再停用。
		now, grace := q.now(), q.reservationSettings().GraceMinutes
		for _, booking := range q.openReservations(now) {
			if booking.TableID == t.ID && booking.Live(now, grace) {
				s.writeError(w, r, 409, "table_reserved",
					errors.New("该桌位还有未到店的预约，请先取消或改约"))
				return
			}
		}
	}
	if in.Enabled != nil {
		t.Enabled = *in.Enabled
	}
	q.audit(u.ID, "layout.table.updated", t.ID, "", requestID(r))
	writeJSON(w, 200, s.tableViews(q, []*Table{t})[0])
}

// tableViews 是桌位列表的展示视图：占用、计时状态、能算出来的应收。进行中的会话一次读出来按桌分组。
func (s *Server) tableViews(q *txn, tables []*Table) []map[string]any {
	live := map[string][]*TableSession{}
	var stopped []string
	for _, x := range q.liveSessions() {
		live[x.TableID] = append(live[x.TableID], x)
		if x.StoppedAt != nil {
			stopped = append(stopped, x.ID)
		}
	}
	// 分笔付款收了一部分的会话（计时停在收第一笔时）：订单已经收了钱，整单的计时费不是「还要收多少」，
	// 不再报 estimatedCents，免得会话页「去收款 ¥X」写成整单的数；还差多少看订单的 outstandingCents
	partial := map[string]bool{}
	for session, o := range q.ordersOfSessions(stopped) {
		partial[session] = o.Status == ordersdomain.StatusPartiallyPaid
	}
	billing := q.billingEnabled()
	out := make([]map[string]any, 0, len(tables))
	for _, t := range tables {
		out = append(out, s.tableView(q, t, live[t.ID], partial, billing))
	}
	return out
}

// tableView 是一张桌的展示视图。billing 是系统内收费开着没有：关着时不给应收（estimatedCents）和计价说明（charge）。
func (s *Server) tableView(q *txn, t *Table, sessions []*TableSession, partial map[string]bool, billing bool) map[string]any {
	view := map[string]any{"id": t.ID, "code": t.Code, "zone": zoneKeyOf(t.Code), "floorAreaId": t.AreaID, "number": t.Number, "seatCount": t.SeatCount, "wholeTable": t.WholeTable, "enabled": t.Enabled, "occupancy": "idle", "seatBased": false}
	sessions = append([]*TableSession(nil), sessions...)
	for _, x := range sessions {
		if x.AdmissionID != "" {
			view["seatBased"] = true
		}
	}
	sort.Slice(sessions, func(i, j int) bool { return sessions[i].ID < sessions[j].ID })
	// 桌上的会话都已停止计时、保留座位等结账：桌位页写「待结账」，不再按停止那一刻的剩余时间写快到点、已超时
	stopped := len(sessions) > 0
	for _, x := range sessions {
		stopped = stopped && x.StoppedAt != nil
	}
	if stopped {
		view["stopped"] = true
	}
	var earliest int64
	hasTiming := false
	for _, x := range sessions {
		view["occupancy"] = "occupied"
		if x.TimingMode == "free" {
			view["timingMode"] = "free"
			continue
		}
		_, deadline, remaining := s.sessionClock(q, x)
		if hasTiming && remaining >= earliest {
			continue
		}
		hasTiming = true
		earliest = remaining
		view["startedAt"] = x.StartedAt
		view["endsAt"] = deadline
		view["remainingSeconds"] = max(int64(0), remaining)
		view["timingStatus"] = timingStatusOf(remaining)
	}
	// 「应收 ¥X」：让店员在会话页就能报价，不必先建单再进结账页看；charge 写清怎么算的（超时加收几块、
	// 自由计时几块、陪客费）。算不出来（对不上套餐、没发布自由计时价或陪客费、多人同桌）就不下发 estimatedCents ——
	// 缺字段让前端说「结账时填价」，比下发一个 0 让人以为不要钱强。
	if len(sessions) == 1 && billing {
		c := s.sessionCharge(q, sessions[0])
		if c.Priced() && !partial[sessions[0].ID] {
			view["estimatedCents"] = c.TotalCents()
		}
		view["charge"] = viewOfCharge(c, sessions[0])
	}
	return view
}

// sessionEndsAt 是定时会话按后端口径的结束时间（桌位视图的 endsAt，现场挡预约也用它）：开始时间加套餐时长和已暂停的时间；
// 暂停中的按座会话，这次暂停只算到套餐允许的暂停上限。已停止计时的按停止那一刻算（now 由调用方换成 StoppedAt）。
// 自由计时没有结束时间，第二个返回值为 false。
func sessionEndsAt(q *txn, x *TableSession, now time.Time) (time.Time, bool) {
	if x.TimingMode == "free" {
		return time.Time{}, false
	}
	deadline := x.Deadline(now)
	if x.AdmissionID != "" && x.PausedAt != nil {
		a, _ := q.admission(x.AdmissionID)
		pause := min(max(int64(0), int64(a.Package.PauseLimitMinutes)*60-x.PausedSeconds), int64(now.Sub(*x.PausedAt)/time.Second))
		deadline = x.StartedAt.Add(time.Duration(int64(x.DurationMinutes)*60+x.PausedSeconds+pause) * time.Second)
	}
	return deadline, true
}

// listSessions 是进行中的计时会话（员工）。
func (s *Server) listSessions(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.staffMember(w, r); !ok {
		return
	}
	q := s.tx(r)
	// 只回进行中的（计时中、暂停、陪客）：员工端只找这些，全部历史会越积越大，不提供
	if r.URL.Query().Get("status") != "live" {
		s.writeError(w, r, 400, "invalid_request", errors.New("status 必须是 live"))
		return
	}
	sessions := q.liveSessions()
	out := make([]sessionView, 0, len(sessions))
	for _, x := range sessions {
		out = append(out, s.sessionOut(q, *x))
	}
	writeJSON(w, 200, out)
}

// sessionView 是接口返回的会话：开台时记下的价表（Tariff）只供后端计价，不进响应——两端只看后端算好的
// 计价说明（桌位的 charge、订单的 timing），列表每隔几秒读一次，也不必每次带着整张价表。续时只给用得上的
// 那一条续时方案（Renewal）。
type sessionView struct {
	TableSession
	// Renewal 是整桌定时会话眼下能按整块续的续时方案（见 renewalOf）；不能续或对不上套餐时省略。
	Renewal *renewalPlan `json:"renewal,omitempty"`
}

// renewalPlan 是一次续多少分钟、多少钱（开台时记下的价）。两端按它给「续 N 分钟」（N 是 Minutes 的 1、2、3 倍），
// 另能自己填分钟；金额只作说明，记进订单多少钱以后端计价为准。
type renewalPlan struct {
	Minutes     int    `json:"minutes"`
	AmountCents int64  `json:"amountCents"`
	PackageName string `json:"packageName"`
}

func (s *Server) sessionOut(q *txn, x TableSession) sessionView {
	out := sessionView{TableSession: x, Renewal: renewalOf(q, &x)}
	out.Tariff = nil
	return out
}

// renewalOf 是整桌会话的续时方案：开台时记下的价表里，眼下的约定时长（含已续的）对得上的套餐的续时方案
// （tables.RenewalPlan）。只有能续时的才给：定时、不是到打烊、没有停止计时、不是陪客、还在进行中；
// 按座会话的续时方案在入座申请的套餐里，这里不给。
func renewalOf(q *txn, x *TableSession) *renewalPlan {
	if x.AdmissionID != "" || x.TimingMode != "timed" || x.UntilClose || x.StoppedAt != nil ||
		(x.Status != "active" && x.Status != "paused") {
		return nil
	}
	pkg, ok := tables.RenewalPlan(wholeTableTariff(q, x), x.DurationMinutes)
	if !ok {
		return nil
	}
	return &renewalPlan{Minutes: pkg.RenewalMinutes, AmountCents: pkg.RenewalCents, PackageName: pkg.Name}
}

// openSession 开台（员工）。
func (s *Server) openSession(w http.ResponseWriter, r *http.Request) {
	u, ok := s.staffMember(w, r)
	if !ok {
		return
	}
	q := s.tx(r)
	var in struct {
		TableID         string `json:"serviceTableId"`
		UserID          string `json:"accountId"`
		StartedAt       string `json:"startedAt"`
		TimingMode      string `json:"timingMode"`
		DurationMinutes int    `json:"durationMinutes"`
		// UntilClose 是开到当天打烊（「到打烊」的套餐）：不带时长，由服务器按开始时间算到打烊还有多久。
		UntilClose bool `json:"untilClose,omitempty"`
	}
	if e := decode(r, &in); e != nil {
		s.writeError(w, r, 400, "invalid_request", e)
		return
	}
	if in.UntilClose {
		if in.DurationMinutes != 0 || (in.TimingMode != "" && in.TimingMode != "timed") {
			s.writeError(w, r, 400, "invalid_session", errors.New("开到打烊不带时长，计时方式只能是定时"))
			return
		}
		// 先占个合法的时长过下面的核对，开始时间定了再换成到打烊的分钟数
		in.TimingMode, in.DurationMinutes = "timed", 1
	}
	// 开始时间可以省略：员工选「现在」时由服务器取当前时间，不看设备时钟（设备比服务器快一点就会被当成「晚于现在」）
	var started time.Time
	var e error
	if in.StartedAt != "" {
		started, e = parseTime(in.StartedAt)
	}
	if e != nil || in.TableID == "" || (in.TimingMode != "free" && in.TimingMode != "timed") || (in.TimingMode == "timed" && in.DurationMinutes < 1) || (in.TimingMode == "free" && in.DurationMinutes != 0) {
		if in.TimingMode == "" && in.DurationMinutes >= 1 {
			in.TimingMode = "timed"
		}
	}
	if e != nil || in.TableID == "" || (in.TimingMode != "free" && in.TimingMode != "timed") || (in.TimingMode == "timed" && in.DurationMinutes < 1) || (in.TimingMode == "free" && in.DurationMinutes != 0) {
		s.writeError(w, r, 400, "invalid_session", errors.New("serviceTableId and valid timingMode are required; startedAt, when given, must be RFC 3339"))
		return
	}
	if in.DurationMinutes > maxSessionMinutes {
		s.writeError(w, r, 400, "invalid_session", errors.New("时长必须在 1 分钟到 24 小时之间"))
		return
	}
	now := q.now()
	if in.StartedAt == "" {
		started = now
	}
	started, err := sessionStart(now, started, u)
	if err != nil {
		status, code := 400, "invalid_session"
		if !hasRole(u, Manager, Owner) && started.Before(now.Add(-60*time.Minute)) {
			status, code = 403, "backdated_start_forbidden"
		}
		s.writeError(w, r, status, code, err)
		return
	}
	if in.UntilClose {
		if in.DurationMinutes = q.reservationSettings().MinutesUntilClose(started); in.DurationMinutes < 1 {
			s.writeError(w, r, 409, "past_closing", errPastClose)
			return
		}
	}
	t := q.table(in.TableID)
	if t == nil || !t.Enabled {
		s.writeError(w, r, 404, "not_found", errNotFound)
		return
	}
	if in.UserID != "" && q.user(in.UserID) == nil {
		s.writeError(w, r, 404, "not_found", errNotFound)
		return
	}
	if len(q.liveSessionsOnTable(t.ID)) > 0 {
		s.writeError(w, r, 409, "table_occupied", errors.New("该桌位正在使用中"))
		return
	}
	if s.wholeTableReserved(q, t, started, in.DurationMinutes, in.UserID) {
		s.writeError(w, r, 409, "seat_reserved", errors.New("该桌在这个时间段已有预约，请先处理预约或更换桌位"))
		return
	}
	// 记下开台这一刻生效的价（2026-10-06 业主定）：之后老板改价发布不影响这一台，续时、改时长、标陪客都按它算
	tariff := tariffOf(q.membership().Rules())
	x := &TableSession{ID: id(), TableID: in.TableID, UserID: in.UserID, Status: "active", StartedAt: started, TimingMode: in.TimingMode, DurationMinutes: in.DurationMinutes, UntilClose: in.UntilClose, Tariff: &tariff}
	q.addSession(x)
	// 给有账户的顾客开台：他约过这个时段的话（不论约的哪张桌），那条预约算到店了（同扫码入座，见 reservationForSeating）。
	// 自由计时没有结束时间，同上面核对预约一样按开始后 120 分钟衡量。
	horizon := in.DurationMinutes
	if in.TimingMode == "free" {
		horizon = int(freeTimingHorizon / time.Minute)
	}
	if booked := s.reservationForSeating(q, t.ID, 0, in.UserID, started, horizon, now); booked != nil {
		booked.Status, booked.SessionID, booked.DecidedAt = "seated", x.ID, &now
		s.reservationNoticesAfter(q, booked, "")
	}
	writeJSON(w, 201, s.sessionOut(q, *x))
}

// sessionTarget 认出员工和网址里的计时会话：没登录 401，不是员工 403，会话不存在 404。
// 会员体验（入座申请开出的计时）只能在会员计时工作台操作，这里只给看，改动回 409。
func (s *Server) sessionTarget(w http.ResponseWriter, r *http.Request) (*User, *txn, *TableSession, bool) {
	u, ok := s.staffMember(w, r)
	if !ok {
		return nil, nil, nil, false
	}
	q := s.tx(r)
	sessionID := r.PathValue("id")
	if !validID(sessionID) {
		s.writeError(w, r, 404, "not_found", errNotFound)
		return nil, nil, nil, false
	}
	x := q.session(sessionID)
	if x == nil {
		s.writeError(w, r, 404, "not_found", errNotFound)
		return nil, nil, nil, false
	}
	if x.AdmissionID != "" && r.Method != "GET" {
		s.writeError(w, r, 409, "loyalty_conflict", errors.New("请从会员计时工作台操作此体验"))
		return nil, nil, nil, false
	}
	return u, q, x, true
}

// getSession 是一个计时会话（员工）。
func (s *Server) getSession(w http.ResponseWriter, r *http.Request) {
	_, q, x, ok := s.sessionTarget(w, r)
	if !ok {
		return
	}
	writeJSON(w, 200, s.sessionOut(q, *x))
}

// cancelSession 取消计时（员工）：已结算的不能取消。这一台的草稿订单同时作废。
func (s *Server) cancelSession(w http.ResponseWriter, r *http.Request) {
	u, q, x, ok := s.sessionTarget(w, r)
	if !ok {
		return
	}
	if x.Status == "settled" {
		s.writeError(w, r, 409, "session_settled", errors.New("已结算的会话不能取消"))
		return
	}
	if x.Status == "ended" {
		s.writeError(w, r, 409, "invalid_session_state", errEnded)
		return
	}
	if x.Status == "cancelled" {
		// 已经撤销过（上次结果没收到又点了一次）：原样成功，不重复记审计
		w.WriteHeader(204)
		return
	}
	// 分笔付款收了一部分的台不能撤销：钱已经收了，撤销会让这张单永远收不齐。收齐或对剩余免单后结清
	for _, o := range q.ordersOfSession(x.ID) {
		if o.Status == ordersdomain.StatusPartiallyPaid {
			s.writeError(w, r, 409, "partially_paid", fmt.Errorf("这一台的订单已经收了 ¥%s，不能撤销开台；把剩下的收齐或对剩余免单", yuanText(o.PaidCents)))
			return
		}
	}
	x.Status = "cancelled"
	// 取消的计时不再收费：留痕，对账时能看出谁取消了哪一台
	q.audit(u.ID, "venue_session.cancelled", x.ID, "开始于 "+x.StartedAt.In(storetime.Location).Format("01-02 15:04")+"，"+sessionTimingText(*x), requestID(r))
	// 已建好的草稿跟着作废：否则它永远挂在「待结账」里，会话已取消又收不了款。
	// 只动草稿；已付款的单不会落到这里（付款即结清会话，结清的会话上面已拒绝取消）。
	for _, o := range q.ordersOfSession(x.ID) {
		if o.Status == "draft" {
			o.Status = "voided"
			q.audit(u.ID, "order.voided", o.ID, "撤销开台，作废草稿（应收 ¥"+yuanText(o.ReceivableCents)+"）", requestID(r))
		}
	}
	w.WriteHeader(204)
}

// sessionUpdate 是改计时的响应：会话本身，加上这一台草稿订单跟着变了没有。
type sessionUpdate struct {
	sessionView
	// DraftOrder 只在改了计时（时长、计时方式、标记陪客）且这一台已有草稿订单时给出。
	DraftOrder *draftOrderNote `json:"draftOrder,omitempty"`
}

// draftOrderNote 告诉员工草稿订单有没有按新的计时改价：没改（员工改过明细）就要去结账页核对。
type draftOrderNote struct {
	ID              string `json:"id"`
	Repriced        bool   `json:"repriced"`
	ReceivableCents int64  `json:"receivableCents"`
}

// updateSession 改计时：暂停、继续、陪客、换桌、改开始时间、时长或计时方式、续时、停止计时（员工）。
//
// 续时用 extendMinutes（在 expectedDurationMinutes 这个员工看到的时长上追加），要带幂等键：
// 看到的时长已经变了就 409，同一个键重发只追加一次。旧写法 durationMinutes（读到的时长 + N
// 的绝对值）照样收，已上传的 0.0.12 小程序还在用。
//
// 停止计时（stop，2026-10-06 业主定，同按座会话）：要带幂等键、单独提交。停在这一刻，计价按停止时刻冻结（草稿的
// 计时明细当场按停止时刻重算存下），座位保留到结账；之后不能再暂停、继续、续时或改计时，换桌、撤销开台、去结账照旧。
// 暂停中的先结束暂停（暂停的时间照旧不计）；陪客不计时，不用停止。
//
// 结束（end，2026-10-10 业主定）：系统内收费关着时结束这一台并放座，同样要带幂等键、单独提交，见 session_end.go。
func (s *Server) updateSession(w http.ResponseWriter, r *http.Request) {
	u, q, x, ok := s.sessionTarget(w, r)
	if !ok {
		return
	}
	// 在副本上改，全部核对通过才写回：中途被拒的请求不留下半截修改（事务也会回滚，这里让读起来更清楚）。
	previous := x
	candidate := *x
	x = &candidate
	var in struct {
		TableID                 string  `json:"serviceTableId"`
		StartedAt               string  `json:"startedAt"`
		TimingMode              *string `json:"timingMode"`
		DurationMinutes         *int    `json:"durationMinutes"`
		ExtendMinutes           *int    `json:"extendMinutes,omitempty"`
		ExpectedDurationMinutes *int    `json:"expectedDurationMinutes,omitempty"`
		Status                  string  `json:"status"`
		// Stop 停止计时。omitempty：不带它的请求算出的幂等指纹和以前一样（滚动发布时新旧版本认同一个键）。
		Stop *bool `json:"stop,omitempty"`
		// End 结束并放座（系统内收费关着时）。omitempty 的用意同 Stop。
		End *bool `json:"end,omitempty"`
	}
	if e := decode(r, &in); e != nil {
		s.writeError(w, r, 400, "invalid_request", e)
		return
	}
	// 幂等：带了键就按「操作者 + 会话 + 键」记下结果，同键同内容重放、同键不同内容 409。
	// 旧版小程序一直带着键，旧网页后台不带；不带键的旧写法照旧执行，追加分钟数必须带。
	key := idemKey(r)
	fingerprintBytes, _ := json.Marshal(in)
	fingerprint := identityKey(string(fingerprintBytes))
	cacheKey := "venue-session:" + u.ID + ":" + previous.ID + ":" + key
	if key != "" {
		if cached := q.idemGet(cacheKey); cached != nil {
			if cached.Fingerprint != fingerprint {
				s.writeError(w, r, 409, "idempotency_conflict", errors.New("key already used for a different request"))
				return
			}
			w.Header().Set("Content-Type", cached.ContentType)
			w.WriteHeader(cached.Status)
			_, _ = w.Write(cached.Body)
			return
		}
	}
	if in.ExtendMinutes != nil {
		if key == "" {
			s.writeError(w, r, 400, "idempotency_required", errors.New("Idempotency-Key is required"))
			return
		}
		if in.ExpectedDurationMinutes == nil || in.DurationMinutes != nil {
			s.writeError(w, r, 400, "invalid_session", errors.New("续时要带上看到的当前时长（expectedDurationMinutes），且不能同时改时长"))
			return
		}
		if *in.ExtendMinutes < 1 || *in.ExtendMinutes > maxSessionMinutes {
			s.writeError(w, r, 400, "invalid_session", errors.New("续时必须在 1 分钟到 24 小时之间"))
			return
		}
	}
	timingChange := in.StartedAt != "" || in.TimingMode != nil || in.DurationMinutes != nil || in.ExtendMinutes != nil || in.Status != ""
	if in.Stop != nil {
		if !*in.Stop {
			s.writeError(w, r, 400, "invalid_session", errors.New("stop 只能为 true"))
			return
		}
		if key == "" {
			s.writeError(w, r, 400, "idempotency_required", errors.New("Idempotency-Key is required"))
			return
		}
		if timingChange || in.TableID != "" || in.ExpectedDurationMinutes != nil {
			s.writeError(w, r, 400, "invalid_session", errors.New("停止计时要单独提交，不能和其他修改一起"))
			return
		}
	}
	if in.End != nil {
		if !*in.End {
			s.writeError(w, r, 400, "invalid_session", errors.New("end 只能为 true"))
			return
		}
		if key == "" {
			s.writeError(w, r, 400, "idempotency_required", errors.New("Idempotency-Key is required"))
			return
		}
		if timingChange || in.TableID != "" || in.ExpectedDurationMinutes != nil || in.Stop != nil {
			s.writeError(w, r, 400, "invalid_session", errors.New("结束要单独提交，不能和其他修改一起"))
			return
		}
	}
	if !liveSession(x) {
		s.writeError(w, r, 409, "invalid_session_state", errors.New("该会话已结束"))
		return
	}
	if in.End != nil {
		if err := s.endSession(q, u, requestID(r), x); err != nil {
			status, code := 409, "invalid_session_state"
			var refusal loyaltyRefusal
			if errors.As(err, &refusal) {
				status, code = refusal.status, refusal.code
			}
			s.writeError(w, r, status, code, err)
			return
		}
		*previous = *x
		body, _ := json.Marshal(sessionUpdate{sessionView: s.sessionOut(q, *x)})
		body = append(body, '\n')
		q.rememberIdem(cacheKey, idemResponse{Fingerprint: fingerprint, Status: 200, ContentType: "application/json", Body: body})
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(200)
		_, _ = w.Write(body)
		return
	}
	// 停止计时后计价冻结在停止那一刻（同按座会话）：不能再停一次，也不能再暂停、继续、续时或改计时；换桌照旧
	if previous.StoppedAt != nil && in.Stop != nil {
		s.writeError(w, r, 409, "invalid_session_state", errors.New("已停止计时"))
		return
	}
	if previous.StoppedAt != nil && timingChange {
		s.writeError(w, r, 409, "invalid_session_state", errors.New("计时已停止，不能再暂停、继续、续时或改计时；要改金额请到结账页改明细"))
		return
	}
	// 开到打烊的台用到打烊为止（同「到打烊」的套餐）：不能暂停、续时、改时长或计时方式；改开始时间时时长跟着重算到打烊。
	// 也不能标陪客：陪客不计时、改按陪客费收，等于改计时方式；按座的「到打烊」本来就没有陪客（2026-10-11 定）
	if previous.UntilClose && (in.Status == "paused" || in.Status == "companion" || in.ExtendMinutes != nil || in.DurationMinutes != nil || in.TimingMode != nil) {
		s.writeError(w, r, 409, "invalid_session_state", errors.New("这一台开到打烊，用到打烊为止：不能暂停、续时、标陪客，也不能改时长或计时方式；标错了请撤销开台后重新开台"))
		return
	}
	if in.Stop != nil {
		if x.Status == "companion" {
			s.writeError(w, r, 409, "invalid_session_state", errors.New("陪客不计时，不用停止计时，直接去结账"))
			return
		}
		now := q.now()
		if x.Status == "paused" {
			x.Transition("active", now)
		}
		x.StoppedAt = &now
		q.audit(u.ID, "venue_session.stopped", x.ID, fmt.Sprintf("开始于 %s，%s，停止时已用 %d 分钟（不含暂停）",
			x.StartedAt.In(storetime.Location).Format("01-02 15:04"), sessionTimingText(*x), x.UsedSeconds(now, -1)/60), requestID(r))
	}
	// 员工确认时看到的时长：已经不是这个数（别人刚续过、页面过期）就拒绝，看过新状态再确认
	if in.ExpectedDurationMinutes != nil && (previous.TimingMode == "free" || previous.DurationMinutes != *in.ExpectedDurationMinutes) {
		current := "现在是自由计时"
		if previous.TimingMode != "free" {
			current = fmt.Sprintf("现在是 %d 分钟", previous.DurationMinutes)
		}
		s.writeError(w, r, 409, "session_conflict", fmt.Errorf("这一台的计时刚被改过，%s，请核对后再续时", current))
		return
	}
	if in.TimingMode != nil {
		if *in.TimingMode != "free" && *in.TimingMode != "timed" {
			s.writeError(w, r, 400, "invalid_session", errors.New("计时方式无效"))
			return
		}
		x.TimingMode = *in.TimingMode
		if x.TimingMode == "free" {
			x.DurationMinutes = 0
		}
	}
	if in.TableID != "" && in.TableID != x.TableID {
		t := q.table(in.TableID)
		if t == nil || !t.Enabled {
			s.writeError(w, r, 404, "not_found", errNotFound)
			return
		}
		for _, z := range q.liveSessionsOnTable(in.TableID) {
			if z.ID != x.ID {
				s.writeError(w, r, 409, "table_occupied", errors.New("目标桌位正在使用中"))
				return
			}
		}
		x.TableID = in.TableID
	}
	if in.StartedAt != "" {
		t, e := parseTime(in.StartedAt)
		if e != nil {
			s.writeError(w, r, 400, "invalid_session", e)
			return
		}
		t, e = sessionStart(q.now(), t, u)
		if e != nil {
			s.writeError(w, r, 400, "invalid_session", e)
			return
		}
		x.StartedAt = t
		if x.UntilClose {
			if x.DurationMinutes = q.reservationSettings().MinutesUntilClose(t); x.DurationMinutes < 1 {
				s.writeError(w, r, 400, "invalid_session", errPastClose)
				return
			}
		}
	}
	if in.DurationMinutes != nil {
		if x.TimingMode == "free" {
			s.writeError(w, r, 400, "invalid_session", errors.New("自由计时不能设置时长"))
			return
		}
		if *in.DurationMinutes < 1 || *in.DurationMinutes > maxSessionMinutes {
			s.writeError(w, r, 400, "invalid_session", errors.New("时长必须在 1 分钟到 24 小时之间"))
			return
		}
		x.DurationMinutes = *in.DurationMinutes
	}
	if in.ExtendMinutes != nil {
		if x.TimingMode == "free" {
			s.writeError(w, r, 400, "invalid_session", errors.New("自由计时没有时长，不能续时"))
			return
		}
		if x.DurationMinutes+*in.ExtendMinutes > maxSessionMinutes {
			s.writeError(w, r, 400, "invalid_session", errors.New("时长必须在 1 分钟到 24 小时之间"))
			return
		}
		x.DurationMinutes += *in.ExtendMinutes
	}
	if in.Status != "" {
		if in.Status != "active" && in.Status != "paused" && in.Status != "companion" {
			s.writeError(w, r, 400, "invalid_session", errors.New("会话状态无效"))
			return
		}
		if err := x.ChangeStatus(in.Status, q.now()); err != nil {
			s.writeError(w, r, 409, "invalid_session_state", err)
			return
		}
	}
	// 换过去的桌同样要避开预约：直接在那张桌开台会被拒，先开别的桌再换过去也得被拒。
	if x.TableID != previous.TableID && s.wholeTableReserved(q, q.table(x.TableID), q.now(), x.DurationMinutes, x.UserID) {
		s.writeError(w, r, 409, "seat_reserved", errors.New("目标桌在这个时间段已有预约，请先处理预约或更换桌位"))
		return
	}
	// 续时、改时长、改开始时间让这一台坐得更久：新增的那段时间同样不能压到别人的预约
	if x.TableID == previous.TableID {
		now := q.now()
		before, after := wholeTableUntil(q, previous, now), wholeTableUntil(q, x, now)
		if after.After(before) {
			from := before
			if from.Before(now) {
				from = now
			}
			if hold := s.wholeTableHold(q, q.table(x.TableID), from, after, x.UserID); hold != nil {
				s.writeError(w, r, 409, "seat_reserved", fmt.Errorf("这样会坐到 %s，压到%s：请先处理那个预约，或少续一些", after.In(storetime.Location).Format("15:04"), s.reservationText(q, hold)))
				return
			}
		}
	}
	// 改开始时间、时长或计时方式会改应收：留痕（暂停、继续、换桌是日常操作，不记）
	if !previous.StartedAt.Equal(x.StartedAt) || previous.DurationMinutes != x.DurationMinutes || previous.TimingMode != x.TimingMode {
		q.audit(u.ID, "venue_session.timing_changed", x.ID, fmt.Sprintf("开始 %s → %s，%s → %s",
			previous.StartedAt.In(storetime.Location).Format("15:04"), x.StartedAt.In(storetime.Location).Format("15:04"), sessionTimingText(*previous), sessionTimingText(*x)), requestID(r))
	}
	out := sessionUpdate{sessionView: s.sessionOut(q, *x)}
	// 计时变了（续时、改时长或计时方式、标记陪客），已建好的草稿跟着变：见 followDraft
	if previous.DurationMinutes != x.DurationMinutes || previous.TimingMode != x.TimingMode || (previous.Status == "companion") != (x.Status == "companion") {
		out.DraftOrder = s.followDraft(q, u, r, *previous, *x)
	}
	*previous = *x
	if in.Stop != nil {
		// 计价冻结在停止那一刻：草稿开头系统生成的计时明细（超时加收、自由计时的块数）按停止时刻重算一次，随请求存下
		q.ordersOfSession(previous.ID)
	}
	body, _ := json.Marshal(out)
	body = append(body, '\n')
	if key != "" {
		q.rememberIdem(cacheKey, idemResponse{Fingerprint: fingerprint, Status: 200, ContentType: "application/json", Body: body})
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(200)
	_, _ = w.Write(body)
}

// followDraft 让这一台的草稿订单跟上新的计时（续时、改时长或计时方式、标记陪客）。
//
// 以前草稿只在第一次建单时按计时生成明细，之后续时、改时长都不碰它：开 60 分钟建了 ¥29.90 的
// 草稿，续时 30 分钟再去收款，还是 ¥29.90。现在草稿开头那几行仍是系统生成的计时明细（AutoLines，员工没改过）
// 时，按新的计时换掉这几行、重算应收（含超时加收、自由计时价、陪客费），订单版本随之变化，拿着旧版本的
// 结账页收款会被拦下重读；员工加在后面的商品照留。计时行被员工改过就不动，告诉员工去结账页核对。
// 0.0.18 及更早建的草稿没有 AutoLines：开头几行和建单时按原计时生成的一样，就算系统生成的。
func (s *Server) followDraft(q *txn, u *User, r *http.Request, previous, current TableSession) *draftOrderNote {
	for _, o := range q.ordersOfSession(current.ID) {
		if o.Status != "draft" {
			continue
		}
		note := &draftOrderNote{ID: o.ID, ReceivableCents: o.ReceivableCents}
		var n int
		if o.AutoLines != nil {
			n = *o.AutoLines
		} else {
			generated := sessionLines(&previous, wholeTableTariff(q, &previous), o.CreatedAt)
			if len(generated) > 0 && len(o.Lines) >= len(generated) && slices.Equal(o.Lines[:len(generated)], generated) {
				n = len(generated)
			}
		}
		if n <= 0 || n > len(o.Lines) {
			return note
		}
		lines := chargeLines(s.sessionCharge(q, &current))
		if len(lines) == 0 {
			return note
		}
		candidate, ok := withAutoLines(*o, n, lines)
		if !ok {
			return note
		}
		before := o.ReceivableCents
		*o = candidate
		q.audit(u.ID, "order.lines.repriced", o.ID, fmt.Sprintf("计时改为%s，应收 ¥%s → ¥%s", sessionTimingText(current), yuanText(before), yuanText(o.ReceivableCents)), requestID(r))
		note.Repriced, note.ReceivableCents = true, o.ReceivableCents
		return note
	}
	return nil
}

// wholeTableUntil 是整桌会话会坐到什么时候：定时的就是 sessionEndsAt（桌位视图的 endsAt、现场挡预约同一套算法）；
// 自由计时没有结束时间，和开台时（wholeTableReserved）一样按开始后 120 分钟衡量。
func wholeTableUntil(q *txn, x *TableSession, now time.Time) time.Time {
	if ends, ok := sessionEndsAt(q, x, now); ok {
		return ends
	}
	return x.StartedAt.Add(freeTimingHorizon)
}

// wholeTableHold 是 [start, end) 里压在这张桌任何一个座上的别人的预约（整桌会话占满所有座号），没有返回 nil。
func (s *Server) wholeTableHold(q *txn, t *Table, start, end time.Time, account string) *Reservation {
	for seat := 1; seat <= t.SeatCount; seat++ {
		if hold := s.reservationHold(q, t.ID, seat, start, end, account); hold != nil {
			return hold
		}
	}
	return nil
}

// wholeTableReserved 报告从 start 起的整桌会话会不会压到别人的预约。整桌会话占满
// 所有座号，所以任何一个座有预约都算；自由计时没有终点，按默认 120 分钟衡量。
// account 自己的预约不算冲突。
func (s *Server) wholeTableReserved(q *txn, t *Table, start time.Time, minutes int, account string) bool {
	horizon := time.Duration(minutes) * time.Minute
	if minutes < 1 {
		horizon = freeTimingHorizon
	}
	return s.wholeTableHold(q, t, start, start.Add(horizon), account) != nil
}

// freeTimingHorizon 是自由计时的整桌会话核对预约时假定会坐多久（自由计时没有结束时间）。
const freeTimingHorizon = 120 * time.Minute

// sessionTimingText 是审计里写的计时方式：自由计时或定时多少分钟。
func sessionTimingText(x TableSession) string {
	if x.TimingMode == "free" {
		return "自由计时"
	}
	return fmt.Sprintf("定时 %d 分钟", x.DurationMinutes)
}
