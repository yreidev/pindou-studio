package app

import (
	"net/http"
	"testing"
	"time"
)

// 超出整数列范围的数量、时长在接口就拒绝（400 + 中文说明），不留到落库才失败：
// 那样店员看到的是「数据没能保存，请重试」，重试也没用。
func TestOversizedQuantitiesAndMinutesAreRejectedUpFront(t *testing.T) {
	s := newTestServer(t)
	owner := register(t, s, "bounds-owner", "老板")
	if err := s.BootstrapOwner(owner.User.ID); err != nil {
		t.Fatal(err)
	}
	product := decodeMap(t, call(t, s, http.MethodPost, "/api/v2/catalog-items", owner.AccessToken, id(), map[string]any{"name": "拼豆", "unitPriceCents": 100}))["id"].(string)
	order := &Order{ID: id(), Status: "draft", CreatedAt: s.now()}
	edit(t, s, func(q *txn) { q.addOrder(order) })
	table := seedTable(t, s, "B1", "测试区", 1, 2, true)

	for name, w := range map[string]func() int{
		"line quantity": func() int {
			return call(t, s, http.MethodPatch, "/api/v2/sales-orders/"+order.ID, owner.AccessToken, id(), map[string]any{"expectedVersion": orderOf(t, s, order.ID).Version(), "lines": []map[string]any{{"productId": product, "name": "拼豆", "quantity": 10_000, "unitPriceCents": 100}}}).Code
		},
		"session minutes": func() int {
			return call(t, s, http.MethodPost, "/api/v2/venue-sessions", owner.AccessToken, id(), map[string]any{"serviceTableId": table.ID, "startedAt": s.now().Add(-time.Minute).Format(time.RFC3339), "timingMode": "timed", "durationMinutes": 24*60 + 1}).Code
		},
		"purchase quantity": func() int {
			return call(t, s, http.MethodPost, "/api/v2/stock-receipts", owner.AccessToken, id(), map[string]any{"supplierName": "供应商", "items": []map[string]any{{"productId": product, "quantity": 1_000_001, "unitCostCents": 100}}}).Code
		},
	} {
		if got := w(); got != http.StatusBadRequest && got != http.StatusConflict {
			t.Fatalf("%s: %d", name, got)
		}
	}
	if len(sessionsOf(t, s)) != 0 || len(orderOf(t, s, order.ID).Lines) != 0 || len(purchasesOf(t, s)) != 0 {
		t.Fatal("an oversized value got into the state")
	}
}
