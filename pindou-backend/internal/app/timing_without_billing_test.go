package app

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	member "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/membership/application"
	reserve "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/reservations/domain"
	"github.com/yreidev/pindou-studio/pindou-backend/internal/storetime"
)

// 暂不在系统内收费（docs/plan-timing-without-billing.md）：钱都在美团、大众点评收，系统内收费关着时确认入座、到店开台
// 不建单，店员点「结束」放座；套餐可以不定价、可以用到打烊；预约和入座能记团购记录；所有员工能手动加减储值和积分。

type timingShop struct {
	s                               *Server
	now                             *time.Time
	owner, clerk, customer, another sessionResponse
	seats, whole                    *Table // 散座桌（两个座）与整桌
	pack                            member.Rule
}

func newTimingShop(t *testing.T) *timingShop {
	t.Helper()
	now := time.Date(2026, 10, 11, 14, 0, 0, 0, storetime.Location)
	f := &timingShop{s: newTestServer(t), now: &now}
	f.s.now = func() time.Time { return *f.now }
	f.owner = register(t, f.s, "timing-owner", "老板")
	if err := f.s.BootstrapOwner(f.owner.User.ID); err != nil {
		t.Fatal(err)
	}
	f.clerk = register(t, f.s, "timing-clerk", "店员")
	setRoles(t, f.s, f.clerk.User.ID, Clerk)
	f.customer = register(t, f.s, "timing-customer", "小林")
	f.another = register(t, f.s, "timing-another", "小周")
	f.seats = seedTable(t, f.s, "B1", "B 区", 1, 2, false)
	f.whole = seedTable(t, f.s, "A1", "A 区", 1, 4, true)
	f.pack = publishRule(t, f.s, f.owner.AccessToken, member.Rule{Kind: "package", Name: "两小时", AmountCents: 5900, DurationMinutes: 120, PauseLimitMinutes: 30, Overtime: "manual"})
	return f
}

// at 把时钟拨到当天（门店时区）hh:mm。
func (f *timingShop) at(hour, minute int) {
	*f.now = time.Date(2026, 10, 11, hour, minute, 0, 0, storetime.Location)
}

// request 是顾客扫码申请 B1 桌的座位，返回申请。
func (f *timingShop) request(t *testing.T, customer sessionResponse, pack string, seat int, coupon *reserve.Coupon) map[string]any {
	t.Helper()
	return loyaltyOK(t, f.s, customer.AccessToken, loyaltyInput{Action: "request", TargetID: pack, TableID: f.seats.ID, SeatNumber: seat, Coupon: coupon})
}

// seat 是顾客扫码申请、店员确认，返回申请与开出的会话。
func (f *timingShop) seat(t *testing.T, customer sessionResponse, seat int) (map[string]any, string) {
	t.Helper()
	request := f.request(t, customer, f.pack.ID, seat, nil)
	confirmed := loyaltyOK(t, f.s, f.clerk.AccessToken, loyaltyInput{Action: "confirm", TargetID: request["id"].(string)})
	return confirmed, confirmed["venueSessionId"].(string)
}

// end 是店员在按座会话上点「结束」。
func (f *timingShop) end(t *testing.T, bearer, session string) *httptest.ResponseRecorder {
	t.Helper()
	return loyaltyCall(t, f.s, bearer, loyaltyInput{Action: "end", TargetID: session, ExpectedVersion: member.Version(sessionOf(t, f.s, session))})
}

// openWhole 是员工给整桌开台，返回会话。
func (f *timingShop) openWhole(t *testing.T, body map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	body["serviceTableId"] = f.whole.ID
	return call(t, f.s, http.MethodPost, "/api/v2/venue-sessions", f.clerk.AccessToken, "", body)
}

func (f *timingShop) billing(t *testing.T) map[string]any {
	t.Helper()
	w := call(t, f.s, http.MethodGet, "/api/v2/system/billing-settings", "", "", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("读收费开关：%d %s", w.Code, w.Body.String())
	}
	return decodeMap(t, w)
}

func wantCode(t *testing.T, label string, w *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	if w.Code != status || (code != "" && decodeMap(t, w)["code"] != code) {
		t.Fatalf("%s：要 %d %s，实际 %d %s", label, status, code, w.Code, w.Body.String())
	}
}

func TestBillingSwitchIsOwnerOnlyAndAudited(t *testing.T) {
	f := newTimingShop(t)
	manager := register(t, f.s, "timing-manager", "店长")
	setRoles(t, f.s, manager.User.ID, Manager)
	if got := f.billing(t); got["enabled"] != false || got["updatedAt"] != nil {
		t.Fatalf("老板没设置过时按关：%v", got)
	}
	patch := func(bearer string, body map[string]any) *httptest.ResponseRecorder {
		return call(t, f.s, http.MethodPatch, "/api/v2/system/billing-settings", bearer, "", body)
	}
	turnOn := map[string]any{"enabled": true, "expectedEnabled": false, "reason": "开始在系统内收款"}
	before := f.s.snapshotData()
	for _, c := range []struct {
		label  string
		bearer string
		body   map[string]any
		status int
		code   string
	}{
		{"没登录", "", turnOn, 401, "unauthorized"},
		{"店员", f.clerk.AccessToken, turnOn, 403, "forbidden"},
		{"店长", manager.AccessToken, turnOn, 403, "forbidden"},
		{"没写原因", f.owner.AccessToken, map[string]any{"enabled": true, "expectedEnabled": false, "reason": "  "}, 400, "invalid_request"},
		{"原因太长", f.owner.AccessToken, map[string]any{"enabled": true, "expectedEnabled": false, "reason": strings.Repeat("长", 201)}, 400, "invalid_request"},
		{"没带开关", f.owner.AccessToken, map[string]any{"expectedEnabled": false, "reason": "x"}, 400, "invalid_request"},
		{"没带读到的状态", f.owner.AccessToken, map[string]any{"enabled": true, "reason": "x"}, 400, "invalid_request"},
		{"页面过期", f.owner.AccessToken, map[string]any{"enabled": false, "expectedEnabled": true, "reason": "x"}, 409, "billing_settings_conflict"},
	} {
		wantCode(t, c.label, patch(c.bearer, c.body), c.status, c.code)
	}
	if !bytes.Equal(before, f.s.snapshotData()) {
		t.Fatal("被拒的请求改了数据")
	}

	w := patch(f.owner.AccessToken, turnOn)
	if w.Code != http.StatusOK || decodeMap(t, w)["enabled"] != true || decodeMap(t, w)["updatedAt"] == nil {
		t.Fatalf("老板打开：%d %s", w.Code, w.Body.String())
	}
	if got := f.billing(t); got["enabled"] != true {
		t.Fatalf("所有人读到的都是开：%v", got)
	}
	toggles := auditsWithAction(t, f.s, "billing.toggled")
	if len(toggles) != 1 || toggles[0].ActorID != f.owner.User.ID || toggles[0].Reason != "关 → 开：开始在系统内收款" {
		t.Fatalf("开关要记审计（谁、从什么改成什么、原因）：%+v", toggles)
	}
	// 没变化（重放、两个页面先后点同一个）不再记审计
	wantCode(t, "没变化", patch(f.owner.AccessToken, map[string]any{"enabled": true, "expectedEnabled": true, "reason": "再点一次"}), 200, "")
	if len(auditsWithAction(t, f.s, "billing.toggled")) != 1 {
		t.Fatal("没变化不该记审计")
	}
	wantCode(t, "关掉", patch(f.owner.AccessToken, map[string]any{"enabled": false, "expectedEnabled": true, "reason": "钱还是走团购"}), 200, "")
	if f.billing(t)["enabled"] != false || auditsWithAction(t, f.s, "billing.toggled")[1].Reason != "开 → 关：钱还是走团购" {
		t.Fatal("关掉没生效或没记审计")
	}
}

// 收费关着：确认入座不建单、看板不报价；店员点「结束」就结束计时、放出座位，记审计。
func TestEndingASeatFreesItWithoutAnOrder(t *testing.T) {
	f := newTimingShop(t)
	confirmed, session := f.seat(t, f.customer, 1)
	if confirmed["status"] != "confirmed" || len(ordersOf(t, f.s)) != 0 {
		t.Fatalf("收费关着时确认入座不建单：%v %d", confirmed["status"], len(ordersOf(t, f.s)))
	}
	view := tableViewOf(t, f.s, f.seats.ID)
	if _, present := view["estimatedCents"]; present {
		t.Fatalf("收费关着时桌位不报价：%v", view)
	}
	if _, present := view["charge"]; present {
		t.Fatalf("收费关着时桌位没有计费明细：%v", view)
	}

	f.at(15, 10)
	wantCode(t, "顾客自己结束", f.end(t, f.customer.AccessToken, session), 403, "forbidden")
	wantCode(t, "版本过期", loyaltyCall(t, f.s, f.clerk.AccessToken, loyaltyInput{Action: "end", TargetID: session, ExpectedVersion: "stale"}), 409, "loyalty_conflict")
	w := f.end(t, f.clerk.AccessToken, session)
	if w.Code != http.StatusOK {
		t.Fatalf("店员结束：%d %s", w.Code, w.Body.String())
	}
	out := decodeMap(t, w)["session"].(map[string]any)
	x := sessionOf(t, f.s, session)
	if out["status"] != "ended" || x.Status != "ended" || x.StoppedAt == nil || !x.StoppedAt.Equal(*f.now) {
		t.Fatalf("结束后状态是 ended、计时停在这一刻：%v %+v", out["status"], x)
	}
	ended := auditsWithAction(t, f.s, "venue_session.ended")
	if len(ended) != 1 || ended[0].ActorID != f.clerk.User.ID || ended[0].ObjectID != session || !strings.Contains(ended[0].Reason, "已用 70 分钟") {
		t.Fatalf("结束要记审计（谁、哪一台、用了多久）：%+v", ended)
	}
	wantCode(t, "再结束一次", f.end(t, f.clerk.AccessToken, session), 409, "loyalty_conflict")
	wantCode(t, "结束了再建单", call(t, f.s, http.MethodPost, "/api/v2/sales-orders", f.clerk.AccessToken, id(), map[string]any{"venueSessionId": session}), 409, "session_closed")
	if mine := decodeMap(t, call(t, f.s, http.MethodGet, "/api/v2/loyalty/account", f.customer.AccessToken, "", nil)); mine == nil {
		t.Fatal("顾客读自己的会员页")
	}
	// 座位放出来了：另一位顾客能马上坐这个座，原来的顾客也能再来
	if _, again := f.seat(t, f.another, 1); sessionOf(t, f.s, again).Status != "active" {
		t.Fatal("结束后座位没放出来")
	}
	f.seat(t, f.customer, 2)
}

// 开关打开之前建的草稿单在结束时作废；收过一部分钱的不能结束；收费开着时结束被拒（要去结账）。
func TestEndRespectsDraftsPartialPaymentsAndTheSwitch(t *testing.T) {
	f := newTimingShop(t)
	enableBilling(t, f.s, f.owner.User.ID)
	_, seat := f.seat(t, f.customer, 1)
	draft := orderOfSession(t, f.s, seat)
	if draft == nil || draft.Status != "draft" || draft.ReceivableCents != 5900 {
		t.Fatalf("收费开着时确认入座照旧建草稿单：%+v", draft)
	}
	wantCode(t, "收费开着时结束", f.end(t, f.clerk.AccessToken, seat), 409, "billing_enabled")

	// 整桌散客先收一部分钱（分笔付款）
	w := f.openWhole(t, map[string]any{"timingMode": "timed", "durationMinutes": 120})
	if w.Code != http.StatusCreated {
		t.Fatalf("整桌开台：%d %s", w.Code, w.Body.String())
	}
	whole := decodeMap(t, w)["id"].(string)
	created := call(t, f.s, http.MethodPost, "/api/v2/sales-orders", f.clerk.AccessToken, id(), map[string]any{"venueSessionId": whole})
	if created.Code != http.StatusCreated {
		t.Fatalf("整桌建单：%d %s", created.Code, created.Body.String())
	}
	order := orderOf(t, f.s, decodeMap(t, created)["id"].(string))
	if order.ReceivableCents <= 1000 {
		t.Fatalf("整桌单要有应收：%+v", order)
	}
	pay := call(t, f.s, http.MethodPost, "/api/v2/sales-orders/"+order.ID+"/payments", f.clerk.AccessToken, id(),
		map[string]any{"expectedVersion": order.Version(), "method": "cash", "amountCents": 1000})
	if pay.Code != http.StatusCreated || orderOf(t, f.s, order.ID).Status != "partially_paid" {
		t.Fatalf("收一部分：%d %s", pay.Code, pay.Body.String())
	}
	edit(t, f.s, func(q *txn) { q.saveBilling(false, f.owner.User.ID) })

	f.at(14, 30)
	if w := f.end(t, f.clerk.AccessToken, seat); w.Code != http.StatusOK {
		t.Fatalf("开关关掉后能结束：%d %s", w.Code, w.Body.String())
	}
	if got := orderOf(t, f.s, draft.ID); got.Status != "voided" {
		t.Fatalf("开关打开之前建的草稿单要作废：%s", got.Status)
	}
	voided := auditsWithAction(t, f.s, "order.voided")
	if len(voided) != 1 || voided[0].ObjectID != draft.ID || !strings.Contains(voided[0].Reason, "结束计时") {
		t.Fatalf("作废草稿要记审计：%+v", voided)
	}
	before := f.s.snapshotData()
	wantCode(t, "收过一部分钱", call(t, f.s, http.MethodPatch, "/api/v2/venue-sessions/"+whole, f.clerk.AccessToken, id(), map[string]any{"end": true}), 409, "partially_paid")
	if !bytes.Equal(before, f.s.snapshotData()) || sessionOf(t, f.s, whole).Status != "active" {
		t.Fatal("被拒的结束改了数据")
	}
}

// 整桌会话走 PATCH /venue-sessions/{id} 的 end：要幂等键、单独提交，重放拿到同样的结果；结束后不能撤销，桌位放出来。
func TestEndingAWholeTableSession(t *testing.T) {
	f := newTimingShop(t)
	w := f.openWhole(t, map[string]any{"timingMode": "timed", "durationMinutes": 120})
	if w.Code != http.StatusCreated {
		t.Fatalf("整桌开台：%d %s", w.Code, w.Body.String())
	}
	session := decodeMap(t, w)["id"].(string)
	path := "/api/v2/venue-sessions/" + session
	patch := func(key string, body map[string]any) *httptest.ResponseRecorder {
		return call(t, f.s, http.MethodPatch, path, f.clerk.AccessToken, key, body)
	}
	wantCode(t, "没带幂等键", patch("", map[string]any{"end": true}), 400, "idempotency_required")
	wantCode(t, "end 为 false", patch(id(), map[string]any{"end": false}), 400, "invalid_session")
	wantCode(t, "和停止计时一起", patch(id(), map[string]any{"end": true, "stop": true}), 400, "invalid_session")
	wantCode(t, "和改时长一起", patch(id(), map[string]any{"end": true, "expectedDurationMinutes": 120, "durationMinutes": 180}), 400, "invalid_session")

	f.at(15, 0)
	key := id()
	one := patch(key, map[string]any{"end": true})
	if one.Code != http.StatusOK || decodeMap(t, one)["status"] != "ended" {
		t.Fatalf("结束整桌：%d %s", one.Code, one.Body.String())
	}
	f.at(15, 5)
	if two := patch(key, map[string]any{"end": true}); two.Code != http.StatusOK || two.Body.String() != one.Body.String() {
		t.Fatalf("同键重放要拿到同样的结果：%d %s", two.Code, two.Body.String())
	}
	if x := sessionOf(t, f.s, session); x.Status != "ended" || !x.StoppedAt.Equal(time.Date(2026, 10, 11, 15, 0, 0, 0, storetime.Location)) {
		t.Fatalf("计时停在结束那一刻：%+v", x)
	}
	wantCode(t, "再结束一次", patch(id(), map[string]any{"end": true}), 409, "invalid_session_state")
	wantCode(t, "结束了再撤销", call(t, f.s, http.MethodDelete, path, f.clerk.AccessToken, "", nil), 409, "invalid_session_state")
	if w := f.openWhole(t, map[string]any{"timingMode": "free"}); w.Code != http.StatusCreated {
		t.Fatalf("结束后桌位放出来：%d %s", w.Code, w.Body.String())
	}

	// 收费开着：整桌也要去结账
	enableBilling(t, f.s, f.owner.User.ID)
	live := sessionsOf(t, f.s)
	var open string
	for _, x := range live {
		if liveSession(x) {
			open = x.ID
		}
	}
	wantCode(t, "收费开着时结束整桌", call(t, f.s, http.MethodPatch, "/api/v2/venue-sessions/"+open, f.clerk.AccessToken, id(), map[string]any{"end": true}), 409, "billing_enabled")
}

// 预约到店开台：收费关着不建单，开着照旧建草稿单。
func TestReservationSeatingFollowsTheSwitch(t *testing.T) {
	f := newTimingShop(t)
	start := time.Date(2026, 10, 11, 16, 0, 0, 0, storetime.Location)
	book := func(customer sessionResponse, seat int) string {
		t.Helper()
		out := reservationOK(t, f.s, f.clerk.AccessToken, reservationInput{Action: "register", AccountID: customer.User.ID, TableID: f.seats.ID, SeatNumber: seat, PackageID: f.pack.ID, StartAt: start.Format(time.RFC3339)})
		return out["targetId"].(string)
	}
	off, on := book(f.customer, 1), book(f.another, 2)
	f.at(16, 0)
	reservationOK(t, f.s, f.clerk.AccessToken, reservationInput{Action: "seat", TargetID: off})
	if len(ordersOf(t, f.s)) != 0 || reservationOf(t, f.s, off).Status != "seated" {
		t.Fatal("收费关着时到店开台不建单")
	}
	enableBilling(t, f.s, f.owner.User.ID)
	reservationOK(t, f.s, f.clerk.AccessToken, reservationInput{Action: "seat", TargetID: on})
	if order := orderOfSession(t, f.s, reservationOf(t, f.s, on).SessionID); order == nil || order.Status != "draft" {
		t.Fatalf("收费开着时到店开台建草稿单：%+v", order)
	}
}

// 套餐可以不定价（收费关着时）；「到打烊」的套餐不填时长，开台、预约都算到当天打烊。
func TestUnpricedAndUntilClosePackages(t *testing.T) {
	f := newTimingShop(t)
	for _, c := range []struct {
		label string
		rule  member.Rule
	}{
		{"到打烊还填时长", member.Rule{Kind: "package", Name: "全天", UntilClose: true, DurationMinutes: 60, Overtime: "manual"}},
		{"到打烊还能续时", member.Rule{Kind: "package", Name: "全天", UntilClose: true, RenewalMinutes: 30, RenewalCents: 1000, Overtime: "manual"}},
		{"到打烊还能暂停", member.Rule{Kind: "package", Name: "全天", UntilClose: true, PauseLimitMinutes: 10, Overtime: "manual"}},
		{"定时套餐没填时长", member.Rule{Kind: "package", Name: "没时长", Overtime: "manual"}},
	} {
		wantCode(t, c.label, loyaltyCall(t, f.s, f.owner.AccessToken, loyaltyInput{Action: "save_rule", Rule: c.rule}), 409, "loyalty_conflict")
	}
	allDay := publishRule(t, f.s, f.owner.AccessToken, member.Rule{Kind: "package", Name: "全天", UntilClose: true, Overtime: "manual"})
	free := publishRule(t, f.s, f.owner.AccessToken, member.Rule{Kind: "package", Name: "一小时", DurationMinutes: 60, Overtime: "manual"})
	preview := loyaltyOK(t, f.s, f.owner.AccessToken, loyaltyInput{Action: "preview_rule", Rule: allDay})["preview"].(string)
	if !strings.Contains(preview, "打烊") || !strings.Contains(preview, "未定价") {
		t.Fatalf("计算示例要说明到打烊、未定价：%s", preview)
	}

	// 20:30 扫码、确认：门店默认 22:00 打烊，用 90 分钟
	f.at(20, 30)
	request := f.request(t, f.customer, allDay.ID, 1, nil)
	confirmed := loyaltyOK(t, f.s, f.clerk.AccessToken, loyaltyInput{Action: "confirm", TargetID: request["id"].(string)})
	seat := confirmed["venueSessionId"].(string)
	if x := sessionOf(t, f.s, seat); x.DurationMinutes != 90 || x.TimingMode != "timed" || !x.UntilClose {
		t.Fatalf("到打烊的套餐从确认这一刻算到打烊：%+v", x)
	}
	for _, action := range []string{"pause", "renew"} {
		wantCode(t, "到打烊的套餐 "+action, loyaltyCall(t, f.s, f.clerk.AccessToken, loyaltyInput{Action: action, TargetID: seat, ExpectedVersion: member.Version(sessionOf(t, f.s, seat))}), 409, "loyalty_conflict")
	}
	// 整桌开到打烊：20:45 开，75 分钟；带了时长或选自由计时都不行
	f.at(20, 45)
	wantCode(t, "到打烊又带时长", f.openWhole(t, map[string]any{"untilClose": true, "timingMode": "timed", "durationMinutes": 60}), 400, "invalid_session")
	wantCode(t, "到打烊又自由计时", f.openWhole(t, map[string]any{"untilClose": true, "timingMode": "free"}), 400, "invalid_session")
	w := f.openWhole(t, map[string]any{"untilClose": true, "timingMode": "timed"})
	if w.Code != http.StatusCreated || decodeMap(t, w)["untilClose"] != true || sessionOf(t, f.s, decodeMap(t, w)["id"].(string)).DurationMinutes != 75 {
		t.Fatalf("整桌开到打烊：%d %s", w.Code, w.Body.String())
	}
	// 开到打烊的整桌和「到打烊」的套餐一样：不能暂停、续时、标陪客、改时长或计时方式；改开始时间时时长重算到打烊
	whole := "/api/v2/venue-sessions/" + decodeMap(t, w)["id"].(string)
	for label, body := range map[string]map[string]any{
		"暂停":    {"status": "paused"},
		"标陪客":   {"status": "companion"},
		"续时":    {"extendMinutes": 30, "expectedDurationMinutes": 75},
		"改时长":   {"durationMinutes": 120},
		"改自由计时": {"timingMode": "free"},
	} {
		wantCode(t, "开到打烊的整桌"+label, call(t, f.s, http.MethodPatch, whole, f.clerk.AccessToken, id(), body), 409, "invalid_session_state")
	}
	moved := call(t, f.s, http.MethodPatch, whole, f.clerk.AccessToken, id(), map[string]any{"startedAt": time.Date(2026, 10, 11, 20, 30, 0, 0, storetime.Location).Format(time.RFC3339)})
	if moved.Code != http.StatusOK || decodeMap(t, moved)["durationMinutes"] != float64(90) {
		t.Fatalf("开到打烊的整桌改开始时间，时长重算到打烊：%d %s", moved.Code, moved.Body.String())
	}
	// 预约：16:00 起约到打烊是 360 分钟，时段按这个占
	f.at(14, 0)
	out := reservationOK(t, f.s, f.clerk.AccessToken, reservationInput{Action: "register", AccountID: f.another.User.ID, TableID: f.seats.ID, SeatNumber: 2,
		PackageID: allDay.ID, StartAt: time.Date(2026, 10, 12, 16, 0, 0, 0, storetime.Location).Format(time.RFC3339)})
	if x := reservationOf(t, f.s, out["targetId"].(string)); x.DurationMinutes != 360 {
		t.Fatalf("到打烊的预约时长算到打烊：%d", x.DurationMinutes)
	}
	if reservationCall(t, f.s, f.clerk.AccessToken, reservationInput{Action: "register", AccountID: f.customer.User.ID, TableID: f.seats.ID, SeatNumber: 2,
		PackageID: free.ID, StartAt: time.Date(2026, 10, 12, 21, 0, 0, 0, storetime.Location).Format(time.RFC3339)}).Code == http.StatusOK {
		t.Fatal("到打烊的预约占到打烊，后面的时段约不进来")
	}

	// 过了打烊：到打烊的套餐不能再开
	f.at(22, 0)
	wantCode(t, "打烊后扫码", loyaltyCall(t, f.s, f.another.AccessToken, loyaltyInput{Action: "request", TargetID: allDay.ID, TableID: f.seats.ID, SeatNumber: 2}), 409, "loyalty_conflict")
	f.at(22, 5)
	if w := f.openWhole(t, map[string]any{"untilClose": true, "timingMode": "timed"}); w.Code != http.StatusConflict {
		t.Fatalf("打烊后整桌开到打烊：%d %s", w.Code, w.Body.String())
	}

	// 收费打开后，没定价的套餐不能用来开台、预约
	f.at(14, 0)
	packagesIn := func(rules []any) map[string]bool {
		names := map[string]bool{}
		for _, r := range rules {
			if r := r.(map[string]any); r["kind"] == "package" {
				names[r["name"].(string)] = true
			}
		}
		return names
	}
	public := func() map[string]bool {
		return packagesIn(decodeMap(t, call(t, f.s, http.MethodGet, "/api/v2/loyalty/public", "", "", nil))["rules"].([]any))
	}
	booking := func() map[string]bool {
		return packagesIn(decodeMap(t, call(t, f.s, http.MethodGet, "/api/v2/reservations/me", f.customer.AccessToken, "", nil))["packages"].([]any))
	}
	if got := public(); !got["一小时"] || !got["全天"] || !got["两小时"] || !booking()["一小时"] {
		t.Fatalf("收费关着时没定价的套餐照常列出：%v", got)
	}
	enableBilling(t, f.s, f.owner.User.ID)
	if got := public(); got["一小时"] || got["全天"] || !got["两小时"] || booking()["一小时"] || !booking()["两小时"] {
		t.Fatalf("收费开着时顾客看不到没定价的套餐：%v %v", got, booking())
	}
	wantCode(t, "收费开着时用没定价的套餐扫码", loyaltyCall(t, f.s, f.another.AccessToken, loyaltyInput{Action: "request", TargetID: free.ID, TableID: f.seats.ID, SeatNumber: 2}), 409, "loyalty_conflict")
	if reservationCall(t, f.s, f.clerk.AccessToken, reservationInput{Action: "register", AccountID: f.another.User.ID, TableID: f.seats.ID, SeatNumber: 1,
		PackageID: free.ID, StartAt: time.Date(2026, 10, 13, 16, 0, 0, 0, storetime.Location).Format(time.RFC3339)}).Code == http.StatusOK {
		t.Fatal("收费开着时没定价的套餐不能预约")
	}
}

// 团购记录：平台加券码，选填；券码去掉空白，只能是字母数字；到店现付不填券码。预约里记的到入座时带过去，确认时能改能清。
func TestCouponsAreCheckedAndCarriedToTheSeat(t *testing.T) {
	f := newTimingShop(t)
	start := time.Date(2026, 10, 11, 16, 0, 0, 0, storetime.Location)
	register := func(account string, seat int, coupon *reserve.Coupon) *httptest.ResponseRecorder {
		return reservationCall(t, f.s, f.clerk.AccessToken, reservationInput{Action: "register", AccountID: account, TableID: f.seats.ID, SeatNumber: seat, PackageID: f.pack.ID, StartAt: start.Format(time.RFC3339), Coupon: coupon})
	}
	for _, c := range []struct {
		label  string
		coupon reserve.Coupon
	}{
		{"不认识的平台", reserve.Coupon{Platform: "taobao", Code: "123"}},
		{"只填券码", reserve.Coupon{Code: "123"}},
		{"到店现付填券码", reserve.Coupon{Platform: "in_store", Code: "123"}},
		{"券码带符号", reserve.Coupon{Platform: "meituan", Code: "1234-5678"}},
		{"券码太长", reserve.Coupon{Platform: "meituan", Code: strings.Repeat("1", 33)}},
	} {
		wantCode(t, c.label, register(f.customer.User.ID, 1, &c.coupon), 400, "invalid_request")
		wantCode(t, "扫码："+c.label, loyaltyCall(t, f.s, f.customer.AccessToken, loyaltyInput{Action: "request", TargetID: f.pack.ID, TableID: f.seats.ID, SeatNumber: 1, Coupon: &c.coupon}), 400, "invalid_request")
	}
	booked := decodeMap(t, register(f.customer.User.ID, 1, &reserve.Coupon{Platform: "meituan", Code: " 1234 5678 9012 "}))["targetId"].(string)
	if got := reservationOf(t, f.s, booked).Coupon; got == nil || *got != (reserve.Coupon{Platform: "meituan", Code: "123456789012"}) {
		t.Fatalf("券码去掉空白存下：%+v", got)
	}
	inStore := decodeMap(t, register(f.another.User.ID, 2, &reserve.Coupon{Platform: "in_store"}))["targetId"].(string)
	if got := reservationOf(t, f.s, inStore).Coupon; got == nil || got.Platform != "in_store" || got.Code != "" {
		t.Fatalf("到店现付只记平台：%+v", got)
	}

	// 顾客约过这个座位，到店扫码没填：带上预约里的；店员确认时能改
	f.at(16, 0)
	request := f.request(t, f.customer, f.pack.ID, 1, nil)
	carried := request["coupon"].(map[string]any)
	if carried["platform"] != "meituan" || carried["code"] != "123456789012" {
		t.Fatalf("扫码时带上预约里的团购记录：%v", request)
	}
	confirmed := loyaltyOK(t, f.s, f.clerk.AccessToken, loyaltyInput{Action: "confirm", TargetID: request["id"].(string), Coupon: &reserve.Coupon{Platform: "dianping", Code: "A1B2"}})
	if got := admissionOf(t, f.s, request["id"].(string)).Coupon; got == nil || got.Platform != "dianping" || got.Code != "A1B2" {
		t.Fatalf("确认时改成点评的券：%+v", got)
	}
	if reservationOf(t, f.s, booked).Status != "seated" || confirmed["status"] != "confirmed" {
		t.Fatal("入座结掉自己的预约")
	}
	// 店员确认时清掉（平台和券码都空）
	second := f.request(t, f.another, f.pack.ID, 2, &reserve.Coupon{Platform: "dianping", Code: "C3"})
	loyaltyOK(t, f.s, f.clerk.AccessToken, loyaltyInput{Action: "confirm", TargetID: second["id"].(string), Coupon: &reserve.Coupon{}})
	if got := admissionOf(t, f.s, second["id"].(string)).Coupon; got != nil {
		t.Fatalf("确认时清掉团购记录：%+v", got)
	}
	// 只有扫码、确认能带团购记录
	wantCode(t, "别的动作带团购记录", loyaltyCall(t, f.s, f.clerk.AccessToken, loyaltyInput{Action: "adjust", AccountID: f.customer.User.ID, Points: 1, Reason: "x", Coupon: &reserve.Coupon{Platform: "meituan"}}), 400, "invalid_request")
}

// 预约到店开台：预约里记的团购记录带到入座申请上（员工在会话里看得到）。
func TestReservationSeatingCarriesTheCoupon(t *testing.T) {
	f := newTimingShop(t)
	start := time.Date(2026, 10, 11, 16, 0, 0, 0, storetime.Location)
	out := reservationOK(t, f.s, f.clerk.AccessToken, reservationInput{Action: "register", AccountID: f.another.User.ID, TableID: f.seats.ID, SeatNumber: 1, PackageID: f.pack.ID,
		StartAt: start.Format(time.RFC3339), Coupon: &reserve.Coupon{Platform: "dianping", Code: "998877"}})
	booked := out["targetId"].(string)
	f.at(16, 5)
	reservationOK(t, f.s, f.clerk.AccessToken, reservationInput{Action: "seat", TargetID: booked})
	session := sessionOf(t, f.s, reservationOf(t, f.s, booked).SessionID)
	if got := admissionOf(t, f.s, session.AdmissionID).Coupon; got == nil || got.Platform != "dianping" || got.Code != "998877" {
		t.Fatalf("到店开台带上预约里的团购记录：%+v", got)
	}
}

// 所有员工都能手动加减储值和积分（写原因、记审计），扣不成负数。
func TestClerkAdjustsBalanceAndPointsButNotBelowZero(t *testing.T) {
	f := newTimingShop(t)
	adjust := func(in loyaltyInput) *httptest.ResponseRecorder {
		in.Action, in.AccountID = "adjust", f.customer.User.ID
		return loyaltyCall(t, f.s, f.clerk.AccessToken, in)
	}
	if w := adjust(loyaltyInput{PrincipalCents: 5000, Points: 30, Reason: "美团团购送储值和积分"}); w.Code != http.StatusOK {
		t.Fatalf("店员加：%d %s", w.Code, w.Body.String())
	}
	if w := adjust(loyaltyInput{PrincipalCents: -2000, Points: -10, Reason: "线下用掉"}); w.Code != http.StatusOK {
		t.Fatalf("店员减：%d %s", w.Code, w.Body.String())
	}
	b := memberOf(t, f.s, f.customer.User.ID).Balance(f.customer.User.ID, f.s.now())
	if b.PrincipalCents != 3000 || b.Points != 20 {
		t.Fatalf("加减后的余额：%+v", b)
	}
	before := f.s.snapshotData()
	for label, in := range map[string]loyaltyInput{
		"储值扣成负数": {PrincipalCents: -3001, Reason: "扣多了"},
		"积分扣成负数": {Points: -21, Reason: "扣多了"},
	} {
		if w := adjust(in); w.Code == http.StatusOK {
			t.Fatalf("%s应当被拒：%s", label, w.Body.String())
		}
	}
	wantCode(t, "没写原因", adjust(loyaltyInput{Points: 1}), 409, "loyalty_conflict")
	if !bytes.Equal(before, f.s.snapshotData()) {
		t.Fatal("被拒的调整改了数据")
	}
	adjusted := auditsWithAction(t, f.s, "loyalty.adjust")
	if len(adjusted) != 2 || adjusted[0].ActorID != f.clerk.User.ID || adjusted[0].ObjectID != f.customer.User.ID {
		t.Fatalf("调整记在顾客名下、记下是哪位店员：%+v", adjusted)
	}
}
