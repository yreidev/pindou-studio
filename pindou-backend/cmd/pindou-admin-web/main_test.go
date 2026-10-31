package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// 页面服务：探针报版本；页面带安全响应头，CSP 是页面自己的（不是接口那条什么都不放行的）；接口路径不回页面。
func TestHandlerServesPagesAndProbe(t *testing.T) {
	Version, Commit = "0.0.39", "abc1234"
	pages := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy", "default-src 'self'")
		_, _ = w.Write([]byte("page " + r.URL.Path))
	})
	h := handler(pages)
	serve := func(method, target string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(method, target, nil))
		return w
	}
	probe := serve(http.MethodGet, "/healthz")
	if probe.Code != http.StatusOK || !strings.Contains(probe.Body.String(), `"version":"0.0.39"`) || !strings.Contains(probe.Body.String(), `"commit":"abc1234"`) {
		t.Fatalf("探针：%d %s", probe.Code, probe.Body.String())
	}
	for _, target := range []string{"/", "/login", "/assets/index.js"} {
		w := serve(http.MethodGet, target)
		if w.Body.String() != "page "+target {
			t.Fatalf("%s 没交给页面：%q", target, w.Body.String())
		}
		if w.Header().Get("X-Frame-Options") != "DENY" || w.Header().Get("X-Content-Type-Options") != "nosniff" {
			t.Fatalf("%s 缺安全响应头：%v", target, w.Header())
		}
		if got := w.Header().Get("Content-Security-Policy"); got != "default-src 'self'" {
			t.Fatalf("%s 的 CSP 应是页面自己的：%q", target, got)
		}
	}
	if w := serve(http.MethodGet, "/api/v2/accounts/me"); w.Code != http.StatusNotFound {
		t.Fatalf("接口路径到了页面服务应回 404：%d %q", w.Code, w.Body.String())
	}
	if w := serve(http.MethodPost, "/healthz"); w.Body.String() != "page /healthz" {
		t.Fatalf("探针只认 GET：%d %q", w.Code, w.Body.String())
	}
}
