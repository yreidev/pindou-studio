package app

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
)

type stockStaffFixture struct {
	owner, manager, clerk, customer sessionResponse
}

// stockStaff 登记老板、店长、店员和一位顾客。
func stockStaff(t *testing.T, s *Server, prefix string) stockStaffFixture {
	t.Helper()
	f := stockStaffFixture{owner: register(t, s, prefix+"-owner", "Owner")}
	if err := s.BootstrapOwner(f.owner.User.ID); err != nil {
		t.Fatal(err)
	}
	f.manager = register(t, s, prefix+"-manager", "Manager")
	f.clerk = register(t, s, prefix+"-clerk", "Clerk")
	for account, role := range map[string]string{f.manager.User.ID: "manager", f.clerk.User.ID: "clerk"} {
		if w := call(t, s, http.MethodPost, "/api/v2/staff-role-assignments", f.owner.AccessToken, id(), map[string]any{"accountId": account, "role": role}); w.Code != http.StatusCreated {
			t.Fatalf("assign %s: %d %s", role, w.Code, w.Body.String())
		}
	}
	f.customer = register(t, s, prefix+"-customer", "Customer")
	return f
}

// receiveStock 登记一笔采购入库，返回这个商品的库存项目编号。
func receiveStock(t *testing.T, s *Server, bearer, product string, quantity int) string {
	t.Helper()
	w := call(t, s, http.MethodPost, "/api/v2/stock-receipts", bearer, id(), map[string]any{
		"supplierName": "豆子批发", "items": []map[string]any{{"productId": product, "quantity": quantity, "unitCostCents": 100}},
	})
	if w.Code != http.StatusCreated {
		t.Fatalf("purchase: %d %s", w.Code, w.Body.String())
	}
	return stockByProductOf(t, s, product).ID
}

func auditsWithAction(t *testing.T, s *Server, action string) []*auditLog {
	t.Helper()
	var out []*auditLog
	for _, a := range auditsOf(t, s) {
		if a.Action == action {
			out = append(out, a)
		}
	}
	return out
}

func stockRow(t *testing.T, s *Server, bearer, itemID string) map[string]any {
	t.Helper()
	for _, row := range decodeList(t, call(t, s, http.MethodGet, "/api/v2/stock-items", bearer, "", nil)) {
		if row["id"] == itemID {
			return row
		}
	}
	t.Fatalf("stock item %s missing from the list", itemID)
	return nil
}

// 预警线：只有店长、老板能改，只收 alertAt，要幂等键，改了写审计；库存不高于预警线就算偏低。
func TestStockAlertUpdatedByManagersOnly(t *testing.T) {
	s := newTestServer(t)
	staff := stockStaff(t, s, "stock-alert")
	itemID := receiveStock(t, s, staff.clerk.AccessToken, id(), 3)
	path := "/api/v2/stock-items/" + itemID
	movementsBefore := len(movementsOf(t, s))

	for name, bearer := range map[string]string{"clerk": staff.clerk.AccessToken, "customer": staff.customer.AccessToken} {
		if w := call(t, s, http.MethodPatch, path, bearer, id(), map[string]any{"alertAt": 5}); w.Code != http.StatusForbidden {
			t.Fatalf("%s must not change the alert line: %d %s", name, w.Code, w.Body.String())
		}
	}
	if w := call(t, s, http.MethodPatch, path, "", id(), map[string]any{"alertAt": 5}); w.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous: %d", w.Code)
	}
	if w := call(t, s, http.MethodPatch, path, staff.manager.AccessToken, "", map[string]any{"alertAt": 5}); w.Code != http.StatusBadRequest || decodeMap(t, w)["code"] != "idempotency_required" {
		t.Fatalf("missing idempotency key: %d %s", w.Code, w.Body.String())
	}
	for name, body := range map[string]any{
		"negative":       map[string]any{"alertAt": -1},
		"too large":      map[string]any{"alertAt": maxStockAlert + 1},
		"missing":        map[string]any{},
		"fraction":       map[string]any{"alertAt": 1.5},
		"quantity field": map[string]any{"alertAt": 5, "quantity": 99},
	} {
		w := call(t, s, http.MethodPatch, path, staff.manager.AccessToken, id(), body)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("%s: %d %s", name, w.Code, w.Body.String())
		}
		if code := decodeMap(t, w)["code"]; code != "invalid_stock_alert" && code != "invalid_request" {
			t.Fatalf("%s: code=%v", name, code)
		}
	}
	if w := call(t, s, http.MethodPatch, path, staff.manager.AccessToken, id(), map[string]any{"alertAt": -1}); !strings.Contains(decodeMap(t, w)["message"].(string), "预警线") {
		t.Fatalf("validation message should be readable Chinese: %s", w.Body.String())
	}
	for _, missing := range []string{id(), "not-a-uuid"} {
		if w := call(t, s, http.MethodPatch, "/api/v2/stock-items/"+missing, staff.manager.AccessToken, id(), map[string]any{"alertAt": 5}); w.Code != http.StatusNotFound {
			t.Fatalf("unknown stock item %q: %d %s", missing, w.Code, w.Body.String())
		}
	}
	if got := stockRow(t, s, staff.owner.AccessToken, itemID); got["alertAt"] != float64(0) {
		t.Fatalf("rejected requests changed the alert line: %v", got)
	}
	if got := auditsWithAction(t, s, "stock.alert_updated"); len(got) != 0 {
		t.Fatalf("rejected requests wrote audit: %v", got)
	}

	updated := call(t, s, http.MethodPatch, path, staff.manager.AccessToken, "alert-1", map[string]any{"alertAt": 5})
	if updated.Code != http.StatusOK {
		t.Fatalf("manager updates the alert line: %d %s", updated.Code, updated.Body.String())
	}
	if got := decodeMap(t, updated); got["id"] != itemID || got["alertAt"] != float64(5) || got["quantity"] != float64(3) || got["lowStock"] != true {
		t.Fatalf("response should be the stock item with the new alert line: %v", got)
	}
	if got := stockRow(t, s, staff.clerk.AccessToken, itemID); got["alertAt"] != float64(5) || got["lowStock"] != true || got["quantity"] != float64(3) {
		t.Fatalf("list after update: %v", got)
	}

	if again := call(t, s, http.MethodPatch, path, staff.manager.AccessToken, "alert-1", map[string]any{"alertAt": 5}); again.Code != http.StatusOK || again.Body.String() != updated.Body.String() {
		t.Fatalf("same key and content must replay: %d %s", again.Code, again.Body.String())
	}
	if changed := call(t, s, http.MethodPatch, path, staff.manager.AccessToken, "alert-1", map[string]any{"alertAt": 6}); changed.Code != http.StatusConflict || decodeMap(t, changed)["code"] != "idempotency_conflict" {
		t.Fatalf("same key with different content: %d %s", changed.Code, changed.Body.String())
	}

	audits := auditsWithAction(t, s, "stock.alert_updated")
	if len(audits) != 1 || audits[0].ActorID != staff.manager.User.ID || audits[0].ObjectID != itemID || audits[0].Reason != "预警线 0 件 → 5 件" {
		t.Fatalf("audit after one change: %+v", audits)
	}

	if w := call(t, s, http.MethodPatch, path, staff.owner.AccessToken, id(), map[string]any{"alertAt": 2}); w.Code != http.StatusOK || decodeMap(t, w)["lowStock"] != false {
		t.Fatalf("owner lowers the alert line below the quantity: %d %s", w.Code, w.Body.String())
	}
	// 和库存相等也算偏低。
	if w := call(t, s, http.MethodPatch, path, staff.owner.AccessToken, id(), map[string]any{"alertAt": 3}); decodeMap(t, w)["lowStock"] != true {
		t.Fatalf("quantity equal to the alert line is low: %s", w.Body.String())
	}
	// 没变就不再记一笔审计。
	if w := call(t, s, http.MethodPatch, path, staff.owner.AccessToken, id(), map[string]any{"alertAt": 3}); w.Code != http.StatusOK {
		t.Fatalf("unchanged alert line: %d %s", w.Code, w.Body.String())
	}
	if got := auditsWithAction(t, s, "stock.alert_updated"); len(got) != 3 || got[2].Reason != "预警线 2 件 → 3 件" || got[2].ActorID != staff.owner.User.ID {
		t.Fatalf("audits after owner changes: %d", len(got))
	}
	quantity, movements := stockOf(t, s, itemID).Quantity, len(movementsOf(t, s))
	if quantity != 3 || movements != movementsBefore {
		t.Fatalf("changing the alert line must not touch quantity or the ledger: quantity=%d movements=%d", quantity, movements)
	}
}

// 预警线以前一直是 0，从没真正改过；改了要随业务快照落库，重启后还在。
func TestPostgresStockAlertSurvivesRestart(t *testing.T) {
	dsn, db, s := openSessionServer(t)
	owner := register(t, s, "stock-alert-db-owner", "Owner")
	if err := s.BootstrapOwner(owner.User.ID); err != nil {
		t.Fatal(err)
	}
	itemID := receiveStock(t, s, owner.AccessToken, id(), 2)
	if w := call(t, s, http.MethodPatch, "/api/v2/stock-items/"+itemID, owner.AccessToken, id(), map[string]any{"alertAt": 4}); w.Code != http.StatusOK {
		t.Fatalf("update alert line: %d %s", w.Code, w.Body.String())
	}
	// 被拒的盘点（库存已变化）整体回滚，不落任何东西。
	if w := call(t, s, http.MethodPost, "/api/v2/stock-adjustments", owner.AccessToken, id(), map[string]any{"stockItemId": itemID, "quantityDelta": -1, "reason": "盘点", "expectedQuantity": 9}); w.Code != http.StatusConflict {
		t.Fatalf("stale adjustment: %d %s", w.Code, w.Body.String())
	}

	restarted := restartServer(t, db)
	if got := stockRow(t, restarted, owner.AccessToken, itemID); got["alertAt"] != float64(4) || got["lowStock"] != true || got["quantity"] != float64(2) {
		t.Fatalf("stock item after restart: %v", got)
	}
	if got := auditsWithAction(t, restarted, "stock.alert_updated"); len(got) != 1 {
		t.Fatalf("alert audit after restart: %d", len(got))
	}
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	var alertAt, quantity, adjustments int64
	if err := conn.QueryRow(ctx, `SELECT alert_at, quantity, (SELECT count(*) FROM stock_ledger_entries WHERE kind = 'adjustment') FROM stock_items WHERE id = $1`, itemID).Scan(&alertAt, &quantity, &adjustments); err != nil {
		t.Fatal(err)
	}
	if alertAt != 4 || quantity != 2 || adjustments != 0 {
		t.Fatalf("stored alert_at=%d quantity=%d adjustments=%d", alertAt, quantity, adjustments)
	}
}
