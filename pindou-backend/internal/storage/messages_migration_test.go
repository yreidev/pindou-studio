package storage

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/yreidev/pindou-studio/pindou-backend/internal/testdb"
)

// 从 027 的隔离库升级，已有账户与会员流水不变，已读时间按账户独立保存并受主键、外键和非空约束保护。
func TestMigration028AddsMessageReads(t *testing.T) {
	ctx := context.Background()
	pool := openPool(t, testdb.New(t))
	if err := runMigrate(t, pool, migrationsThrough(t, 27)); err != nil {
		t.Fatal(err)
	}
	var accounts [2]string
	for i := range accounts {
		if err := pool.QueryRow(ctx, `INSERT INTO accounts(id,nickname,phone_verification_status,created_at,state)
			VALUES (gen_random_uuid(),'小林','unverified',now(),'{"nickname":"小林"}') RETURNING id`).Scan(&accounts[i]); err != nil {
			t.Fatal(err)
		}
	}
	var entry string
	if err := pool.QueryRow(ctx, `INSERT INTO membership_entries(id,account_id,kind,principal_cents,gift_cents,created_at,state)
		VALUES (gen_random_uuid(),$1,'adjust',0,0,now(),'{"kind":"adjust","reason":"已有流水"}') RETURNING state::text`, accounts[0]).Scan(&entry); err != nil {
		t.Fatal(err)
	}
	if err := runMigrate(t, pool, embeddedMigrations(t)); err != nil {
		t.Fatal(err)
	}
	var nickname, state string
	var n int
	if err := pool.QueryRow(ctx, `SELECT nickname FROM accounts WHERE id=$1`, accounts[0]).Scan(&nickname); err != nil || nickname != "小林" {
		t.Fatalf("已有账户变化：%s %v", nickname, err)
	}
	if err := pool.QueryRow(ctx, `SELECT state::text FROM membership_entries WHERE account_id=$1`, accounts[0]).Scan(&state); err != nil || state != entry {
		t.Fatalf("已有流水变化：%s %v", state, err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM message_reads`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("升级后不应替顾客标已读：%d %v", n, err)
	}
	at := time.Date(2026, 10, 27, 2, 0, 0, 0, time.UTC)
	for i, account := range accounts {
		if _, err := pool.Exec(ctx, `INSERT INTO message_reads(account_id,read_at) VALUES ($1,$2)`, account, at.Add(time.Duration(i)*time.Hour)); err != nil {
			t.Fatal(err)
		}
	}
	for _, tc := range []struct {
		label, sql, code string
	}{
		{"同一账户第二行", `INSERT INTO message_reads(account_id,read_at) SELECT account_id,read_at FROM message_reads LIMIT 1`, "23505"},
		{"账户不存在", `INSERT INTO message_reads(account_id,read_at) VALUES ('00000000-0000-4000-8000-000000000000',now())`, "23503"},
		{"没有已读时刻", `UPDATE message_reads SET read_at=NULL`, "23502"},
	} {
		_, err := pool.Exec(ctx, tc.sql)
		var pgErr *pgconn.PgError
		if !errors.As(err, &pgErr) || pgErr.Code != tc.code {
			t.Errorf("%s 应被约束拒绝（%s）：%v", tc.label, tc.code, err)
		}
	}
	if _, err := pool.Exec(ctx, `UPDATE message_reads SET read_at=$2 WHERE account_id=$1`, accounts[0], at.Add(2*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := runMigrate(t, pool, embeddedMigrations(t)); err != nil {
		t.Fatal(err)
	}
	for i, account := range accounts {
		var got time.Time
		want := at.Add(time.Duration(2-i) * time.Hour)
		if err := pool.QueryRow(ctx, `SELECT read_at FROM message_reads WHERE account_id=$1`, account).Scan(&got); err != nil || !got.Equal(want) {
			t.Errorf("账户 %d 的已读时间应独立保留：%s %v", i, got, err)
		}
	}
}
