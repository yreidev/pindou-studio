package testdb

import (
	"context"
	"database/sql"
	"net/url"
	"testing"

	"github.com/jackc/pgx/v5"
)

// 连接串里的用户名、口令原样转给 pgtestdb（它直接拼进 URL），特殊字符不能把连接串弄坏。
func TestServerCredentialsSurviveTheURL(t *testing.T) {
	for _, value := range []string{"simple", "space and 'quote'", `back\slash`, "at@colon:slash/question?", "中文"} {
		dsn := (&url.URL{Scheme: "postgres", User: url.UserPassword(value, value), Host: "localhost:5432", Path: "/business"}).String()
		conf, err := configFor(dsn)
		if err != nil {
			t.Fatal(err)
		}
		if conf.Database != "postgres" {
			t.Fatalf("server config targets %q, want the maintenance database", conf.Database)
		}
		parsed, err := pgx.ParseConfig(conf.URL())
		if err != nil {
			t.Fatalf("%q: %v", value, err)
		}
		if parsed.User != value || parsed.Password != value {
			t.Fatalf("credential %q became %q/%q", value, parsed.User, parsed.Password)
		}
	}
}

// 每个测试一个独立的库，测试通过后删掉；连接串里写的业务库从不使用。
func TestDisposableDatabasesAreIsolatedAndCleanedUp(t *testing.T) {
	conf := serverConfig(t)
	admin, err := conf.Connect()
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	ctx := context.Background()
	names := map[string]bool{}
	for _, name := range []string{"first", "second"} {
		var database string
		t.Run(name, func(t *testing.T) {
			dsn := New(t)
			parsed, err := pgx.ParseConfig(dsn)
			if err != nil {
				t.Fatal(err)
			}
			database = parsed.Database
			if database == "postgres" || names[database] {
				t.Fatalf("database %q is not isolated", database)
			}
			names[database] = true
			conn, err := pgx.Connect(ctx, dsn)
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close(ctx)
			// 空库：上一个测试建的表不在这里。
			if _, err := conn.Exec(ctx, "CREATE TABLE fixture (id integer)"); err != nil {
				t.Fatal(err)
			}
		})
		var exists bool
		if err := admin.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=$1)", database).Scan(&exists); err != nil {
			t.Fatal(err)
		}
		if exists {
			t.Fatalf("database %s survived test cleanup", database)
		}
	}
}

// 同一个摘要的模板只准备一次，之后的库都从它复制，互不影响。
func TestPreparedDatabasesShareOneTemplate(t *testing.T) {
	ctx := context.Background()
	runs := 0
	migrator := Migrations("testdb-template-probe-1", func(ctx context.Context, db *sql.DB) error {
		runs++
		_, err := db.ExecContext(ctx, "CREATE TABLE prepared (id integer)")
		return err
	})
	for range 2 {
		conn, err := pgx.Connect(ctx, Prepared(t, migrator))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := conn.Exec(ctx, "INSERT INTO prepared VALUES (1)"); err != nil {
			t.Fatal(err)
		}
		var n int
		if err := conn.QueryRow(ctx, "SELECT count(*) FROM prepared").Scan(&n); err != nil || n != 1 {
			t.Fatalf("copies share rows: count=%d err=%v", n, err)
		}
		conn.Close(ctx)
	}
	if runs > 1 {
		t.Fatalf("template prepared %d times", runs)
	}
}
