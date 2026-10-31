// Package testdb 给测试准备一次性的数据库（pgtestdb）：同一组迁移只建一次模板库，每个测试从模板复制出
// 自己的库（几十毫秒），测试通过后删掉（失败的留着供排查）。从不碰连接串里指定的那个库。
//
// 数据库服务器：设了 PINDOU_TEST_DATABASE_URL 就用它（CI 的服务容器、本机常驻的测试库，模板跨进程复用，最快）；
// 没设时这个测试进程用 testcontainers 起一个和生产同一镜像的 PostgreSQL 容器，整个包的测试共用，
// 进程退出后由 Ryuk 收掉——所以 go test 不用任何准备，只要有 docker。
// 确实不需要数据库时用 PINDOU_SKIP_DATABASE_TESTS=1 显式跳过（以前没库时静默跳过，CI 全绿而数据库测试一条没跑）。
package testdb

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	_ "github.com/jackc/pgx/v5/stdlib" // pgtestdb 经 database/sql 用 pgx 驱动连库
	"github.com/peterldowns/pgtestdb"
	"github.com/testcontainers/testcontainers-go"
	tclog "github.com/testcontainers/testcontainers-go/log"
	"github.com/testcontainers/testcontainers-go/modules/postgres"
)

// Image 是没设 PINDOU_TEST_DATABASE_URL 时起的容器：与生产同一个镜像（glibc 的排序规则与 alpine 的 musl 不同）。
const Image = "postgres:17.11-trixie"

// Migrator 准备模板库：Hash 是迁移内容的摘要（同一个摘要只建一次模板），Migrate 在空库上跑迁移。
type Migrator = pgtestdb.Migrator

// New 是一个空库（没跑迁移），测试结束时删掉。返回它的连接串。
func New(t testing.TB) string {
	t.Helper()
	return Prepared(t, pgtestdb.NoopMigrator{})
}

// Prepared 是从 migrator 准备好的模板复制出来的库，测试结束时删掉。返回它的连接串。
func Prepared(t testing.TB, migrator Migrator) string {
	t.Helper()
	conf := serverConfig(t)
	return pgtestdb.Custom(t, conf, migrator).URL()
}

// Migrations 是按 hash 命名模板、用 migrate 跑迁移的 Migrator（hash 要随迁移内容变化）。
func Migrations(hash string, migrate func(context.Context, *sql.DB) error) Migrator {
	return migrations{hash: hash, migrate: migrate}
}

type migrations struct {
	hash    string
	migrate func(context.Context, *sql.DB) error
}

func (m migrations) Hash() (string, error) { return m.hash, nil }

func (m migrations) Migrate(ctx context.Context, db *sql.DB, _ pgtestdb.Config) error {
	return m.migrate(ctx, db)
}

var server struct {
	once sync.Once
	conf pgtestdb.Config
	err  error
}

// serverConfig 是测试用的数据库服务器（维护库 postgres）。容器在这个进程里只起一次。
func serverConfig(t testing.TB) pgtestdb.Config {
	t.Helper()
	dsn := os.Getenv("PINDOU_TEST_DATABASE_URL")
	if dsn == "" && os.Getenv("PINDOU_SKIP_DATABASE_TESTS") == "1" {
		t.Skip("PINDOU_SKIP_DATABASE_TESTS=1")
	}
	server.once.Do(func() {
		if dsn == "" {
			dsn, server.err = startContainer()
			if server.err != nil {
				server.err = fmt.Errorf("PINDOU_TEST_DATABASE_URL is not set and the test PostgreSQL container did not start (docker required; or set PINDOU_SKIP_DATABASE_TESTS=1 to skip on purpose): %w", server.err)
				return
			}
		}
		server.conf, server.err = configFor(dsn)
	})
	if server.err != nil {
		t.Fatal(server.err)
	}
	return server.conf
}

// startContainer 起一个 PostgreSQL 容器，返回连它的连接串。容器在进程退出后由 Ryuk 删掉。
func startContainer() (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	tclog.SetDefault(tclog.NewNoopLogger())
	container, err := postgres.Run(ctx, Image,
		postgres.WithDatabase("postgres"),
		postgres.WithUsername("postgres"),
		postgres.WithPassword("pindou-test"),
		postgres.BasicWaitStrategies(),
		// 测试库丢了无所谓：不等落盘，快不少。
		testcontainers.WithCmdArgs("-c", "synchronous_commit=off", "-c", "full_page_writes=off"),
	)
	if err != nil {
		return "", err
	}
	return container.ConnectionString(ctx, "sslmode=disable")
}

// configFor 把连接串换成 pgtestdb 的服务器配置：一律连维护库 postgres，不碰连接串里写的库。
func configFor(dsn string) (pgtestdb.Config, error) {
	parsed, err := pgx.ParseConfig(dsn)
	if err != nil {
		return pgtestdb.Config{}, fmt.Errorf("invalid test database configuration")
	}
	sslmode := "disable"
	if parsed.TLSConfig != nil {
		sslmode = "require"
	}
	// pgtestdb 把这些字段直接拼进 URL，用户名和口令里的特殊字符要先转义。
	user, password, _ := strings.Cut(url.UserPassword(parsed.User, parsed.Password).String(), ":")
	return pgtestdb.Config{
		DriverName: "pgx",
		Host:       parsed.Host,
		Port:       strconv.Itoa(int(parsed.Port)),
		User:       user,
		Password:   password,
		Database:   "postgres",
		Options:    "sslmode=" + sslmode,
		// 测试里的服务、推送监听可能在清理时还没断开：删库前先把连接踢掉（和以前 DROP DATABASE … WITH (FORCE) 一样）。
		ForceTerminateConnections: true,
	}, nil
}
