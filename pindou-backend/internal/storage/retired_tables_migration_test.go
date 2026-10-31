package storage

import (
	"context"
	"testing"

	"github.com/yreidev/pindou-studio/pindou-backend/internal/testdb"
)

// 迁移 016（删掉没人读写的旧表和退役的登录凭证列）：从 015 的库升上来，那些表和列都没了，
// 账户的其余资料原样不动；login_name 的唯一索引随列一起去掉。拆桌表这一版还留着（0.0.12 的导出还读它）。
func TestMigration016DropsRetiredTablesAndLoginColumns(t *testing.T) {
	ctx := context.Background()
	pool := openPool(t, testdb.New(t))
	if err := runMigrate(t, pool, migrationsThrough(t, 15)); err != nil {
		t.Fatal(err)
	}
	// 015 的库里有一位老账户，还带着退役的网页登录名与密码哈希
	var account string
	if err := pool.QueryRow(ctx, `INSERT INTO accounts(id,nickname,phone,phone_verification_status,created_at,state,login_name,password_hash,password_change_required)
 VALUES (gen_random_uuid(),'老板','13800000000','verified','2026-09-01T08:00:00Z','{"nickname":"老板"}','boss','hash',true) RETURNING id`).Scan(&account); err != nil {
		t.Fatal(err)
	}

	if err := runMigrate(t, pool, embeddedMigrations(t)); err != nil {
		t.Fatal(err)
	}

	for _, table := range []string{"pindou_state", "application_state", "system_backups", "system_restore_runs", "catalog_services", "service_table_seats", "web_login_challenges", "schema_migrations"} {
		var found *string
		if err := pool.QueryRow(ctx, `SELECT to_regclass($1)::text`, "public."+table).Scan(&found); err != nil {
			t.Fatal(err)
		}
		if found != nil {
			t.Errorf("表 %s 还在", table)
		}
	}
	var columns int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM information_schema.columns WHERE table_name = 'accounts'
 AND column_name IN ('login_name','password_hash','password_change_required')`).Scan(&columns); err != nil {
		t.Fatal(err)
	}
	if columns != 0 {
		t.Fatalf("账户表还留着 %d 个退役的登录列", columns)
	}
	var index *string
	if err := pool.QueryRow(ctx, `SELECT to_regclass('public.accounts_login_name_unique')::text`).Scan(&index); err != nil || index != nil {
		t.Fatalf("login_name 的唯一索引还在：%v %v", index, err)
	}
	var nickname, phone, status, state string
	if err := pool.QueryRow(ctx, `SELECT nickname, phone, phone_verification_status, state::text FROM accounts WHERE id = $1`, account).Scan(&nickname, &phone, &status, &state); err != nil {
		t.Fatal(err)
	}
	if nickname != "老板" || phone != "13800000000" || status != "verified" || state != `{"nickname": "老板"}` {
		t.Fatalf("迁移动了账户的其余资料：%s %s %s %s", nickname, phone, status, state)
	}
	// 新账户照常建（不再需要给 password_change_required 填值）
	if _, err := pool.Exec(ctx, `INSERT INTO accounts(id,nickname,phone_verification_status,created_at,state) VALUES (gen_random_uuid(),'新顾客','unverified',now(),'{}')`); err != nil {
		t.Fatal(err)
	}
	var splits *string
	if err := pool.QueryRow(ctx, `SELECT to_regclass('public.service_table_splits')::text`).Scan(&splits); err != nil || splits == nil {
		t.Fatalf("拆桌表这一版不该删：%v %v", splits, err)
	}
}
