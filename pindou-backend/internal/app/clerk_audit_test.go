package app

import (
	"net/http"
	"strings"
	"testing"
	"time"
)

// 店员不能不留痕地少收钱：带商品的明细只能按商品资料的售价（或这一单原有的价）记账，改价要店长或老板；
// 改明细、取消计时、改计时的开始时间或时长都留审计。服务行（计时占位等）由员工按实际填价，只留审计。
func TestClerkPricingAndSessionChangesAreAudited(t *testing.T) {
	s := newTestServer(t)
	owner := register(t, s, "audit-owner", "老板")
	if err := s.BootstrapOwner(owner.User.ID); err != nil {
		t.Fatal(err)
	}
	clerk := register(t, s, "audit-clerk", "店员")
	setRoles(t, s, clerk.User.ID, Clerk)
	manager := register(t, s, "audit-manager", "店长")
	setRoles(t, s, manager.User.ID, Manager)

	product := decodeMap(t, call(t, s, http.MethodPost, "/api/v2/catalog-items", owner.AccessToken, id(), map[string]any{"name": "拼豆材料包", "unitPriceCents": 10000}))["id"].(string)
	order := &Order{ID: id(), Status: "draft", CreatedAt: s.now()}
	edit(t, s, func(q *txn) { q.addOrder(order) })
	version := func() string { return orderOf(t, s, order.ID).Version() }
	save := func(who sessionResponse, lines []map[string]any) *httpResult {
		t.Helper()
		w := call(t, s, http.MethodPatch, "/api/v2/sales-orders/"+order.ID, who.AccessToken, id(), map[string]any{"expectedVersion": version(), "lines": lines})
		return &httpResult{code: w.Code, body: w.Body.String()}
	}
	auditsOf := func(action string) []*auditLog {
		var out []*auditLog
		for _, a := range auditsOf(t, s) {
			if a.Action == action {
				out = append(out, a)
			}
		}
		return out
	}

	// 店员按售价记账：可以，并留审计
	if r := save(clerk, []map[string]any{{"productId": product, "name": "拼豆材料包", "quantity": 1, "unitPriceCents": 10000}}); r.code != 200 {
		t.Fatalf("clerk at catalog price: %d %s", r.code, r.body)
	}
	if got := auditsOf("order.lines.updated"); len(got) != 1 || got[0].ActorID != clerk.User.ID || !strings.Contains(got[0].Reason, "¥0.00 → ¥100.00") {
		t.Fatalf("line audit: %+v", got)
	}
	// 店员把 ¥100 记成 ¥1：拒绝，不改订单
	if r := save(clerk, []map[string]any{{"productId": product, "name": "拼豆材料包", "quantity": 1, "unitPriceCents": 100}}); r.code != 403 {
		t.Fatalf("clerk discounted a product: %d %s", r.code, r.body)
	}
	if orderOf(t, s, order.ID).ReceivableCents != 10000 {
		t.Fatal("rejected price change altered the order")
	}
	// 商品资料调价后，单里原有的旧价照常保存；服务行员工按实际填价
	if w := call(t, s, http.MethodPatch, "/api/v2/catalog-items/"+product, owner.AccessToken, id(), map[string]any{"name": "拼豆材料包", "unitPriceCents": 12000}); w.Code != 200 {
		t.Fatalf("reprice catalog: %d %s", w.Code, w.Body.String())
	}
	if r := save(clerk, []map[string]any{
		{"productId": product, "name": "拼豆材料包", "quantity": 1, "unitPriceCents": 10000},
		{"name": "计时 90 分钟", "quantity": 1, "unitPriceCents": 5800},
	}); r.code != 200 {
		t.Fatalf("clerk keeps the existing price and adds a service line: %d %s", r.code, r.body)
	}
	// 店长可以改价
	if r := save(manager, []map[string]any{{"productId": product, "name": "拼豆材料包", "quantity": 1, "unitPriceCents": 8000}}); r.code != 200 {
		t.Fatalf("manager reprices: %d %s", r.code, r.body)
	}
	if got := auditsOf("order.lines.updated"); len(got) != 3 || got[2].ActorID != manager.User.ID {
		t.Fatalf("every saved line change is audited: %d", len(got))
	}

	// 计时：改开始时间、取消都留审计
	table := seedTable(t, s, "Z1", "测试区", 1, 2, true)
	start := s.now().Add(-30 * time.Minute)
	opened := call(t, s, http.MethodPost, "/api/v2/venue-sessions", clerk.AccessToken, id(), map[string]any{"serviceTableId": table.ID, "startedAt": start.Format(time.RFC3339), "timingMode": "timed", "durationMinutes": 120})
	if opened.Code != 201 {
		t.Fatalf("open session: %d %s", opened.Code, opened.Body.String())
	}
	sessionID := decodeMap(t, opened)["id"].(string)
	if w := call(t, s, http.MethodPatch, "/api/v2/venue-sessions/"+sessionID, clerk.AccessToken, id(), map[string]any{"startedAt": s.now().Add(-10 * time.Minute).Format(time.RFC3339)}); w.Code != 200 {
		t.Fatalf("shift start: %d %s", w.Code, w.Body.String())
	}
	if got := auditsOf("venue_session.timing_changed"); len(got) != 1 || got[0].ActorID != clerk.User.ID || got[0].ObjectID != sessionID {
		t.Fatalf("timing audit: %+v", got)
	}
	if w := call(t, s, http.MethodPatch, "/api/v2/venue-sessions/"+sessionID, clerk.AccessToken, id(), map[string]any{"status": "paused"}); w.Code != 200 {
		t.Fatalf("pause: %d %s", w.Code, w.Body.String())
	}
	if got := auditsOf("venue_session.timing_changed"); len(got) != 1 {
		t.Fatal("pausing is routine and should not be audited as a timing change")
	}
	if w := call(t, s, http.MethodDelete, "/api/v2/venue-sessions/"+sessionID, clerk.AccessToken, id(), nil); w.Code != 204 {
		t.Fatalf("cancel: %d %s", w.Code, w.Body.String())
	}
	if got := auditsOf("venue_session.cancelled"); len(got) != 1 || got[0].ActorID != clerk.User.ID || !strings.Contains(got[0].Reason, "定时 120 分钟") {
		t.Fatalf("cancel audit: %+v", got)
	}
}

type httpResult struct {
	code int
	body string
}
