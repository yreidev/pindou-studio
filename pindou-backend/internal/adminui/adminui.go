// Package adminui 提供员工电脑网页后台（pindou-admin）的静态页面。
//
// 构建产物由 make admin-embed 从 pindou-admin/dist 复制到本包的 dist/ 再编进二进制（托管方式见 webui）：生产是只提供
// 页面的网页后台服务（cmd/pindou-admin-web，和后端分开部署，见 docs/plan-split-release.md），本机开发和端到端是
// cmd/pindou-dev（和接口同一端口）。后端二进制不再带页面。
package adminui

import (
	"embed"
	"io/fs"
	"net/http"

	"github.com/yreidev/pindou-studio/pindou-backend/internal/webui"
)

//go:embed all:dist
var files embed.FS

// Handler 是网页后台的页面：vite 的打包文件在 assets/ 下、文件名带内容哈希。
func Handler() http.Handler {
	dist, err := fs.Sub(files, "dist")
	if err != nil {
		panic(err)
	}
	return webui.Handler(dist, webui.Config{
		NotBuilt:  "网页后台未构建：先运行 make admin-embed，或用 make admin-binary 构建网页后台服务。",
		Immutable: []string{"assets/"},
	})
}
