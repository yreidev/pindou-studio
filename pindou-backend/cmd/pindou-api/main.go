package main

import (
	"context"
	"encoding/base64"
	"errors"
	"log"
	"log/slog"
	"os"
	"os/signal"
	"regexp"
	"strings"
	"syscall"

	identityapp "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/identity/application"
	"github.com/yreidev/pindou-studio/pindou-backend/internal/service"
)

type configuration struct {
	address, databaseURL, appID, appSecret, developerAccountIDs string
	// fakeWechat 是显式开启的开发用假微信（PINDOU_DEV_FAKE_WECHAT=1）：不调微信，登录码直接当身份、
	// 手机号原样收下。只给本机开发和网页端到端测试用，不能和真实的微信凭证同时配。
	fakeWechat bool
	// bootstrapOwnerID 只在还没有任何老板时生效：启动时把这个已注册账号任命为首位老板。
	bootstrapOwnerID string
	// customerWebHosts 是顾客域名（PINDOU_CUSTOMER_WEB_HOSTS，逗号分隔），默认 localhost：网页桌码印的、
	// 小程序接口所在的域名，接口以外只给微信校验文件和「请用微信扫码」那一页。
	customerWebHosts string
	// linkVerifyFile、linkVerifyContent 是微信「扫普通链接二维码打开小程序」的校验文件
	// （PINDOU_WECHAT_LINK_VERIFY_FILE、PINDOU_WECHAT_LINK_VERIFY_CONTENT）：公众平台添加规则时下载，两项一起配。
	linkVerifyFile, linkVerifyContent string
	// openIDKey 是加密 openid 的密钥（PINDOU_WECHAT_OPENID_KEY，32 字节的 base64）：顾客的预约微信通知要它，
	// 没配时这项功能关着（顾客端不弹订阅框）。生成：openssl rand -base64 32。
	openIDKey []byte
}

// linkVerifyFileName 是校验文件名的样子（微信给的是随机文件名 + 扩展名），挡住带路径的写法。
var linkVerifyFileName = regexp.MustCompile(`^[A-Za-z0-9_-]{1,100}\.[A-Za-z0-9]{1,10}$`)

func loadConfiguration(getenv func(string) string) (configuration, error) {
	cfg := configuration{
		address:             getenv("PINDOU_HTTP_ADDRESS"),
		databaseURL:         getenv("PINDOU_DATABASE_URL"),
		appID:               getenv("PINDOU_WECHAT_APP_ID"),
		appSecret:           getenv("PINDOU_WECHAT_APP_SECRET"),
		developerAccountIDs: getenv("PINDOU_DEVELOPER_ACCOUNT_IDS"),
		fakeWechat:          getenv("PINDOU_DEV_FAKE_WECHAT") == "1",
		bootstrapOwnerID:    getenv("PINDOU_BOOTSTRAP_OWNER_ID"),
		customerWebHosts:    getenv("PINDOU_CUSTOMER_WEB_HOSTS"),
		linkVerifyFile:      strings.TrimSpace(getenv("PINDOU_WECHAT_LINK_VERIFY_FILE")),
		linkVerifyContent:   strings.TrimSpace(getenv("PINDOU_WECHAT_LINK_VERIFY_CONTENT")),
	}
	if cfg.customerWebHosts == "" {
		cfg.customerWebHosts = "localhost"
	}
	if (cfg.linkVerifyFile == "") != (cfg.linkVerifyContent == "") {
		return configuration{}, errors.New("set PINDOU_WECHAT_LINK_VERIFY_FILE and PINDOU_WECHAT_LINK_VERIFY_CONTENT together")
	}
	if cfg.linkVerifyFile != "" && !linkVerifyFileName.MatchString(cfg.linkVerifyFile) {
		return configuration{}, errors.New("PINDOU_WECHAT_LINK_VERIFY_FILE must be a bare file name such as abc123.txt")
	}
	if len(cfg.linkVerifyContent) > 1024 {
		return configuration{}, errors.New("PINDOU_WECHAT_LINK_VERIFY_CONTENT is longer than 1024 bytes")
	}
	if key := strings.TrimSpace(getenv("PINDOU_WECHAT_OPENID_KEY")); key != "" {
		decoded, err := base64.StdEncoding.DecodeString(key)
		if err != nil || len(decoded) != 32 {
			return configuration{}, errors.New("PINDOU_WECHAT_OPENID_KEY must be 32 random bytes in base64 (openssl rand -base64 32)")
		}
		cfg.openIDKey = decoded
	}
	if ids, err := identityapp.DeveloperAccounts(cfg.bootstrapOwnerID); err != nil || len(ids) > 1 {
		return configuration{}, errors.New("PINDOU_BOOTSTRAP_OWNER_ID must be one account UUID")
	}
	if getenv("PINDOU_DEV_STORAGE") != "" {
		return configuration{}, errors.New("PINDOU_DEV_STORAGE was removed: the API always runs on PostgreSQL (see make backend-dev)")
	}
	if cfg.databaseURL == "" {
		return configuration{}, errors.New("PINDOU_DATABASE_URL is required")
	}
	if _, err := identityapp.DeveloperAccounts(cfg.developerAccountIDs); err != nil {
		return configuration{}, err
	}
	if cfg.address == "" {
		cfg.address = ":8080"
	}
	if (cfg.appID == "") != (cfg.appSecret == "") || (cfg.appID == "") != cfg.fakeWechat {
		return configuration{}, errors.New("set PINDOU_WECHAT_APP_ID and PINDOU_WECHAT_APP_SECRET, or PINDOU_DEV_FAKE_WECHAT=1 for local development (not both)")
	}
	return cfg, nil
}

func main() {
	// 日志一律 JSON 写到标准输出（kubectl logs 可直接筛选）；log.Printf 也经它输出。
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))
	// Validate identity settings before connecting or applying database migrations.
	cfg, err := loadConfiguration(os.Getenv)
	if err != nil {
		log.Fatal(err)
	}
	// 0.0.24 起小程序码指向的版本由老板在网页后台「桌码」页设置（迁移 023），这个变量不再读。
	if os.Getenv("PINDOU_WECHAT_TABLE_CODE_ENV") != "" {
		slog.Warn("PINDOU_WECHAT_TABLE_CODE_ENV is no longer read: the owner sets the mini program version on the admin table-codes page")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := service.Run(ctx, service.Config{
		Address: cfg.address, DatabaseURL: cfg.databaseURL, AppID: cfg.appID, AppSecret: cfg.appSecret,
		DeveloperAccountIDs: cfg.developerAccountIDs,
		FakeWechat:          cfg.fakeWechat, BootstrapOwnerID: cfg.bootstrapOwnerID, CustomerWebHosts: cfg.customerWebHosts,
		// 网页桌码印的地址：PINDOU_CUSTOMER_WEB_HOSTS 的第一个域名
		CustomerWebsite: "https://" + strings.TrimSpace(strings.Split(cfg.customerWebHosts, ",")[0]),
		LinkVerifyFile:  cfg.linkVerifyFile, LinkVerifyContent: cfg.linkVerifyContent,
		OpenIDKey: cfg.openIDKey,
	}); err != nil {
		log.Fatal(err)
	}
}
