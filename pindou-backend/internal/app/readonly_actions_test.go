package app

import (
	"bytes"
	"net/http"
	"testing"
	"time"

	member "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/membership/application"
)

// 结账报价、规则计算示例只算不写：不改状态、不存幂等记录、不广播。以前它们和写操作一样整份落库并广播，
// 网页发布确认框开着时每次广播都让计算示例重算一遍，每秒约 3 次「预览 → 落库 → 广播 → 重读」不停。
func TestReadOnlyLoyaltyActionsDoNotPersistOrBroadcast(t *testing.T) {
	s := newTestServer(t)
	owner := register(t, s, "readonly-owner", "老板")
	if err := s.BootstrapOwner(owner.User.ID); err != nil {
		t.Fatal(err)
	}
	customer := register(t, s, "readonly-customer", "顾客")
	publishRule(t, s, owner.AccessToken, member.Rule{Kind: "earn", Name: "消费积分", AmountCents: 100, Points: 1, Scope: "all", ValidDays: 30})
	order := &Order{ID: id(), UserID: customer.User.ID, Status: "draft", CreatedAt: s.now(), ReceivableCents: 1000, Lines: []OrderLine{{Name: "服务费", Quantity: 1, UnitPriceCents: 1000}}}
	edit(t, s, func(q *txn) { q.addOrder(order) })

	events := s.hub.subscribe(streamViewer{staff: true})
	defer s.hub.unsubscribe(events)
	// 上面注册、发布规则、建单的推送经 LISTEN/NOTIFY 异步送到，机器忙时会在订阅之后才到：先收完、等安静下来，
	// 免得把准备步骤的推送当成只读操作发的（2026-10-06 同类问题在全量检查里误判过推送测试）。
	for settled := false; !settled; {
		select {
		case <-events:
		case <-time.After(300 * time.Millisecond):
			settled = true
		}
	}
	before := s.snapshotData()
	idemBefore := len(idemOf(t, s))
	for _, in := range []loyaltyInput{
		{Action: "preview_rule", Rule: member.Rule{Kind: "earn", Name: "示例", AmountCents: 100, Points: 2, Scope: "all", ValidDays: 30}},
		{Action: "quote", TargetID: order.ID, ExpectedVersion: order.Version()},
	} {
		for range 2 { // 同一个幂等键重放也只是再算一遍
			if w := call(t, s, http.MethodPost, "/api/v2/loyalty/actions", owner.AccessToken, "same-key-"+in.Action, in); w.Code != http.StatusOK {
				t.Fatalf("%s: %d %s", in.Action, w.Code, w.Body.String())
			}
		}
	}
	if !bytes.Equal(before, s.snapshotData()) || len(idemOf(t, s)) != idemBefore {
		t.Fatal("read-only actions changed state or stored idempotency records")
	}
	select {
	case e := <-events:
		t.Fatalf("read-only action broadcast %v", e)
	case <-time.After(50 * time.Millisecond):
	}

	// 真正的写动作照常落库、广播
	loyaltyOK(t, s, owner.AccessToken, loyaltyInput{Action: "adjust", AccountID: customer.User.ID, ExpectedVersion: accountVersionOf(t, s, customer.User.ID), Points: 5, Reason: "测试"})
	select {
	case <-events:
	case <-time.After(time.Second):
		t.Fatal("a real write should still broadcast")
	}
}

// 员工总览只下发当班要看的入座申请：待确认、计时进行中、今天申请或今天结束的；更早结束的历史不再每次下发。
// 顾客读自己的仍是全部。
func TestStaffAdmissionsAreLimitedToTheCurrentShift(t *testing.T) {
	s := newTestServer(t)
	now := time.Date(2026, 10, 5, 6, 0, 0, 0, time.UTC) // 北京时间 14:00
	s.now = func() time.Time { return now }
	owner := register(t, s, "shift-owner", "老板")
	if err := s.BootstrapOwner(owner.User.ID); err != nil {
		t.Fatal(err)
	}
	customer := register(t, s, "shift-customer", "顾客")
	table := seedTable(t, s, "S1", "测试区", 1, 2, false).ID
	yesterday := now.Add(-24 * time.Hour)
	stoppedYesterday, stoppedToday := yesterday.Add(2*time.Hour), now.Add(-time.Hour)
	// 和真实入座一样：会话按时长计时，申请带着当时选的套餐（响应要符合契约）。
	timed := func(status string, stopped *time.Time) *TableSession {
		return &TableSession{ID: id(), TableID: table, SeatNumber: 1, Status: status, StartedAt: yesterday, StoppedAt: stopped, TimingMode: "timed", DurationMinutes: 120}
	}
	sessions := map[string]*TableSession{
		"live":       timed("active", nil),
		"done-old":   timed("settled", &stoppedYesterday),
		"done-today": timed("settled", &stoppedToday),
	}
	pack := member.Rule{ID: id(), Kind: "package", Name: "两小时", Enabled: true, AmountCents: 6800, DurationMinutes: 120, Overtime: "manual"}
	named := map[string]string{}
	add := func(name, status string, created time.Time, session *TableSession) {
		a := member.Admission{ID: id(), AccountID: customer.User.ID, TableID: table, SeatNumber: 1, Package: pack, Status: status, CreatedAt: created}
		named[a.ID] = name
		edit(t, s, func(q *txn) {
			if session != nil {
				q.addSession(session)
				a.SessionID = session.ID
			}
			q.memberAccount(customer.User.ID).Admissions[a.ID] = a
		})
	}
	add("pending", "pending", now.Add(-5*time.Minute), nil)
	add("expired-old", "pending", yesterday, nil)
	add("rejected-today", "rejected", now.Add(-3*time.Hour), nil)
	add("live", "confirmed", yesterday, sessions["live"])
	add("done-old", "confirmed", yesterday, sessions["done-old"])
	add("done-today", "confirmed", yesterday, sessions["done-today"])

	names := func(path, bearer string) map[string]bool {
		t.Helper()
		body := decodeMap(t, call(t, s, http.MethodGet, path, bearer, "", nil))
		out := map[string]bool{}
		for _, v := range body["admissions"].([]any) {
			out[named[v.(map[string]any)["admission"].(map[string]any)["id"].(string)]] = true
		}
		return out
	}
	staff := names("/api/v2/loyalty/shift", owner.AccessToken)
	for _, want := range []string{"pending", "rejected-today", "live", "done-today"} {
		if !staff[want] {
			t.Fatalf("staff view is missing %s: %v", want, staff)
		}
	}
	for _, old := range []string{"expired-old", "done-old"} {
		if staff[old] {
			t.Fatalf("staff view still carries old history %s", old)
		}
	}
	if mine := names("/api/v2/loyalty/me", customer.AccessToken); len(mine) != 6 {
		t.Fatalf("customers still see their whole history: %v", mine)
	}
}

// /venue-sessions 只回进行中的计时，必须带 status=live：全部历史会越积越大（0.0.6 起的小程序都带）。
func TestVenueSessionsAreLimitedToLiveOnes(t *testing.T) {
	s := newTestServer(t)
	owner := register(t, s, "live-owner", "老板")
	if err := s.BootstrapOwner(owner.User.ID); err != nil {
		t.Fatal(err)
	}
	stopped := s.now()
	table := seedTable(t, s, "S2", "测试区", 1, 2, false).ID
	for _, x := range []*TableSession{
		{ID: id(), TableID: table, Status: "active", StartedAt: s.now(), TimingMode: "free"},
		{ID: id(), TableID: table, Status: "paused", StartedAt: s.now(), TimingMode: "free", PausedAt: &stopped},
		{ID: id(), TableID: table, Status: "companion", StartedAt: s.now(), TimingMode: "free"},
		{ID: id(), TableID: table, Status: "settled", StartedAt: s.now(), StoppedAt: &stopped, TimingMode: "free"},
		{ID: id(), TableID: table, Status: "cancelled", StartedAt: s.now(), TimingMode: "free"},
	} {
		edit(t, s, func(q *txn) { q.addSession(x) })
	}
	if w := call(t, s, http.MethodGet, "/api/v2/venue-sessions", owner.AccessToken, "", nil); w.Code != http.StatusBadRequest {
		t.Fatalf("unfiltered session list: %d", w.Code)
	}
	live := decodeList(t, call(t, s, http.MethodGet, "/api/v2/venue-sessions?status=live", owner.AccessToken, "", nil))
	if len(live) != 3 {
		t.Fatalf("live sessions: %d", len(live))
	}
	if w := call(t, s, http.MethodGet, "/api/v2/venue-sessions?status=settled", owner.AccessToken, "", nil); w.Code != http.StatusBadRequest {
		t.Fatalf("unknown status filter: %d", w.Code)
	}
}
