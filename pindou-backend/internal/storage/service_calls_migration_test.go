package storage

import (
	"context"
	"io/fs"
	"testing"
	"testing/fstest"

	"github.com/pressly/goose/v3"

	"github.com/yreidev/pindou-studio/pindou-backend/internal/testdb"
)

// migrationsThrough 是嵌入的迁移里版本号不超过 n 的那些：模拟还停在旧版本的生产库。
func migrationsThrough(t *testing.T, n int64) fs.FS {
	t.Helper()
	dir := embeddedMigrations(t)
	out := fstest.MapFS{}
	entries, err := fs.ReadDir(dir, ".")
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		version, err := goose.NumericComponent(entry.Name())
		if err != nil || version > n {
			continue
		}
		b, err := fs.ReadFile(dir, entry.Name())
		if err != nil {
			t.Fatal(err)
		}
		out[entry.Name()] = &fstest.MapFile{Data: b}
	}
	return out
}

// 迁移 015（呼叫店员）：从 014 的库升上来，已有的计时会话原样不动；新表只收合规的呼叫——
// 状态只有 pending、handled（过期是读时算的，不存），处理过的一定记着谁、何时，没处理的一定没有，
// 会话和账户要真的存在。
func TestMigration015AddsServiceCallsBesideExistingSessions(t *testing.T) {
	ctx := context.Background()
	pool := openPool(t, testdb.New(t))
	if err := runMigrate(t, pool, migrationsThrough(t, 14)); err != nil {
		t.Fatal(err)
	}
	// 014 的库里已有一位顾客正在 B3 桌计时，还有一位员工
	var customer, staff, area, table, session string
	for _, step := range []struct {
		sql  string
		args []any
		into *string
	}{
		{`INSERT INTO accounts(id,nickname,phone_verification_status,created_at,state) VALUES (gen_random_uuid(),'小林','unverified',now(),'{}') RETURNING id`, nil, &customer},
		{`INSERT INTO accounts(id,nickname,phone_verification_status,created_at,state) VALUES (gen_random_uuid(),'店员','unverified',now(),'{}') RETURNING id`, nil, &staff},
		{`INSERT INTO floor_areas(id,name,grid_columns,grid_rows,locked,state) VALUES (gen_random_uuid(),'B 区',4,4,false,'{}') RETURNING id`, nil, &area},
		{`INSERT INTO service_tables(id,floor_area_id,number,seat_count,enabled,state,code) VALUES (gen_random_uuid(),$1,3,2,true,'{"Code":"B3"}','B3') RETURNING id`, []any{&area}, &table},
		{`INSERT INTO venue_sessions(id,service_table_id,account_id,status,started_at,duration_minutes,state,seat_number) VALUES (gen_random_uuid(),$1,$2,'active',now(),120,'{"status":"active"}',2) RETURNING id`, []any{&table, &customer}, &session},
	} {
		args := make([]any, 0, len(step.args))
		for _, a := range step.args {
			args = append(args, *(a.(*string)))
		}
		if err := pool.QueryRow(ctx, step.sql, args...).Scan(step.into); err != nil {
			t.Fatal(err)
		}
	}

	if err := runMigrate(t, pool, embeddedMigrations(t)); err != nil {
		t.Fatal(err)
	}
	var status string
	var seat int
	if err := pool.QueryRow(ctx, `SELECT status, seat_number FROM venue_sessions WHERE id = $1`, session).Scan(&status, &seat); err != nil || status != "active" || seat != 2 {
		t.Fatalf("迁移动了已有的会话：%s %d %v", status, seat, err)
	}

	insert := func(status string, handled bool, sessionID string) error {
		sql := `INSERT INTO service_calls(id,venue_session_id,account_id,status,created_at,state) VALUES (gen_random_uuid(),$1,$2,$3,now(),'{}')`
		args := []any{sessionID, customer, status}
		if handled {
			sql = `INSERT INTO service_calls(id,venue_session_id,account_id,status,created_at,handled_at,handled_by_account_id,state) VALUES (gen_random_uuid(),$1,$2,$3,now(),now(),$4,'{}')`
			args = append(args, staff)
		}
		_, err := pool.Exec(ctx, sql, args...)
		return err
	}
	if err := insert("pending", false, session); err != nil {
		t.Fatalf("没处理的呼叫：%v", err)
	}
	if err := insert("handled", true, session); err != nil {
		t.Fatalf("处理过的呼叫：%v", err)
	}
	for name, err := range map[string]error{
		"处理过却没记谁、何时": insert("handled", false, session),
		"没处理却记了处理人":  insert("pending", true, session),
		"过期不是存下来的状态": insert("expired", false, session),
		"会话不存在":      insert("pending", false, customer),
	} {
		if err == nil {
			t.Fatalf("%s：数据库应当拒收", name)
		}
	}
	if _, err := pool.Exec(ctx, `UPDATE service_calls SET handled_by_account_id = NULL WHERE status = 'handled'`); err == nil {
		t.Fatal("处理过的呼叫不能抹掉处理人")
	}
	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM service_calls WHERE venue_session_id = $1`, session).Scan(&n); err != nil || n != 2 {
		t.Fatalf("应当正好两条：%d %v", n, err)
	}
}
