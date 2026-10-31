// pindou-admin-web 是员工网页后台的页面服务（docs/plan-split-release.md）：只提供 pindou-admin 构建出的静态页面
// （go:embed 编进二进制，托管方式见 internal/webui），不连数据库、不调微信。生产经 Traefik 和后端同源：
// admin.example.invalid 的 /api/、/healthz 转给后端，其余转到这里，所以页面不用配跨域。
// 本机开发和端到端不用它：cmd/pindou-dev 在同一端口同时提供接口和这些页面。
package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/yreidev/pindou-studio/pindou-backend/internal/adminui"
	"github.com/yreidev/pindou-studio/pindou-backend/internal/webui"
)

// Version、Commit 由发布构建注入（make admin-binary，-ldflags -X main.Version=… -X main.Commit=…）：网页后台自己的
// 版本（pindou-admin/package.json，标签 admin-v<版本>），和后端分开。页面上显示的是构建页面时写进去的同一个版本号。
var (
	Version = "dev"
	Commit  = "unknown"
)

func main() { os.Exit(run()) }

func run() int {
	address := os.Getenv("PINDOU_HTTP_ADDRESS")
	if address == "" {
		address = "127.0.0.1:8080"
	}
	server := &http.Server{
		Addr:              address,
		Handler:           handler(adminui.Handler()),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		IdleTimeout:       60 * time.Second,
		WriteTimeout:      60 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		// 只有静态文件，进行中的请求很快就完
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdown); err != nil {
			slog.Error("shutdown", "error", err.Error())
		}
	}()
	slog.Info("pindou-admin-web listening", "address", address, "version", Version, "commit", Commit)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Print(err)
		return 1
	}
	return 0
}

// handler 是页面加上探针：/healthz 只给 k8s 探针看进程活着、跑的是哪个版本（公网上 admin 域名的 /healthz 由
// Traefik 转给后端）。/api/ 本该由 Traefik 转给后端，到了这里说明路由配错了：回 404，不让页面回退把 index.html
// 当接口响应发出去。安全响应头同后端（webui.SetSecurityHeaders），页面的 CSP 由 webui.Handler 换成自己的。
func handler(pages http.Handler) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok", "version": Version, "commit": Commit})
	})
	mux.HandleFunc("/api/", http.NotFound)
	mux.Handle("/", pages)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		webui.SetSecurityHeaders(w)
		mux.ServeHTTP(w, r)
	})
}
