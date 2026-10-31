// Package webui 是编进程序的单页网页的托管方式（员工网页后台 adminui 用），以及接口和页面共用的安全响应头。
// 网页后台在生产是单独的服务（cmd/pindou-admin-web，docs/plan-split-release.md），经 Traefik 和 /api/v2 同源，
// 不用配 CORS；本机开发和端到端由 cmd/pindou-dev 在同一端口提供。
package webui

import (
	"crypto/sha256"
	"encoding/base64"
	"io/fs"
	"net/http"
	"path"
	"regexp"
	"strings"
)

// SetSecurityHeaders 是接口和页面共用的安全响应头。CSP 默认什么都不放行（接口只回 JSON 和事件流），
// 页面由 Handler 换成自己的。
func SetSecurityHeaders(w http.ResponseWriter) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Frame-Options", "DENY")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
	// 只走 HTTPS（浏览器只在 HTTPS 响应上认这个头）。不带 includeSubDomains：store.example.invalid、personal.example.invalid 下还有别的站点。
	w.Header().Set("Strict-Transport-Security", "max-age=31536000")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
}

// Config 是一个网页的托管方式。
type Config struct {
	// NotBuilt 是只编了后端、没有构建页面时回的说明（503），不给空白页。
	NotBuilt string
	// Immutable 是文件名带内容哈希、可以长期缓存的目录前缀（如 "assets/"）。
	Immutable []string
}

// baseCSP 只放行同源脚本、样式和接口（含 wss 实时连接）；头像是 data: 图片、桌码是 blob: 图片。
// 样式允许 'unsafe-inline'：组件库会在运行时写内联样式。脚本不放开，index.html 里的内联脚本按内容哈希放行。
const baseCSP = "default-src 'self'; script-src 'self'%s; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"

var inlineScript = regexp.MustCompile(`(?s)<script>(.*?)</script>`)

// contentSecurityPolicy 是这份 index.html 的 CSP：其中每段内联脚本按 SHA-256 放行，别的内联脚本照样拦。
func contentSecurityPolicy(index []byte) string {
	hashes := ""
	for _, m := range inlineScript.FindAllSubmatch(index, -1) {
		sum := sha256.Sum256(m[1])
		hashes += " 'sha256-" + base64.StdEncoding.EncodeToString(sum[:]) + "'"
	}
	return strings.Replace(baseCSP, "%s", hashes, 1)
}

// Handler 是单页应用：有对应文件就给文件，其余路径都回 index.html，交给前端路由。
func Handler(dist fs.FS, cfg Config) http.Handler {
	server := http.FileServer(http.FS(dist))
	index, indexErr := fs.ReadFile(dist, "index.html")
	csp := contentSecurityPolicy(index)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Security-Policy", csp)
		name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
		immutable := false
		for _, prefix := range cfg.Immutable {
			immutable = immutable || strings.HasPrefix(name, prefix)
		}
		if name != "" && name != "index.html" {
			if info, err := fs.Stat(dist, name); err == nil && !info.IsDir() {
				// 打包产物文件名带内容哈希，可以长期缓存；其他文件（图标、图片等）短缓存。
				if immutable {
					w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
				} else {
					w.Header().Set("Cache-Control", "public, max-age=300")
				}
				server.ServeHTTP(w, r)
				return
			}
			// 打包资源或带扩展名的文件不存在（多半是发版后旧页面要旧文件）时如实 404，不拿 index.html 冒充脚本、图片。
			// 前端路由的地址没有扩展名。
			if immutable || path.Ext(name) != "" {
				http.NotFound(w, r)
				return
			}
		}
		if indexErr != nil {
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte(cfg.NotBuilt + "\n"))
			return
		}
		// index.html 不缓存：发版后浏览器马上拿到引用新资源的页面。
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write(index)
	})
}
