// Package service 把 API 进程跑起来：连库、迁移、校正布局、监听推送、提供 HTTP，直到 ctx 结束再优雅退出。
// cmd/pindou-api（生产）和 cmd/pindou-dev（本机开发、网页端到端测试）共用它。
package service

import (
	"context"
	"log"
	"log/slog"
	"net"
	"net/http"
	"time"

	"github.com/yreidev/pindou-studio/pindou-backend/internal/app"
	"github.com/yreidev/pindou-studio/pindou-backend/internal/modules/identity/infrastructure/wechat"
	"github.com/yreidev/pindou-studio/pindou-backend/internal/storage"
)

// Config 是已经校验过的启动配置。
type Config struct {
	Address, DatabaseURL, AppID, AppSecret, DeveloperAccountIDs string
	// FakeWechat 不调微信：登录码直接当身份、手机号原样收下。只给本机开发和网页端到端测试用。
	FakeWechat bool
	// BootstrapOwnerID 只在还没有任何老板时生效：启动时把这个已注册账号任命为首位老板。
	BootstrapOwnerID string
	// CustomerWebHosts 是顾客域名（逗号分隔）：接口以外只给微信校验文件和「请用微信扫码」那一页。
	CustomerWebHosts string
	// CustomerWebsite 是顾客域名的地址（如 https://pindou.example.invalid），网页桌码印的就是它。
	CustomerWebsite string
	// Pages 是员工网页后台的页面（顾客域名以外、接口以外的路径）：只给本机开发和端到端，生产不配（网页后台是单独的服务）。
	Pages http.Handler
	// LinkVerifyFile、LinkVerifyContent 是微信「扫普通链接二维码打开小程序」的校验文件（没配为空）。
	LinkVerifyFile, LinkVerifyContent string
	// OpenIDKey 是加密 openid 的 32 字节密钥：顾客的预约微信通知要它，没配（nil）时这项功能关着。
	OpenIDKey []byte
}

func Run(ctx context.Context, cfg Config) error {
	// 数据库可能比 API 晚就绪（服务器重启时两者一起起），等它最多一分钟。迁移在咨询锁里执行，
	// 滚动发布时新旧副本同时启动也只有一个在跑迁移。
	postgres, err := storage.OpenWhenReady(context.Background(), cfg.DatabaseURL, time.Minute)
	if err != nil {
		return err
	}
	defer postgres.Close()
	server := app.NewServer(postgres)
	server.LogScale()
	// 门店布局是固定的：启动时按 layout/store-layout.json 校正区域与桌位。
	// ★ 刻意放在这里而不是 NewServer 里：NewServer 也是测试建夹具的入口，
	//   在那里自动灌进 4 区 20 桌会把每个用例的初始状态搅浑。
	// ★ 布局对不上就开不起来（布局外的桌、有人坐在将被缩掉的座号上），
	//   这是设计如此 —— 带着错的布局跑起来，顾客端会整张图拒绝服务而店家收不到信号。
	if err := server.ReconcileLayout(context.Background()); err != nil {
		return err
	}
	if err := server.ConfigureDeveloperAccounts(cfg.DeveloperAccountIDs); err != nil {
		return err
	}
	server.ConfigureCustomerWebHosts(cfg.CustomerWebHosts)
	if cfg.Pages != nil {
		server.ServePages(cfg.Pages)
	}
	server.ConfigureCustomerWebsite(cfg.CustomerWebsite)
	server.ConfigureLinkVerification(cfg.LinkVerifyFile, cfg.LinkVerifyContent)
	if err := server.ConfigureNoticeKey(cfg.OpenIDKey); err != nil {
		return err
	}
	if cfg.OpenIDKey == nil {
		slog.Warn("PINDOU_WECHAT_OPENID_KEY is not set: reservation notices to customers are off")
	}
	if cfg.BootstrapOwnerID != "" {
		done, err := server.BootstrapFirstOwner(context.Background(), cfg.BootstrapOwnerID)
		if err != nil {
			return err
		}
		slog.Info("bootstrap owner", "applied", done)
	}
	if cfg.FakeWechat {
		slog.Warn("PINDOU_DEV_FAKE_WECHAT=1: login codes are accepted as identities; never use this in production")
	} else {
		client, err := wechat.New(cfg.AppID, cfg.AppSecret)
		if err != nil {
			return err
		}
		server.UseWechat(client)
	}
	httpServer := &http.Server{
		Handler:           server,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		IdleTimeout:       60 * time.Second,
		WriteTimeout:      60 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}
	// Shutdown 不管已被接管的 WebSocket，也不会结束仍在推送的 SSE：先让事件流自己退出。
	// 客户端会重连到别的副本（滚动发布时总有一个在服务）。
	httpServer.RegisterOnShutdown(server.CloseEvents)
	listener, err := (&net.ListenConfig{}).Listen(context.Background(), "tcp", cfg.Address)
	if err != nil {
		return err
	}
	log.Printf("pindou API listening on %s", cfg.Address)
	// 各副本的写入经 LISTEN/NOTIFY 送到这里，再推给连在本副本上的事件流。
	events, stopEvents := context.WithCancel(context.Background())
	defer stopEvents()
	go server.ListenEvents(events)
	// 顾客预约的开始前提醒：每分钟查一次到点的（两个副本都跑，领取时只有一个领得到）
	go server.RunNotices(events)
	err = serve(ctx, httpServer, listener, server.Drain, 20*time.Second)
	// 请求提交之后还在发的微信通知，给它们一点时间做完
	server.WaitBackground(10 * time.Second)
	return err
}

// serve 运行到 ctx 结束，然后关停并等进行中的请求处理完。
//
// ★ Shutdown 一开始，Serve 就立刻返回 ErrServerClosed。以前 main 在那时直接退出，
//
//	正在落库的写请求被整个进程带走 —— 每次发布都可能切断一笔收款。
//
// 只有 Serve 自己失败才返回错误（进程应以非零退出，交给 k8s 重启）；
// 关停超时只记日志，这是一次正常的停止。
func serve(ctx context.Context, srv *http.Server, listener net.Listener, drain func(), grace time.Duration) error {
	served := make(chan error, 1)
	go func() { served <- srv.Serve(listener) }()
	select {
	case err := <-served:
		return err
	case <-ctx.Done():
	}
	// 就绪检查先失败：Kubernetes 不再转新请求过来（Pod 的 preStop 已经等过一会儿，端点多半已经摘掉）。
	drain()
	shutdown, cancel := context.WithTimeout(context.Background(), grace)
	defer cancel()
	if err := srv.Shutdown(shutdown); err != nil {
		log.Printf("pindou API graceful shutdown failed: %v", err)
	}
	return nil
}
