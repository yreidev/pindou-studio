package app

import (
	"net/http"
	"testing"
	"time"

	member "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/membership/application"
)

// 撤销开台（误开）之后，那一台已经建好的草稿订单要跟着作废。
//
// 以前取消会话不碰订单：草稿永远挂在「待结账」里，小程序工作台和网页订单列表一直
// 提醒有一单没收，却再也收不了（会话已取消，收款被拒）。契约里早就有 voided 状态，
// 只是没有任何地方用它。
func TestCancellingASessionVoidsItsDraftOrder(t *testing.T) {
	now := time.Date(2026, 9, 20, 10, 0, 0, 0, time.UTC)
	s := newTestServer(t)
	s.now = func() time.Time { return now }
	o := register(t, s, "cancel-void-owner", "老板")
	if err := s.BootstrapOwner(o.User.ID); err != nil {
		t.Fatal(err)
	}
	publishRule(t, s, o.AccessToken, member.Rule{Kind: "package", Name: "1小时", AmountCents: 2990, DurationMinutes: 60, Overtime: "manual"})
	table := seedTable(t, s, "A1", "A", 1, 2, true)
	w := call(t, s, http.MethodPost, "/api/v2/venue-sessions", o.AccessToken, "",
		map[string]any{"serviceTableId": table.ID, "timingMode": "timed", "durationMinutes": 60, "startedAt": now.Format(time.RFC3339)})
	if w.Code != 201 {
		t.Fatalf("开台失败：%d %s", w.Code, w.Body.String())
	}
	sessionID := decodeMap(t, w)["id"].(string)
	w = call(t, s, http.MethodPost, "/api/v2/sales-orders", o.AccessToken, "cancel-void-order", map[string]any{"venueSessionId": sessionID})
	if w.Code != 201 {
		t.Fatalf("建单失败：%d %s", w.Code, w.Body.String())
	}
	orderID := decodeMap(t, w)["id"].(string)

	if w := call(t, s, http.MethodDelete, "/api/v2/venue-sessions/"+sessionID, o.AccessToken, "", nil); w.Code != 204 {
		t.Fatalf("撤销开台失败：%d %s", w.Code, w.Body.String())
	}
	if got := orderOf(t, s, orderID); got.Status != "voided" {
		t.Fatalf("撤销开台后草稿应作废，实际 %q", got.Status)
	}
	if drafts := decodeList(t, call(t, s, http.MethodGet, "/api/v2/sales-orders?status=draft", o.AccessToken, "", nil)); len(drafts) != 0 {
		t.Fatalf("作废的草稿不该再出现在待结账里：%v", drafts)
	}
	if got := decodeMap(t, call(t, s, http.MethodGet, "/api/v2/sales-orders/"+orderID, o.AccessToken, "", nil)); got["status"] != "voided" {
		t.Fatalf("订单详情应显示已作废：%v", got["status"])
	}
	voided := 0
	for _, a := range auditsOf(t, s) {
		if a.Action == "order.voided" && a.ObjectID == orderID && a.ActorID == o.User.ID {
			voided++
		}
	}
	if voided != 1 {
		t.Fatalf("作废草稿要记一条审计（谁、哪一单），实际 %d 条", voided)
	}

	// 再点一次撤销（结果没收到时的重试）：不重复记审计
	if w := call(t, s, http.MethodDelete, "/api/v2/venue-sessions/"+sessionID, o.AccessToken, "", nil); w.Code != 204 {
		t.Fatalf("重复撤销应原样成功：%d %s", w.Code, w.Body.String())
	}
	cancelled := 0
	for _, a := range auditsOf(t, s) {
		if a.Action == "venue_session.cancelled" || a.Action == "order.voided" {
			cancelled++
		}
	}
	if cancelled != 2 {
		t.Fatalf("重复撤销不该再记审计，实际取消与作废共 %d 条", cancelled)
	}
	// 作废的单不能再收款
	order := orderOf(t, s, orderID)
	if w := call(t, s, http.MethodPost, "/api/v2/sales-orders/"+orderID+"/payments", o.AccessToken, "cancel-void-pay",
		map[string]any{"method": "cash", "amountCents": order.ReceivableCents, "expectedVersion": order.Version()}); w.Code < 400 {
		t.Fatalf("作废的单不能收款：%d %s", w.Code, w.Body.String())
	}
}
