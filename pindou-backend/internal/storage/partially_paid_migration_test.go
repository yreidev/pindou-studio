package storage

import (
	"context"
	"testing"

	"github.com/yreidev/pindou-studio/pindou-backend/internal/testdb"
)

// 迁移 021（分笔付款，多人合付）：从 020 的库升上来，已有的草稿、已付款订单原样不动，旧版本写的草稿、收款、退款照常写入；
// 订单可以是 partially_paid（部分付款）。部分付款的单由触发器守着：明细、折扣、应收、顾客、所属会话都不能改，付款只追加、
// 已收只增不减，状态只能留着或收齐变 paid，不能删、不能回草稿或作废、不能退款；明细的行同样不能改、不能删。
// 还有部分付款订单的会话不能撤销（滚动发布时旧版本撤销开台只作废草稿，会让这张单永远收不齐）。
func TestMigration021GuardsPartiallyPaidOrders(t *testing.T) {
	ctx := context.Background()
	pool := openPool(t, testdb.New(t))
	if err := runMigrate(t, pool, migrationsThrough(t, 20)); err != nil {
		t.Fatal(err)
	}
	var area, table, session, draft, paid string
	for _, step := range []struct {
		sql  string
		args []any
		into *string
	}{
		{`INSERT INTO floor_areas(id,name,grid_columns,grid_rows,locked,state) VALUES (gen_random_uuid(),'A 区',4,4,false,'{}') RETURNING id`, nil, &area},
		{`INSERT INTO service_tables(id,floor_area_id,number,seat_count,enabled,state,code) VALUES (gen_random_uuid(),$1,1,2,true,'{"Code":"A1"}','A1') RETURNING id`, []any{&area}, &table},
		{`INSERT INTO venue_sessions(id,service_table_id,status,started_at,duration_minutes,state,seat_number) VALUES (gen_random_uuid(),$1,'active',now(),60,'{"status":"active"}',0) RETURNING id`, []any{&table}, &session},
		{`INSERT INTO sales_orders(id,venue_session_id,status,receivable_cents,paid_cents,created_at,state) VALUES (gen_random_uuid(),$1,'draft',10000,0,now(),'{"lines":[{"name":"1小时","quantity":1,"unitPriceCents":10000}]}') RETURNING id`, []any{&session}, &draft},
		{`INSERT INTO sales_orders(id,status,receivable_cents,paid_cents,created_at,state) VALUES (gen_random_uuid(),'paid',2990,2990,now(),'{"payments":[{"id":"p","method":"cash","amountCents":2990}]}') RETURNING id`, nil, &paid},
	} {
		args := make([]any, 0, len(step.args))
		for _, a := range step.args {
			args = append(args, *(a.(*string)))
		}
		if err := pool.QueryRow(ctx, step.sql, args...).Scan(step.into); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(ctx, `INSERT INTO sales_order_lines(sales_order_id,line_index,name,quantity,unit_price_cents) VALUES ($1,1,'1小时',1,10000)`, draft); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE sales_orders SET status='partially_paid' WHERE id=$1`, draft); err == nil {
		t.Fatal("前置条件：021 之前的库不该收 partially_paid")
	}

	if err := runMigrate(t, pool, embeddedMigrations(t)); err != nil {
		t.Fatal(err)
	}
	var status string
	var cents int64
	if err := pool.QueryRow(ctx, `SELECT status, paid_cents FROM sales_orders WHERE id = $1`, paid).Scan(&status, &cents); err != nil || status != "paid" || cents != 2990 {
		t.Fatalf("迁移动了已付款订单：%s %d %v", status, cents, err)
	}
	// 旧版本照常：已付款订单追加退款
	if _, err := pool.Exec(ctx, `UPDATE sales_orders SET status='refunded', state=state || '{"refunds":[{"id":"r","amountCents":2990}],"status":"refunded"}' WHERE id=$1`, paid); err != nil {
		t.Fatalf("已付款订单照常能追加退款：%v", err)
	}

	// 草稿收了第一笔、没收齐：部分付款
	first := `{"lines":[{"name":"1小时","quantity":1,"unitPriceCents":10000}],"status":"partially_paid","paidCents":4000,"payments":[{"id":"a","method":"wechat","amountCents":4000}]}`
	if _, err := pool.Exec(ctx, `UPDATE sales_orders SET status='partially_paid', paid_cents=4000, state=$2 WHERE id=$1`, draft, first); err != nil {
		t.Fatalf("草稿变部分付款：%v", err)
	}

	rejected := map[string]string{
		"回到草稿":    `UPDATE sales_orders SET status='draft' WHERE id=$1`,
		"作废":      `UPDATE sales_orders SET status='voided' WHERE id=$1`,
		"直接变已退款":  `UPDATE sales_orders SET status='refunded' WHERE id=$1`,
		"改应收":     `UPDATE sales_orders SET receivable_cents=9000 WHERE id=$1`,
		"已收变少":    `UPDATE sales_orders SET paid_cents=3000 WHERE id=$1`,
		"换顾客":     `UPDATE sales_orders SET account_id=NULL, venue_session_id=NULL WHERE id=$1`,
		"改明细":     `UPDATE sales_orders SET state=jsonb_set(state,'{lines,0,unitPriceCents}','9000') WHERE id=$1`,
		"加折扣":     `UPDATE sales_orders SET state=state || '{"discounts":[{"id":"d","kind":"fixed","amountCents":100}]}' WHERE id=$1`,
		"加退款":     `UPDATE sales_orders SET state=state || '{"refunds":[{"id":"r","amountCents":100}]}' WHERE id=$1`,
		"删掉已收的一笔": `UPDATE sales_orders SET state=jsonb_set(state,'{payments}','[]') WHERE id=$1`,
		"删订单":     `DELETE FROM sales_orders WHERE id=$1`,
		"改明细行":    `UPDATE sales_order_lines SET unit_price_cents=9000 WHERE sales_order_id=$1`,
		"删明细行":    `DELETE FROM sales_order_lines WHERE sales_order_id=$1`,
		// 旧版本（不认识 member 等新键）把订单读出来再整条写回，丢了键也算改写
		"整条改写丢键": `UPDATE sales_orders SET state=state - 'lines' WHERE id=$1`,
	}
	for name, sql := range rejected {
		if _, err := pool.Exec(ctx, sql, draft); err == nil {
			t.Fatalf("%s：部分付款的单应当拒收", name)
		}
	}
	// 撤销开台：这一台还有部分付款的单，旧版本把会话改成 cancelled 被拒
	if _, err := pool.Exec(ctx, `UPDATE venue_sessions SET status='cancelled' WHERE id=$1`, session); err == nil {
		t.Fatal("有部分付款订单的会话不能撤销")
	}
	// 会话别的改动照常（停止计时、换桌写的是 state）
	if _, err := pool.Exec(ctx, `UPDATE venue_sessions SET state='{"status":"active","stoppedAt":"2026-10-06T10:00:00Z"}' WHERE id=$1`, session); err != nil {
		t.Fatalf("会话照常能改：%v", err)
	}

	// 收下一笔、收齐：付款只追加，状态变 paid
	second := `{"lines":[{"name":"1小时","quantity":1,"unitPriceCents":10000}],"status":"partially_paid","paidCents":7000,"payments":[{"id":"a","method":"wechat","amountCents":4000},{"id":"b","method":"cash","amountCents":3000}]}`
	if _, err := pool.Exec(ctx, `UPDATE sales_orders SET paid_cents=7000, state=$2 WHERE id=$1`, draft, second); err != nil {
		t.Fatalf("收下一笔：%v", err)
	}
	settled := `{"lines":[{"name":"1小时","quantity":1,"unitPriceCents":10000}],"status":"paid","paidCents":7000,"payments":[{"id":"a","method":"wechat","amountCents":4000},{"id":"b","method":"cash","amountCents":3000},{"id":"c","method":"comp","amountCents":3000,"reason":"老顾客"}]}`
	if _, err := pool.Exec(ctx, `UPDATE sales_orders SET status='paid', state=$2 WHERE id=$1`, draft, settled); err != nil {
		t.Fatalf("对剩余免单、结清：%v", err)
	}
	// 结清之后会话可以结清；已付款的单照旧只能追加退款
	if _, err := pool.Exec(ctx, `UPDATE venue_sessions SET status='settled' WHERE id=$1`, session); err != nil {
		t.Fatalf("结清会话：%v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE sales_orders SET status='partially_paid' WHERE id=$1`, draft); err == nil {
		t.Fatal("已付款订单不能回到部分付款")
	}

	// 旧版本照常：新草稿可以写、改明细、作废；没有部分付款订单的会话可以撤销
	var other, otherOrder string
	if err := pool.QueryRow(ctx, `INSERT INTO venue_sessions(id,service_table_id,status,started_at,duration_minutes,state,seat_number) VALUES (gen_random_uuid(),$1,'active',now(),60,'{"status":"active"}',0) RETURNING id`, table).Scan(&other); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO sales_orders(id,venue_session_id,status,receivable_cents,paid_cents,created_at,state) VALUES (gen_random_uuid(),$1,'draft',100,0,now(),'{}') RETURNING id`, other).Scan(&otherOrder); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE sales_orders SET receivable_cents=200, state='{"lines":[]}' WHERE id=$1`, otherOrder); err != nil {
		t.Fatalf("草稿照常能改：%v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE sales_orders SET status='voided' WHERE id=$1`, otherOrder); err != nil {
		t.Fatalf("草稿照常能作废：%v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE venue_sessions SET status='cancelled' WHERE id=$1`, other); err != nil {
		t.Fatalf("没有部分付款订单的会话照常能撤销：%v", err)
	}
}
