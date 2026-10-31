package storage

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/yreidev/pindou-studio/pindou-backend/internal/testdb"
)

func TestMigration029AddsMiniappVersionObservation(t *testing.T) {
	ctx := context.Background()
	pool := openPool(t, testdb.New(t))
	if err := runMigrate(t, pool, migrationsThrough(t, 28)); err != nil {
		t.Fatal(err)
	}
	var account string
	if err := pool.QueryRow(ctx, `INSERT INTO accounts(id,nickname,phone_verification_status,created_at,state)
		VALUES (gen_random_uuid(),'已有顾客','unverified',now(),'{"nickname":"已有顾客"}') RETURNING id`).Scan(&account); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO membership_entries(id,account_id,kind,principal_cents,gift_cents,created_at,state)
		VALUES (gen_random_uuid(),$1,'adjust',100,20,now(),'{"kind":"adjust","reason":"原有余额"}')`, account); err != nil {
		t.Fatal(err)
	}
	if err := runMigrate(t, pool, embeddedMigrations(t)); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM miniapp_version_observation`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("迁移后不能虚构版本：%d %v", count, err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO miniapp_version_observation(version,reported_at) VALUES ('0.0.39',now())`); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ name, sql, code string }{
		{"重复记录", `INSERT INTO miniapp_version_observation(version,reported_at) VALUES ('0.0.40',now())`, "23505"},
		{"第二行", `INSERT INTO miniapp_version_observation(id,version,reported_at) VALUES (false,'0.0.40',now())`, "23514"},
		{"无效版本", `UPDATE miniapp_version_observation SET version='dev'`, "23514"},
		{"过长版本", `UPDATE miniapp_version_observation SET version=repeat('1',30)||'.0.0'`, "23514"},
		{"空版本", `UPDATE miniapp_version_observation SET version=NULL`, "23502"},
		{"空时间", `UPDATE miniapp_version_observation SET reported_at=NULL`, "23502"},
	} {
		_, err := pool.Exec(ctx, tc.sql)
		var pgErr *pgconn.PgError
		if !errors.As(err, &pgErr) || pgErr.Code != tc.code {
			t.Errorf("%s 应返回 %s：%v", tc.name, tc.code, err)
		}
	}
	if err := runMigrate(t, pool, embeddedMigrations(t)); err != nil {
		t.Fatal(err)
	}
	var version, nickname string
	var principal, gift int64
	if err := pool.QueryRow(ctx, `SELECT version FROM miniapp_version_observation`).Scan(&version); err != nil || version != "0.0.39" {
		t.Fatalf("重复迁移不能覆盖记录：%s %v", version, err)
	}
	if err := pool.QueryRow(ctx, `SELECT nickname FROM accounts WHERE id=$1`, account).Scan(&nickname); err != nil || nickname != "已有顾客" {
		t.Fatalf("已有账户应保留：%s %v", nickname, err)
	}
	if err := pool.QueryRow(ctx, `SELECT principal_cents,gift_cents FROM membership_entries WHERE account_id=$1`, account).Scan(&principal, &gift); err != nil || principal != 100 || gift != 20 {
		t.Fatalf("已有资金流水应保留：%d %d %v", principal, gift, err)
	}
}
