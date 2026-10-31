package app

import (
	"net/http"
	"testing"
	"time"
)

// 库存流水：网页后台「流水」标签页的数据来源。时间倒序；按库存项目、门店日期筛选；
// 采购带出供应商与备注、盘点带出原因；所有员工可读，顾客与未登录不行。
func TestStockMovementsListNewestFirstWithFilters(t *testing.T) {
	s := newTestServer(t)
	owner := register(t, s, "movement-owner", "Owner")
	if err := s.BootstrapOwner(owner.User.ID); err != nil {
		t.Fatal(err)
	}
	clerk := register(t, s, "movement-clerk", "Clerk")
	if w := call(t, s, http.MethodPost, "/api/v2/staff-role-assignments", owner.AccessToken, id(), map[string]any{"accountId": clerk.User.ID, "role": "clerk"}); w.Code != http.StatusCreated {
		t.Fatalf("assign clerk: %d %s", w.Code, w.Body.String())
	}
	customer := register(t, s, "movement-customer", "Customer")

	// 北京时间 10-04 01:00 是 UTC 的 10-03 —— 按门店日期筛选时它属于 10-04。
	clock := time.Date(2026, 10, 3, 17, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return clock }
	beans, pegboard := id(), id()
	receipt := call(t, s, http.MethodPost, "/api/v2/stock-receipts", clerk.AccessToken, id(), map[string]any{
		"supplierName": "豆子批发", "note": "发票 0921",
		"items": []map[string]any{{"productId": beans, "quantity": 5, "unitCostCents": 120}},
	})
	if receipt.Code != http.StatusCreated {
		t.Fatalf("purchase: %d %s", receipt.Code, receipt.Body.String())
	}
	purchaseID := decodeMap(t, receipt)["id"].(string)

	clock = clock.Add(time.Hour)
	if w := call(t, s, http.MethodPost, "/api/v2/stock-receipts", clerk.AccessToken, id(), map[string]any{
		"supplierName": "板子厂", "items": []map[string]any{{"productId": pegboard, "quantity": 3, "unitCostCents": 800}},
	}); w.Code != http.StatusCreated {
		t.Fatalf("second purchase: %d %s", w.Code, w.Body.String())
	}
	beansItem := stockByProductOf(t, s, beans).ID

	clock = clock.Add(time.Hour)
	if w := call(t, s, http.MethodPost, "/api/v2/stock-adjustments", owner.AccessToken, id(), map[string]any{"stockItemId": beansItem, "quantityDelta": -1, "reason": "盘点少 1 包"}); w.Code != http.StatusCreated {
		t.Fatalf("adjust: %d %s", w.Code, w.Body.String())
	}

	all := call(t, s, http.MethodGet, "/api/v2/stock-movements", clerk.AccessToken, "", nil)
	if all.Code != http.StatusOK {
		t.Fatalf("clerk lists movements: %d %s", all.Code, all.Body.String())
	}
	rows := decodeList(t, all)
	if len(rows) != 3 {
		t.Fatalf("want 3 movements, got %d: %s", len(rows), all.Body.String())
	}
	if rows[0]["kind"] != "adjustment" || rows[0]["quantityDelta"] != float64(-1) || rows[0]["reason"] != "盘点少 1 包" || rows[0]["productId"] != beans || rows[0]["stockItemId"] != beansItem {
		t.Fatalf("newest first should be the adjustment with its reason: %v", rows[0])
	}
	if rows[1]["kind"] != "purchase" || rows[1]["productId"] != pegboard || rows[1]["supplierName"] != "板子厂" {
		t.Fatalf("second row should be the pegboard purchase: %v", rows[1])
	}
	if rows[2]["kind"] != "purchase" || rows[2]["referenceId"] != purchaseID || rows[2]["supplierName"] != "豆子批发" || rows[2]["note"] != "发票 0921" || rows[2]["quantityDelta"] != float64(5) {
		t.Fatalf("oldest row should be the beans purchase with supplier and note: %v", rows[2])
	}
	if _, leaked := rows[2]["reason"]; leaked {
		t.Fatalf("purchase rows carry the receipt id as referenceId, not as reason: %v", rows[2])
	}
	// 每条带办理的员工：盘点是老板，两笔采购是店员；名字由后端换算，店员看流水不用另查账户
	if rows[0]["actorId"] != owner.User.ID || rows[0]["actorName"] != "Owner" {
		t.Fatalf("adjustment actor: %v", rows[0])
	}
	for _, row := range rows[1:] {
		if row["actorId"] != clerk.User.ID || row["actorName"] != "Clerk" {
			t.Fatalf("purchase actor: %v", row)
		}
	}

	byItem := decodeList(t, call(t, s, http.MethodGet, "/api/v2/stock-movements?stockItemId="+beansItem, clerk.AccessToken, "", nil))
	if len(byItem) != 2 || byItem[0]["kind"] != "adjustment" || byItem[1]["kind"] != "purchase" {
		t.Fatalf("filter by stock item: %v", byItem)
	}
	// 门店日期 10-04 覆盖全部三条（第一条是 UTC 10-03 17:00）；10-03 一条都没有。
	if got := decodeList(t, call(t, s, http.MethodGet, "/api/v2/stock-movements?from=2026-10-04&to=2026-10-04", owner.AccessToken, "", nil)); len(got) != 3 {
		t.Fatalf("store date 10-04 should include all three movements, got %d", len(got))
	}
	if got := decodeList(t, call(t, s, http.MethodGet, "/api/v2/stock-movements?to=2026-10-03", owner.AccessToken, "", nil)); len(got) != 0 {
		t.Fatalf("store date 10-03 should be empty, got %v", got)
	}

	if w := call(t, s, http.MethodGet, "/api/v2/stock-movements?stockItemId=not-a-uuid", clerk.AccessToken, "", nil); w.Code != http.StatusBadRequest {
		t.Fatalf("bad stock item id: %d", w.Code)
	}
	if w := call(t, s, http.MethodGet, "/api/v2/stock-movements?from=2026-10-05&to=2026-10-04", clerk.AccessToken, "", nil); w.Code != http.StatusBadRequest {
		t.Fatalf("reversed date range: %d", w.Code)
	}
	if w := call(t, s, http.MethodGet, "/api/v2/stock-movements", customer.AccessToken, "", nil); w.Code != http.StatusForbidden {
		t.Fatalf("customer must not read the ledger: %d", w.Code)
	}
	if w := call(t, s, http.MethodGet, "/api/v2/stock-movements", "", "", nil); w.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous must not read the ledger: %d", w.Code)
	}
}
