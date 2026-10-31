package storage

import (
	"context"
	"testing"

	"github.com/yreidev/pindou-studio/pindou-backend/internal/testdb"
)

// 迁移 017（现金实收与找零）：从 016 的库升上来，已有的付款记录原样不动、两列为空；
// 之后没填实收的付款照旧写入（滚动发布时旧版本就是这样写的），填了的只收合规的：
// 只有现金能有实收，实收不少于收款金额，找零正好是两者之差，两列要么都有要么都没有。付款记录写入后仍不能改。
func TestMigration017AddsCashTenderToPaymentRecords(t *testing.T) {
	ctx := context.Background()
	pool := openPool(t, testdb.New(t))
	if err := runMigrate(t, pool, migrationsThrough(t, 16)); err != nil {
		t.Fatal(err)
	}
	// 016 的库里已有一张收过现金的单
	var order, old string
	if err := pool.QueryRow(ctx, `INSERT INTO sales_orders(id,status,receivable_cents,paid_cents,created_at,state)
 VALUES (gen_random_uuid(),'paid',2990,2990,now(),'{}') RETURNING id`).Scan(&order); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO payment_records(id,sales_order_id,method,amount_cents,created_at,state)
 VALUES (gen_random_uuid(),$1,'cash',2990,now(),'{}') RETURNING id`, order).Scan(&old); err != nil {
		t.Fatal(err)
	}

	if err := runMigrate(t, pool, embeddedMigrations(t)); err != nil {
		t.Fatal(err)
	}
	var amount int64
	var received, change *int64
	if err := pool.QueryRow(ctx, `SELECT amount_cents, cash_received_cents, change_cents FROM payment_records WHERE id = $1`, old).
		Scan(&amount, &received, &change); err != nil || amount != 2990 || received != nil || change != nil {
		t.Fatalf("迁移动了已有的付款：%d %v %v %v", amount, received, change, err)
	}

	insert := func(method string, amount int64, received, change *int64) error {
		_, err := pool.Exec(ctx, `INSERT INTO payment_records(id,sales_order_id,method,amount_cents,created_at,cash_received_cents,change_cents,state)
 VALUES (gen_random_uuid(),$1,$2,$3,now(),$4,$5,'{}')`, order, method, amount, received, change)
		return err
	}
	ptr := func(v int64) *int64 { return &v }
	// 旧版本写的、没填实收的：两列都空
	if _, err := pool.Exec(ctx, `INSERT INTO payment_records(id,sales_order_id,method,amount_cents,created_at,state)
 VALUES (gen_random_uuid(),$1,'wechat',100,now(),'{}')`, order); err != nil {
		t.Fatalf("不带新列的写入：%v", err)
	}
	if err := insert("cash", 2990, ptr(5000), ptr(2010)); err != nil {
		t.Fatalf("实收 50 元找零 20.10：%v", err)
	}
	if err := insert("cash", 2990, ptr(2990), ptr(0)); err != nil {
		t.Fatalf("刚好不用找零：%v", err)
	}
	for name, err := range map[string]error{
		"微信不能有实收":    insert("wechat", 2990, ptr(5000), ptr(2010)),
		"储值支付不能有实收":  insert("balance", 2990, ptr(5000), ptr(2010)),
		"实收少于收款金额":   insert("cash", 2990, ptr(2000), ptr(-990)),
		"找零不等于实收减收款": insert("cash", 2990, ptr(5000), ptr(2000)),
		"只有实收没有找零":   insert("cash", 2990, ptr(5000), nil),
		"只有找零没有实收":   insert("cash", 2990, nil, ptr(0)),
	} {
		if err == nil {
			t.Fatalf("%s：数据库应当拒收", name)
		}
	}
	// 付款记录只追加：记下的实收、找零不能事后改
	if _, err := pool.Exec(ctx, `UPDATE payment_records SET cash_received_cents = 10000, change_cents = 7010 WHERE cash_received_cents = 5000`); err == nil {
		t.Fatal("付款记录的实收不能改写")
	}
	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM payment_records WHERE sales_order_id = $1 AND cash_received_cents IS NOT NULL`, order).Scan(&n); err != nil || n != 2 {
		t.Fatalf("应当正好两笔带实收：%d %v", n, err)
	}
}
