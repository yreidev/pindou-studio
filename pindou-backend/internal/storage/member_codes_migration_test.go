package storage

import (
	"context"
	"strings"
	"testing"

	"github.com/yreidev/pindou-studio/pindou-backend/internal/testdb"
)

// 迁移 019（会员码与网页报到）：从 018 的库升上来，已有账户原样不动；member_codes 只收合规的码
// （64 位十六进制哈希、真实账户、到期晚于签发、同一哈希只一条），web_presences 是 UNLOGGED，
// 同一条连接再报到就是续期。
func TestMigration019AddsMemberCodesAndWebPresences(t *testing.T) {
	ctx := context.Background()
	pool := openPool(t, testdb.New(t))
	if err := runMigrate(t, pool, migrationsThrough(t, 18)); err != nil {
		t.Fatal(err)
	}
	var alice string
	if err := pool.QueryRow(ctx, `INSERT INTO accounts(id,nickname,phone_verification_status,created_at,state) VALUES (gen_random_uuid(),'Alice','unverified',now(),'{"Nickname":"Alice"}') RETURNING id`).Scan(&alice); err != nil {
		t.Fatal(err)
	}

	if err := runMigrate(t, pool, embeddedMigrations(t)); err != nil {
		t.Fatal(err)
	}
	var nickname string
	if err := pool.QueryRow(ctx, `SELECT nickname FROM accounts WHERE id = $1`, alice).Scan(&nickname); err != nil || nickname != "Alice" {
		t.Fatalf("迁移动了已有账户：%q %v", nickname, err)
	}

	hash := strings.Repeat("ab", 32)
	insert := func(hash, account, ttl string) error {
		_, err := pool.Exec(ctx, `INSERT INTO member_codes(token_hash, account_id, created_at, expires_at) VALUES ($1, $2, now(), now() + $3::interval)`, hash, account, ttl)
		return err
	}
	if err := insert(hash, alice, "90 seconds"); err != nil {
		t.Fatalf("登记一个会员码：%v", err)
	}
	for label, err := range map[string]error{
		"同一哈希两条":  insert(hash, alice, "90 seconds"),
		"不是哈希":    insert("91234567890123456789", alice, "90 seconds"),
		"大写十六进制":  insert(strings.Repeat("AB", 32), alice, "90 seconds"),
		"不存在的账户":  insert(strings.Repeat("cd", 32), "8d0f3c1e-2b4a-4c6d-9e8f-0a1b2c3d4e5f", "90 seconds"),
		"到期不晚于签发": insert(strings.Repeat("ef", 32), alice, "0 seconds"),
	} {
		if err == nil {
			t.Fatalf("%s 应当被拒", label)
		}
	}

	var persistence string
	if err := pool.QueryRow(ctx, `SELECT relpersistence FROM pg_class WHERE relname = 'web_presences'`).Scan(&persistence); err != nil || persistence != "u" {
		t.Fatalf("web_presences 应当是 UNLOGGED：%q %v", persistence, err)
	}
	put := `INSERT INTO web_presences(connection_id, account_id, expires_at) VALUES ('11111111-1111-4111-8111-111111111111', $1, now() + $2::interval)
	ON CONFLICT (connection_id) DO UPDATE SET expires_at = excluded.expires_at`
	for _, ttl := range []string{"75 seconds", "150 seconds"} {
		if _, err := pool.Exec(ctx, put, alice, ttl); err != nil {
			t.Fatalf("报到 %s：%v", ttl, err)
		}
	}
	var rows int
	var online bool
	if err := pool.QueryRow(ctx, `SELECT count(*), bool_and(expires_at > now() + interval '100 seconds') FROM web_presences`).Scan(&rows, &online); err != nil || rows != 1 || !online {
		t.Fatalf("同一条连接再报到应当只续期：%d %v %v", rows, online, err)
	}
}
