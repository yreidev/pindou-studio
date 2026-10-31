package storage

import (
	"context"
	"fmt"
	"io/fs"
	"slices"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"

	"github.com/yreidev/pindou-studio/pindou-backend/internal/testdb"
)

func embeddedMigrations(t *testing.T) fs.FS {
	t.Helper()
	dir, err := fs.Sub(migrationFS, "migrations")
	if err != nil {
		t.Fatal(err)
	}
	return dir
}

// latestMigration 是嵌入的最新迁移的版本号。
func latestMigration(t *testing.T) int64 {
	t.Helper()
	entries, err := fs.ReadDir(embeddedMigrations(t), ".")
	if err != nil {
		t.Fatal(err)
	}
	var latest int64
	for _, entry := range entries {
		if version, err := goose.NumericComponent(entry.Name()); err == nil && version > latest {
			latest = version
		}
	}
	return latest
}

// registeredVersions 是迁移全部登记后 goose 表里应有的版本：0（goose 自己的起始行）加上 dir 里每个迁移的版本号。
// 按文件算而不是按 0..最新 连续算：几个分支并行加迁移时编号会先留空（如 019 在别的分支、本分支先用 020），
// 要核对的是「每个迁移登记且只登记一次」。
func registeredVersions(t *testing.T, dir fs.FS) []int64 {
	t.Helper()
	entries, err := fs.ReadDir(dir, ".")
	if err != nil {
		t.Fatal(err)
	}
	out := []int64{0}
	for _, entry := range entries {
		if version, err := goose.NumericComponent(entry.Name()); err == nil {
			out = append(out, version)
		}
	}
	slices.Sort(out)
	return out
}

// withMigrations 是嵌入的迁移再加上 extra（文件名 → 内容）。
func withMigrations(t *testing.T, extra map[string]string) fs.FS {
	t.Helper()
	dir := embeddedMigrations(t)
	out := fstest.MapFS{}
	entries, err := fs.ReadDir(dir, ".")
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		b, err := fs.ReadFile(dir, entry.Name())
		if err != nil {
			t.Fatal(err)
		}
		out[entry.Name()] = &fstest.MapFile{Data: b}
	}
	for name, body := range extra {
		out[name] = &fstest.MapFile{Data: []byte(body)}
	}
	return out
}

func openPool(t *testing.T, dsn string) *pgxpool.Pool {
	t.Helper()
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func runMigrate(t *testing.T, pool *pgxpool.Pool, dir fs.FS) error {
	t.Helper()
	db := stdlib.OpenDBFromPool(pool)
	defer db.Close()
	return migrate(context.Background(), db, dir)
}

// gooseVersions 是 goose 版本表里登记的版本（按登记先后），含建表时的 0。
func gooseVersions(t *testing.T, pool *pgxpool.Pool) []int64 {
	t.Helper()
	rows, err := pool.Query(context.Background(), `SELECT version_id FROM goose_db_version WHERE is_applied ORDER BY id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []int64
	for rows.Next() {
		var v int64
		if err := rows.Scan(&v); err != nil {
			t.Fatal(err)
		}
		out = append(out, v)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

// 以后的迁移照 goose 的写法（带注解，函数体用 StatementBegin/End 包住）：执行一次、登记一次，
// 再启动不重跑。失败的迁移连同登记整个回滚。
func TestNewMigrationsRunOnceAndRollBackOnFailure(t *testing.T) {
	ctx := context.Background()
	dsn := testdb.New(t)
	pool := openPool(t, dsn)
	if err := runMigrate(t, pool, embeddedMigrations(t)); err != nil {
		t.Fatal(err)
	}
	// 探针排在仓库里最新的迁移之后，以后加了迁移也不会撞号
	latest := latestMigration(t)
	probe := fmt.Sprintf("%03d_probe.sql", latest+1)
	next := withMigrations(t, map[string]string{probe: `-- +goose Up
-- 以后的迁移的样子：普通语句按分号拆开，函数体整段交给数据库。
CREATE TABLE migration_probe (id integer PRIMARY KEY);
-- +goose StatementBegin
CREATE FUNCTION migration_probe_count() RETURNS bigint LANGUAGE plpgsql AS $$
BEGIN
  RETURN (SELECT count(*) FROM migration_probe);
END $$;
-- +goose StatementEnd
INSERT INTO migration_probe VALUES (1);
`})
	if err := runMigrate(t, pool, next); err != nil {
		t.Fatal(err)
	}
	var probes int64
	if err := pool.QueryRow(ctx, `SELECT migration_probe_count()`).Scan(&probes); err != nil || probes != 1 {
		t.Fatalf("%s did not run as written: count=%d err=%v", probe, probes, err)
	}
	if got, want := gooseVersions(t, pool), registeredVersions(t, next); !slices.Equal(got, want) {
		t.Fatalf("goose versions %v, want %v", got, want)
	}
	// 再升级：不重跑（重跑 CREATE TABLE 会报错）。
	if err := runMigrate(t, pool, next); err != nil {
		t.Fatal(err)
	}
	// 失败的迁移：已执行的语句和登记一起回滚，报出文件名。
	brokenName := fmt.Sprintf("%03d_broken.sql", latest+2)
	broken := withMigrations(t, map[string]string{
		probe:      "-- +goose Up\nSELECT 1;\n",
		brokenName: "-- +goose Up\nCREATE TABLE half_done (id integer);\nSELECT 1/0;\n",
	})
	err := runMigrate(t, pool, broken)
	if err == nil || !strings.Contains(err.Error(), brokenName) {
		t.Fatalf("broken migration: err=%v", err)
	}
	var exists bool
	if err := pool.QueryRow(ctx, `SELECT to_regclass('public.half_done') IS NOT NULL`).Scan(&exists); err != nil || exists {
		t.Fatalf("failed migration left half_done behind (err %v)", err)
	}
	if got := gooseVersions(t, pool); slices.Contains(got, latest+2) {
		t.Fatal("failed migration was recorded by goose")
	}
}

// 几个副本同时对一个空库启动：只有一个在执行，都能起来，每个迁移只登记一次。
func TestConcurrentStartupOnAnEmptyDatabase(t *testing.T) {
	ctx := context.Background()
	dsn := testdb.New(t)
	errs := make(chan error, 3)
	for range 3 {
		go func() {
			db, err := Open(ctx, dsn)
			if err == nil {
				db.Close()
			}
			errs <- err
		}()
	}
	for range 3 {
		if err := <-errs; err != nil {
			t.Fatalf("concurrent startup: %v", err)
		}
	}
	pool := openPool(t, dsn)
	if got, want := gooseVersions(t, pool), registeredVersions(t, embeddedMigrations(t)); !slices.Equal(got, want) {
		t.Fatalf("goose versions %v, want %v", got, want)
	}
}

// 迁移 014（布局按店主 2026-09-26 的最终版调整）：从旧布局升上来，去掉的五张桌（B8、C4、E4–E6）连同座位行删掉，
// 其余的桌一张不动；去掉的桌只要有一条营业记录，迁移就失败、什么都不删。
func TestMigration014RemovesOnlyUnusedTablesOutsideTheFinalLayout(t *testing.T) {
	ctx := context.Background()
	seedOldLayout := func(t *testing.T) (*pgxpool.Pool, map[string]string) {
		t.Helper()
		pool := openPool(t, testdb.New(t))
		if err := runMigrate(t, pool, migrationsThrough(t, 13)); err != nil {
			t.Fatal(err)
		}
		ids := map[string]string{}
		for _, zone := range []string{"A", "B", "C", "E"} {
			var area string
			if err := pool.QueryRow(ctx, `INSERT INTO floor_areas(id,name,grid_columns,grid_rows,locked,state) VALUES (gen_random_uuid(),$1,4,4,false,'{}') RETURNING id`, zone+" 区").Scan(&area); err != nil {
				t.Fatal(err)
			}
			for number := 1; number <= map[string]int{"A": 2, "B": 8, "C": 4, "E": 6}[zone]; number++ {
				code := fmt.Sprintf("%s%d", zone, number)
				var id string
				if err := pool.QueryRow(ctx, `INSERT INTO service_tables(id,floor_area_id,number,seat_count,enabled,state,code) VALUES (gen_random_uuid(),$1,$2,1,true,jsonb_build_object('Code',$3::text),$3) RETURNING id`, area, number, code).Scan(&id); err != nil {
					t.Fatal(err)
				}
				if _, err := pool.Exec(ctx, `INSERT INTO service_table_seats(id,service_table_id,seat_number) VALUES (gen_random_uuid(),$1,1)`, id); err != nil {
					t.Fatal(err)
				}
				ids[code] = id
			}
		}
		return pool, ids
	}
	codes := func(t *testing.T, pool *pgxpool.Pool) []string {
		t.Helper()
		rows, err := pool.Query(ctx, `SELECT code FROM service_tables ORDER BY code`)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		var out []string
		for rows.Next() {
			var code string
			if err := rows.Scan(&code); err != nil {
				t.Fatal(err)
			}
			out = append(out, code)
		}
		return out
	}

	t.Run("没用过的桌按新布局删掉", func(t *testing.T) {
		pool, _ := seedOldLayout(t)
		// 只升到 014：座位行所在的旧表由 016 整张删掉
		if err := runMigrate(t, pool, migrationsThrough(t, 14)); err != nil {
			t.Fatal(err)
		}
		want := []string{"A1", "A2", "B1", "B2", "B3", "B4", "B5", "B6", "B7", "C1", "C2", "C3", "E1", "E2", "E3"}
		if got := codes(t, pool); !slices.Equal(got, want) {
			t.Fatalf("迁移后的桌位 %v，应为 %v", got, want)
		}
		var seats int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM service_table_seats`).Scan(&seats); err != nil || seats != len(want) {
			t.Fatalf("座位行 %d（%v），应只剩留下的 %d 张桌的", seats, err, len(want))
		}
	})

	t.Run("有营业记录就失败，什么都不删", func(t *testing.T) {
		pool, ids := seedOldLayout(t)
		if _, err := pool.Exec(ctx, `INSERT INTO reservations(id,service_table_id,seat_number,start_at,duration_minutes,status,created_at,state) VALUES (gen_random_uuid(),$1,1,now(),60,'cancelled',now(),'{}')`, ids["E5"]); err != nil {
			t.Fatal(err)
		}
		err := runMigrate(t, pool, migrationsThrough(t, 14))
		if err == nil || !strings.Contains(err.Error(), "E5") || strings.Contains(err.Error(), "E4") {
			t.Fatalf("应只报出有记录的 E5：%v", err)
		}
		if got := codes(t, pool); len(got) != 20 {
			t.Fatalf("失败的迁移删掉了桌：剩 %v", got)
		}
	})
}
