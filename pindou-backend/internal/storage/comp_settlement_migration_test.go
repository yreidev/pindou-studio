package storage

import (
	"context"
	"testing"

	"github.com/yreidev/pindou-studio/pindou-backend/internal/testdb"
)

// 迁移 020（免单）：从 019 的库升上来（019 是会员码，没有它的分支上就是 018），已有的付款记录原样不动；之后旧版本写的现金、微信、支付宝、储值付款照常写入，
// 免单（comp）的结清记录可以写入、金额至少 1 分，不认识的付款方式照旧拒收。付款记录（含免单）写入后仍不能改、不能删。
func TestMigration020AllowsCompSettlement(t *testing.T) {
	ctx := context.Background()
	pool := openPool(t, testdb.New(t))
	if err := runMigrate(t, pool, migrationsThrough(t, 19)); err != nil {
		t.Fatal(err)
	}
	var order, old string
	if err := pool.QueryRow(ctx, `INSERT INTO sales_orders(id,status,receivable_cents,paid_cents,created_at,state)
 VALUES (gen_random_uuid(),'paid',2990,2990,now(),'{}') RETURNING id`).Scan(&order); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO payment_records(id,sales_order_id,method,amount_cents,created_at,state)
 VALUES (gen_random_uuid(),$1,'cash',2990,now(),'{}') RETURNING id`, order).Scan(&old); err != nil {
		t.Fatal(err)
	}
	insert := func(method string, amount int64) error {
		_, err := pool.Exec(ctx, `INSERT INTO payment_records(id,sales_order_id,method,amount_cents,created_at,state)
 VALUES (gen_random_uuid(),$1,$2,$3,now(),jsonb_build_object('method',$2::text,'reason','老顾客生日'))`, order, method, amount)
		return err
	}
	if insert("comp", 2990) == nil {
		t.Fatal("前置条件：020 之前的库不该收 comp")
	}

	if err := runMigrate(t, pool, embeddedMigrations(t)); err != nil {
		t.Fatal(err)
	}
	var method string
	var amount int64
	if err := pool.QueryRow(ctx, `SELECT method, amount_cents FROM payment_records WHERE id = $1`, old).Scan(&method, &amount); err != nil || method != "cash" || amount != 2990 {
		t.Fatalf("迁移动了已有的付款：%s %d %v", method, amount, err)
	}
	for _, m := range []string{"cash", "wechat", "alipay", "balance"} {
		if err := insert(m, 100); err != nil {
			t.Fatalf("旧版本写的 %s 付款照常写入：%v", m, err)
		}
	}
	if err := insert("comp", 2990); err != nil {
		t.Fatalf("免单结清记录应当能写入：%v", err)
	}
	_, cashOnComp := pool.Exec(ctx, `INSERT INTO payment_records(id,sales_order_id,method,amount_cents,created_at,cash_received_cents,change_cents,state)
 VALUES (gen_random_uuid(),$1,'comp',2990,now(),3000,10,'{}')`, order)
	for name, err := range map[string]error{
		"免单金额为 0":   insert("comp", 0),
		"不认识的付款方式":  insert("voucher", 100),
		"免单不能带现金实收": cashOnComp,
	} {
		if err == nil {
			t.Fatalf("%s：数据库应当拒收", name)
		}
	}
	// 免单记录同样只追加：不能改成别的付款方式，也不能删掉
	if _, err := pool.Exec(ctx, `UPDATE payment_records SET method = 'cash' WHERE method = 'comp'`); err == nil {
		t.Fatal("免单记录不能改写")
	}
	if _, err := pool.Exec(ctx, `DELETE FROM payment_records WHERE method = 'comp'`); err == nil {
		t.Fatal("免单记录不能删除")
	}
}
