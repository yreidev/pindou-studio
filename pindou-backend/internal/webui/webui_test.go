package webui

import (
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

func serve(t *testing.T, h http.Handler, method, target string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(method, target, nil))
	if csp := w.Header().Get("Content-Security-Policy"); method == http.MethodGet && !strings.Contains(csp, "script-src 'self'") {
		t.Fatalf("%s %s: CSP = %q", method, target, csp)
	}
	return w
}

var site = Config{NotBuilt: "网页未构建", Immutable: []string{"assets/"}}

// 单页应用：深层地址回 index.html 交给前端路由；带哈希的打包文件长期缓存，index.html 不缓存。
func TestServesTheSinglePageApp(t *testing.T) {
	h := Handler(fstest.MapFS{
		"index.html":        {Data: []byte("<!doctype html><title>示例工坊后台</title>")},
		"assets/index-1.js": {Data: []byte("console.log(1)")},
		"favicon.png":       {Data: []byte("png")},
	}, site)

	for _, target := range []string{"/", "/index.html", "/orders?page=2", "/sales-orders/abc/refunds"} {
		w := serve(t, h, http.MethodGet, target)
		if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "示例工坊后台") || w.Header().Get("Cache-Control") != "no-cache" {
			t.Fatalf("%s: %d cache=%q body=%q", target, w.Code, w.Header().Get("Cache-Control"), w.Body.String())
		}
	}
	if w := serve(t, h, http.MethodGet, "/assets/index-1.js"); w.Code != http.StatusOK || !strings.Contains(w.Header().Get("Cache-Control"), "immutable") {
		t.Fatalf("asset: %d cache=%q", w.Code, w.Header().Get("Cache-Control"))
	}
	if w := serve(t, h, http.MethodGet, "/favicon.png"); w.Code != http.StatusOK || w.Header().Get("Cache-Control") != "public, max-age=300" {
		t.Fatalf("favicon: %d cache=%q", w.Code, w.Header().Get("Cache-Control"))
	}
	// 发版后旧页面要旧的打包文件、或要一张不存在的图：如实 404，不能拿 index.html 冒充脚本和图片
	for _, target := range []string{"/assets/index-0.js", "/pages/customer/assets/gallery/none.jpg"} {
		if w := serve(t, h, http.MethodGet, target); w.Code != http.StatusNotFound {
			t.Fatalf("missing %s: %d %q", target, w.Code, w.Body.String())
		}
	}
	// 路径穿越被规整回站内
	if w := serve(t, h, http.MethodGet, "/../../etc/passwd"); w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "示例工坊后台") {
		t.Fatalf("traversal: %d %q", w.Code, w.Body.String())
	}
	if w := serve(t, h, http.MethodPost, "/orders"); w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST: %d", w.Code)
	}
}

// Taro 网页版的 index.html 里有一段按屏宽设根字号的内联脚本：按内容哈希放行它，别的内联脚本照样拦。
func TestInlineScriptsInTheIndexAreAllowedByHash(t *testing.T) {
	script := `!function(n){n.document.documentElement.style.fontSize="20px"}(window);`
	h := Handler(fstest.MapFS{
		"index.html": {Data: []byte(`<!doctype html><body><div id="app"></div><script>` + script + `</script><script type="module" src="/js/app.js"></script></body>`)},
	}, site)
	sum := sha256.Sum256([]byte(script))
	csp := serve(t, h, http.MethodGet, "/").Header().Get("Content-Security-Policy")
	if !strings.Contains(csp, "script-src 'self' 'sha256-"+base64.StdEncoding.EncodeToString(sum[:])+"';") {
		t.Fatalf("CSP = %q", csp)
	}
	if strings.Contains(csp, "unsafe-inline'; style-src") || strings.Count(csp, "sha256-") != 1 {
		t.Fatalf("只放行那一段：%q", csp)
	}
}

// 只编了后端、没构建网页时明确说未构建，而不是给一个空白页。
func TestSaysSoWhenThePagesWereNotBuilt(t *testing.T) {
	h := Handler(fstest.MapFS{"README.txt": {Data: []byte("placeholder")}}, site)
	w := serve(t, h, http.MethodGet, "/orders")
	if w.Code != http.StatusServiceUnavailable || !strings.Contains(w.Body.String(), "网页未构建") {
		t.Fatalf("without a build: %d %q", w.Code, w.Body.String())
	}
}
