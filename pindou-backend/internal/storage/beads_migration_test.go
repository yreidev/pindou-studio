package storage

import (
	"context"
	"strings"
	"testing"

	"github.com/yreidev/pindou-studio/pindou-backend/internal/testdb"
)

// 迁移 027（顾客的「做图纸」工具）：从 026 的库升上来，已有的账户照旧；店里的豆子设置只有一行，图纸只收合规的行——
// 格子正好宽×高个字符、缩略格子对得上自己的宽高、颗数不超过格数、拼完的不超过颗数，账户要真的存在。
func TestMigration027AddsBeadMaker(t *testing.T) {
	ctx := context.Background()
	pool := openPool(t, testdb.New(t))
	if err := runMigrate(t, pool, migrationsThrough(t, 26)); err != nil {
		t.Fatal(err)
	}
	var customer string
	if err := pool.QueryRow(ctx, `INSERT INTO accounts(id,nickname,phone_verification_status,created_at,state) VALUES (gen_random_uuid(),'小林','unverified',now(),'{}') RETURNING id`).Scan(&customer); err != nil {
		t.Fatal(err)
	}
	if err := runMigrate(t, pool, embeddedMigrations(t)); err != nil {
		t.Fatal(err)
	}
	var nickname string
	if err := pool.QueryRow(ctx, `SELECT nickname FROM accounts WHERE id = $1`, customer).Scan(&nickname); err != nil || nickname != "小林" {
		t.Fatalf("已有的账户应照旧：%q %v", nickname, err)
	}

	settings := func(id, size string) error {
		_, err := pool.Exec(ctx, `INSERT INTO bead_settings(id,palette,available,boxes,board_size,bead_size,revision,updated_by,updated_at)
			VALUES ($1::boolean,'mard-221',NULL,'{"A1":"1"}',52,$2,1,$3,now())`, id, size, customer)
		return err
	}
	if err := settings("true", "mini"); err != nil {
		t.Fatalf("存店里的设置：%v", err)
	}
	for label, err := range map[string]error{"第二行": settings("false", "mini"), "豆子大小不认识": settings("true", "huge")} {
		if err == nil {
			t.Fatalf("%s 应被拒绝", label)
		}
	}
	if _, err := pool.Exec(ctx, `UPDATE bead_settings SET boxes = '[]'`); err == nil {
		t.Fatal("盒号要是对象")
	}

	pattern := func(account, cells, preview string, width, height, previewWidth, beads, done int) error {
		_, err := pool.Exec(ctx, `INSERT INTO bead_patterns(id,account_id,name,palette,width,height,colors,cells,done,preview,preview_width,preview_height,
			beads,done_beads,revision,created_at,updated_at)
			VALUES (gen_random_uuid(),$1,'小猫','mard-221',$2,$3,'{A1,H7}',$4,'',$5,$6,1,$7,$8,1,now(),now())`,
			account, width, height, cells, preview, previewWidth, beads, done)
		return err
	}
	cells := "0101" + "1..." + "...." + "...." // 4×4，4 颗
	if err := pattern(customer, cells, "01", 4, 4, 2, 4, 1); err != nil {
		t.Fatalf("存一张图纸：%v", err)
	}
	// 最大 300×300（2026-10-21）
	if err := pattern(customer, strings.Repeat("0", 300*300), "0", 300, 300, 1, 300*300, 0); err != nil {
		t.Fatalf("存一张 300×300 的图纸：%v", err)
	}
	for label, err := range map[string]error{
		"格子数不对":      pattern(customer, cells[:15], "01", 4, 4, 2, 4, 0),
		"缩略格子和宽高对不上": pattern(customer, cells, "011", 4, 4, 2, 4, 0),
		"颗数超过格数":     pattern(customer, cells, "01", 4, 4, 2, 17, 0),
		"拼完的超过颗数":    pattern(customer, cells, "01", 4, 4, 2, 4, 5),
		"太小":         pattern(customer, cells[:9], "01", 3, 3, 2, 4, 0),
		"太大":         pattern(customer, strings.Repeat("0", 301*4), "0", 301, 4, 1, 4, 0),
		"账户不存在":      pattern("00000000-0000-4000-8000-000000000000", cells, "01", 4, 4, 2, 4, 0),
	} {
		if err == nil {
			t.Fatalf("%s 应被拒绝", label)
		}
	}
	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM bead_patterns WHERE account_id = $1`, customer).Scan(&n); err != nil || n != 2 {
		t.Fatalf("应只存下合规的两张：%d %v", n, err)
	}
}
