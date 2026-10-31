package storage

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/yreidev/pindou-studio/pindou-backend/internal/testdb"
)

// schema.sql 是迁移全部跑完之后的表结构，给 sqlc 推断查询的参数与结果类型（sqlc.yaml）。sqlc 读不了迁移本身：
// 002、003 用 DO 块循环改表名、加列，它不执行这些块，看到的是改名之前的表。所以从跑完迁移的真库导出一份，
// 由这个测试保证它和迁移一致；迁移变了用 make backend-sqlc 重新导出并生成代码（PINDOU_UPDATE_SCHEMA=1 时这里改写文件）。
func TestSchemaSnapshotMatchesMigrations(t *testing.T) {
	ctx := context.Background()
	dsn := testdb.New(t)
	db, err := Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	got := renderSchema(t, db.pool)
	db.Close()
	if os.Getenv("PINDOU_UPDATE_SCHEMA") == "1" {
		if err := os.WriteFile("schema.sql", []byte(got), 0o644); err != nil { //nolint:gosec // 仓库里的源文件
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile("schema.sql")
	if err != nil {
		t.Fatal(err)
	}
	if string(want) != got {
		t.Fatal("internal/storage/schema.sql is out of date with the migrations: run make backend-sqlc and commit the result")
	}
}

// renderSchema 按表名、列序列出业务表的列（类型、是否可空）和迁移建的函数，格式固定，便于比对。
// 迁移登记表（goose_db_version、schema_migrations）和扩展自带的函数不在里面。
func renderSchema(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	ctx := context.Background()
	var b strings.Builder
	b.WriteString("-- 迁移全部跑完之后的表结构，给 sqlc 用（见 sqlc.yaml）。由 TestSchemaSnapshotMatchesMigrations 从真库导出，\n")
	b.WriteString("-- 不要手改：迁移变了运行 make backend-sqlc。\n")
	rows, err := pool.Query(ctx, `SELECT quote_ident(c.relname), quote_ident(a.attname), format_type(a.atttypid, a.atttypmod), a.attnotnull
 FROM pg_class c
 JOIN pg_namespace n ON n.oid = c.relnamespace
 JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
 WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname NOT IN ('goose_db_version', 'schema_migrations')
 ORDER BY c.relname, a.attnum`)
	if err != nil {
		t.Fatal(err)
	}
	type column struct {
		table, name, typ string
		notNull          bool
	}
	columns, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (column, error) {
		var c column
		err := row.Scan(&c.table, &c.name, &c.typ, &c.notNull)
		return c, err
	})
	if err != nil {
		t.Fatal(err)
	}
	for i, c := range columns {
		if i == 0 || columns[i-1].table != c.table {
			b.WriteString("\nCREATE TABLE " + c.table + " (\n")
		}
		b.WriteString("  " + c.name + " " + c.typ)
		if c.notNull {
			b.WriteString(" NOT NULL")
		}
		if i+1 < len(columns) && columns[i+1].table == c.table {
			b.WriteString(",\n")
		} else {
			b.WriteString("\n);\n")
		}
	}
	rows, err = pool.Query(ctx, `SELECT pg_get_functiondef(p.oid)
 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
 ORDER BY p.proname, p.oid`)
	if err != nil {
		t.Fatal(err)
	}
	functions, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range functions {
		b.WriteString("\n" + strings.TrimSpace(f) + ";\n")
	}
	return b.String()
}
