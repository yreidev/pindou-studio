package app

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// 流水记操作人（ActorID）之前的旧流水（state 里没有这个键）不可改写：之后的写入不能碰它们，
// 否则 immutable_record 触发器会拒绝、整次写入失败。新流水的操作人落库，另一个进程读得到。
func TestPostgresMovementActorKeepsLegacyRows(t *testing.T) {
	dsn, db, s := openSessionServer(t)
	owner := register(t, s, "actor-owner", "老板")
	if err := s.BootstrapOwner(owner.User.ID); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	beans := id()
	// 一笔记操作人之前的流水：第一次落库就是旧格式（state 里没有 ActorID 键）
	item := &inventoryItem{ID: id(), ProductID: beans, Quantity: 3}
	edit(t, s, func(q *txn) { q.addStockItem(item) })
	legacyID := id()
	edit(t, s, func(q *txn) {
		q.addMovementRecord(&movement{ID: legacyID, InventoryItemID: item.ID, Kind: "purchase", Reason: id(), QuantityDelta: 3, CreatedAt: s.now().Add(-time.Hour)})
	})

	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	hasActorKey := func(movementID string) bool {
		t.Helper()
		var has bool
		if err := conn.QueryRow(ctx, `SELECT state ? 'ActorID' FROM stock_ledger_entries WHERE id = $1`, movementID).Scan(&has); err != nil {
			t.Fatal(err)
		}
		return has
	}
	if hasActorKey(legacyID) {
		t.Fatal("旧流水的 state 不该带 ActorID 键")
	}

	// 新的一笔入库要碰同一个库存项目：旧流水必须原样留着，否则这次采购整体失败
	if w := call(t, s, http.MethodPost, "/api/v2/stock-receipts", owner.AccessToken, id(), map[string]any{
		"supplierName": "豆子批发", "items": []map[string]any{{"productId": beans, "quantity": 5, "unitCostCents": 120}},
	}); w.Code != http.StatusCreated {
		t.Fatalf("purchase after legacy row: %d %s", w.Code, w.Body.String())
	}
	if hasActorKey(legacyID) {
		t.Fatal("旧流水被改写了")
	}

	restarted := restartServer(t, db)
	if len(movementsOf(t, restarted)) != 2 {
		t.Fatalf("重启后应有 2 笔流水：%d", len(movementsOf(t, restarted)))
	}
	for _, m := range movementsOf(t, restarted) {
		want := owner.User.ID
		if m.ID == legacyID {
			want = ""
		}
		if m.ActorID != want {
			t.Fatalf("流水 %s 的操作人 %q，期望 %q", m.ID, m.ActorID, want)
		}
	}
}
