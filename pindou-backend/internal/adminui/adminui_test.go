package adminui

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// 嵌入的产物总能打开：本机没构建时只有占位说明，构建过则有 index.html，两种都不能让程序起不来。
// 页面本身的托管规则在 internal/webui 里测。
func TestTheEmbeddedPagesAlwaysLoad(t *testing.T) {
	w := httptest.NewRecorder()
	Handler().ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/", nil))
	if w.Code != http.StatusOK && w.Code != http.StatusServiceUnavailable {
		t.Fatalf("embedded admin: %d", w.Code)
	}
}
