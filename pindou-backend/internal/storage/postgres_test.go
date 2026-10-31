package storage

import (
	"context"
	"testing"

	"github.com/yreidev/pindou-studio/pindou-backend/internal/testdb"
)

func TestPostgresMigrationAndStateRoundTrip(t *testing.T) {
	dsn := testdb.New(t)
	ctx := context.Background()
	db, err := Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, table := range []string{"accounts", "account_wechat_identities", "web_logins", "staff_role_assignments", "floor_areas", "service_tables", "venue_sessions", "catalog_items", "stock_items", "stock_ledger_entries", "stock_receipts", "stock_adjustments", "sales_orders", "payment_records", "refund_records", "audit_events", "auth_sessions"} {
		var present bool
		if err := db.pool.QueryRow(ctx, `SELECT to_regclass('public.' || $1) IS NOT NULL`, table).Scan(&present); err != nil {
			t.Fatal(err)
		}
		if !present {
			t.Fatalf("migration did not create %s", table)
		}
	}
	for _, column := range []struct{ table, name string }{
		{"account_wechat_identities", "account_id"},
		{"staff_role_assignments", "account_id"}, {"service_tables", "floor_area_id"},
		{"venue_sessions", "service_table_id"}, {"venue_sessions", "account_id"},
		{"stock_items", "catalog_item_id"}, {"stock_ledger_entries", "stock_item_id"},
		{"sales_orders", "venue_session_id"}, {"sales_orders", "account_id"},
		{"sales_order_lines", "sales_order_id"}, {"sales_order_lines", "catalog_item_id"},
		{"payment_records", "sales_order_id"}, {"refund_records", "sales_order_id"}, {"audit_events", "actor_account_id"},
	} {
		var present bool
		if err := db.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2)`, column.table, column.name).Scan(&present); err != nil {
			t.Fatal(err)
		}
		if !present {
			t.Fatalf("migration did not rename %s.%s", column.table, column.name)
		}
	}
	// 迁移在咨询锁里执行：两个进程同时启动（滚动发布），只有一个在跑迁移，另一个等它跑完，都能正常连上。
	errs := make(chan error, 2)
	for range 2 {
		go func() {
			other, err := Open(ctx, dsn)
			if err == nil {
				other.Close()
			}
			errs <- err
		}()
	}
	for range 2 {
		if err := <-errs; err != nil {
			t.Fatalf("concurrent startup: %v", err)
		}
	}
}
