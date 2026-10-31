package app

import (
	"net/http"
	"testing"
)

// 采购和盘点和订单写请求一样：同键同内容重放，同键换了内容是冲突，换个操作者不共用。
func TestStockWritesBindIdempotencyToContentAndActor(t *testing.T) {
	s := newTestServer(t)
	owner := register(t, s, "stock-idem-owner", "Owner")
	if err := s.BootstrapOwner(owner.User.ID); err != nil {
		t.Fatal(err)
	}
	manager := register(t, s, "stock-idem-manager", "Manager")
	if w := call(t, s, http.MethodPost, "/api/v2/staff-role-assignments", owner.AccessToken, id(), map[string]any{"accountId": manager.User.ID, "role": "manager"}); w.Code != http.StatusCreated {
		t.Fatalf("assign manager: %d %s", w.Code, w.Body.String())
	}
	product := id()
	type result struct {
		Code int
		Body string
	}
	purchase := func(bearer, key string, quantity int) result {
		w := call(t, s, http.MethodPost, "/api/v2/stock-receipts", bearer, key, map[string]any{"supplierName": "供应商", "items": []map[string]any{{"productId": product, "quantity": quantity, "unitCostCents": 100}}})
		return result{w.Code, w.Body.String()}
	}

	first := purchase(owner.AccessToken, "receipt-1", 5)
	if first.Code != http.StatusCreated {
		t.Fatalf("purchase: %d %s", first.Code, first.Body)
	}
	if again := purchase(owner.AccessToken, "receipt-1", 5); again.Code != http.StatusCreated || again.Body != first.Body {
		t.Fatalf("same key and content must replay: %d %s", again.Code, again.Body)
	}
	if changed := purchase(owner.AccessToken, "receipt-1", 9); changed.Code != http.StatusConflict {
		t.Fatalf("same key with different content must conflict: %d %s", changed.Code, changed.Body)
	}
	if other := purchase(manager.AccessToken, "receipt-1", 5); other.Code != http.StatusCreated || other.Body == first.Body {
		t.Fatalf("another operator must not receive the first operator's replay: %d %s", other.Code, other.Body)
	}
	item := stockByProductOf(t, s, product)
	quantity, itemID := item.Quantity, item.ID
	if quantity != 10 {
		t.Fatalf("stock quantity=%d, want 10 (two receipts of 5)", quantity)
	}

	adjust := func(delta int) int {
		return call(t, s, http.MethodPost, "/api/v2/stock-adjustments", owner.AccessToken, "count-1", map[string]any{"stockItemId": itemID, "quantityDelta": delta, "reason": "盘点"}).Code
	}
	if got := adjust(-1); got != http.StatusCreated {
		t.Fatalf("adjust: %d", got)
	}
	if got := adjust(-2); got != http.StatusConflict {
		t.Fatalf("adjustment key reused with different content: %d", got)
	}
}

// 不是 UUID 的商品编号在内存里能过，落库转 uuid 时才失败，只能换来 503。进门就拒。
func TestProductIDsMustBeUUIDs(t *testing.T) {
	s := newTestServer(t)
	owner := register(t, s, "product-id-owner", "Owner")
	if err := s.BootstrapOwner(owner.User.ID); err != nil {
		t.Fatal(err)
	}
	receipt := call(t, s, http.MethodPost, "/api/v2/stock-receipts", owner.AccessToken, id(), map[string]any{"supplierName": "供应商", "items": []map[string]any{{"productId": "not-a-uuid", "quantity": 1, "unitCostCents": 100}}})
	if receipt.Code != http.StatusBadRequest {
		t.Fatalf("purchase with a non-UUID product: %d %s", receipt.Code, receipt.Body.String())
	}
	created := call(t, s, http.MethodPost, "/api/v2/sales-orders", owner.AccessToken, id(), map[string]any{})
	order := decodeMap(t, created)
	lines := call(t, s, http.MethodPatch, "/api/v2/sales-orders/"+order["id"].(string), owner.AccessToken, id(), map[string]any{
		"expectedVersion": order["version"],
		"lines":           []map[string]any{{"productId": "zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz", "name": "豆", "quantity": 1, "unitPriceCents": 100}},
	})
	if lines.Code != http.StatusBadRequest {
		t.Fatalf("order line with a non-UUID product: %d %s", lines.Code, lines.Body.String())
	}
}
