package app

import (
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	member "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/membership/application"
	reserve "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/reservations/domain"
	"github.com/yreidev/pindou-studio/pindou-backend/internal/storetime"
)

var cst = storetime.Location

func reservationCall(t *testing.T, s *Server, bearer string, in reservationInput) *httptest.ResponseRecorder {
	t.Helper()
	return call(t, s, "POST", "/api/v2/reservations/actions", bearer, id(), in)
}
func reservationOK(t *testing.T, s *Server, bearer string, in reservationInput) map[string]any {
	t.Helper()
	r := reservationCall(t, s, bearer, in)
	if r.Code != 200 {
		t.Fatalf("%s: %d %s", in.Action, r.Code, r.Body.String())
	}
	return decodeMap(t, r)
}

type reservationFixture struct {
	server                 *Server
	owner, customer, other sessionResponse
	table, pack            string
	start                  time.Time
	now                    time.Time
	duration               int
}

func newReservationFixture(t *testing.T) *reservationFixture {
	t.Helper()
	return reservationFixtureOn(t, newTestServer(t))
}

func reservationFixtureOn(t *testing.T, s *Server) *reservationFixture {
	t.Helper()
	now := time.Date(2026, 9, 14, 10, 0, 0, 0, cst)
	s.now = func() time.Time { return now }
	owner := register(t, s, "reservation-owner", "老板")
	if err := s.BootstrapOwner(owner.User.ID); err != nil {
		t.Fatal(err)
	}
	enableBilling(t, s, owner.User.ID)
	customer := register(t, s, "reservation-customer", "顾客")
	other := register(t, s, "reservation-other", "另一位")
	// 布局固定之后没有建桌接口了，夹具直接进 store（见 fixtures_test.go）。
	table := seedTable(t, s, "H1", "大厅", 1, 2, false).ID
	pack := publishRule(t, s, owner.AccessToken, member.Rule{Kind: "package", Name: "三小时", AmountCents: 10000, DurationMinutes: 180, RenewalMinutes: 60, RenewalCents: 2000, PauseLimitMinutes: 10, Overtime: "manual"})
	return &reservationFixture{server: s, owner: owner, customer: customer, other: other, table: table, pack: pack.ID,
		start: time.Date(2026, 9, 14, 14, 0, 0, 0, cst), now: now, duration: 180}
}

func (f *reservationFixture) book(t *testing.T, bearer string, seat int) string {
	t.Helper()
	out := reservationOK(t, f.server, bearer, reservationInput{Action: "book", TableID: f.table, SeatNumber: seat, PackageID: f.pack, StartAt: f.start.Format(time.RFC3339)})
	return out["targetId"].(string)
}
func (f *reservationFixture) at(t *testing.T, id string) *Reservation {
	t.Helper()
	x := reservationOf(t, f.server, id)
	if x == nil {
		t.Fatalf("reservation %s missing", id)
	}
	return x
}

// A self-service booking waits for staff, then becomes the existing seat timing
// flow when the customer turns up.
func TestReservationBookingBecomesASeatSession(t *testing.T) {
	f := newReservationFixture(t)
	s := f.server
	booked := f.book(t, f.customer.AccessToken, 1)
	if f.at(t, booked).Status != "pending" {
		t.Fatal("self-service booking must wait for staff confirmation")
	}
	if len(sessionsOf(t, s)) != 0 || len(ordersOf(t, s)) != 0 {
		t.Fatal("a reservation must not start timing or charge anything")
	}
	reservationOK(t, s, f.owner.AccessToken, reservationInput{Action: "confirm", TargetID: booked})
	if f.at(t, booked).Status != "confirmed" {
		t.Fatal("confirmation did not take effect")
	}
	arrival := f.start.Add(5 * time.Minute)
	s.now = func() time.Time { return arrival }
	reservationOK(t, s, f.owner.AccessToken, reservationInput{Action: "seat", TargetID: booked})
	x := f.at(t, booked)
	if x.Status != "seated" || x.SessionID == "" {
		t.Fatalf("seating did not link a session: %+v", x)
	}
	session := sessionOf(t, s, x.SessionID)
	if session == nil || session.SeatNumber != 1 || session.UserID != f.customer.User.ID || session.DurationMinutes != f.duration {
		t.Fatalf("session does not match the booking: %+v", session)
	}
	if session.AdmissionID == "" || admissionOf(t, s, session.AdmissionID).Package.ID != f.pack {
		t.Fatal("seating must reuse the package admission flow")
	}
	order := orderOfSession(t, s, session.ID)
	if order == nil || order.Status != "draft" || order.ReceivableCents != 10000 {
		t.Fatalf("package order not created: %+v", order)
	}
}

func TestReservationRejectsOverlappingSeatAndClosedHours(t *testing.T) {
	f := newReservationFixture(t)
	s := f.server
	f.book(t, f.customer.AccessToken, 1)
	if reservationCall(t, s, f.other.AccessToken, reservationInput{Action: "book", TableID: f.table, SeatNumber: 1, PackageID: f.pack, StartAt: f.start.Add(time.Hour).Format(time.RFC3339)}).Code != 409 {
		t.Fatal("overlapping booking on the same seat accepted")
	}
	// The neighbouring seat and a later window on the same seat stay free.
	f.book(t, f.other.AccessToken, 2)
	reservationOK(t, s, f.other.AccessToken, reservationInput{Action: "book", TableID: f.table, SeatNumber: 1, PackageID: f.pack, StartAt: f.start.Add(3 * time.Hour).Format(time.RFC3339)})
	for name, start := range map[string]time.Time{
		"before opening": time.Date(2026, 9, 15, 8, 0, 0, 0, cst),
		"past closing":   time.Date(2026, 9, 15, 20, 0, 0, 0, cst),
		"off the grid":   time.Date(2026, 9, 15, 14, 10, 0, 0, cst),
		"too soon":       f.now.Add(10 * time.Minute),
		"far ahead":      f.now.AddDate(0, 0, 30),
	} {
		if reservationCall(t, s, f.customer.AccessToken, reservationInput{Action: "book", TableID: f.table, SeatNumber: 2, PackageID: f.pack, StartAt: start.Format(time.RFC3339)}).Code != 409 {
			t.Fatalf("%s accepted", name)
		}
	}
	if reservationCall(t, s, f.customer.AccessToken, reservationInput{Action: "book", TableID: f.table, SeatNumber: 9, PackageID: f.pack, StartAt: f.start.Format(time.RFC3339)}).Code != 409 {
		t.Fatal("seat outside the table accepted")
	}
}

func TestReservationHoldsTheSeatAgainstWalkInsUntilItExpires(t *testing.T) {
	f := newReservationFixture(t)
	s := f.server
	booked := f.book(t, f.customer.AccessToken, 1)
	reservationOK(t, s, f.owner.AccessToken, reservationInput{Action: "confirm", TargetID: booked})
	s.now = func() time.Time { return f.start.Add(-10 * time.Minute) }
	// A walk-in cannot take the booked seat, nor the whole table it sits on.
	request := loyaltyCall(t, s, f.other.AccessToken, loyaltyInput{Action: "request", TargetID: f.pack, TableID: f.table, SeatNumber: 1})
	if request.Code != 409 {
		t.Fatalf("walk-in took a booked seat: %d %s", request.Code, request.Body.String())
	}
	whole := call(t, s, "POST", "/api/v2/venue-sessions", f.owner.AccessToken, id(), map[string]any{"serviceTableId": f.table, "startedAt": s.now().Format(time.RFC3339), "timingMode": "timed", "durationMinutes": 60})
	if whole.Code != 409 || decodeMap(t, whole)["code"] != "seat_reserved" {
		t.Fatalf("whole-table session ignored the booking: %d %s", whole.Code, whole.Body.String())
	}
	// Nor can a session opened elsewhere be moved onto the booked table.
	elsewhere := seedTable(t, s, "H2", "大厅", 2, 2, false)
	opened := call(t, s, "POST", "/api/v2/venue-sessions", f.owner.AccessToken, id(), map[string]any{"serviceTableId": elsewhere.ID, "startedAt": s.now().Format(time.RFC3339), "timingMode": "timed", "durationMinutes": 60})
	if opened.Code != 201 {
		t.Fatalf("open elsewhere: %d %s", opened.Code, opened.Body.String())
	}
	moved := call(t, s, "PATCH", "/api/v2/venue-sessions/"+decodeMap(t, opened)["id"].(string), f.owner.AccessToken, id(), map[string]any{"serviceTableId": f.table})
	if moved.Code != 409 || decodeMap(t, moved)["code"] != "seat_reserved" {
		t.Fatalf("moving a session onto a booked table bypassed the booking: %d %s", moved.Code, moved.Body.String())
	}
	// Once the grace period passes the seat is free again, without any stored
	// status being rewritten behind the staff's back.
	s.now = func() time.Time { return f.start.Add(31 * time.Minute) }
	if f.at(t, booked).Status != "confirmed" {
		t.Fatal("expiry must stay derived")
	}
	view := decodeMap(t, call(t, s, "GET", "/api/v2/reservations/staff?scope=open", f.owner.AccessToken, "", nil))
	if view["reservations"].([]any)[0].(map[string]any)["displayStatus"] != "expired" {
		t.Fatal("expired reservation not reported to staff")
	}
	if reservationCall(t, s, f.owner.AccessToken, reservationInput{Action: "confirm", TargetID: booked}).Code != 409 {
		t.Fatal("expired reservation confirmed")
	}
	if loyaltyCall(t, s, f.other.AccessToken, loyaltyInput{Action: "request", TargetID: f.pack, TableID: f.table, SeatNumber: 1}).Code != 200 {
		t.Fatal("expired reservation still blocks the seat")
	}
	reservationOK(t, s, f.owner.AccessToken, reservationInput{Action: "no_show", TargetID: booked, Reason: "顾客未到店"})
	if f.at(t, booked).Status != "no_show" {
		t.Fatal("no-show not recorded")
	}
}

// A customer who books and then scans the table code settles their own booking
// instead of colliding with it.
func TestArrivingCustomerSettlesTheirOwnReservation(t *testing.T) {
	for _, confirmFirst := range []bool{true, false} {
		f := newReservationFixture(t)
		s := f.server
		booked := f.book(t, f.customer.AccessToken, 1)
		if confirmFirst {
			reservationOK(t, s, f.owner.AccessToken, reservationInput{Action: "confirm", TargetID: booked})
		}
		s.now = func() time.Time { return f.start.Add(-5 * time.Minute) }
		admission := loyaltyOK(t, s, f.customer.AccessToken, loyaltyInput{Action: "request", TargetID: f.pack, TableID: f.table, SeatNumber: 1})["id"].(string)
		confirmed := loyaltyOK(t, s, f.owner.AccessToken, loyaltyInput{Action: "confirm", TargetID: admission})
		x := f.at(t, booked)
		if x.Status != "seated" || x.SessionID != confirmed["venueSessionId"].(string) {
			t.Fatalf("own reservation (confirmed=%v) was not settled on arrival: %+v", confirmFirst, x)
		}
	}
}

// 只写了称呼的预约到店，单座桌可以不选账户、当散客开台（2026-10-20 业主定）：走整桌开台那条路，
// 按预约的套餐时长计时，记下开台时的价，不建草稿单（同整桌开台，结账时建单），桌随即占用。
func TestWalkInReservationSeatsAsAGuest(t *testing.T) {
	f := newReservationFixture(t)
	s := f.server
	single := seedTable(t, s, "H2", "大厅", 2, 1, false).ID
	guest := reservationOK(t, s, f.owner.AccessToken, reservationInput{Action: "register", GuestName: "张阿姨", TableID: single, SeatNumber: 1, PackageID: f.pack, StartAt: f.start.Format(time.RFC3339)})["targetId"].(string)
	s.now = func() time.Time { return f.start }
	reservationOK(t, s, f.owner.AccessToken, reservationInput{Action: "seat", TargetID: guest})
	x := f.at(t, guest)
	if x.Status != "seated" || x.SessionID == "" || x.AccountID != "" {
		t.Fatalf("walk-in reservation not seated as a guest: %+v", x)
	}
	session := sessionOf(t, s, x.SessionID)
	if session.UserID != "" || session.AdmissionID != "" || session.SeatNumber != 0 || session.TimingMode != "timed" || session.DurationMinutes != f.duration || session.Tariff == nil || !session.StartedAt.Equal(f.start) {
		t.Fatalf("guest session should be a whole-table session timed by the booked package: %+v", session)
	}
	if order := orderOfSession(t, s, x.SessionID); order != nil {
		t.Fatalf("whole-table guest session builds its order at checkout, not on arrival: %+v", order)
	}
	w := call(t, s, "POST", "/api/v2/venue-sessions", f.owner.AccessToken, "", map[string]any{"serviceTableId": single, "timingMode": "timed", "durationMinutes": 60})
	if w.Code != 409 {
		t.Fatalf("table seated from a reservation still opened again: %d %s", w.Code, w.Body.String())
	}
}

func TestStaffRegisterAndPermissionBoundaries(t *testing.T) {
	f := newReservationFixture(t)
	s := f.server
	clerk := register(t, s, "reservation-clerk", "店员")
	call(t, s, "POST", "/api/v2/staff-role-assignments", f.owner.AccessToken, id(), map[string]any{"accountId": clerk.User.ID, "role": "clerk"})
	// Staff record a phone booking for a customer with no account yet.
	guest := reservationOK(t, s, clerk.AccessToken, reservationInput{Action: "register", GuestName: "张阿姨", TableID: f.table, SeatNumber: 1, PackageID: f.pack, StartAt: f.start.Format(time.RFC3339)})["targetId"].(string)
	if f.at(t, guest).Status != "confirmed" {
		t.Fatal("staff registration must take effect without a second confirmation")
	}
	s.now = func() time.Time { return f.start }
	// 夹具的桌两座、按座卖：没关联账户的预约在这种桌上仍要先选账户（单座桌当散客开台，见下一个测试）
	if reservationCall(t, s, clerk.AccessToken, reservationInput{Action: "seat", TargetID: guest}).Code != 409 {
		t.Fatal("a reservation with no account was seated on a per-seat table without choosing one")
	}
	reservationOK(t, s, clerk.AccessToken, reservationInput{Action: "seat", TargetID: guest, AccountID: f.customer.User.ID})
	if f.at(t, guest).AccountID != f.customer.User.ID {
		t.Fatal("account not bound on arrival")
	}
	for _, action := range []string{"register", "confirm", "seat", "no_show"} {
		if reservationCall(t, s, f.customer.AccessToken, reservationInput{Action: action, TargetID: guest, TableID: f.table, SeatNumber: 2, PackageID: f.pack, StartAt: f.start.Format(time.RFC3339)}).Code != 403 {
			t.Fatalf("customer performed %s", action)
		}
	}
	if call(t, s, "GET", "/api/v2/reservations/staff?scope=open", f.customer.AccessToken, "", nil).Code != 403 {
		t.Fatal("customer read every reservation")
	}
	settings := reserve.DefaultSettings()
	settings.Enabled = false
	if reservationCall(t, s, clerk.AccessToken, reservationInput{Action: "save_settings", Settings: &settings, ExpectedVersion: member.Version(reservationSettingsOf(t, s))}).Code != 403 {
		t.Fatal("clerk changed reservation settings")
	}
	stale := member.Version(reservationSettingsOf(t, s))
	reservationOK(t, s, f.owner.AccessToken, reservationInput{Action: "save_settings", Settings: &settings, ExpectedVersion: stale})
	if reservationSettingsOf(t, s).Enabled {
		t.Fatal("owner setting not saved")
	}
	if reservationCall(t, s, f.owner.AccessToken, reservationInput{Action: "save_settings", Settings: &settings, ExpectedVersion: stale}).Code != 409 {
		t.Fatal("stale settings version accepted")
	}
	if reservationCall(t, s, f.other.AccessToken, reservationInput{Action: "book", TableID: f.table, SeatNumber: 2, PackageID: f.pack, StartAt: f.start.Format(time.RFC3339)}).Code != 409 {
		t.Fatal("self-service booking accepted while disabled")
	}
}

// 顾客自助预约每个账号同时最多 2 个还没到店的（待确认、已确认都算），超了回 409 reservation_limit_reached，
// 小程序据此提示联系门店；顾客电话、微信约第 3 个，由员工代客登记，不受这个上限。同一顾客同一时段不能重复照旧。
func TestSelfServiceBookingLimitLeavesStaffRegistrationOpen(t *testing.T) {
	f := newReservationFixture(t)
	s := f.server
	clerk := register(t, s, "reservation-clerk", "店员")
	call(t, s, "POST", "/api/v2/staff-role-assignments", f.owner.AccessToken, id(), map[string]any{"accountId": clerk.User.ID, "role": "clerk"})
	book := func(start time.Time) *httptest.ResponseRecorder {
		return reservationCall(t, s, f.customer.AccessToken, reservationInput{Action: "book", TableID: f.table, SeatNumber: 1, PackageID: f.pack, StartAt: start.Format(time.RFC3339)})
	}
	mine := func() int {
		return len(decodeMap(t, call(t, s, "GET", "/api/v2/reservations/me", f.customer.AccessToken, "", nil))["reservations"].([]any))
	}
	tomorrow := f.start.AddDate(0, 0, 1)

	first := f.book(t, f.customer.AccessToken, 1)
	second := reservationOK(t, s, f.customer.AccessToken, reservationInput{Action: "book", TableID: f.table, SeatNumber: 1, PackageID: f.pack, StartAt: f.start.Add(3 * time.Hour).Format(time.RFC3339)})["targetId"].(string)
	reservationOK(t, s, f.owner.AccessToken, reservationInput{Action: "confirm", TargetID: second})

	over := book(tomorrow)
	if over.Code != 409 || decodeMap(t, over)["code"] != "reservation_limit_reached" {
		t.Fatalf("第 3 个自助预约应回 409 reservation_limit_reached，实得 %d %s", over.Code, over.Body.String())
	}
	if !strings.Contains(decodeMap(t, over)["message"].(string), "最多同时预约 2 个座位") {
		t.Fatalf("超限说明没写上限：%s", over.Body.String())
	}
	if mine() != 2 {
		t.Fatal("被拒的预约不应留下记录")
	}
	// 另一位顾客不受影响
	reservationOK(t, s, f.other.AccessToken, reservationInput{Action: "book", TableID: f.table, SeatNumber: 2, PackageID: f.pack, StartAt: f.start.Format(time.RFC3339)})

	// 店员代客登记第 3 个：不受上限
	third := reservationOK(t, s, clerk.AccessToken, reservationInput{Action: "register", AccountID: f.customer.User.ID, TableID: f.table, SeatNumber: 1, PackageID: f.pack, StartAt: tomorrow.Format(time.RFC3339)})["targetId"].(string)
	if x := f.at(t, third); x.Status != "confirmed" || x.AccountID != f.customer.User.ID {
		t.Fatalf("代客登记的第 3 个没有记到顾客名下：%+v", x)
	}
	// 同一顾客同一时段不能重复，代客登记也一样
	clash := reservationCall(t, s, clerk.AccessToken, reservationInput{Action: "register", AccountID: f.customer.User.ID, TableID: f.table, SeatNumber: 2, PackageID: f.pack, StartAt: tomorrow.Add(time.Hour).Format(time.RFC3339)})
	if clash.Code != 409 || decodeMap(t, clash)["code"] != "reservation_conflict" {
		t.Fatalf("同一顾客同一时段的代客登记应被拒：%d %s", clash.Code, clash.Body.String())
	}

	// 代客登记的也算在还没到店的预约里：取消一个还剩 2 个，仍不能自助再约；再取消一个才行
	later := tomorrow.Add(3 * time.Hour)
	reservationOK(t, s, f.customer.AccessToken, reservationInput{Action: "cancel", TargetID: first, Reason: "改期"})
	if r := book(later); r.Code != 409 || decodeMap(t, r)["code"] != "reservation_limit_reached" {
		t.Fatalf("还有 2 个没到店（含代客登记的）时自助预约应被拒：%d %s", r.Code, r.Body.String())
	}
	reservationOK(t, s, f.customer.AccessToken, reservationInput{Action: "cancel", TargetID: second, Reason: "改期"})
	if r := book(later); r.Code != 200 {
		t.Fatalf("降到上限以下后应能再约：%d %s", r.Code, r.Body.String())
	}
}

// 门店电话、微信号由老板在预约设置里填，顾客的预约视图带着它们（超限提示、包间说明、预约须知里显示）。
// 去掉首尾空白再存；填得不对回 400 invalid_request，不和设置版本冲突混在一起；重启后还在，清空后不再返回。
func TestReservationSettingsCarryStoreContacts(t *testing.T) {
	live := newTestServer(t)
	f := reservationFixtureOn(t, live)
	version := func() string { return member.Version(reservationSettingsOf(t, live)) }
	save := func(settings reserve.Settings) *httptest.ResponseRecorder {
		return reservationCall(t, live, f.owner.AccessToken, reservationInput{Action: "save_settings", Settings: &settings, ExpectedVersion: version()})
	}
	customerSettings := func(s *Server) map[string]any {
		return decodeMap(t, call(t, s, "GET", "/api/v2/reservations/me", f.customer.AccessToken, "", nil))["settings"].(map[string]any)
	}
	if _, ok := customerSettings(live)["contactPhone"]; ok {
		t.Fatal("没填的联系方式不应返回")
	}
	before := version()

	for name, change := range map[string]func(*reserve.Settings){
		"电话带字母":     func(s *reserve.Settings) { s.ContactPhone = "0571-abc" },
		"电话太长":      func(s *reserve.Settings) { s.ContactPhone = strings.Repeat("8", 21) },
		"微信号中间有空格":  func(s *reserve.Settings) { s.ContactWechat = "examplebrand pindou" },
		"微信号太长":     func(s *reserve.Settings) { s.ContactWechat = strings.Repeat("b", 41) },
		"时段粒度不在范围内": func(s *reserve.Settings) { s.SlotMinutes = 3 },
	} {
		settings := reserve.DefaultSettings()
		change(&settings)
		r := save(settings)
		if r.Code != 400 || decodeMap(t, r)["code"] != "invalid_request" {
			t.Fatalf("%s：应回 400 invalid_request，实得 %d %s", name, r.Code, r.Body.String())
		}
	}
	if version() != before {
		t.Fatal("被拒的设置不应保存")
	}

	settings := reserve.DefaultSettings()
	settings.ContactPhone, settings.ContactWechat = " 0571-8888 6666 ", "examplebrand_pindou"
	if r := save(settings); r.Code != 200 {
		t.Fatalf("保存联系方式：%d %s", r.Code, r.Body.String())
	}
	got := customerSettings(live)
	if got["contactPhone"] != "0571-8888 6666" || got["contactWechat"] != "examplebrand_pindou" {
		t.Fatalf("顾客的预约视图没带上去掉空白的联系方式：%v", got)
	}

	restart := serverOn(t, live.postgres)
	restart.now = live.now // 登录会话按夹具的时钟签发
	if stored := reservationSettingsOf(t, restart); stored.ContactPhone != "0571-8888 6666" || stored.ContactWechat != "examplebrand_pindou" {
		t.Fatalf("联系方式没有存进数据库：%+v", stored)
	}
	if got := customerSettings(restart); got["contactPhone"] != "0571-8888 6666" {
		t.Fatalf("重启后顾客读不到门店电话：%v", got)
	}

	// 清空：保存不带联系方式的设置，版本回到没填时那一版
	if r := save(reserve.DefaultSettings()); r.Code != 200 {
		t.Fatalf("清空联系方式：%d %s", r.Code, r.Body.String())
	}
	cleared := customerSettings(live)
	_, phone := cleared["contactPhone"]
	_, wechat := cleared["contactWechat"]
	if phone || wechat || version() != before {
		t.Fatalf("清空后不应再返回联系方式：%v", cleared)
	}
}

func TestReservationPrivacyAndIdempotency(t *testing.T) {
	f := newReservationFixture(t)
	s := f.server
	booked := f.book(t, f.customer.AccessToken, 1)
	mine := decodeMap(t, call(t, s, "GET", "/api/v2/reservations/me", f.other.AccessToken, "", nil))
	if len(mine["reservations"].([]any)) != 0 {
		t.Fatal("customer read another customer's reservations")
	}
	busy := mine["busy"].([]any)
	if len(busy) != 1 {
		t.Fatal("free/busy seats must be visible so a customer can choose a slot")
	}
	if _, leaked := busy[0].(map[string]any)["accountId"]; leaked {
		t.Fatal("free/busy exposed an identity")
	}
	staff := decodeMap(t, call(t, s, "GET", "/api/v2/reservations/staff?scope=open", f.owner.AccessToken, "", nil))
	entry := staff["reservations"].([]any)[0].(map[string]any)
	if entry["customerName"] != "顾客" || entry["phoneMasked"] != maskPhone("13800138000") {
		t.Fatalf("staff view lost the customer summary: %+v", entry)
	}
	if entry["phoneMasked"] == "13800138000" {
		t.Fatal("staff view exposed a full phone number")
	}
	in := reservationInput{Action: "cancel", TargetID: booked, Reason: "临时有事"}
	first := call(t, s, "POST", "/api/v2/reservations/actions", f.customer.AccessToken, "same-cancel", in)
	second := call(t, s, "POST", "/api/v2/reservations/actions", f.customer.AccessToken, "same-cancel", in)
	if first.Code != 200 || second.Code != 200 || strings.TrimSpace(first.Body.String()) != strings.TrimSpace(second.Body.String()) {
		t.Fatalf("replay did not repeat the first result: %d %d", first.Code, second.Code)
	}
	// 幂等记录只存目标，不存整份视图（员工视图带全部历史预约，一年下来一条就近 2MB）
	for key, recorded := range idemOf(t, s) {
		if strings.HasPrefix(key, "reservation:") && (recorded.Replay != replayReservationView || len(recorded.Body) > 100) {
			t.Fatalf("reservation replay record keeps the whole view: %s %d bytes", key, len(recorded.Body))
		}
	}
	in.Reason = "换个理由"
	if call(t, s, "POST", "/api/v2/reservations/actions", f.customer.AccessToken, "same-cancel", in).Code != 409 {
		t.Fatal("same key with changed content accepted")
	}
	if call(t, s, "POST", "/api/v2/reservations/actions", f.customer.AccessToken, "", reservationInput{Action: "book"}).Code != 400 {
		t.Fatal("missing idempotency key accepted")
	}
	if f.at(t, booked).Status != "cancelled" {
		t.Fatal("cancellation not recorded")
	}
	if reservationCall(t, s, f.other.AccessToken, reservationInput{Action: "cancel", TargetID: booked}).Code != 403 {
		t.Fatal("another customer cancelled a booking")
	}
	// Creating a booking must be auditable by the reservation it created, not
	// by the empty target the request carried.
	created := false
	for _, entry := range auditsOf(t, s) {
		if entry.Action == "reservation.book" && entry.ObjectID == booked {
			created = true
		}
	}
	if !created {
		t.Fatal("booking was not audited against the reservation it created")
	}
}

// Migration 005 has to carry a booking through every state across a restart,
// and a restore must not be able to drop reservation history.
func TestPostgresReservationMigrationAndRestart(t *testing.T) {
	live := newTestServer(t)
	f := reservationFixtureOn(t, live)
	booked := f.book(t, f.customer.AccessToken, 1)
	reservationOK(t, live, f.owner.AccessToken, reservationInput{Action: "confirm", TargetID: booked})
	settings := reserve.DefaultSettings()
	settings.GraceMinutes = 45
	reservationOK(t, live, f.owner.AccessToken, reservationInput{Action: "save_settings", Settings: &settings, ExpectedVersion: member.Version(reservationSettingsOf(t, live))})

	restart := serverOn(t, live.postgres)
	x := reservationOf(t, restart, booked)
	if x == nil || x.Status != "confirmed" || x.SeatNumber != 1 || x.PackageID != f.pack || !x.StartAt.Equal(f.start) {
		t.Fatalf("reservation did not survive restart: %+v", x)
	}
	if reservationSettingsOf(t, restart).GraceMinutes != 45 {
		t.Fatal("reservation settings did not survive restart")
	}
	// The arrival is driven through the process whose clock the test controls.
	arrival := f.start.Add(10 * time.Minute)
	live.now = func() time.Time { return arrival }
	reservationOK(t, live, f.owner.AccessToken, reservationInput{Action: "seat", TargetID: booked})

	reloaded := serverOn(t, live.postgres)
	seated := reservationOf(t, reloaded, booked)
	if seated.Status != "seated" || seated.SessionID == "" {
		t.Fatalf("seated reservation did not survive restart: %+v", seated)
	}
	if session := sessionOf(t, reloaded, seated.SessionID); session == nil || session.SeatNumber != 1 {
		t.Fatal("the session started from a reservation was lost")
	}
}

// 桌号只在区域内唯一，所以顾客端必须拿到区域名才能定位一张桌；而排序若只按桌号，
// 同号桌之间的先后取决于 map 迭代顺序，同一份数据每次请求都可能排得不一样。
func TestLoyaltyTablesCarryAreaNameAndKeepAStableOrder(t *testing.T) {
	f := newReservationFixture(t)
	s := f.server
	// 两个同样有 1 号桌的区域：本用例要验的就是同号桌之间的排序确定性。
	seedTable(t, s, "W1", "靠窗区", 1, 2, false)
	seedTable(t, s, "P1", "包间", 1, 2, false)

	read := func() []map[string]any {
		view := decodeMap(t, call(t, s, "GET", "/api/v2/reservations/me", f.customer.AccessToken, "", nil))
		raw, ok := view["tables"].([]any)
		if !ok {
			t.Fatalf("预约视图没有 tables：%v", view)
		}
		out := make([]map[string]any, 0, len(raw))
		for _, item := range raw {
			out = append(out, item.(map[string]any))
		}
		return out
	}

	tables := read()
	if len(tables) != 3 {
		t.Fatalf("应有 3 张桌，实际 %d", len(tables))
	}
	// 三个区域各建了一张桌，每区桌号都从 1 开始——单看桌号无法区分它们。
	byArea := map[string]string{}
	for _, table := range tables {
		name, _ := table["floorAreaName"].(string)
		if name == "" {
			t.Fatalf("桌位缺少 floorAreaName：%v", table)
		}
		if got := table["number"].(float64); got != 1 {
			t.Fatalf("%s 的桌号应为 1，实际 %v", name, got)
		}
		byArea[name] = table["id"].(string)
	}
	for _, want := range []string{"大厅", "靠窗区", "包间"} {
		if byArea[want] == "" {
			t.Fatalf("缺少区域 %s，实得 %v", want, byArea)
		}
	}
	if len(byArea) != 3 {
		t.Fatalf("三张 1 号桌应分属三个区域，实得 %v", byArea)
	}

	// 同一份数据反复读取，顺序必须一致，否则客户端按位置对应就会漂移。
	first := make([]string, 0, len(tables))
	for _, table := range tables {
		first = append(first, table["floorAreaName"].(string)+"#"+table["id"].(string))
	}
	for i := 0; i < 12; i++ {
		again := make([]string, 0, len(first))
		for _, table := range read() {
			again = append(again, table["floorAreaName"].(string)+"#"+table["id"].(string))
		}
		for n := range first {
			if again[n] != first[n] {
				t.Fatalf("第 %d 次读取顺序变化：%v 与 %v", i+1, again, first)
			}
		}
	}
}

// 停用一张还有人预约的桌，顾客到店时开台会失败，而他已经白跑一趟了。
// 停用必须先被拒绝；预约取消之后才放行。
func TestDisablingATableWithLiveReservationsIsRefused(t *testing.T) {
	f := newReservationFixture(t)
	s := f.server
	id := f.book(t, f.customer.AccessToken, 1)

	off := call(t, s, "PATCH", "/api/v2/service-tables/"+f.table, f.owner.AccessToken, "",
		map[string]any{"enabled": false})
	if off.Code != 409 || decodeMap(t, off)["code"] != "table_reserved" {
		t.Fatalf("有预约的桌不该能停用，实得 %d %s", off.Code, off.Body.String())
	}
	if !tableOf(t, s, f.table).Enabled {
		t.Fatal("被拒绝的停用不应改动桌位")
	}

	// 取消预约后才放行
	reservationOK(t, s, f.customer.AccessToken, reservationInput{Action: "cancel", TargetID: id, Reason: "改期"})
	if w := call(t, s, "PATCH", "/api/v2/service-tables/"+f.table, f.owner.AccessToken, "",
		map[string]any{"enabled": false}); w.Code != 200 {
		t.Fatalf("预约取消后应可停用：%d %s", w.Code, w.Body.String())
	}
}

// keepSignedIn 给这些账号换一张一年后才过期的令牌，夹具时钟往后挪过 24 小时也还登录着（会话本来 24 小时就过期）。
func keepSignedIn(t *testing.T, s *Server, sessions ...*sessionResponse) {
	t.Helper()
	for _, sess := range sessions {
		sess.AccessToken = "long-lived-" + id()
		putAuth(t, s, sess.AccessToken, authSession{UserID: sess.User.ID, ExpiresAt: s.now().AddDate(1, 0, 0), Client: clientMiniapp})
	}
}

// saveReservationSettings 以当前设置版本保存一份预约设置（老板）。
func saveReservationSettings(t *testing.T, f *reservationFixture, settings reserve.Settings) {
	t.Helper()
	reservationOK(t, f.server, f.owner.AccessToken, reservationInput{Action: "save_settings", Settings: &settings, ExpectedVersion: member.Version(reservationSettingsOf(t, f.server))})
}

// jsonStrings 把 JSON 里的字符串数组取出来。
func jsonStrings(t *testing.T, v any) []string {
	t.Helper()
	items, ok := v.([]any)
	if !ok {
		t.Fatalf("不是数组：%#v", v)
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		out = append(out, item.(string))
	}
	return out
}

// 歇业日：顾客自助预约被拒（409 store_closed），员工代客登记照常；预约视图的 closedDays 列出今天起到最多提前天数的歇业日
// （含每周休息日），顾客、员工都看得到；把某天设为歇业不取消、不改动已经约在那天的预约，员工照常处理。
func TestClosedDaysStopSelfServiceButNotStaffRegistration(t *testing.T) {
	f := newReservationFixture(t) // 此刻 2026-09-14（周一）10:00
	s := f.server
	clerk := register(t, s, "reservation-clerk", "店员")
	call(t, s, "POST", "/api/v2/staff-role-assignments", f.owner.AccessToken, id(), map[string]any{"accountId": clerk.User.ID, "role": "clerk"})
	book := func(bearer string, start time.Time, seat int) *httptest.ResponseRecorder {
		return reservationCall(t, s, bearer, reservationInput{Action: "book", TableID: f.table, SeatNumber: seat, PackageID: f.pack, StartAt: start.Format(time.RFC3339)})
	}
	tue := time.Date(2026, 9, 15, 14, 0, 0, 0, cst)
	wed, thu := tue.AddDate(0, 0, 1), tue.AddDate(0, 0, 2)
	// 设歇业之前已经有人约了 15 日
	earlier := reservationOK(t, s, f.other.AccessToken, reservationInput{Action: "book", TableID: f.table, SeatNumber: 2, PackageID: f.pack, StartAt: tue.Format(time.RFC3339)})["targetId"].(string)

	settings := reserve.DefaultSettings()
	settings.ClosedDates = []string{"2026-09-15"}
	settings.ClosedWeekdays = []int{3} // 每周三
	saveReservationSettings(t, f, settings)

	if x := f.at(t, earlier); x.Status != "pending" || x.DecidedAt != nil {
		t.Fatalf("设歇业不该动已经约在那天的预约：%+v", x)
	}
	for name, start := range map[string]time.Time{"歇业日期": tue, "每周休息日": wed} {
		r := book(f.customer.AccessToken, start, 1)
		if r.Code != 409 || decodeMap(t, r)["code"] != "store_closed" {
			t.Fatalf("%s的自助预约应回 409 store_closed，实得 %d %s", name, r.Code, r.Body.String())
		}
		if !strings.Contains(decodeMap(t, r)["message"].(string), "歇业") {
			t.Fatalf("歇业的说明没写清：%s", r.Body.String())
		}
	}
	if r := book(f.customer.AccessToken, thu, 1); r.Code != 200 {
		t.Fatalf("不歇业的日子照常可约：%d %s", r.Code, r.Body.String())
	}
	// 员工代客登记不受歇业限制，直接生效
	registered := reservationOK(t, s, clerk.AccessToken, reservationInput{Action: "register", AccountID: f.customer.User.ID, TableID: f.table, SeatNumber: 1, PackageID: f.pack, StartAt: tue.Format(time.RFC3339)})["targetId"].(string)
	if x := f.at(t, registered); x.Status != "confirmed" {
		t.Fatalf("歇业日的代客登记应直接生效：%+v", x)
	}
	guest := reservationOK(t, s, clerk.AccessToken, reservationInput{Action: "register", GuestName: "张阿姨", TableID: f.table, SeatNumber: 1, PackageID: f.pack, StartAt: wed.Format(time.RFC3339)})["targetId"].(string)
	if f.at(t, guest).Status != "confirmed" {
		t.Fatal("每周休息日的散客代客登记应直接生效")
	}
	// 约在歇业日的预约员工照常确认
	reservationOK(t, s, clerk.AccessToken, reservationInput{Action: "confirm", TargetID: earlier})

	// 今天（14 日）起到 21 日：15 日（歇业日期）、16 日（周三）；顾客、员工的视图一样
	for who, path := range map[string]string{f.customer.AccessToken: "/api/v2/reservations/me", clerk.AccessToken: "/api/v2/reservations/staff?scope=open"} {
		got := decodeMap(t, call(t, s, "GET", path, who, "", nil))
		if days := strings.Join(jsonStrings(t, got["closedDays"]), ","); days != "2026-09-15,2026-09-16" {
			t.Fatalf("%s 的 closedDays：%s", path, days)
		}
		set := got["settings"].(map[string]any)
		if strings.Join(jsonStrings(t, set["closedDates"]), ",") != "2026-09-15" || len(set["closedWeekdays"].([]any)) != 1 {
			t.Fatalf("%s 的设置没带歇业：%v", path, set)
		}
	}
}

// 歇业按门店时区（东八区）的日期判断，不按 UTC：门店 16 日零点是 UTC 15 日 16:00。
// 日子过了，设置里不再列出那天，closedDays 也从第二天算起。
func TestClosedDayFollowsTheStoreDate(t *testing.T) {
	f := newReservationFixture(t)
	s := f.server
	keepSignedIn(t, s, &f.owner, &f.customer)
	half := publishRule(t, s, f.owner.AccessToken, member.Rule{Kind: "package", Name: "半小时", AmountCents: 2000, DurationMinutes: 30, PauseLimitMinutes: 10, Overtime: "manual"})
	settings := reserve.DefaultSettings()
	settings.OpenMinute, settings.CloseMinute = 0, 24*60
	settings.ClosedDates = []string{"2026-09-16"}
	saveReservationSettings(t, f, settings)

	for utc, want := range map[string]string{
		"2026-09-15T15:30:00Z": "",             // 门店 15 日 23:30：营业
		"2026-09-15T16:00:00Z": "store_closed", // 门店 16 日 00:00：歇业（UTC 还是 15 日）
		"2026-09-16T15:30:00Z": "store_closed", // 门店 16 日 23:30：歇业
		"2026-09-16T16:00:00Z": "",             // 门店 17 日 00:00：营业（UTC 还是 16 日）
	} {
		start, _ := time.Parse(time.RFC3339, utc)
		r := reservationCall(t, s, f.customer.AccessToken, reservationInput{Action: "book", TableID: f.table, SeatNumber: 1, PackageID: half.ID, StartAt: start.Format(time.RFC3339)})
		if want == "" && r.Code != 200 || want != "" && (r.Code != 409 || decodeMap(t, r)["code"] != want) {
			t.Fatalf("%s（门店 %s）：应为 %q，实得 %d %s", utc, start.In(cst).Format(time.DateTime), want, r.Code, r.Body.String())
		}
	}

	mine := func() map[string]any {
		return decodeMap(t, call(t, s, "GET", "/api/v2/reservations/me", f.customer.AccessToken, "", nil))
	}
	s.now = func() time.Time { return time.Date(2026, 9, 16, 15, 59, 59, 0, time.UTC) } // 门店 16 日 23:59:59
	if days := jsonStrings(t, mine()["closedDays"]); len(days) != 1 || days[0] != "2026-09-16" {
		t.Fatalf("门店还是 16 日，今天就是歇业日：%v", days)
	}
	s.now = func() time.Time { return time.Date(2026, 9, 16, 16, 0, 0, 0, time.UTC) } // 门店 17 日零点
	view := mine()
	if days := jsonStrings(t, view["closedDays"]); len(days) != 0 {
		t.Fatalf("16 日过去了不该再列：%v", days)
	}
	if dates := jsonStrings(t, view["settings"].(map[string]any)["closedDates"]); len(dates) != 0 {
		t.Fatalf("设置里不该再给人看已过去的歇业日：%v", dates)
	}
	// 读取不改写存着的设置（版本不因日子过去而变）；下次保存时把过去的那天去掉，而不是拒收
	stored := reservationSettingsOf(t, s)
	if len(stored.ClosedDates) != 1 {
		t.Fatalf("读取不该改写存着的设置：%+v", stored)
	}
	reservationOK(t, s, f.owner.AccessToken, reservationInput{Action: "save_settings", Settings: &stored, ExpectedVersion: member.Version(stored)})
	if after := reservationSettingsOf(t, s); len(after.ClosedDates) != 0 {
		t.Fatalf("已过去的歇业日保存时应去掉：%+v", after)
	}
}

// 爽约限制：默认不限制；老板设了次数后，门店时区里含今天在内最近 N 天被标记爽约达到次数的账号，自助预约被拒
// （409 reservation_suspended），顾客的预约视图提前说明（selfServiceSuspended）；员工代客登记不受限，其他顾客不受影响。
func TestNoShowLimitSuspendsSelfServiceOnly(t *testing.T) {
	f := newReservationFixture(t) // 此刻 2026-09-14 10:00
	s := f.server
	clerk := register(t, s, "reservation-clerk", "店员")
	call(t, s, "POST", "/api/v2/staff-role-assignments", f.owner.AccessToken, id(), map[string]any{"accountId": clerk.User.ID, "role": "clerk"})
	keepSignedIn(t, s, &f.owner, &f.customer, &f.other, &clerk)
	suspended := func(who sessionResponse) any {
		return decodeMap(t, call(t, s, "GET", "/api/v2/reservations/me", who.AccessToken, "", nil))["selfServiceSuspended"]
	}
	book := func(who sessionResponse, start time.Time, seat int) *httptest.ResponseRecorder {
		return reservationCall(t, s, who.AccessToken, reservationInput{Action: "book", TableID: f.table, SeatNumber: seat, PackageID: f.pack, StartAt: start.Format(time.RFC3339)})
	}
	if _, ok := decodeMap(t, call(t, s, "GET", "/api/v2/reservations/staff?scope=open", clerk.AccessToken, "", nil))["selfServiceSuspended"]; ok {
		t.Fatal("员工视图不带 selfServiceSuspended")
	}

	// 顾客约了 14 日 14:00 没来，员工过了时间标记爽约；另一条约了又取消（取消不算爽约）
	missed := f.book(t, f.customer.AccessToken, 1)
	reservationOK(t, s, f.owner.AccessToken, reservationInput{Action: "confirm", TargetID: missed})
	tomorrow := time.Date(2026, 9, 15, 14, 0, 0, 0, cst)
	cancelled := reservationOK(t, s, f.customer.AccessToken, reservationInput{Action: "book", TableID: f.table, SeatNumber: 1, PackageID: f.pack, StartAt: tomorrow.Format(time.RFC3339)})["targetId"].(string)
	reservationOK(t, s, f.customer.AccessToken, reservationInput{Action: "cancel", TargetID: cancelled, Reason: "改期"})
	s.now = func() time.Time { return f.start.Add(40 * time.Minute) }
	reservationOK(t, s, f.owner.AccessToken, reservationInput{Action: "no_show", TargetID: missed, Reason: "没来"})

	// 默认不限制
	if suspended(f.customer) != false {
		t.Fatal("没开爽约限制时不该暂停")
	}
	r := book(f.customer, tomorrow, 1)
	if r.Code != 200 {
		t.Fatalf("没开爽约限制时照常可约：%d %s", r.Code, r.Body.String())
	}
	reservationOK(t, s, f.customer.AccessToken, reservationInput{Action: "cancel", TargetID: decodeMap(t, r)["targetId"].(string)})

	// 爽约 1 次就暂停，只统计今天
	settings := reserve.DefaultSettings()
	settings.NoShowLimit, settings.NoShowWindowDays = 1, 1
	saveReservationSettings(t, f, settings)
	if suspended(f.customer) != true {
		t.Fatal("达到爽约次数的顾客视图应提前说明暂停自助预约")
	}
	r = book(f.customer, tomorrow, 1)
	if r.Code != 409 || decodeMap(t, r)["code"] != "reservation_suspended" || !strings.Contains(decodeMap(t, r)["message"].(string), "爽约") {
		t.Fatalf("应回 409 reservation_suspended，实得 %d %s", r.Code, r.Body.String())
	}
	// 其他顾客不受影响
	if suspended(f.other) != false {
		t.Fatal("没爽约的顾客不该被暂停")
	}
	if r := book(f.other, tomorrow, 2); r.Code != 200 {
		t.Fatalf("其他顾客照常可约：%d %s", r.Code, r.Body.String())
	}
	// 员工代客登记不受限
	registered := reservationOK(t, s, clerk.AccessToken, reservationInput{Action: "register", AccountID: f.customer.User.ID, TableID: f.table, SeatNumber: 1, PackageID: f.pack, StartAt: tomorrow.Format(time.RFC3339)})["targetId"].(string)
	if f.at(t, registered).Status != "confirmed" {
		t.Fatal("被暂停的顾客仍可由员工代客登记")
	}

	// 窗口按门店时区的日子算：门店 14 日 23:59:59 还在窗口里，15 日零点（UTC 14 日 16:00）起不算了
	s.now = func() time.Time { return time.Date(2026, 9, 14, 15, 59, 59, 0, time.UTC) }
	if suspended(f.customer) != true {
		t.Fatal("门店还是 14 日，当天的爽约还算")
	}
	s.now = func() time.Time { return time.Date(2026, 9, 14, 16, 0, 0, 0, time.UTC) }
	if suspended(f.customer) != false {
		t.Fatal("门店到了 15 日，只统计今天时 14 日的爽约不再算")
	}
	if r := book(f.customer, tomorrow.AddDate(0, 0, 1), 1); r.Code != 200 {
		t.Fatalf("出了统计窗口应能再自助预约：%d %s", r.Code, r.Body.String())
	}
	// 统计最近 2 天：14 日的爽约又算进来；次数上限改成 2：只爽约 1 次，不暂停
	settings.NoShowWindowDays = 2
	saveReservationSettings(t, f, settings)
	if suspended(f.customer) != true {
		t.Fatal("统计最近 2 天时 14 日的爽约要算")
	}
	settings.NoShowLimit = 2
	saveReservationSettings(t, f, settings)
	if suspended(f.customer) != false {
		t.Fatal("只爽约 1 次，上限 2 次时不该暂停（取消的不算爽约）")
	}
}

// 歇业与爽约限制的设置填得不对回 400 invalid_request；保存后去重排序、重启后还在，并照旧记审计。
// 老库里存的设置（0.0.12 及以前）没有这几项：按默认值读，不歇业、不限制爽约、统计 30 天。
func TestReservationSettingsClosuresAndNoShowRuleArePersisted(t *testing.T) {
	live := newTestServer(t)
	f := reservationFixtureOn(t, live)
	if _, err := live.postgres.Pool().Exec(t.Context(), `INSERT INTO reservation_settings(id,state) VALUES (true, '{"enabled":true,"openMinute":540,"closeMinute":1320,"slotMinutes":30,"advanceDays":7,"leadMinutes":30,"graceMinutes":45}')`); err != nil {
		t.Fatal(err)
	}
	old := reservationSettingsOf(t, live)
	if old.GraceMinutes != 45 || old.NoShowLimit != 0 || old.NoShowWindowDays != 30 || old.ClosedDates == nil || len(old.ClosedDates) != 0 || old.ClosedWeekdays == nil {
		t.Fatalf("老设置应按默认值补上新的几项：%+v", old)
	}
	customer := decodeMap(t, call(t, live, "GET", "/api/v2/reservations/me", f.customer.AccessToken, "", nil))
	if set := customer["settings"].(map[string]any); set["noShowLimit"] != float64(0) || set["noShowWindowDays"] != float64(30) || len(set["closedDates"].([]any)) != 0 {
		t.Fatalf("老设置读出来的视图：%v", set)
	}
	if customer["selfServiceSuspended"] != false || len(customer["closedDays"].([]any)) != 0 {
		t.Fatalf("老设置不歇业、不暂停：%v %v", customer["selfServiceSuspended"], customer["closedDays"])
	}

	before := member.Version(reservationSettingsOf(t, live))
	for name, change := range map[string]func(*reserve.Settings){
		"歇业日期写法不对":   func(s *reserve.Settings) { s.ClosedDates = []string{"2026/09/20"} },
		"新加的歇业日期已过去": func(s *reserve.Settings) { s.ClosedDates = []string{"2026-09-13"} },
		"每周休息日写成 0":  func(s *reserve.Settings) { s.ClosedWeekdays = []int{0} },
		"爽约次数太多":     func(s *reserve.Settings) { s.NoShowLimit = 21 },
		"爽约统计 0 天":   func(s *reserve.Settings) { s.NoShowWindowDays = 0 },
	} {
		settings := reserve.DefaultSettings()
		change(&settings)
		r := reservationCall(t, live, f.owner.AccessToken, reservationInput{Action: "save_settings", Settings: &settings, ExpectedVersion: before})
		if r.Code != 400 || decodeMap(t, r)["code"] != "invalid_request" {
			t.Fatalf("%s：应回 400 invalid_request，实得 %d %s", name, r.Code, r.Body.String())
		}
	}
	if member.Version(reservationSettingsOf(t, live)) != before {
		t.Fatal("被拒的设置不应保存")
	}

	settings := reserve.DefaultSettings()
	settings.ClosedDates = []string{"2026-09-20", "2026-09-14", "2026-09-20"}
	settings.ClosedWeekdays = []int{7, 1}
	settings.NoShowLimit, settings.NoShowWindowDays = 3, 60
	saveReservationSettings(t, f, settings)
	restart := serverOn(t, live.postgres)
	restart.now = live.now
	stored := reservationSettingsOf(t, restart)
	if strings.Join(stored.ClosedDates, ",") != "2026-09-14,2026-09-20" || len(stored.ClosedWeekdays) != 2 || stored.ClosedWeekdays[0] != 1 || stored.NoShowLimit != 3 || stored.NoShowWindowDays != 60 {
		t.Fatalf("歇业与爽约限制没有去重排序后存进数据库：%+v", stored)
	}
	if a := lastAudit(t, restart); a.Action != "reservation.save_settings" {
		t.Fatalf("保存预约设置要记审计：%+v", a)
	}
}

// sessionBusyOf 是预约视图 busy 里 kind=session 的条目，按「桌#座」给出结束时间。
func sessionBusyOf(t *testing.T, view map[string]any) map[string]time.Time {
	t.Helper()
	out := map[string]time.Time{}
	for _, item := range view["busy"].([]any) {
		slot := item.(map[string]any)
		if slot["kind"] != "session" {
			continue
		}
		end, err := time.Parse(time.RFC3339, slot["endAt"].(string))
		if err != nil {
			t.Fatal(err)
		}
		out[slot["serviceTableId"].(string)+"#"+fmt.Sprint(slot["seatNumber"])] = end
	}
	return out
}

// 现场挡预约：座位上正在进行的定时会话结束前，顾客自助预约不能约进来（409 seat_in_use，说明几点空出），
// 预约视图的 busy 把这段列为 kind=session，整桌会话按每个座号列；自由计时不挡；员工代客登记不受限。
func TestLiveTimedSessionHoldsTheSeatAgainstSelfService(t *testing.T) {
	f := newReservationFixture(t) // 此刻 2026-09-14 10:00
	s := f.server
	clerk := register(t, s, "reservation-clerk", "店员")
	call(t, s, "POST", "/api/v2/staff-role-assignments", f.owner.AccessToken, id(), map[string]any{"accountId": clerk.User.ID, "role": "clerk"})
	hour := publishRule(t, s, f.owner.AccessToken, member.Rule{Kind: "package", Name: "一小时", AmountCents: 3000, DurationMinutes: 60, PauseLimitMinutes: 10, Overtime: "manual"})
	at := func(hh, mm int) time.Time { return time.Date(2026, 9, 14, hh, mm, 0, 0, cst) }
	book := func(who sessionResponse, table string, seat int, start time.Time) *httptest.ResponseRecorder {
		return reservationCall(t, s, who.AccessToken, reservationInput{Action: "book", TableID: table, SeatNumber: seat, PackageID: f.pack, StartAt: start.Format(time.RFC3339)})
	}
	// 顾客扫码坐 H1 的 1 号座，三小时套餐 10:00 起，到 13:00
	admission := loyaltyOK(t, s, f.customer.AccessToken, loyaltyInput{Action: "request", TargetID: f.pack, TableID: f.table, SeatNumber: 1})["id"].(string)
	loyaltyOK(t, s, f.owner.AccessToken, loyaltyInput{Action: "confirm", TargetID: admission})

	r := book(f.other, f.table, 1, at(12, 0))
	if r.Code != 409 || decodeMap(t, r)["code"] != "seat_in_use" || !strings.Contains(decodeMap(t, r)["message"].(string), "到 13:00 才空出") {
		t.Fatalf("压到现场定时会话的自助预约应回 409 seat_in_use 并说明几点空出，实得 %d %s", r.Code, r.Body.String())
	}
	// 同桌的另一个座（不是整桌售卖）不受影响
	third := register(t, s, "reservation-third", "第三位")
	if r := book(third, f.table, 2, at(12, 0)); r.Code != 200 {
		t.Fatalf("同桌另一个座照常可约：%d %s", r.Code, r.Body.String())
	}
	// 员工代客登记不受现场会话限制
	guest := reservationOK(t, s, clerk.AccessToken, reservationInput{Action: "register", GuestName: "张阿姨", TableID: f.table, SeatNumber: 1, PackageID: hour.ID, StartAt: at(11, 0).Format(time.RFC3339)})["targetId"].(string)
	if f.at(t, guest).Status != "confirmed" {
		t.Fatal("代客登记应不受现场会话限制")
	}
	// 会话结束那一刻起可约
	if r := book(f.other, f.table, 1, at(13, 0)); r.Code != 200 {
		t.Fatalf("会话结束时起应能约：%d %s", r.Code, r.Body.String())
	}

	// 自由计时没有结束时间，不挡；整桌定时会话挡整张桌，busy 按每个座号列
	free := seedTable(t, s, "H2", "大厅", 2, 2, false)
	whole := seedTable(t, s, "H3", "大厅", 3, 2, false)
	for table, timing := range map[string]map[string]any{
		free.ID:  {"timingMode": "free"},
		whole.ID: {"timingMode": "timed", "durationMinutes": 120},
	} {
		body := map[string]any{"serviceTableId": table, "startedAt": s.now().Format(time.RFC3339)}
		for k, v := range timing {
			body[k] = v
		}
		if w := call(t, s, "POST", "/api/v2/venue-sessions", f.owner.AccessToken, id(), body); w.Code != 201 {
			t.Fatalf("开台：%d %s", w.Code, w.Body.String())
		}
	}
	if r := book(f.customer, free.ID, 1, at(12, 0)); r.Code != 200 {
		t.Fatalf("自由计时不该挡预约：%d %s", r.Code, r.Body.String())
	}
	if r := book(f.customer, whole.ID, 2, at(11, 0)); r.Code != 409 || decodeMap(t, r)["code"] != "seat_in_use" || !strings.Contains(decodeMap(t, r)["message"].(string), "到 12:00 才空出") {
		t.Fatalf("整桌定时会话应挡整张桌：%d %s", r.Code, r.Body.String())
	}

	// 空闲接口：busy 把现场定时会话列成 kind=session（到结束时间），顾客、员工的视图一样
	for _, path := range []string{"/api/v2/reservations/me", "/api/v2/reservations/staff?scope=open"} {
		bearer := f.other.AccessToken
		if strings.Contains(path, "staff") {
			bearer = clerk.AccessToken
		}
		held := sessionBusyOf(t, decodeMap(t, call(t, s, "GET", path, bearer, "", nil)))
		want := map[string]time.Time{f.table + "#1": at(13, 0), whole.ID + "#1": at(12, 0), whole.ID + "#2": at(12, 0)}
		if len(held) != len(want) {
			t.Fatalf("%s 的现场占用：%v", path, held)
		}
		for key, end := range want {
			if !held[key].Equal(end) {
				t.Fatalf("%s 的现场占用 %s 应到 %s：%v", path, key, end, held)
			}
		}
	}
}

// 暂停中的定时会话按桌位视图的 endsAt 口径挡（暂停时间算进去，按座会话只算到套餐允许的暂停上限）；
// 停止计时、等结账的结账前一直挡着（2026-10-06 业主定）：挡到门店今天结束，明天照常可约。
func TestPausedSessionHoldsUntilItsEndsAtAndStoppedOneHoldsUntilCheckout(t *testing.T) {
	f := newReservationFixture(t) // 此刻 2026-09-14 10:00，套餐暂停上限 10 分钟
	s := f.server
	at := func(hh, mm int) time.Time { return time.Date(2026, 9, 14, hh, mm, 0, 0, cst) }
	book := func(start time.Time) *httptest.ResponseRecorder {
		return reservationCall(t, s, f.other.AccessToken, reservationInput{Action: "book", TableID: f.table, SeatNumber: 1, PackageID: f.pack, StartAt: start.Format(time.RFC3339)})
	}
	admission := loyaltyOK(t, s, f.customer.AccessToken, loyaltyInput{Action: "request", TargetID: f.pack, TableID: f.table, SeatNumber: 1})["id"].(string)
	session := loyaltyOK(t, s, f.owner.AccessToken, loyaltyInput{Action: "confirm", TargetID: admission})["venueSessionId"].(string)
	s.now = func() time.Time { return at(10, 20) }
	loyaltyOK(t, s, f.owner.AccessToken, loyaltyInput{Action: "pause", TargetID: session, ExpectedVersion: member.Version(sessionOf(t, s, session))})
	s.now = func() time.Time { return at(10, 40) } // 已暂停 20 分钟，按上限只算 10 分钟：到 13:10

	ends, err := time.Parse(time.RFC3339, fmt.Sprint(decodeMap(t, call(t, s, "GET", "/api/v2/reservations/me", f.other.AccessToken, "", nil))["busy"].([]any)[0].(map[string]any)["endAt"]))
	if err != nil || !ends.Equal(at(13, 10)) || !ends.Equal(tableViewOf(t, s, f.table)["endsAt"].(time.Time)) {
		t.Fatalf("暂停中的会话应按桌位视图的 endsAt 挡到 13:10：%s %v", ends, err)
	}
	if r := book(at(13, 0)); r.Code != 409 || !strings.Contains(decodeMap(t, r)["message"].(string), "到 13:10 才空出") {
		t.Fatalf("暂停延后了结束时间，13:00 应仍被挡：%d %s", r.Code, r.Body.String())
	}
	// 停止计时等结账：结账前一直挡着——今天后面的时段约不了，说明要等结账；明天照常
	loyaltyOK(t, s, f.owner.AccessToken, loyaltyInput{Action: "stop", TargetID: session, ExpectedVersion: member.Version(sessionOf(t, s, session))})
	if r := book(at(16, 0)); r.Code != 409 || decodeMap(t, r)["code"] != "seat_in_use" || !strings.Contains(decodeMap(t, r)["message"].(string), "还在等结账") {
		t.Fatalf("停止计时、没结账的座位今天后面的时段应被挡并说明在等结账：%d %s", r.Code, r.Body.String())
	}
	midnight := time.Date(2026, 9, 15, 0, 0, 0, 0, cst)
	if held := sessionBusyOf(t, decodeMap(t, call(t, s, "GET", "/api/v2/reservations/me", f.other.AccessToken, "", nil))); !held[f.table+"#1"].Equal(midnight) {
		t.Fatalf("停止计时的会话应列为占用到门店今天结束：%v", held)
	}
	tomorrow := time.Date(2026, 9, 15, 11, 0, 0, 0, cst)
	if r := book(tomorrow); r.Code != 200 {
		t.Fatalf("明天的时段不该被今天等结账的会话挡住：%d %s", r.Code, r.Body.String())
	}
}
