package storage

import (
	"context"
	"testing"

	"github.com/yreidev/pindou-studio/pindou-backend/internal/testdb"
)

// 迁移 024（暂不在系统内收费）：从 023 的库升上来，收费开关是空表（按关），只能有一行、修改人必须是真实账户；
// 会话可以是 ended（已结束、没经过收款），已有会话原样不动。还有部分付款订单的会话不能结束（同撤销），
// 结束了的会话不能再改回进行中（滚动发布时旧版本从过期页面暂停、继续会把状态整条写回）。
func TestMigration024AddsBillingSwitchAndEndedSessions(t *testing.T) {
	ctx := context.Background()
	pool := openPool(t, testdb.New(t))
	if err := runMigrate(t, pool, migrationsThrough(t, 23)); err != nil {
		t.Fatal(err)
	}
	scan := func(into *string, sql string, args ...any) {
		t.Helper()
		if err := pool.QueryRow(ctx, sql, args...).Scan(into); err != nil {
			t.Fatal(err)
		}
	}
	var owner, area, table, live, partial string
	scan(&owner, `INSERT INTO accounts(id,nickname,phone,phone_verification_status,created_at,state) VALUES (gen_random_uuid(),'老板','13800138000','unverified',now(),'{}') RETURNING id`)
	scan(&area, `INSERT INTO floor_areas(id,name,grid_columns,grid_rows,locked,state) VALUES (gen_random_uuid(),'A 区',4,4,false,'{}') RETURNING id`)
	scan(&table, `INSERT INTO service_tables(id,floor_area_id,number,seat_count,enabled,state,code) VALUES (gen_random_uuid(),$1,1,2,true,'{"Code":"A1"}','A1') RETURNING id`, area)
	for _, into := range []*string{&live, &partial} {
		scan(into, `INSERT INTO venue_sessions(id,service_table_id,status,started_at,duration_minutes,state,seat_number) VALUES (gen_random_uuid(),$1,'active',now(),60,'{"status":"active"}',0) RETURNING id`, table)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO sales_orders(id,venue_session_id,status,receivable_cents,paid_cents,created_at,state) VALUES (gen_random_uuid(),$1,'partially_paid',10000,4000,now(),'{"status":"partially_paid","paidCents":4000,"payments":[{"id":"a","method":"wechat","amountCents":4000}]}')`, partial); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE venue_sessions SET status='ended' WHERE id=$1`, live); err == nil {
		t.Fatal("前置条件：024 之前的库不该收 ended")
	}

	if err := runMigrate(t, pool, embeddedMigrations(t)); err != nil {
		t.Fatal(err)
	}
	var rows int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM billing_settings`).Scan(&rows); err != nil || rows != 0 {
		t.Fatalf("升上来应当是空表（按关）：%d %v", rows, err)
	}
	save := func(id, enabled bool, account string) error {
		_, err := pool.Exec(ctx, `INSERT INTO billing_settings(id, enabled, updated_by, updated_at) VALUES ($1, $2, $3, now())
			ON CONFLICT (id) DO UPDATE SET enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = excluded.updated_at`, id, enabled, account)
		return err
	}
	for _, enabled := range []bool{true, false} {
		if err := save(true, enabled, owner); err != nil {
			t.Fatalf("保存 %v：%v", enabled, err)
		}
	}
	for label, err := range map[string]error{
		"第二行":    save(false, true, owner),
		"不存在的账户": save(true, true, "00000000-0000-4000-8000-000000000000"),
	} {
		if err == nil {
			t.Errorf("%s应当被拒", label)
		}
	}

	var status string
	if err := pool.QueryRow(ctx, `SELECT status FROM venue_sessions WHERE id=$1`, live).Scan(&status); err != nil || status != "active" {
		t.Fatalf("迁移动了已有会话：%s %v", status, err)
	}
	if _, err := pool.Exec(ctx, `UPDATE venue_sessions SET status='ended', state=state || '{"status":"ended"}' WHERE id=$1`, live); err != nil {
		t.Fatalf("会话应当能结束：%v", err)
	}
	for label, sql := range map[string]string{
		"结束了又改回计时中": `UPDATE venue_sessions SET status='active' WHERE id=$1`,
		"结束了又改成暂停":  `UPDATE venue_sessions SET status='paused' WHERE id=$1`,
		"结束了又撤销":    `UPDATE venue_sessions SET status='cancelled' WHERE id=$1`,
		"不认识的状态":    `UPDATE venue_sessions SET status='closed' WHERE id=$1`,
	} {
		if _, err := pool.Exec(ctx, sql, live); err == nil {
			t.Errorf("%s应当被拒", label)
		}
	}
	if _, err := pool.Exec(ctx, `UPDATE venue_sessions SET state=state || '{"stoppedAt":"2026-10-10T12:00:00Z"}' WHERE id=$1`, live); err != nil {
		t.Fatalf("结束了的会话状态不变时照常能写回：%v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE venue_sessions SET status='ended' WHERE id=$1`, partial); err == nil {
		t.Error("还有部分付款订单的会话不该能结束")
	}
	if _, err := pool.Exec(ctx, `UPDATE venue_sessions SET status='cancelled' WHERE id=$1`, partial); err == nil {
		t.Error("还有部分付款订单的会话照旧不能撤销")
	}
}
