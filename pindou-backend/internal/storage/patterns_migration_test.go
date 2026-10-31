package storage

import (
	"context"
	"testing"

	"github.com/yreidev/pindou-studio/pindou-backend/internal/testdb"
)

// 迁移 025（新首页与员工上传的图纸）：从 024 的库升上来，预置四个启用的分类、没有图纸和公告；分类不能重名，
// 上架的图纸必须记着第一次上架的时刻，图片类型只认 JPEG、PNG；公告只能有一行、修改人必须是真实账户。
func TestMigration025AddsPatternsAndAnnouncement(t *testing.T) {
	ctx := context.Background()
	pool := openPool(t, testdb.New(t))
	if err := runMigrate(t, pool, migrationsThrough(t, 24)); err != nil {
		t.Fatal(err)
	}
	var owner string
	if err := pool.QueryRow(ctx, `INSERT INTO accounts(id,nickname,phone,phone_verification_status,created_at,state) VALUES (gen_random_uuid(),'老板','13800138000','unverified',now(),'{}') RETURNING id`).Scan(&owner); err != nil {
		t.Fatal(err)
	}

	if err := runMigrate(t, pool, embeddedMigrations(t)); err != nil {
		t.Fatal(err)
	}
	rows, err := pool.Query(ctx, `SELECT name FROM pattern_categories WHERE enabled AND updated_by IS NULL ORDER BY position`)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatal(err)
		}
		names = append(names, name)
	}
	rows.Close()
	if got := len(names); got != 4 || names[0] != "新手" || names[3] != "花草" {
		t.Fatalf("预置分类：%v", names)
	}
	var patterns, notices int
	if err := pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM patterns), (SELECT count(*) FROM storefront_announcement)`).Scan(&patterns, &notices); err != nil || patterns != 0 || notices != 0 {
		t.Fatalf("升上来应当没有图纸和公告：%d %d %v", patterns, notices, err)
	}

	var category string
	if err := pool.QueryRow(ctx, `SELECT id FROM pattern_categories WHERE name='水果'`).Scan(&category); err != nil {
		t.Fatal(err)
	}
	exec := func(sql string, args ...any) error {
		_, err := pool.Exec(ctx, sql, args...)
		return err
	}
	insert := func(published bool, first, kind string) error {
		return exec(`INSERT INTO patterns(id,name,category_id,published,first_published_at,position,image,image_type,thumbnail,width,height,image_version,created_by,created_at,updated_by,updated_at)
			VALUES (gen_random_uuid(),'草莓',$1,$2,NULLIF($3,'')::timestamptz,1,'\x89'::bytea,$4,'\xff'::bytea,10,10,'abc',$5,now(),$5,now())`, category, published, first, kind, owner)
	}
	if err := insert(true, "2026-10-20T10:00:00+08:00", "image/png"); err != nil {
		t.Fatalf("上架的图纸：%v", err)
	}
	if err := insert(false, "", "image/jpeg"); err != nil {
		t.Fatalf("没上架的图纸：%v", err)
	}
	announce := func(id bool, body, account string) error {
		return exec(`INSERT INTO storefront_announcement(id,body,expires_on,updated_by,updated_at) VALUES ($1,$2,NULL,$3,now())`, id, body, account)
	}
	if err := announce(true, "国庆照常营业", owner); err != nil {
		t.Fatalf("公告：%v", err)
	}
	for label, err := range map[string]error{
		"重名的分类":      exec(`INSERT INTO pattern_categories(id,name,position,enabled,created_at,updated_at) VALUES (gen_random_uuid(),'水果',5,true,now(),now())`),
		"超过 10 字的分类": exec(`INSERT INTO pattern_categories(id,name,position,enabled,created_at,updated_at) VALUES (gen_random_uuid(),'一二三四五六七八九十一',5,true,now(),now())`),
		"上架却没记第一次上架": insert(true, "", "image/png"),
		"GIF 图片":     insert(false, "", "image/gif"),
		"第二条公告":      announce(false, "又一条", owner),
		"空公告":        exec(`UPDATE storefront_announcement SET body=''`),
		"公告修改人不存在":   exec(`UPDATE storefront_announcement SET updated_by='00000000-0000-4000-8000-000000000000'`),
	} {
		if err == nil {
			t.Errorf("%s应当被拒", label)
		}
	}
}
