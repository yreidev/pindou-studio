package app

import (
	"bufio"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

// 手机当扫码枪（scanrelay.go）：员工手机扫到的码只转给本人开着的网页，不给别人、不给小程序，也不落库。

type stream struct {
	conn   net.Conn
	reader *bufio.Reader
}

// openWebPage 像网页后台那样用子协议带网页会话的令牌连事件流。
func openWebPage(t *testing.T, server *httptest.Server, webToken string) stream {
	t.Helper()
	conn, reader, _ := handshake(t, server, "Sec-WebSocket-Protocol: pindou.v1, bearer."+webToken+"\r\n")
	return stream{conn, reader}
}

func openMiniapp(t *testing.T, server *httptest.Server, bearer string) stream {
	t.Helper()
	conn, reader := openWebSocket(t, server, bearer)
	return stream{conn, reader}
}

// waitForPresences 等 web_presences 里正好有 n 条没过期的报到（连接报到在订阅之后，断开时删掉）。
func waitForPresences(t *testing.T, s *Server, n int) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		got := view(t, s, func(q *txn) int {
			return scalar[int](q, `SELECT count(*) FROM web_presences WHERE expires_at > $1`, q.now())
		})
		if got == n {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("web presences=%d, want %d", got, n)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func relay(t *testing.T, s http.Handler, bearer, code string) (int, map[string]any) {
	t.Helper()
	w := call(t, s, http.MethodPost, "/api/v2/scan-relays", bearer, "", map[string]any{"code": code})
	return w.Code, decodeMap(t, w)
}

func expectRelayed(t *testing.T, name string, st stream, code string) {
	t.Helper()
	text, err := readTextFrame(t, st.conn, st.reader, 2*time.Second)
	if err != nil || text != `{"code":"`+code+`","type":"scan.relayed"}` {
		t.Fatalf("%s: %q %v", name, text, err)
	}
}

func expectNothing(t *testing.T, name string, st stream) {
	t.Helper()
	if text, err := readTextFrame(t, st.conn, st.reader, 300*time.Millisecond); !errors.Is(err, os.ErrDeadlineExceeded) {
		t.Fatalf("%s should not receive anything: %q %v", name, text, err)
	}
}

func TestScanRelayReachesOnlyTheStaffMembersOwnWebPages(t *testing.T) {
	s := newTestServer(t)
	owner := ownerFixture(t, s)
	clerk := register(t, s, "relay-clerk", "店员")
	setRoles(t, s, clerk.User.ID, Clerk)
	alice := register(t, s, "relay-alice", "Alice")
	// 网页会话属于批准扫码登录的那位员工
	ownerWeb, clerkWeb := webSessionFor(t, s, owner), webSessionFor(t, s, clerk)
	server := httptest.NewServer(s)
	defer server.Close()

	pages := map[string]stream{
		"owner web":     openWebPage(t, server, ownerWeb),
		"owner web tab": openWebPage(t, server, ownerWeb),
		"clerk web":     openWebPage(t, server, clerkWeb),
		"owner miniapp": openMiniapp(t, server, owner.AccessToken),
		"clerk miniapp": openMiniapp(t, server, clerk.AccessToken),
		"alice":         openMiniapp(t, server, alice.AccessToken),
	}
	waitForSubscribers(t, s, len(pages))
	waitForPresences(t, s, 3)
	before := s.snapshotData()
	audits := len(auditsOf(t, s))

	// 老板在手机上扫到一个商品条码：只到老板自己开着的两个网页标签页
	if status, body := relay(t, s, owner.AccessToken, " 6901234567892 "); status != http.StatusOK || body["computers"] != float64(2) {
		t.Fatalf("owner relay: %d %v", status, body)
	}
	expectRelayed(t, "owner web", pages["owner web"], "6901234567892")
	expectRelayed(t, "owner web tab", pages["owner web tab"], "6901234567892")
	for _, name := range []string{"clerk web", "owner miniapp", "clerk miniapp", "alice"} {
		expectNothing(t, name, pages[name])
	}

	// 店员扫到的会员码只到店员的网页
	if status, body := relay(t, s, clerk.AccessToken, "91234567890123456789"); status != http.StatusOK || body["computers"] != float64(1) {
		t.Fatalf("clerk relay: %d %v", status, body)
	}
	expectRelayed(t, "clerk web", pages["clerk web"], "91234567890123456789")
	for _, name := range []string{"owner web", "owner web tab", "owner miniapp", "clerk miniapp", "alice"} {
		expectNothing(t, name, pages[name])
	}

	// 码不落库、不记审计
	if string(s.snapshotData()) != string(before) || len(auditsOf(t, s)) != audits {
		t.Fatal("relaying a scan changed stored data")
	}
}

func TestScanRelaySaysTheComputerIsOfflineWithoutAnOpenWebPage(t *testing.T) {
	s := newTestServer(t)
	clerk := register(t, s, "offline-clerk", "店员")
	setRoles(t, s, clerk.User.ID, Clerk)
	web := webSessionFor(t, s, clerk)
	server := httptest.NewServer(s)
	defer server.Close()

	// 登录过网页、但网页没开着：电脑没在线
	if status, body := relay(t, s, clerk.AccessToken, "6901234567892"); status != http.StatusConflict || body["code"] != "computer_offline" {
		t.Fatalf("no open page: %d %v", status, body)
	}
	// 小程序自己的连接不算电脑
	mini := openMiniapp(t, server, clerk.AccessToken)
	waitForSubscribers(t, s, 1)
	if status, _ := relay(t, s, clerk.AccessToken, "6901234567892"); status != http.StatusConflict {
		t.Fatalf("a miniapp connection counted as a computer: %d", status)
	}

	page := openWebPage(t, server, web)
	waitForPresences(t, s, 1)
	if status, body := relay(t, s, clerk.AccessToken, "6901234567892"); status != http.StatusOK || body["computers"] != float64(1) {
		t.Fatalf("open page: %d %v", status, body)
	}
	expectRelayed(t, "web", page, "6901234567892")
	expectNothing(t, "miniapp", mini)

	// 关掉网页：报到随之删掉，又是没在线
	_ = page.conn.Close()
	waitForPresences(t, s, 0)
	if status, _ := relay(t, s, clerk.AccessToken, "6901234567892"); status != http.StatusConflict {
		t.Fatalf("closed page: %d", status)
	}

	// 进程崩了没删掉的报到，过了有效期就不算
	edit(t, s, func(q *txn) {
		q.exec(`INSERT INTO web_presences(connection_id, account_id, expires_at) VALUES ($1, $2, $3)`, id(), clerk.User.ID, q.now().Add(-time.Second))
	})
	if status, _ := relay(t, s, clerk.AccessToken, "6901234567892"); status != http.StatusConflict {
		t.Fatalf("a stale presence counted as online: %d", status)
	}
}

// 网页连在一个副本上，手机的请求落到另一个副本：经数据库 NOTIFY 照样送到。
func TestScanRelayCrossesReplicas(t *testing.T) {
	db := newTestDatabase(t)
	a, b := serverOn(t, db), serverOn(t, db)
	owner := ownerFixture(t, a)
	web := webSessionFor(t, a, owner)
	server := httptest.NewServer(a)
	defer server.Close()
	page := openWebPage(t, server, web)
	waitForSubscribers(t, a, 1)
	waitForPresences(t, a, 1)

	if status, body := relay(t, b, owner.AccessToken, "6901234567892"); status != http.StatusOK || body["computers"] != float64(1) {
		t.Fatalf("relay on the other replica: %d %v", status, body)
	}
	expectRelayed(t, "web on replica a", page, "6901234567892")
}

func TestOnlyStaffCanRelayAndOnlyPlainCodes(t *testing.T) {
	s := newTestServer(t)
	owner := ownerFixture(t, s)
	alice := register(t, s, "relay-customer", "Alice")
	web := webSessionFor(t, s, owner)
	server := httptest.NewServer(s)
	defer server.Close()
	openWebPage(t, server, web)
	waitForPresences(t, s, 1)

	if status, _ := relay(t, s, alice.AccessToken, "6901234567892"); status != http.StatusForbidden {
		t.Fatalf("customer relay: %d", status)
	}
	if w := call(t, s, http.MethodPost, "/api/v2/scan-relays", "", "", map[string]any{"code": "6901234567892"}); w.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous relay: %d", w.Code)
	}
	for name, code := range map[string]string{
		"空白":   "   ",
		"换行":   "690\n123",
		"制表符":  "690\t123",
		"超过上限": strings.Repeat("码", maxRelayedCode+1),
	} {
		if status, body := relay(t, s, owner.AccessToken, code); status != http.StatusBadRequest || body["code"] != "invalid_request" {
			t.Fatalf("%s: %d %v", name, status, body)
		}
	}
	// 二维码里的中文、网址照样能转（网页认不出就只提示「手机扫到」）
	if status, _ := relay(t, s, owner.AccessToken, "https://example.com/商品?id=1"); status != http.StatusOK {
		t.Fatalf("url relay: %d", status)
	}
}
