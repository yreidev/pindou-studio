package app

import (
	"net/http"
	"strings"
	"testing"
)

// 盘点带 expectedQuantity（提交时界面上的当前库存）：确认之后有人结账或入库，按旧数换算的变化量
// 就不对了，必须拒绝让人重新核对。只比这一个库存项目；不带这个字段（小程序）照旧。
func TestStockAdjustmentRejectsStaleExpectedQuantity(t *testing.T) {
	s := newTestServer(t)
	staff := stockStaff(t, s, "stock-expected")
	beans := id()
	itemID := receiveStock(t, s, staff.clerk.AccessToken, beans, 10)
	adjust := func(key string, body map[string]any) (int, map[string]any) {
		body["stockItemId"] = itemID
		w := call(t, s, http.MethodPost, "/api/v2/stock-adjustments", staff.manager.AccessToken, key, body)
		return w.Code, decodeMap(t, w)
	}
	state := func() (quantity int64, movements, audits int) {
		return stockOf(t, s, itemID).Quantity, len(movementsOf(t, s)), len(auditsOf(t, s))
	}

	if code, body := adjust(id(), map[string]any{"quantityDelta": -2, "reason": "月底盘点", "expectedQuantity": 10}); code != http.StatusCreated || body["quantity"] != float64(8) {
		t.Fatalf("matching expectedQuantity: %d %v", code, body)
	}

	// 有人在确认后结了账：界面上还是 10，库里已是 8。
	quantity, movements, audits := state()
	code, body := adjust(id(), map[string]any{"quantityDelta": -1, "reason": "月底盘点", "expectedQuantity": 10})
	if code != http.StatusConflict || body["code"] != "stock_quantity_conflict" {
		t.Fatalf("stale expectedQuantity: %d %v", code, body)
	}
	if message, _ := body["message"].(string); !strings.Contains(message, "库存已变化") || !strings.Contains(message, "8 件") {
		t.Fatalf("conflict message should say the stock changed and what it is now: %q", message)
	}
	if q, m, a := state(); q != quantity || m != movements || a != audits {
		t.Fatalf("rejected adjustment changed state: quantity %d→%d movements %d→%d audits %d→%d", quantity, q, movements, m, audits, a)
	}

	// 只看这一个库存项目：别的商品入库不影响这次盘点。
	receiveStock(t, s, staff.clerk.AccessToken, id(), 4)
	if code, body := adjust(id(), map[string]any{"quantityDelta": 1, "reason": "找到 1 包", "expectedQuantity": 8}); code != http.StatusCreated || body["quantity"] != float64(9) {
		t.Fatalf("another product's movement must not invalidate this adjustment: %d %v", code, body)
	}

	// 小程序不传 expectedQuantity：行为与以前一致。
	if code, body := adjust(id(), map[string]any{"quantityDelta": -1, "reason": "小程序盘点"}); code != http.StatusCreated || body["quantity"] != float64(8) {
		t.Fatalf("adjustment without expectedQuantity: %d %v", code, body)
	}

	if code, body := adjust(id(), map[string]any{"quantityDelta": 1, "reason": "盘点", "expectedQuantity": -1}); code != http.StatusBadRequest || body["code"] != "invalid_adjustment" {
		t.Fatalf("negative expectedQuantity: %d %v", code, body)
	}
	// 先比当前库存再看会不会变负：数对不上时说的是「库存已变化」，不是「库存不足」。
	if code, body := adjust(id(), map[string]any{"quantityDelta": -20, "reason": "盘点", "expectedQuantity": 20}); code != http.StatusConflict || body["code"] != "stock_quantity_conflict" {
		t.Fatalf("stale expectedQuantity with an over-large decrease: %d %v", code, body)
	}

	// 成功过的请求原样重放，即使库存之后又变了；重放不是新的盘点。
	first, firstBody := adjust("count-1", map[string]any{"quantityDelta": 2, "reason": "补录", "expectedQuantity": 8})
	if first != http.StatusCreated || firstBody["quantity"] != float64(10) {
		t.Fatalf("adjust before replay: %d %v", first, firstBody)
	}
	receiveStock(t, s, staff.clerk.AccessToken, beans, 1)
	if code, body := adjust("count-1", map[string]any{"quantityDelta": 2, "reason": "补录", "expectedQuantity": 8}); code != http.StatusCreated || body["quantity"] != float64(10) {
		t.Fatalf("same key and content must replay the first result: %d %v", code, body)
	}
	if code, body := adjust("count-1", map[string]any{"quantityDelta": 2, "reason": "补录", "expectedQuantity": 11}); code != http.StatusConflict || body["code"] != "idempotency_conflict" {
		t.Fatalf("same key with a different expectedQuantity: %d %v", code, body)
	}
	if q, _, _ := state(); q != 11 {
		t.Fatalf("quantity=%d, want 11", q)
	}
}

// 不带 expectedQuantity 的请求摘要必须和加这个字段之前一样：发版前记下的幂等键，
// 发版后同内容重试还要能重放，而不是被当成「同键不同内容」。
func TestStockAdjustmentFingerprintUnchangedWithoutExpectedQuantity(t *testing.T) {
	s := newTestServer(t)
	staff := stockStaff(t, s, "stock-fingerprint")
	itemID := receiveStock(t, s, staff.owner.AccessToken, id(), 5)
	if w := call(t, s, http.MethodPost, "/api/v2/stock-adjustments", staff.owner.AccessToken, "legacy-key", map[string]any{"stockItemId": itemID, "quantityDelta": -1, "reason": "盘点"}); w.Code != http.StatusCreated {
		t.Fatalf("adjust: %d %s", w.Code, w.Body.String())
	}
	legacy := struct {
		InventoryItemID string `json:"stockItemId"`
		QuantityDelta   int64  `json:"quantityDelta"`
		Reason          string `json:"reason"`
	}{itemID, -1, "盘点"}
	recorded := idemOf(t, s)["adjustment:"+staff.owner.User.ID+":legacy-key"]
	if recorded.Fingerprint != requestFingerprint(legacy) {
		t.Fatal("fingerprint of an adjustment without expectedQuantity changed")
	}
}
