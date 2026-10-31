package app

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// 电脑网页后台的扫码登录：网页发挑战 → 员工在小程序里看清设备后批准 → 网页凭 pollToken 领到网页会话。

type webChallenge struct {
	ID, PollToken, QRText string
}

func createChallenge(t *testing.T, s *Server, userAgent string) webChallenge {
	t.Helper()
	r := httptest.NewRequest(http.MethodPost, "/api/v2/auth/web-login-challenges", nil)
	r.Header.Set("User-Agent", userAgent)
	w := serve(t, s, r)
	if w.Code != http.StatusCreated {
		t.Fatalf("create challenge: %d %s", w.Code, w.Body.String())
	}
	m := decodeMap(t, w)
	return webChallenge{ID: m["id"].(string), PollToken: m["pollToken"].(string), QRText: m["qrText"].(string)}
}

func claim(t *testing.T, s *Server, c webChallenge) *httptest.ResponseRecorder {
	t.Helper()
	return call(t, s, http.MethodPost, "/api/v2/auth/web-login-challenges/"+c.ID+"/session", "", "", map[string]any{"pollToken": c.PollToken})
}

func decide(t *testing.T, s *Server, bearer string, c webChallenge, approve bool) *httptest.ResponseRecorder {
	t.Helper()
	return call(t, s, http.MethodPost, "/api/v2/auth/web-login-challenges/"+c.ID+"/decision", bearer, "", map[string]any{"approve": approve})
}

func ownerFixture(t *testing.T, s *Server) sessionResponse {
	t.Helper()
	owner := register(t, s, "web-login-owner", "Owner")
	if err := s.BootstrapOwner(owner.User.ID); err != nil {
		t.Fatal(err)
	}
	return owner
}

func TestWebLoginApprovedByStaffIssuesOneWebSession(t *testing.T) {
	s := newTestServer(t)
	owner := ownerFixture(t, s)
	c := createChallenge(t, s, "Mozilla/5.0 前台电脑")
	if c.QRText != "pindou-web-login:"+c.ID {
		t.Fatalf("qrText=%q", c.QRText)
	}
	if w := claim(t, s, c); w.Code != http.StatusAccepted || decodeMap(t, w)["status"] != "pending" {
		t.Fatalf("claim before approval: %d %s", w.Code, w.Body.String())
	}
	view := call(t, s, http.MethodGet, "/api/v2/auth/web-login-challenges/"+c.ID, owner.AccessToken, "", nil)
	if view.Code != http.StatusOK {
		t.Fatalf("view: %d %s", view.Code, view.Body.String())
	}
	if v := decodeMap(t, view); v["status"] != "pending" || v["userAgent"] != "Mozilla/5.0 前台电脑" {
		t.Fatalf("view body: %v", v)
	}
	if w := decide(t, s, owner.AccessToken, c, true); w.Code != http.StatusOK || decodeMap(t, w)["status"] != "approved" {
		t.Fatalf("approve: %d %s", w.Code, w.Body.String())
	}
	w := claim(t, s, c)
	if w.Code != http.StatusCreated {
		t.Fatalf("claim after approval: %d %s", w.Code, w.Body.String())
	}
	webToken := decodeMap(t, w)["accessToken"].(string)
	if got := call(t, s, http.MethodGet, "/api/v2/accounts/"+owner.User.ID, webToken, "", nil).Code; got != http.StatusOK {
		t.Fatalf("web session cannot read: %d", got)
	}
	sess := authSessionOf(t, s, webToken)
	if sess.Client != clientWeb || sess.UserID != owner.User.ID {
		t.Fatalf("web session = %+v", sess)
	}
	if left := time.Until(sess.ExpiresAt); left < 11*time.Hour || left > 12*time.Hour {
		t.Fatalf("web session lasts %s, want 12h", left)
	}
	if w := claim(t, s, c); w.Code != http.StatusGone {
		t.Fatalf("second claim: %d %s", w.Code, w.Body.String())
	}
	if len(auditsOf(t, s)) == 0 || lastAudit(t, s).Action != "web_login.approved" {
		t.Fatal("approval not audited")
	}
}

func TestWebLoginRejectExpiryAndWrongPollToken(t *testing.T) {
	s := newTestServer(t)
	owner := ownerFixture(t, s)

	rejected := createChallenge(t, s, "ua")
	if w := decide(t, s, owner.AccessToken, rejected, false); w.Code != http.StatusOK {
		t.Fatalf("reject: %d", w.Code)
	}
	if w := claim(t, s, rejected); w.Code != http.StatusGone {
		t.Fatalf("claim rejected: %d", w.Code)
	}

	wrong := createChallenge(t, s, "ua")
	wrong.PollToken = "not-the-token"
	if w := claim(t, s, wrong); w.Code != http.StatusNotFound {
		t.Fatalf("wrong pollToken: %d", w.Code)
	}
	if w := claim(t, s, webChallenge{ID: id(), PollToken: "x"}); w.Code != http.StatusNotFound {
		t.Fatalf("unknown challenge: %d", w.Code)
	}

	expired := createChallenge(t, s, "ua")
	s.now = func() time.Time { return time.Now().Add(webLoginTTL + time.Second) }
	if v := decodeMap(t, call(t, s, http.MethodGet, "/api/v2/auth/web-login-challenges/"+expired.ID, owner.AccessToken, "", nil)); v["status"] != "expired" {
		t.Fatalf("expired view: %v", v)
	}
	if w := decide(t, s, owner.AccessToken, expired, true); w.Code != http.StatusConflict {
		t.Fatalf("approve expired: %d", w.Code)
	}
	if w := claim(t, s, expired); w.Code != http.StatusGone {
		t.Fatalf("claim expired: %d", w.Code)
	}
}

func TestWebLoginNeedsStaffAndAnExplicitDecision(t *testing.T) {
	s := newTestServer(t)
	owner := ownerFixture(t, s)
	customer := register(t, s, "web-login-customer", "Customer")
	c := createChallenge(t, s, "ua")
	if w := call(t, s, http.MethodGet, "/api/v2/auth/web-login-challenges/"+c.ID, customer.AccessToken, "", nil); w.Code != http.StatusForbidden {
		t.Fatalf("customer view: %d", w.Code)
	}
	if w := decide(t, s, customer.AccessToken, c, true); w.Code != http.StatusForbidden {
		t.Fatalf("customer approve: %d", w.Code)
	}
	if w := decide(t, s, "", c, true); w.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous approve: %d", w.Code)
	}
	if w := call(t, s, http.MethodPost, "/api/v2/auth/web-login-challenges/"+c.ID+"/decision", owner.AccessToken, "", map[string]any{}); w.Code != http.StatusBadRequest {
		t.Fatalf("missing approve: %d", w.Code)
	}
	if w := claim(t, s, c); w.Code != http.StatusAccepted {
		t.Fatalf("challenge should still be pending: %d", w.Code)
	}
}

func TestConcurrentClaimsIssueExactlyOneSession(t *testing.T) {
	s := newTestServer(t)
	owner := ownerFixture(t, s)
	c := createChallenge(t, s, "ua")
	if w := decide(t, s, owner.AccessToken, c, true); w.Code != http.StatusOK {
		t.Fatal(w.Code)
	}
	var wg sync.WaitGroup
	codes := make(chan int, 8)
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			codes <- claim(t, s, c).Code
		}()
	}
	wg.Wait()
	close(codes)
	issued := 0
	for code := range codes {
		if code == http.StatusCreated {
			issued++
		} else if code != http.StatusGone {
			t.Fatalf("unexpected claim status %d", code)
		}
	}
	if issued != 1 {
		t.Fatalf("issued %d web sessions, want 1", issued)
	}
}

func webSessionFor(t *testing.T, s *Server, approver sessionResponse) string {
	t.Helper()
	c := createChallenge(t, s, "ua")
	if w := decide(t, s, approver.AccessToken, c, true); w.Code != http.StatusOK {
		t.Fatalf("approve: %d %s", w.Code, w.Body.String())
	}
	w := claim(t, s, c)
	if w.Code != http.StatusCreated {
		t.Fatalf("claim: %d %s", w.Code, w.Body.String())
	}
	return decodeMap(t, w)["accessToken"].(string)
}

func TestLogoutAndRevokeWebSessions(t *testing.T) {
	s := newTestServer(t)
	owner := ownerFixture(t, s)
	first, second := webSessionFor(t, s, owner), webSessionFor(t, s, owner)

	if w := call(t, s, http.MethodDelete, "/api/v2/auth/sessions/current", first, "", nil); w.Code != http.StatusNoContent {
		t.Fatalf("logout: %d %s", w.Code, w.Body.String())
	}
	if got := call(t, s, http.MethodGet, "/api/v2/accounts/"+owner.User.ID, first, "", nil).Code; got != http.StatusUnauthorized {
		t.Fatalf("logged out token still works: %d", got)
	}

	w := call(t, s, http.MethodDelete, "/api/v2/auth/web-sessions", owner.AccessToken, "", nil)
	if w.Code != http.StatusOK || decodeMap(t, w)["revoked"] != float64(1) {
		t.Fatalf("revoke web sessions: %d %s", w.Code, w.Body.String())
	}
	if got := call(t, s, http.MethodGet, "/api/v2/accounts/"+owner.User.ID, second, "", nil).Code; got != http.StatusUnauthorized {
		t.Fatalf("revoked web token still works: %d", got)
	}
	if got := call(t, s, http.MethodGet, "/api/v2/accounts/"+owner.User.ID, owner.AccessToken, "", nil).Code; got != http.StatusOK {
		t.Fatalf("revoking web sessions logged out the mini program: %d", got)
	}
}

// 网页会话按批准人的真实任命算角色：小程序里选的体验身份不带过去；网页会话既不能切换体验身份，
// 也不能批准新的扫码登录（否则一张网页令牌能自己续期）。
func TestWebSessionUsesRealRolesAndCannotApproveOrSwitch(t *testing.T) {
	s := newTestServer(t)
	owner := ownerFixture(t, s)
	dev := register(t, s, "web-login-developer", "Developer")
	if err := s.ConfigureDeveloperAccounts(dev.User.ID); err != nil {
		t.Fatal(err)
	}
	if w := call(t, s, http.MethodPost, "/api/v2/staff-role-assignments", owner.AccessToken, id(), map[string]string{"accountId": dev.User.ID, "role": "manager"}); w.Code != http.StatusCreated {
		t.Fatalf("assign manager: %d %s", w.Code, w.Body.String())
	}
	dev = switchMode(t, s, dev, "clerk")
	webToken := webSessionFor(t, s, dev)
	v := decodeMap(t, call(t, s, http.MethodGet, "/api/v2/accounts/"+dev.User.ID, webToken, "", nil))
	if roles, _ := v["roles"].([]any); len(roles) != 1 || roles[0] != "manager" || v["developerMode"] != "developer" {
		t.Fatalf("web session should use the real assignment: roles=%v mode=%v", v["roles"], v["developerMode"])
	}
	if got := call(t, s, http.MethodPost, "/api/v2/auth/developer-sessions", webToken, "", map[string]string{"mode": "clerk"}).Code; got != http.StatusForbidden {
		t.Fatalf("web session switched experience mode: %d", got)
	}
	c := createChallenge(t, s, "ua")
	if w := decide(t, s, webToken, c, true); w.Code != http.StatusForbidden {
		t.Fatalf("web session approved a web login: %d %s", w.Code, w.Body.String())
	}
	if w := decide(t, s, owner.AccessToken, c, true); w.Code != http.StatusOK {
		t.Fatalf("miniapp approval after rejected web attempt: %d %s", w.Code, w.Body.String())
	}
}

func TestCreatingChallengesIsRateLimited(t *testing.T) {
	s := newTestServer(t)
	limited := false
	for range identityRateLimit + 1 {
		w := serve(t, s, httptest.NewRequest(http.MethodPost, "/api/v2/auth/web-login-challenges", nil))
		if w.Code == http.StatusTooManyRequests {
			limited = true
			break
		}
	}
	if !limited {
		t.Fatal("anonymous challenge creation is not rate limited")
	}
}

// 浏览器的 WebSocket 设不了 Authorization 头：事件流接受子协议带令牌，并且必须回显选中的子协议。
func TestEventStreamAcceptsTheTokenAsAWebSocketSubprotocol(t *testing.T) {
	s := newTestServer(t)
	owner := ownerFixture(t, s)
	customer := register(t, s, "web-login-ws-customer", "Customer")
	server := httptest.NewServer(s)
	defer server.Close()

	// 只要状态码和服务端选中的子协议；响应在函数里读完就关掉。
	handshake := func(path, protocols string) (int, string) {
		t.Helper()
		conn, err := net.Dial("tcp", strings.TrimPrefix(server.URL, "http://"))
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = conn.Close() })
		request := "GET " + path + " HTTP/1.1\r\nHost: test\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
			"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n"
		if protocols != "" {
			request += "Sec-WebSocket-Protocol: " + protocols + "\r\n"
		}
		if _, err := io.WriteString(conn, request+"\r\n"); err != nil {
			t.Fatal(err)
		}
		response, err := http.ReadResponse(bufio.NewReader(conn), nil)
		if err != nil {
			t.Fatal(err)
		}
		_ = response.Body.Close()
		return response.StatusCode, response.Header.Get("Sec-WebSocket-Protocol")
	}

	if status, protocol := handshake("/api/v2/event-streams", "pindou.v1, bearer."+owner.AccessToken); status != http.StatusSwitchingProtocols || protocol != "pindou.v1" {
		t.Fatalf("subprotocol handshake: %d protocol=%q", status, protocol)
	}
	if got, _ := handshake("/api/v2/event-streams", "bearer."+owner.AccessToken); got != http.StatusUnauthorized {
		t.Fatalf("token without pindou.v1: %d", got)
	}
	if got, _ := handshake("/api/v2/event-streams?access_token="+owner.AccessToken, ""); got != http.StatusUnauthorized {
		t.Fatalf("token in the URL must not be accepted: %d", got)
	}
	// 顾客也能用子协议连上（只收自己的事件）
	if got, _ := handshake("/api/v2/event-streams", "pindou.v1, bearer."+customer.AccessToken); got != http.StatusSwitchingProtocols {
		t.Fatalf("customer token: %d", got)
	}
}

// 顾客域名（PINDOU_CUSTOMER_WEB_HOSTS）下接口以外的路径：顾客网页已下线，根路径和网页桌码（/t）给「请用微信扫码」
// 那一页（不带脚本），其余 404；接口照常可用。别的域名交给配上的网页后台页面，没配（生产的后端）就 404。
func TestCustomerHostShowsTheWechatOnlyPage(t *testing.T) {
	s := newTestServer(t)
	s.ConfigureCustomerWebHosts(" Pindou.Example.Invalid , localhost")
	s.ServePages(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusTeapot) }))
	page := func(method, host, target string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, target, nil)
		r.Host = host
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		return w
	}
	for _, host := range []string{"pindou.example.invalid", "PINDOU.EXAMPLE.INVALID", "localhost:8080"} {
		for _, target := range []string{"/", "/t", "/t/", "/t?tableId=abc"} {
			w := page(http.MethodGet, host, target)
			if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "请用微信扫码") || !strings.HasPrefix(w.Header().Get("Content-Type"), "text/html") {
				t.Fatalf("%s%s: %d %q", host, target, w.Code, w.Body.String())
			}
			if csp := w.Header().Get("Content-Security-Policy"); strings.Contains(csp, "script-src") || !strings.Contains(csp, "default-src 'none'") {
				t.Fatalf("%s%s: 说明页不该放行脚本：%q", host, target, csp)
			}
			if strings.Contains(w.Body.String(), "<script") {
				t.Fatalf("%s%s: 说明页带了脚本", host, target)
			}
		}
		for _, target := range []string{"/js/app.js", "/pages/customer/experience/index", "/login"} {
			if w := page(http.MethodGet, host, target); w.Code != http.StatusNotFound {
				t.Fatalf("%s%s: 顾客网页已下线，应 404：%d", host, target, w.Code)
			}
		}
	}
	if w := page(http.MethodHead, "pindou.example.invalid", "/t"); w.Code != http.StatusOK || w.Body.Len() != 0 {
		t.Fatalf("HEAD /t: %d %q", w.Code, w.Body.String())
	}
	if w := page(http.MethodPost, "pindou.example.invalid", "/t"); w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST /t: %d", w.Code)
	}
	for _, host := range []string{"admin.example.invalid", "127.0.0.1:8080", "store.example.invalid"} {
		if w := page(http.MethodGet, host, "/"); w.Code != http.StatusTeapot {
			t.Fatalf("%s: %d", host, w.Code)
		}
	}
	if w := page(http.MethodGet, "pindou.example.invalid", "/healthz"); w.Code != http.StatusOK {
		t.Fatalf("health on the customer host: %d", w.Code)
	}
	if w := page(http.MethodGet, "pindou.example.invalid", "/api/v2/no-such-resource"); w.Code != http.StatusNotFound {
		t.Fatalf("API on the customer host: %d", w.Code)
	}
}

// 微信「扫普通链接二维码打开小程序」的校验文件：配了才有，只在顾客域名下、根目录和 /t 下各一份，只认 GET/HEAD；
// 顾客网页下线后照样在（网页桌码在微信里扫开小程序靠这条规则），后台域名下没有。
func TestCustomerHostServesTheWechatLinkVerificationFile(t *testing.T) {
	s := newTestServer(t)
	s.ConfigureCustomerWebHosts("pindou.example.invalid")
	s.ServePages(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusTeapot) }))
	serve := func(method, host, target string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, target, nil)
		r.Host = host
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		return w
	}
	// 没配：和别的路径一样 404
	if w := serve(http.MethodGet, "pindou.example.invalid", "/abc123.txt"); w.Code != http.StatusNotFound {
		t.Fatalf("not configured: %d", w.Code)
	}
	s.ConfigureLinkVerification("abc123.txt", "0123456789abcdef")
	for _, target := range []string{"/abc123.txt", "/t/abc123.txt"} {
		w := serve(http.MethodGet, "pindou.example.invalid", target)
		if w.Code != http.StatusOK || w.Body.String() != "0123456789abcdef" || !strings.HasPrefix(w.Header().Get("Content-Type"), "text/plain") {
			t.Fatalf("%s: %d %q %q", target, w.Code, w.Body.String(), w.Header().Get("Content-Type"))
		}
	}
	if w := serve(http.MethodHead, "pindou.example.invalid", "/abc123.txt"); w.Code != http.StatusOK {
		t.Fatalf("HEAD: %d", w.Code)
	}
	for _, target := range []string{"/other.txt", "/x/abc123.txt"} {
		if w := serve(http.MethodGet, "pindou.example.invalid", target); w.Code != http.StatusNotFound {
			t.Fatalf("%s: %d", target, w.Code)
		}
	}
	if w := serve(http.MethodPost, "pindou.example.invalid", "/abc123.txt"); w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST: %d", w.Code)
	}
	if w := serve(http.MethodGet, "admin.example.invalid", "/abc123.txt"); w.Code != http.StatusTeapot {
		t.Fatalf("admin host: %d", w.Code)
	}
}

// 接口以外的路径交给配上的网页后台页面（本机开发、端到端；页面本身的行为在 internal/adminui 里测）；接口路径、
// 健康检查不经过它。生产的后端不配页面（网页后台是单独的服务），这些路径 404，带接口那条什么都不放行的 CSP。
func TestNonAPIPathsServeTheAdminPages(t *testing.T) {
	s := newTestServer(t)
	for _, target := range []string{"/", "/orders"} {
		w := serve(t, s, httptest.NewRequest(http.MethodGet, target, nil))
		if w.Code != http.StatusNotFound || w.Header().Get("Content-Security-Policy") != "default-src 'none'; frame-ancestors 'none'" {
			t.Fatalf("没配页面时 %s：%d csp=%q", target, w.Code, w.Header().Get("Content-Security-Policy"))
		}
	}
	var served []string
	s.ServePages(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		served = append(served, r.URL.Path)
		w.WriteHeader(http.StatusTeapot)
	}))
	for _, target := range []string{"/", "/orders?page=2", "/assets/index.js"} {
		w := httptest.NewRecorder()
		s.ServeHTTP(w, httptest.NewRequest(http.MethodGet, target, nil))
		if w.Code != http.StatusTeapot {
			t.Fatalf("%s did not reach the admin pages: %d", target, w.Code)
		}
	}
	for _, target := range []string{"/api/v2/no-such-resource", "/healthz", "/readyz"} {
		w := serve(t, s, httptest.NewRequest(http.MethodGet, target, nil))
		if w.Code == http.StatusTeapot {
			t.Fatalf("%s was handed to the admin pages", target)
		}
		if strings.HasPrefix(target, "/api/") && (w.Code != http.StatusNotFound || w.Header().Get("Content-Security-Policy") != "default-src 'none'; frame-ancestors 'none'") {
			t.Fatalf("API path: %d csp=%q", w.Code, w.Header().Get("Content-Security-Policy"))
		}
	}
	if len(served) != 3 {
		t.Fatalf("admin served %v", served)
	}
}

// 网页的实时连接靠子协议带令牌；小程序里「退出所有电脑登录」后，已经连着的网页也要在下一次推送前断开。
func TestRevokingWebSessionsClosesTheirEventStreams(t *testing.T) {
	s := newTestServer(t)
	owner := ownerFixture(t, s)
	web := webSessionFor(t, s, owner)
	server := httptest.NewServer(s)
	defer server.Close()

	conn, reader, _ := handshake(t, server, "Sec-WebSocket-Protocol: pindou.v1, bearer."+web+"\r\n")
	// 一直推事件：每次推送前服务端都会复查身份，撤销后的下一次推送就该断开。
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		ticker := time.NewTicker(10 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				s.hub.publish(map[string]string{"type": "resource.updated", "resource": "tables"}, nil, false)
			}
		}
	}()
	if first, err := readFrameHeader(t, conn, reader); err != nil || first != 0x81 {
		t.Fatalf("first frame=%#x err=%v, want an event before the revocation", first, err)
	}

	if w := call(t, s, http.MethodDelete, "/api/v2/auth/web-sessions", owner.AccessToken, "", nil); w.Code != http.StatusOK {
		t.Fatalf("revoke web sessions: %d %s", w.Code, w.Body.String())
	}
	expectClosed(t, conn, reader, 1008, "web event stream stayed open after its session was revoked")
}

// codeWechat 只会生成小程序码，记下 scene。
type codeWechat struct {
	scenes []string
	envs   []string
	err    error
}

func (c *codeWechat) ExchangeLogin(context.Context, string) (string, error) {
	return "", errors.New("not used")
}
func (c *codeWechat) ExchangePhone(context.Context, string) (string, error) {
	return "", errors.New("not used")
}
func (c *codeWechat) TableCode(context.Context, string, string) ([]byte, error) {
	return nil, errors.New("not used")
}
func (c *codeWechat) WebLoginCode(_ context.Context, scene, env string) ([]byte, error) {
	c.scenes = append(c.scenes, scene)
	c.envs = append(c.envs, env)
	if c.err != nil {
		return nil, c.err
	}
	return []byte{137, 80, 78, 71, 13, 10, 26, 10, 0}, nil
}

// 网页拿 pollToken 换一张小程序码：微信扫一扫直达批准页，scene 是去掉连字符的挑战编号。
// 只有发起的网页能换；挑战关了、没配微信、微信出错都说清楚，网页据此退回普通二维码。
func TestWebLoginCodeOpensTheApprovalPage(t *testing.T) {
	s := newTestServer(t)
	owner := ownerFixture(t, s)
	c := createChallenge(t, s, "Mozilla/5.0 (Windows NT 10.0) Chrome/150")
	codeOf := func(challenge, pollToken string) *httptest.ResponseRecorder {
		return call(t, s, http.MethodPost, "/api/v2/auth/web-login-challenges/"+challenge+"/code", "", "", map[string]any{"pollToken": pollToken})
	}
	if w := codeOf(c.ID, c.PollToken); w.Code != http.StatusServiceUnavailable || decodeMap(t, w)["code"] != "wechat_unavailable" {
		t.Fatalf("without WeChat: %d %s", w.Code, w.Body.String())
	}
	fake := &codeWechat{}
	s.wechat = fake
	w := codeOf(c.ID, c.PollToken)
	if w.Code != http.StatusOK || !strings.HasPrefix(decodeMap(t, w)["imageDataUrl"].(string), "data:image/png;base64,") {
		t.Fatalf("code: %d %s", w.Code, w.Body.String())
	}
	if len(fake.scenes) != 1 || fake.scenes[0] != strings.ReplaceAll(c.ID, "-", "") || len(fake.scenes[0]) != 32 {
		t.Fatalf("scene %v for challenge %s", fake.scenes, c.ID)
	}
	// 登录码和桌码指向同一个版本：老板没改过时是体验版
	if len(fake.envs) != 1 || fake.envs[0] != "trial" {
		t.Fatalf("login code env %v", fake.envs)
	}
	if w := codeOf(c.ID, "wrong-token"); w.Code != http.StatusNotFound {
		t.Fatalf("wrong poll token: %d", w.Code)
	}
	if w := codeOf(id(), c.PollToken); w.Code != http.StatusNotFound {
		t.Fatalf("unknown challenge: %d", w.Code)
	}
	if w := call(t, s, http.MethodPost, "/api/v2/auth/web-login-challenges/"+c.ID+"/code", "", "", map[string]any{}); w.Code != http.StatusBadRequest {
		t.Fatalf("missing poll token: %d", w.Code)
	}
	fake.err = errors.New("小程序码生成失败（当前指向体验版）：微信 errcode 41030，invalid page")
	if w := codeOf(c.ID, c.PollToken); w.Code != http.StatusServiceUnavailable || !strings.Contains(w.Body.String(), "41030") {
		t.Fatalf("WeChat failure should carry its errcode: %d %s", w.Code, w.Body.String())
	}
	fake.err = nil
	if w := decide(t, s, owner.AccessToken, c, true); w.Code != http.StatusOK {
		t.Fatalf("approve: %d %s", w.Code, w.Body.String())
	}
	if w := codeOf(c.ID, c.PollToken); w.Code != http.StatusGone {
		t.Fatalf("code for a decided challenge: %d", w.Code)
	}
	// 每次都调微信：和登录接口一样按来源限流
	other := createChallenge(t, s, "ua")
	s.rateLimit = 2
	for i := 0; i < 3; i++ {
		r := httptest.NewRequest(http.MethodPost, "/api/v2/auth/web-login-challenges/"+other.ID+"/code", strings.NewReader(`{"pollToken":"`+other.PollToken+`"}`))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-Real-IP", "203.0.113.9") // 另一个来源，额度从零算
		w = serve(t, s, r)
	}
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("code requests are not rate limited: %d", w.Code)
	}
}
