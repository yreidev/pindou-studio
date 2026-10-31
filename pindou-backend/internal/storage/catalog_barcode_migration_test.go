package storage

import (
	"context"
	"strings"
	"testing"

	"github.com/yreidev/pindou-studio/pindou-backend/internal/testdb"
)

// 迁移 018（商品条码）：从 017 的库升上来，已有商品（有资料的、只因被库存引用而占位的）原样不动、条码为空；
// 滚动发布时 0.0.15 照旧写商品资料（下面是它原样的写入语句），不带条码也能写，而且不会冲掉新版本登记的条码；
// 条码只收 1–64 个可打印 ASCII，同一条码只能属于一件商品，没登记条码的商品可以有任意多件。
func TestMigration018AddsUniqueBarcodeToCatalogItems(t *testing.T) {
	ctx := context.Background()
	pool := openPool(t, testdb.New(t))
	if err := runMigrate(t, pool, migrationsThrough(t, 17)); err != nil {
		t.Fatal(err)
	}
	// 017 的库里已有一件有资料的商品，和一件只入过库、没建资料的占位商品（名称就是编号）
	var beads, placeholder string
	if err := pool.QueryRow(ctx, `INSERT INTO catalog_items(id,name,unit_price_cents) VALUES (gen_random_uuid(),'拼豆 5mm 白',1200) RETURNING id`).Scan(&beads); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO catalog_items(id,name,unit_price_cents) SELECT id, id::text, 0 FROM (SELECT gen_random_uuid() AS id) x RETURNING id`).Scan(&placeholder); err != nil {
		t.Fatal(err)
	}

	if err := runMigrate(t, pool, embeddedMigrations(t)); err != nil {
		t.Fatal(err)
	}
	var name string
	var price int64
	var barcode *string
	if err := pool.QueryRow(ctx, `SELECT name, unit_price_cents, barcode FROM catalog_items WHERE id = $1`, beads).Scan(&name, &price, &barcode); err != nil ||
		name != "拼豆 5mm 白" || price != 1200 || barcode != nil {
		t.Fatalf("迁移动了已有商品：%q %d %v %v", name, price, barcode, err)
	}

	setBarcode := func(id string, code any) error {
		_, err := pool.Exec(ctx, `UPDATE catalog_items SET barcode = $2 WHERE id = $1`, id, code)
		return err
	}
	if err := setBarcode(beads, "6901234567892"); err != nil {
		t.Fatalf("登记 EAN-13：%v", err)
	}
	// 0.0.15 写商品资料的语句（records.go 的 Catalog），一字不改：只写名称和售价
	oldSave := `INSERT INTO catalog_items(id,name,unit_price_cents) SELECT key::uuid,value->>'name',(value->>'unitPriceCents')::bigint FROM jsonb_each(COALESCE(NULLIF($1::jsonb->'Catalog','null'),'{}')) ON CONFLICT(id) DO UPDATE SET name=excluded.name,unit_price_cents=excluded.unit_price_cents WHERE (catalog_items.name,catalog_items.unit_price_cents) IS DISTINCT FROM (excluded.name,excluded.unit_price_cents)`
	doc := `{"Catalog":{"` + beads + `":{"id":"` + beads + `","name":"拼豆 5mm 白（新包装）","unitPriceCents":1300},"8d0f3c1e-2b4a-4c6d-9e8f-0a1b2c3d4e5f":{"id":"8d0f3c1e-2b4a-4c6d-9e8f-0a1b2c3d4e5f","name":"旧版本新建的商品","unitPriceCents":500}}}`
	if _, err := pool.Exec(ctx, oldSave, doc); err != nil {
		t.Fatalf("0.0.15 写商品资料：%v", err)
	}
	if err := pool.QueryRow(ctx, `SELECT name, unit_price_cents, barcode FROM catalog_items WHERE id = $1`, beads).Scan(&name, &price, &barcode); err != nil ||
		name != "拼豆 5mm 白（新包装）" || price != 1300 || barcode == nil || *barcode != "6901234567892" {
		t.Fatalf("旧版本改名改价后条码应当还在：%q %d %v %v", name, price, barcode, err)
	}
	var newCount int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM catalog_items WHERE barcode IS NULL`).Scan(&newCount); err != nil || newCount != 2 {
		t.Fatalf("占位商品和旧版本新建的商品都没有条码，可以同时存在：%d %v", newCount, err)
	}

	// 同一条码只能属于一件商品
	if err := setBarcode(placeholder, "6901234567892"); err == nil || !strings.Contains(err.Error(), "catalog_items_barcode") {
		t.Fatalf("同一条码登记到第二件商品应当撞唯一索引：%v", err)
	}
	// Code128 区分大小写、可以带符号
	if err := setBarcode(placeholder, "Ab-12/x"); err != nil {
		t.Fatalf("Code128 样式的条码：%v", err)
	}
	if err := setBarcode(placeholder, "AB-12/X"); err != nil {
		t.Fatalf("大小写不同是不同的条码：%v", err)
	}
	for label, code := range map[string]string{
		"空串":      "",
		"带空格":     "690 123",
		"带制表符":    "690\t123",
		"中文":      "条码123",
		"全角数字":    "６９０１",
		"超过 64 位": strings.Repeat("1", 65),
	} {
		if err := setBarcode(beads, code); err == nil {
			t.Fatalf("%s：数据库应当拒收", label)
		}
	}
	if err := setBarcode(beads, strings.Repeat("9", 64)); err != nil {
		t.Fatalf("64 位正好可以：%v", err)
	}
	// 清除条码：回到 NULL
	if err := setBarcode(beads, nil); err != nil {
		t.Fatalf("清除条码：%v", err)
	}
}
