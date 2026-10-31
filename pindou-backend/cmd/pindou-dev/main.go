// pindou-dev 在本机起一个开发用的 API（make backend-dev，网页后台的端到端测试也用它）。
//
// 连 PINDOU_DEV_DATABASE_URL 指的 PostgreSQL 服务器（没设时用 PINDOU_TEST_DATABASE_URL），用其中名为 -db 的库：
// 不存在就建；带 -fresh 时先删掉重建，退出时再删掉。微信是假的：登录码直接当身份、手机号原样收下。
// 监听 PINDOU_HTTP_ADDRESS（默认 127.0.0.1:8080）；PINDOU_DEVELOPER_ACCOUNT_IDS、PINDOU_BOOTSTRAP_OWNER_ID 与生产同义。只连本机或测试用的数据库服务器，不要指向生产。
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/yreidev/pindou-studio/pindou-backend/internal/adminui"
	"github.com/yreidev/pindou-studio/pindou-backend/internal/service"
)

var databaseName = regexp.MustCompile(`^[a-z][a-z0-9_]{0,40}$`)

func main() { os.Exit(run()) }

// run 跑到收到停止信号或出错，返回退出码（-fresh 的库在返回前删掉）。
func run() int {
	name := flag.String("db", "pindou_dev", "开发库的名字（小写字母、数字、下划线）")
	fresh := flag.Bool("fresh", false, "先删掉重建这个库，退出时再删掉（端到端测试用）")
	flag.Parse()
	if !databaseName.MatchString(*name) {
		log.Fatalf("库名 %q 不合规：只能用小写字母、数字、下划线", *name)
	}
	serverURL := os.Getenv("PINDOU_DEV_DATABASE_URL")
	if serverURL == "" {
		serverURL = os.Getenv("PINDOU_TEST_DATABASE_URL")
	}
	if serverURL == "" {
		log.Fatal("没有开发用的数据库：设 PINDOU_DEV_DATABASE_URL，或用 make backend-dev（会起一个本机的 PostgreSQL 容器）")
	}
	config, err := pgx.ParseConfig(serverURL)
	if err != nil {
		log.Fatal("PINDOU_DEV_DATABASE_URL 不是有效的连接串")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := prepare(ctx, config, *name, *fresh); err != nil {
		log.Fatal(err)
	}
	if *fresh {
		defer func() {
			if err := drop(config, *name); err != nil {
				slog.Error("drop development database", "error", err.Error())
			}
		}()
	}
	address := os.Getenv("PINDOU_HTTP_ADDRESS")
	if address == "" {
		address = "127.0.0.1:8080"
	}
	err = service.Run(ctx, service.Config{
		Address:             address,
		DatabaseURL:         dsnFor(config, *name),
		DeveloperAccountIDs: os.Getenv("PINDOU_DEVELOPER_ACCOUNT_IDS"),
		BootstrapOwnerID:    os.Getenv("PINDOU_BOOTSTRAP_OWNER_ID"),
		FakeWechat:          true,
		// 顾客的预约微信通知照样开着（订阅框、「开启微信提醒」都能点；假微信不发，记成失败 no_wechat）。
		// 固定的开发密钥，不是秘密：只加密本机开发库里的假 openid
		OpenIDKey: []byte("pindou-dev-openid-key-not-secret"),
		// 本机：http://127.0.0.1:8080 是员工网页后台（页面和接口同一个端口，同线上经 Traefik 同源）；
		// http://localhost:8080 是顾客域名（只有微信校验文件和「请用微信扫码」那一页），网页桌码印的就是它
		CustomerWebHosts: customerWebHosts(),
		CustomerWebsite:  customerWebsite(address),
		Pages:            adminui.Handler(),
	})
	if err != nil {
		log.Print(err)
		return 1
	}
	return 0
}

// prepare 确保库存在；fresh 时先删掉旧的。
func prepare(ctx context.Context, config *pgx.ConnConfig, name string, fresh bool) error {
	admin, err := connectAdmin(ctx, config)
	if err != nil {
		return err
	}
	defer admin.Close(context.Background())
	quoted := pgx.Identifier{name}.Sanitize()
	if fresh {
		if _, err := admin.Exec(ctx, "DROP DATABASE IF EXISTS "+quoted+" WITH (FORCE)"); err != nil {
			return fmt.Errorf("删除旧的开发库: %w", err)
		}
	}
	var exists bool
	if err := admin.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1)`, name).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		if _, err := admin.Exec(ctx, "CREATE DATABASE "+quoted); err != nil {
			return fmt.Errorf("建开发库（需要 CREATEDB 权限）: %w", err)
		}
	}
	return nil
}

func drop(config *pgx.ConnConfig, name string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	admin, err := connectAdmin(ctx, config)
	if err != nil {
		return err
	}
	defer admin.Close(context.Background())
	_, err = admin.Exec(ctx, "DROP DATABASE IF EXISTS "+pgx.Identifier{name}.Sanitize()+" WITH (FORCE)")
	return err
}

func connectAdmin(ctx context.Context, config *pgx.ConnConfig) (*pgx.Conn, error) {
	admin := config.Copy()
	admin.Database = "postgres"
	var conn *pgx.Conn
	var err error
	// 刚起的容器可能还没就绪，等它一会儿。
	for attempt := 0; attempt < 30; attempt++ {
		if conn, err = pgx.ConnectConfig(ctx, admin); err == nil {
			return conn, nil
		}
		select {
		case <-ctx.Done():
			return nil, err
		case <-time.After(time.Second):
		}
	}
	return nil, fmt.Errorf("连不上开发用的数据库服务器: %w", err)
}

// dsnFor 是 config 指向的服务器上 name 这个库的连接串。
func dsnFor(config *pgx.ConnConfig, name string) string {
	sslmode := "disable"
	if config.TLSConfig != nil {
		sslmode = "require"
	}
	quote := func(v string) string { return "'" + strings.NewReplacer(`\`, `\\`, `'`, `\'`).Replace(v) + "'" }
	return "host=" + quote(config.Host) + " port=" + strconv.Itoa(int(config.Port)) + " user=" + quote(config.User) +
		" password=" + quote(config.Password) + " dbname=" + quote(name) + " sslmode=" + sslmode
}

// customerWebsite 是本机顾客域名的地址（网页桌码印的）：第一个顾客域名，加上监听的端口（http://localhost:8080）。
func customerWebsite(address string) string {
	host := strings.TrimSpace(strings.Split(customerWebHosts(), ",")[0])
	if _, port, err := net.SplitHostPort(address); err == nil && port != "" {
		host = net.JoinHostPort(host, port)
	}
	return "http://" + host
}

// customerWebHosts 是本机的顾客域名：PINDOU_CUSTOMER_WEB_HOSTS，没设时是 localhost。
func customerWebHosts() string {
	if hosts := os.Getenv("PINDOU_CUSTOMER_WEB_HOSTS"); hosts != "" {
		return hosts
	}
	return "localhost"
}
