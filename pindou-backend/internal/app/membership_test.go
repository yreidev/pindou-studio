package app

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	member "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/membership/application"
	"github.com/yreidev/pindou-studio/pindou-backend/internal/storetime"
)

func loyaltyCall(t *testing.T, s *Server, bearer string, in loyaltyInput) *httptest.ResponseRecorder {
	t.Helper()
	if in.ExpectedVersion == "" {
		in.ExpectedVersion = loyaltyVersion(t, s, bearer, in)
	}
	return call(t, s, "POST", "/api/v2/loyalty/actions", bearer, id(), in)
}

// loyaltyVersion 取页面此刻会拿到的版本，与小程序一致：规则动作用员工总览的
// version，其余用目标顾客（没指定就是本人）会员视图的 version。
func loyaltyVersion(t *testing.T, s *Server, bearer string, in loyaltyInput) string {
	t.Helper()
	switch in.Action {
	case "save_rule", "publish", "disable":
		return settingsVersionOf(t, s)
	}
	target := in.AccountID
	if target == "" {
		target = bearerAccount(t, s, bearer)
	}
	return accountVersionOf(t, s, target)
}
func loyaltyOK(t *testing.T, s *Server, bearer string, in loyaltyInput) map[string]any {
	t.Helper()
	r := loyaltyCall(t, s, bearer, in)
	if r.Code != 200 {
		t.Fatalf("%s: %d %s", in.Action, r.Code, r.Body.String())
	}
	return decodeMap(t, r)
}
func publishRule(t *testing.T, s *Server, bearer string, r member.Rule) member.Rule {
	t.Helper()
	out := loyaltyOK(t, s, bearer, loyaltyInput{Action: "save_rule", Rule: r})
	r.ID = out["id"].(string)
	loyaltyOK(t, s, bearer, loyaltyInput{Action: "publish", TargetID: r.ID, Reason: "保留已有权益，适用于新交易"})
	r.Enabled = true
	return r
}
func TestMembershipWorkflow(t *testing.T) { exerciseMembership(t, newTestServer(t)) }
func exerciseMembership(t *testing.T, s *Server) string {
	t.Helper()
	owner := register(t, s, "member-owner", "老板")
	if err := s.BootstrapOwner(owner.User.ID); err != nil {
		t.Fatal(err)
	}
	enableBilling(t, s, owner.User.ID)
	customer := register(t, s, "member-customer", "顾客")
	other := register(t, s, "member-other", "另一位")
	recharge := publishRule(t, s, owner.AccessToken, member.Rule{Kind: "recharge", Name: "测试充值", AmountCents: 50000, GiftCents: 10000, Points: 100, ValidDays: 90})
	publishRule(t, s, owner.AccessToken, member.Rule{Kind: "tier", Name: "测试黄金", AmountCents: 50000, Mode: "cumulative", RateBasisPoints: 9000, ValidDays: 365})
	publishRule(t, s, owner.AccessToken, member.Rule{Kind: "earn", Name: "消费积分", AmountCents: 100, Points: 1, Scope: "all", ValidDays: 30})
	publishRule(t, s, owner.AccessToken, member.Rule{Kind: "redeem", Name: "抵扣", AmountCents: 100, Points: 10, MaxBasisPoints: 5000, Stack: true})
	before := s.snapshotData()
	bad := loyaltyCall(t, s, customer.AccessToken, loyaltyInput{Action: "recharge", TargetID: recharge.ID, Method: "cash"})
	if bad.Code != 403 || !bytes.Equal(before, s.snapshotData()) {
		t.Fatal("customer recharged or changed state")
	}
	input := loyaltyInput{Action: "recharge", TargetID: recharge.ID, AccountID: customer.User.ID, Method: "cash"}
	input.ExpectedVersion = loyaltyVersion(t, s, owner.AccessToken, input)
	one := call(t, s, "POST", "/api/v2/loyalty/actions", owner.AccessToken, "same-recharge", input)
	two := call(t, s, "POST", "/api/v2/loyalty/actions", owner.AccessToken, "same-recharge", input)
	if one.Code != 200 || two.Code != 200 {
		t.Fatalf("recharge: %s %s", one.Body, two.Body)
	}
	b := memberOf(t, s, customer.User.ID).Balance(customer.User.ID, s.now())
	if b.PrincipalCents != 50000 || b.GiftCents != 10000 || b.Points != 100 || b.TierName != "测试黄金" {
		t.Fatalf("bad balance %+v", b)
	}
	input.Method = "wechat"
	if call(t, s, "POST", "/api/v2/loyalty/actions", owner.AccessToken, "same-recharge", input).Code != 409 {
		t.Fatal("idempotency changed request accepted")
	}
	if call(t, s, "GET", "/api/v2/loyalty/account?accountId="+customer.User.ID, other.AccessToken, "", nil).Code != 403 {
		t.Fatal("other member read assets")
	}
	// Published snapshot is unchanged by edits; stale publication is rejected.
	oldVersion := settingsVersionOf(t, s)
	recharge.GiftCents = 20000
	loyaltyOK(t, s, owner.AccessToken, loyaltyInput{Action: "save_rule", Rule: recharge, ExpectedVersion: oldVersion})
	live, _ := ruleOf(t, s, recharge.ID)
	if live.GiftCents != 10000 {
		t.Fatal("draft changed active rule")
	}
	if loyaltyCall(t, s, owner.AccessToken, loyaltyInput{Action: "publish", TargetID: recharge.ID, ExpectedVersion: oldVersion, Reason: "旧版本"}).Code != 409 {
		t.Fatal("stale publication accepted")
	}
	// Separate seat admission, snapshot price, two customers on one table.
	// 布局固定之后没有建桌接口了，夹具直接进 store（见 fixtures_test.go）。
	table := seedTable(t, s, "H1", "大厅", 1, 2, false).ID
	pack := publishRule(t, s, owner.AccessToken, member.Rule{Kind: "package", Name: "三小时", AmountCents: 10000, DurationMinutes: 180, RenewalMinutes: 60, RenewalCents: 2000, PauseLimitMinutes: 10, Overtime: "manual"})
	a := loyaltyOK(t, s, customer.AccessToken, loyaltyInput{Action: "request", TargetID: pack.ID, TableID: table, SeatNumber: 1})["id"].(string)
	a2 := loyaltyOK(t, s, other.AccessToken, loyaltyInput{Action: "request", TargetID: pack.ID, TableID: table, SeatNumber: 1})["id"].(string)
	confirmed := loyaltyOK(t, s, owner.AccessToken, loyaltyInput{Action: "confirm", TargetID: a})
	session := confirmed["venueSessionId"].(string)
	if loyaltyCall(t, s, owner.AccessToken, loyaltyInput{Action: "confirm", TargetID: a2}).Code != 409 {
		t.Fatal("double occupied seat")
	}
	loyaltyOK(t, s, other.AccessToken, loyaltyInput{Action: "cancel_request", TargetID: a2})
	a2 = loyaltyOK(t, s, other.AccessToken, loyaltyInput{Action: "request", TargetID: pack.ID, TableID: table, SeatNumber: 2})["id"].(string)
	loyaltyOK(t, s, owner.AccessToken, loyaltyInput{Action: "confirm", TargetID: a2})
	if len(sessionsOf(t, s)) != 2 {
		t.Fatal("two seats not created")
	}
	for _, x := range sessionsOf(t, s) {
		if x.ID != session && x.SeatNumber != 2 {
			t.Fatal("wrong seat")
		}
	}
	order := orderOfSession(t, s, session)
	qInput := loyaltyInput{Action: "quote", TargetID: order.ID, ExpectedVersion: order.Version(), Points: 100, UseBalance: true}
	raw := loyaltyOK(t, s, owner.AccessToken, qInput)
	if raw["principalCents"] != float64(8000) || raw["discountCents"] != float64(1000) || raw["pointsCents"] != float64(1000) {
		t.Fatalf("quote %+v", raw)
	}
	qInput.Action = "checkout"
	qInput.QuoteVersion = raw["version"].(string)
	qInput.Method = "cash"
	paid := loyaltyOK(t, s, owner.AccessToken, qInput)
	if paid["order"].(map[string]any)["status"] != "paid" {
		t.Fatal("not paid")
	}
	b = memberOf(t, s, customer.User.ID).Balance(customer.User.ID, s.now())
	if b.PrincipalCents != 42000 || b.Points != 80 {
		t.Fatalf("settlement %+v", b)
	}
	if sessionOf(t, s, session).Status != "settled" {
		t.Fatal("seat not released")
	}
	for _, x := range sessionsOf(t, s) {
		if x.ID != session && x.Status != "active" {
			t.Fatal("other customer released")
		}
	}
	// Legacy refund path must not bypass loyalty assets.
	order = orderOf(t, s, order.ID)
	if call(t, s, "POST", "/api/v2/sales-orders/"+order.ID+"/refunds", owner.AccessToken, "legacy-refund", map[string]any{"expectedVersion": order.Version(), "amountCents": 1, "reason": "退款"}).Code != 409 {
		t.Fatal("loyalty bypass")
	}
	loyaltyOK(t, s, owner.AccessToken, loyaltyInput{Action: "refund", TargetID: order.ID, ExpectedVersion: order.Version(), Reason: "全额退服务费"})
	b = memberOf(t, s, customer.User.ID).Balance(customer.User.ID, s.now())
	if b.PrincipalCents != 50000 || b.Points != 100 {
		t.Fatalf("refund %+v", b)
	}
	var rechargeID string
	for _, e := range memberOf(t, s, customer.User.ID).Entries {
		if e.Kind == "recharge" && e.AccountID == customer.User.ID {
			rechargeID = e.ID
		}
	}
	loyaltyOK(t, s, owner.AccessToken, loyaltyInput{Action: "recharge_refund", TargetID: rechargeID, AccountID: customer.User.ID, Reason: "原充值退款"})
	b = memberOf(t, s, customer.User.ID).Balance(customer.User.ID, s.now())
	if b.PrincipalCents != 0 || b.GiftCents != 0 || b.Points != 0 || b.TierName != "普通会员" {
		t.Fatalf("recharge refund %+v", b)
	}
	// Birthday no duplicate claims and no customer choosing another beneficiary.
	birthday := publishRule(t, s, owner.AccessToken, member.Rule{Kind: "birthday", Name: "生日月积分", Mode: "month", Scope: "points", Points: 25, PerUserLimit: 1, ValidDays: 30})
	date := s.now().In(storetime.Location).Format("01-02")
	loyaltyOK(t, s, customer.AccessToken, loyaltyInput{Action: "birthday", Birthday: date})
	loyaltyOK(t, s, customer.AccessToken, loyaltyInput{Action: "claim", TargetID: birthday.ID})
	before = s.snapshotData()
	if loyaltyCall(t, s, customer.AccessToken, loyaltyInput{Action: "claim", TargetID: birthday.ID}).Code != 409 || !bytes.Equal(before, s.snapshotData()) {
		t.Fatal("duplicate birthday claim")
	}
	if loyaltyCall(t, s, customer.AccessToken, loyaltyInput{Action: "birthday", Birthday: "01-01"}).Code != 409 {
		t.Fatal("birthday changed twice")
	}
	return customer.User.ID
}
func TestMembershipConcurrentRecharge(t *testing.T) {
	s := newTestServer(t)
	owner := register(t, s, "concurrent-owner", "老板")
	_ = s.BootstrapOwner(owner.User.ID)
	r := publishRule(t, s, owner.AccessToken, member.Rule{Kind: "recharge", Name: "充值", AmountCents: 100})
	version := accountVersionOf(t, s, owner.User.ID)
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			response := call(t, s, "POST", "/api/v2/loyalty/actions", owner.AccessToken, "concurrent", loyaltyInput{ExpectedVersion: version, Action: "recharge", TargetID: r.ID, AccountID: owner.User.ID, Method: "cash"})
			if response.Code != 200 {
				t.Errorf("%s", response.Body)
			}
		}()
	}
	wg.Wait()
	if memberOf(t, s, owner.User.ID).Balance(owner.User.ID, s.now()).PrincipalCents != 100 {
		t.Fatal("double credited")
	}
}
func TestPostgresMembershipRestartAndHistory(t *testing.T) {
	ctx := context.Background()
	s := newTestServer(t)
	user := exerciseMembership(t, s)
	membershipOf := func(server *Server) string {
		var doc map[string]json.RawMessage
		if err := json.Unmarshal(server.snapshotData(), &doc); err != nil {
			t.Fatal(err)
		}
		return string(doc["Membership"])
	}
	before := membershipOf(s)
	restart := serverOn(t, s.postgres)
	if membershipOf(restart) != before {
		t.Fatal("membership did not survive restart")
	}
	if memberOf(t, restart, user).Balance(user, restart.now()).Points != 25 {
		t.Fatal("birthday balance lost")
	}
	db := s.postgres.Pool()
	if _, err := db.Exec(ctx, "UPDATE membership_entries SET state='{}'"); err == nil {
		t.Fatal("immutable entry edited")
	}
	if _, err := db.Exec(ctx, "DELETE FROM membership_publications"); err == nil {
		t.Fatal("publication removed")
	}
	// 写到一半数据库报错：会员资产和登录凭证都回到请求之前。
	var staff string
	for _, a := range view(t, s, func(q *txn) []*roleAssignment { return q.activeRoles() }) {
		staff = a.UserID
	}
	token := "rollback-test"
	putAuth(t, s, token, authSession{UserID: staff, ExpiresAt: s.now().Add(time.Hour)})
	before = membershipOf(s)
	if _, err := db.Exec(ctx, `CREATE FUNCTION reject_entries() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated failure' USING ERRCODE = 'disk_full'; END $$;
 CREATE TRIGGER reject_entries BEFORE INSERT ON membership_entries FOR EACH ROW EXECUTE FUNCTION reject_entries()`); err != nil {
		t.Fatal(err)
	}
	response := loyaltyCall(t, s, token, loyaltyInput{Action: "adjust", AccountID: user, PrincipalCents: 100, Reason: "失败回滚测试"})
	if response.Code != 503 || membershipOf(s) != before {
		t.Fatalf("rollback %d %s", response.Code, response.Body)
	}
	if !hasAuth(t, s, token) {
		t.Fatal("credential lost on rollback")
	}
}

func TestMembershipStockExchangeAndPermissionBoundaries(t *testing.T) {
	s := newTestServer(t)
	owner := register(t, s, "gift-owner", "老板")
	_ = s.BootstrapOwner(owner.User.ID)
	customer := register(t, s, "gift-user", "顾客")
	manager := register(t, s, "gift-manager", "店长")
	setRoles(t, s, manager.User.ID, Manager)
	created := call(t, s, "POST", "/api/v2/catalog-items", owner.AccessToken, id(), map[string]any{"name": "测试礼物", "unitPriceCents": 100})
	product := decodeMap(t, created)["id"].(string)
	rule := publishRule(t, s, owner.AccessToken, member.Rule{Kind: "exchange", Name: "兑换", ProductID: product, Points: 10, Quantity: 2, PerUserLimit: 1})
	loyaltyOK(t, s, owner.AccessToken, loyaltyInput{Action: "adjust", AccountID: customer.User.ID, Points: 20, Reason: "测试积分"})
	before := s.snapshotData()
	if loyaltyCall(t, s, owner.AccessToken, loyaltyInput{Action: "exchange", AccountID: customer.User.ID, TargetID: rule.ID}).Code != 409 || !bytes.Equal(before, s.snapshotData()) {
		t.Fatal("out of stock consumed points")
	}
	it := &inventoryItem{ID: id(), ProductID: product, Quantity: 2}
	edit(t, s, func(q *txn) { q.addStockItem(it) })
	loyaltyOK(t, s, manager.AccessToken, loyaltyInput{Action: "exchange", AccountID: customer.User.ID, TargetID: rule.ID})
	if stockOf(t, s, it.ID).Quantity != 1 || memberOf(t, s, customer.User.ID).Balance(customer.User.ID, s.now()).Points != 10 {
		t.Fatal("exchange not atomic")
	}
	if loyaltyCall(t, s, owner.AccessToken, loyaltyInput{Action: "exchange", AccountID: customer.User.ID, TargetID: rule.ID}).Code != 409 {
		t.Fatal("per-user limit not enforced")
	}
	if loyaltyCall(t, s, manager.AccessToken, loyaltyInput{Action: "publish", TargetID: rule.ID, Reason: "越权"}).Code != 403 {
		t.Fatal("manager published")
	}
	loyaltyOK(t, s, manager.AccessToken, loyaltyInput{Action: "save_rule", Rule: member.Rule{Kind: "recharge", Name: "店长草稿", AmountCents: 100}})
	// 2026-10-10 起所有员工都能手动加减储值和积分（结账藏起来以后靠它）；顾客照旧不能。
	loyaltyOK(t, s, manager.AccessToken, loyaltyInput{Action: "adjust", AccountID: customer.User.ID, Points: 10, Reason: "团购送积分"})
	if memberOf(t, s, customer.User.ID).Balance(customer.User.ID, s.now()).Points != 20 {
		t.Fatal("manager adjustment not applied")
	}
	if loyaltyCall(t, s, customer.AccessToken, loyaltyInput{Action: "adjust", AccountID: customer.User.ID, Points: 10, Reason: "越权"}).Code != 403 {
		t.Fatal("customer adjusted assets")
	}
}
func TestLoyaltyPausedClockBoundedAndStopped(t *testing.T) {
	s := newTestServer(t)
	now := time.Now()
	s.now = func() time.Time { return now }
	owner := register(t, s, "clock-owner", "老板")
	_ = s.BootstrapOwner(owner.User.ID)
	table := seedTable(t, s, "H1", "大厅", 1, 2, false)
	rule := publishRule(t, s, owner.AccessToken, member.Rule{Kind: "package", Name: "限时", AmountCents: 100, DurationMinutes: 60, PauseLimitMinutes: 5, Overtime: "free"})
	admission := loyaltyOK(t, s, owner.AccessToken, loyaltyInput{Action: "request", TableID: table.ID, SeatNumber: 1, TargetID: rule.ID})["id"].(string)
	out := loyaltyOK(t, s, owner.AccessToken, loyaltyInput{Action: "confirm", TargetID: admission})
	sid := out["venueSessionId"].(string)
	now = now.Add(10 * time.Minute)
	x := sessionOf(t, s, sid)
	loyaltyOK(t, s, owner.AccessToken, loyaltyInput{Action: "pause", TargetID: sid, ExpectedVersion: member.Version(x)})
	now = now.Add(10 * time.Minute)
	admissions := func() []map[string]any {
		return view(t, s, func(q *txn) []map[string]any { return s.admissionViews(q, owner.User.ID) })
	}
	views := admissions()
	if views[0]["elapsedSeconds"] != int64(900) {
		t.Fatalf("pause cap %v", views)
	}
	loyaltyOK(t, s, owner.AccessToken, loyaltyInput{Action: "stop", TargetID: sid, ExpectedVersion: member.Version(sessionOf(t, s, sid))})
	now = now.Add(time.Hour)
	if admissions()[0]["elapsedSeconds"] != int64(900) {
		t.Fatal("stopped clock advanced")
	}
	if call(t, s, "PATCH", "/api/v2/venue-sessions/"+sid, owner.AccessToken, id(), map[string]any{"durationMinutes": 1}).Code != 409 {
		t.Fatal("legacy session bypass")
	}
}

func TestMemberCheckoutPreservesLegacyPausedTime(t *testing.T) {
	s := newTestServer(t)
	now := time.Date(2026, 9, 10, 12, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return now }
	owner := register(t, s, "legacy-member-owner", "老板")
	if err := s.BootstrapOwner(owner.User.ID); err != nil {
		t.Fatal(err)
	}
	pausedAt := now.Add(-10 * time.Minute)
	table := seedTable(t, s, "L1", "测试区", 1, 2, false).ID
	x := &TableSession{ID: id(), TableID: table, UserID: owner.User.ID, Status: "paused", StartedAt: now.Add(-30 * time.Minute), TimingMode: "timed", DurationMinutes: 60, PausedAt: &pausedAt, PausedSeconds: 120}
	edit(t, s, func(q *txn) { q.addSession(x) })
	o := &Order{ID: id(), TableSessionID: x.ID, UserID: owner.User.ID, Status: "draft", CreatedAt: now, ReceivableCents: 100, Lines: []OrderLine{{Name: "原整桌服务", Quantity: 1, UnitPriceCents: 100}}}
	edit(t, s, func(q *txn) { q.addOrder(o) })
	q := loyaltyOK(t, s, owner.AccessToken, loyaltyInput{Action: "quote", TargetID: o.ID, ExpectedVersion: o.Version()})
	loyaltyOK(t, s, owner.AccessToken, loyaltyInput{Action: "checkout", TargetID: o.ID, ExpectedVersion: o.Version(), QuoteVersion: q["version"].(string), Method: "cash"})
	x = sessionOf(t, s, x.ID)
	if x.Status != "settled" || x.PausedAt != nil || x.PausedSeconds != 720 || x.StoppedAt == nil || !x.StoppedAt.Equal(now) {
		t.Fatalf("legacy paused session lost timing history: %+v", x)
	}
}

// 请求本身不合法（原因太长、调整超限、未知动作、收款方式不对）回 400；数据此刻的状态不允许（规则不存在或已停用）
// 仍是 409，让人刷新后重新确认。
func TestLoyaltyInvalidInputIsABadRequest(t *testing.T) {
	s := newTestServer(t)
	owner := register(t, s, "invalid-owner", "老板")
	if err := s.BootstrapOwner(owner.User.ID); err != nil {
		t.Fatal(err)
	}
	customer := register(t, s, "invalid-customer", "顾客")
	recharge := publishRule(t, s, owner.AccessToken, member.Rule{Kind: "recharge", Name: "充值", AmountCents: 10000, GiftCents: 0, Points: 0, ValidDays: 30})
	for _, c := range []struct {
		name   string
		in     loyaltyInput
		status int
		code   string
	}{
		{"reason too long", loyaltyInput{Action: "adjust", AccountID: customer.User.ID, PrincipalCents: 1, Reason: strings.Repeat("长", 201)}, 400, "invalid_request"},
		{"adjust over limit", loyaltyInput{Action: "adjust", AccountID: customer.User.ID, PrincipalCents: member.Limit + 1, Reason: "调整"}, 400, "invalid_request"},
		{"unknown action", loyaltyInput{Action: "teleport", AccountID: customer.User.ID}, 400, "invalid_request"},
		{"bad method", loyaltyInput{Action: "recharge", TargetID: recharge.ID, AccountID: customer.User.ID, Method: "bitcoin"}, 400, "invalid_request"},
		{"missing rule", loyaltyInput{Action: "recharge", TargetID: id(), AccountID: customer.User.ID, Method: "cash"}, 409, "loyalty_conflict"},
	} {
		w := loyaltyCall(t, s, owner.AccessToken, c.in)
		if w.Code != c.status || decodeMap(t, w)["code"] != c.code {
			t.Errorf("%s: %d %s, want %d %s", c.name, w.Code, w.Body.String(), c.status, c.code)
		}
	}
}
