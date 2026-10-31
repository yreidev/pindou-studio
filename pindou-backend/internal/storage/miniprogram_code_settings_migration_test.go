package storage

import (
	"context"
	"testing"

	"github.com/yreidev/pindou-studio/pindou-backend/internal/testdb"
)

// 迁移 023（小程序码指向的版本改由老板设置）：从 022 的库升上来是空表（按体验版），
// 只能有一行、只收微信认的三个版本、修改人必须是真实账户。
func TestMigration023AddsMiniprogramCodeSettings(t *testing.T) {
	ctx := context.Background()
	pool := openPool(t, testdb.New(t))
	if err := runMigrate(t, pool, migrationsThrough(t, 22)); err != nil {
		t.Fatal(err)
	}
	var owner string
	if err := pool.QueryRow(ctx, `INSERT INTO accounts(id,nickname,phone,phone_verification_status,created_at,state) VALUES (gen_random_uuid(),'老板','13800138000','unverified',now(),'{}') RETURNING id`).Scan(&owner); err != nil {
		t.Fatal(err)
	}

	if err := runMigrate(t, pool, embeddedMigrations(t)); err != nil {
		t.Fatal(err)
	}
	var rows int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM miniprogram_code_settings`).Scan(&rows); err != nil || rows != 0 {
		t.Fatalf("升上来应当是空表：%d %v", rows, err)
	}
	save := func(id bool, env, account string) error {
		_, err := pool.Exec(ctx, `INSERT INTO miniprogram_code_settings(id, env_version, updated_by, updated_at) VALUES ($1, $2, $3, now())
			ON CONFLICT (id) DO UPDATE SET env_version = excluded.env_version, updated_by = excluded.updated_by, updated_at = excluded.updated_at`, id, env, account)
		return err
	}
	for _, env := range []string{"trial", "release", "develop"} {
		if err := save(true, env, owner); err != nil {
			t.Fatalf("保存 %s：%v", env, err)
		}
	}
	for label, err := range map[string]error{
		"第二行":    save(false, "trial", owner),
		"不认识的版本": save(true, "beta", owner),
		"不存在的账户": save(true, "trial", "00000000-0000-4000-8000-000000000000"),
	} {
		if err == nil {
			t.Errorf("%s应当被拒", label)
		}
	}
	var env string
	if err := pool.QueryRow(ctx, `SELECT env_version FROM miniprogram_code_settings`).Scan(&env); err != nil || env != "develop" {
		t.Fatalf("被拒的写入不该改动已存的版本：%q %v", env, err)
	}
}
