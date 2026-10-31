package storage

import (
	"context"
	"strings"
	"testing"

	"github.com/yreidev/pindou-studio/pindou-backend/internal/testdb"
)

// 迁移 022（顾客网页的密码登录）：从 021 的库升上来，已有账户和会话原样不动；account_passwords 只收合规的行
// （真实账户、合格式且唯一的登录手机号、argon2id 哈希、临时密码必有过期时刻），auth_sessions 多认一个 h5。
func TestMigration022AddsPasswordLogins(t *testing.T) {
	ctx := context.Background()
	pool := openPool(t, testdb.New(t))
	if err := runMigrate(t, pool, migrationsThrough(t, 21)); err != nil {
		t.Fatal(err)
	}
	var alice, bob string
	for name, out := range map[string]*string{"Alice": &alice, "Bob": &bob} {
		if err := pool.QueryRow(ctx, `INSERT INTO accounts(id,nickname,phone,phone_verification_status,created_at,state) VALUES (gen_random_uuid(),$1,'13800138000','unverified',now(),'{}') RETURNING id`, name).Scan(out); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(ctx, `INSERT INTO auth_sessions(token_hash, account_id, developer_mode, expires_at, client) VALUES ($1, $2, '', now() + interval '1 hour', 'web')`, strings.Repeat("a1", 32), alice); err != nil {
		t.Fatal(err)
	}

	if err := runMigrate(t, pool, embeddedMigrations(t)); err != nil {
		t.Fatal(err)
	}
	var client string
	if err := pool.QueryRow(ctx, `SELECT client FROM auth_sessions WHERE token_hash = $1`, strings.Repeat("a1", 32)).Scan(&client); err != nil || client != "web" {
		t.Fatalf("迁移动了已有会话：%q %v", client, err)
	}
	session := func(hash, client string) error {
		_, err := pool.Exec(ctx, `INSERT INTO auth_sessions(token_hash, account_id, developer_mode, expires_at, client) VALUES ($1, $2, '', now() + interval '1 hour', $3)`, hash, alice, client)
		return err
	}
	if err := session(strings.Repeat("b2", 32), "h5"); err != nil {
		t.Fatalf("h5 会话：%v", err)
	}
	if err := session(strings.Repeat("c3", 32), "app"); err == nil {
		t.Fatal("不认识的客户端应当被拒")
	}

	const hash = "$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNoaGFzaA"
	// temporary 为 nil 时没有临时密码的过期时刻
	put := func(account, phone, hash string, mustChange bool, temporary any) error {
		_, err := pool.Exec(ctx, `INSERT INTO account_passwords(account_id, phone, password_hash, must_change, temporary_expires_at, updated_at)
			VALUES ($1, $2, $3, $4, $5::timestamptz, now())`, account, phone, hash, mustChange, temporary)
		return err
	}
	if err := put(alice, "13800138000", hash, false, nil); err != nil {
		t.Fatalf("登记一条密码登录：%v", err)
	}
	for label, err := range map[string]error{
		"同一账户两条":      put(alice, "13900000000", hash, true, "2026-10-11T00:00:00Z"),
		"同一手机号两个账户":   put(bob, "13800138000", hash, true, "2026-10-11T00:00:00Z"),
		"手机号带空格":      put(bob, "139 0000 0000", hash, true, "2026-10-11T00:00:00Z"),
		"手机号太短":       put(bob, "12345", hash, true, "2026-10-11T00:00:00Z"),
		"不是 argon2id": put(bob, "13900000000", "$2a$10$abc", true, "2026-10-11T00:00:00Z"),
		"不存在的账户":      put("8d0f3c1e-2b4a-4c6d-9e8f-0a1b2c3d4e5f", "13900000000", hash, true, "2026-10-11T00:00:00Z"),
	} {
		if err == nil {
			t.Fatalf("%s 应当被拒", label)
		}
	}
	if err := put(bob, "+8613900000000", hash, true, nil); err == nil {
		t.Fatal("要改密码却没有临时密码的过期时刻，应当被拒")
	}
	if err := put(bob, "+8613900000000", hash, false, "2026-10-11T00:00:00Z"); err == nil {
		t.Fatal("不用改密码却有临时密码的过期时刻，应当被拒")
	}
	if err := put(bob, "+8613900000000", hash, true, "2026-10-11T00:00:00Z"); err != nil {
		t.Fatalf("带 + 的号和临时密码：%v", err)
	}
}
