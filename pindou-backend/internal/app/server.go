package app

import (
	"context"
	"crypto/cipher"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	wechatapi "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/identity/infrastructure/wechat"
	"github.com/yreidev/pindou-studio/pindou-backend/internal/storage"
	"github.com/yreidev/pindou-studio/pindou-backend/internal/storage/queries"
)

type Server struct {
	developers map[string]bool
	now        func() time.Time
	hub        *hub
	// postgres 是业务数据的唯一来源。进程不持有业务状态，所以可以同时跑多个副本。
	postgres *storage.Postgres
	wechat   wechatService
	// pages 是员工网页后台的页面（见 ServePages）：只有本机开发、端到端这样配了才有；生产的网页后台是单独的服务。
	pages http.Handler
	// customerHosts 是小程序接口与网页桌码用的顾客域名（见 ConfigureCustomerWebHosts）。
	customerHosts map[string]bool
	// customerWebsite 是顾客域名的地址（见 ConfigureCustomerWebsite），网页桌码印的就是它。
	customerWebsite string
	// linkVerifyFile、linkVerifyContent 是微信「扫普通链接二维码打开小程序」的校验文件（见 ConfigureLinkVerification）。
	linkVerifyFile, linkVerifyContent string
	// mux 按方法与路径分派接口请求（见 routes.go）。
	mux *http.ServeMux
	// heartbeat 是 WebSocket 单向心跳的间隔（见 realtime.go）。按实例保存：测试只调快自己那台，
	// 改包级变量会和别的用例还没退出的连接协程抢着读写。
	heartbeat time.Duration
	// draining 在进程准备退出时置位，就绪检查随之失败。
	draining atomic.Bool
	// rateLimit 次每 rateWindow 是登录类接口按访客地址的限流（0 表示不限）。
	rateLimit  int
	rateWindow time.Duration
	// listening 在推送监听第一次连上后关闭。
	listening   chan struct{}
	eventsReady sync.Once
	// openids 加解密存在库里的 openid（见 notices.go）；nil 表示没开顾客的微信通知。
	openids cipher.AEAD
	// notifier 发订阅消息（真实微信才有）。
	notifier noticeSender
	// background 是请求事务提交之后还在发的通知（见 runAfter）。
	background sync.WaitGroup
}

// ConfigureCustomerWebHosts 设定哪些是顾客域名（逗号分隔，不分大小写，不带端口）：网页桌码印的、小程序接口所在的域名。
// 顾客网页 2026-10-31 下线（docs/plan-split-release.md），这些域名下接口以外的路径只有微信校验文件和「请用微信扫码」
// 那一页（customer_host.go）；接口在哪个域名下都一样。
func (s *Server) ConfigureCustomerWebHosts(value string) {
	hosts := map[string]bool{}
	for _, host := range strings.Split(value, ",") {
		if host = strings.ToLower(strings.TrimSpace(host)); host != "" {
			hosts[host] = true
		}
	}
	s.customerHosts = hosts
}

// onCustomerHost 是这个请求的域名是不是顾客域名。
func (s *Server) onCustomerHost(r *http.Request) bool {
	host := r.Host
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	return s.customerHosts[strings.ToLower(host)]
}

// ServePages 让顾客域名以外的域名下、接口以外的路径交给 pages（员工网页后台的页面）。只给本机开发和端到端用
// （cmd/pindou-dev：一个端口同时提供接口和页面，和线上经 Traefik 同源一样）；生产的网页后台是单独的服务
// （cmd/pindou-admin-web），后端不配页面，这些路径返回 404。
func (s *Server) ServePages(pages http.Handler) { s.pages = pages }

// Drain 让就绪检查失败：滚动发布时旧副本先被摘掉，进行中的请求照常做完。
func (s *Server) Drain() { s.draining.Store(true) }

// NewServer 接上数据库。推送要另外调用 ListenEvents 才能收到（各副本的写入都经数据库转发）。
func NewServer(postgres *storage.Postgres) *Server {
	s := &Server{postgres: postgres, now: time.Now, hub: newHub(), customerHosts: map[string]bool{}, heartbeat: webSocketHeartbeat, rateLimit: identityRateLimit, rateWindow: identityRateWindow, listening: make(chan struct{})}
	s.mux = s.routes()
	return s
}

// ListenEvents 监听数据库转来的推送，直到 ctx 结束：任何一个副本提交的写入，都经 LISTEN/NOTIFY
// 送到这里，再推给连在本副本上的客户端。监听断开重连后，让所有客户端整体重读（断开期间的推送收不到了）。
func (s *Server) ListenEvents(ctx context.Context) {
	s.postgres.Listen(ctx, eventChannel, s.deliverNotification, func(first bool) {
		if first {
			s.eventsReady.Do(func() { close(s.listening) })
			return
		}
		s.hub.publish(map[string]string{"type": "resource.updated", "resource": "*"}, nil, true)
	})
}

// Listening 在推送监听第一次连上后关闭（测试据此等它就绪，免得最早的推送丢在连上之前）。
func (s *Server) Listening() <-chan struct{} { return s.listening }

// deliverNotification 把一条数据库通知推给本副本上的事件流。只把类型和资源推给客户端，
// 受影响的账户只用来挑接收者——不能让一位顾客看到别人的账户编号。
func (s *Server) deliverNotification(payload string) {
	var n notification
	if err := json.Unmarshal([]byte(payload), &n); err != nil {
		slog.Error("bad event notification", "error", err.Error())
		return
	}
	if n.Type == scanRelayedType {
		// 扫码接力只推给这位员工自己的网页连接；码不进日志
		if n.To != "" {
			s.hub.relay(n.To, map[string]string{"type": n.Type, "code": n.Code})
		}
		return
	}
	accounts := make(map[string]bool, len(n.Accounts))
	for _, account := range n.Accounts {
		accounts[account] = true
	}
	s.hub.publish(map[string]string{"type": n.Type, "resource": n.Resource}, accounts, n.Customers)
}

func (s *Server) Handler() http.Handler { return s }
func (s *Server) UseWechat(client *wechatapi.Client) {
	if client != nil {
		s.wechat = client
		s.notifier = client
	}
}

// wechatService 是后端调用的微信接口，测试可以换上能控制何时返回的实现。
type wechatService interface {
	ExchangeLogin(ctx context.Context, code string) (string, error)
	ExchangePhone(ctx context.Context, code string) (string, error)
	// env 是指向的小程序版本（release、trial、develop），每次从数据库读（见 code_settings.go）。
	TableCode(ctx context.Context, scene, env string) ([]byte, error)
	WebLoginCode(ctx context.Context, scene, env string) ([]byte, error)
}

// serveProbe 处理存活、就绪检查和给外部监控看的状态，处理了返回 true。它们不读业务数据、不开事务、不限流。
// 进程收到停止信号后就绪检查立刻失败（Drain），Kubernetes 不再把新请求转过来，进行中的请求照常做完。
func (s *Server) serveProbe(w http.ResponseWriter, r *http.Request) bool {
	switch r.URL.Path {
	case "/healthz", "/api/v2/healthz":
		writeJSON(w, 200, map[string]string{"status": "ok", "version": runningVersion, "commit": runningCommit})
	case "/readyz", "/api/v2/readyz":
		if s.draining.Load() {
			s.writeError(w, r, 503, "draining", errors.New("service is shutting down"))
			return true
		}
		if err := s.postgres.Ping(r.Context()); err != nil {
			s.writeError(w, r, 503, "not_ready", errors.New("persistence dependency is unavailable"))
			return true
		}
		writeJSON(w, 200, map[string]string{"status": "ready"})
	case "/statusz", "/api/v2/statusz":
		s.status(w, r)
	default:
		return false
	}
	return true
}

// backupRun 是最近一次备份（见迁移 012 与清单里的 postgres-backup）。
type backupRun struct {
	Name       string    `json:"name"`
	SizeBytes  int64     `json:"sizeBytes"`
	FinishedAt time.Time `json:"finishedAt"`
}

// walArchive 是 WAL 连续归档的状态：按时间点恢复靠它。两个时间从没发生过为 null。
type walArchive struct {
	LastArchivedAt *time.Time `json:"lastArchivedAt"`
	LastFailedAt   *time.Time `json:"lastFailedAt"`
	// Failing 是最近一次失败晚于最近一次成功：PostgreSQL 会一直重试，归档不上的 WAL 堆在数据盘上。
	Failing bool `json:"failing"`
}

// walArchiveQuery 读归档状态。sqlc 不认识 pg_stat_archiver 这类系统视图，所以手写；它和 archive_mode
// 普通用户都能读（切到 CloudNativePG 后 API 不再是超级用户）。
const walArchiveQuery = `SELECT current_setting('archive_mode') IN ('on', 'always'), last_archived_time, last_failed_time FROM pg_stat_archiver`

// archiveFailing：最近一次失败晚于最近一次成功（或从没成功过）。
func archiveFailing(archived, failed *time.Time) bool {
	return failed != nil && (archived == nil || failed.After(*archived))
}

// status 给外部监控看：在跑的版本、最近一次本机与异地备份（从没成功过为 null）、WAL 归档状态
// （数据库没开归档时为 null）。读不了库时 503。不含业务数据，公开也无妨。
func (s *Server) status(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	latest, err := queries.New(s.postgres.Pool()).LatestBackups(ctx)
	backups := map[string]*backupRun{"local": nil, "offsite": nil}
	for _, run := range latest {
		backups[run.Kind] = &backupRun{Name: run.Name, SizeBytes: run.SizeBytes, FinishedAt: run.FinishedAt}
	}
	var archiving bool
	var archive walArchive
	if err == nil {
		err = s.postgres.Pool().QueryRow(ctx, walArchiveQuery).Scan(&archiving, &archive.LastArchivedAt, &archive.LastFailedAt)
	}
	if err != nil {
		s.writeError(w, r, 503, "not_ready", errors.New("persistence dependency is unavailable"))
		return
	}
	var wal *walArchive
	if archiving {
		archive.Failing = archiveFailing(archive.LastArchivedAt, archive.LastFailedAt)
		wal = &archive
	}
	writeJSON(w, 200, map[string]any{"status": "ok", "version": runningVersion, "commit": runningCommit, "backups": backups, "walArchive": wal})
}
