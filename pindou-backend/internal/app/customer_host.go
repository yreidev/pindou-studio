package app

import (
	"net/http"
)

// 顾客域名（PINDOU_CUSTOMER_WEB_HOSTS，生产是 pindou.example.invalid）下接口以外的路径。顾客网页 2026-10-31 下线
// （docs/plan-split-release.md），这里只剩两样：
//
//   - 微信「扫普通链接二维码打开小程序」的校验文件（serveLinkVerification）。规则发布后还要不要留，微信的文档没写，
//     一直留着。
//   - 网页桌码（https://<顾客域名>/t?tableId=…）用微信扫会直接打开小程序，不到这里；用手机相机、浏览器、别的 App
//     扫才会打开网页，这时给一页「请用微信扫码」的说明（不带脚本），根路径同样给它。其余路径 404。

// wechatOnlyPage 是用微信以外的方式打开网页桌码时看到的说明。
const wechatOnlyPage = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>请用微信扫码</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#faf7f2;color:#2b2b2b;
font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif}
main{max-width:22rem;padding:2rem 1.5rem;text-align:center;line-height:1.7}
h1{margin:0 0 .75rem;font-size:1.25rem}
p{margin:.5rem 0;color:#555}
</style>
</head>
<body>
<main>
<h1>请用微信扫码</h1>
<p>这是 EXAMPLE 示例工坊的桌码，要用微信「扫一扫」打开，会直接进入小程序入座。</p>
<p>打开微信，点右上角「＋」里的「扫一扫」，再扫一次桌上的二维码。</p>
</main>
</body>
</html>
`

// wechatOnlyPagePolicy 只放行这一页自己的内联样式。
const wechatOnlyPagePolicy = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

func (s *Server) serveCustomerHost(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if s.serveLinkVerification(w, r) {
		return
	}
	switch r.URL.Path {
	case "/", "/t", "/t/":
		w.Header().Set("Content-Security-Policy", wechatOnlyPagePolicy)
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		if r.Method == http.MethodGet {
			_, _ = w.Write([]byte(wechatOnlyPage))
		}
	default:
		http.NotFound(w, r)
	}
}
