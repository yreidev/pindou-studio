package app

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

// heldWechat 让每次微信调用停住，直到测试放行。
type heldWechat struct {
	entered chan string
	release chan struct{}
	once    sync.Once
}

func newHeldWechat() *heldWechat {
	return &heldWechat{entered: make(chan string, 4), release: make(chan struct{})}
}

func (h *heldWechat) open() { h.once.Do(func() { close(h.release) }) }

func (h *heldWechat) hold(ctx context.Context, name string) error {
	h.entered <- name
	select {
	case <-h.release:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (h *heldWechat) ExchangeLogin(ctx context.Context, code string) (string, error) {
	return "openid-" + code, h.hold(ctx, "login")
}

func (h *heldWechat) ExchangePhone(ctx context.Context, _ string) (string, error) {
	return "13900139000", h.hold(ctx, "phone")
}

func (h *heldWechat) WebLoginCode(ctx context.Context, scene, env string) ([]byte, error) {
	return h.TableCode(ctx, scene, env)
}

func (h *heldWechat) TableCode(ctx context.Context, _, _ string) ([]byte, error) {
	return []byte("\x89PNG\r\n\x1a\n"), h.hold(ctx, "table-code")
}

// 微信一次调用最多等满超时。这期间占着写锁会卡住全部请求；占着读锁也一样，
// 排队的写请求会把后来的读请求一起挡住。
func TestWechatCallsDoNotHoldLocks(t *testing.T) {
	s := newTestServer(t)
	owner := register(t, s, "wx-owner", "Owner")
	if err := s.BootstrapOwner(owner.User.ID); err != nil {
		t.Fatal(err)
	}
	table := seedTable(t, s, "B1", "B", 1, 1, false)

	cases := []struct {
		name, method, path, bearer string
		body                       any
		want                       int
	}{
		{"register", http.MethodPost, "/api/v2/accounts", "", map[string]any{"wechatLoginCode": "wx-new", "nickname": "New", "phoneCode": "pc", "privacyContractVersion": "v1"}, 201},
		{"login", http.MethodPost, "/api/v2/auth/wechat-sessions", "", map[string]any{"wechatLoginCode": "wx-new"}, 201},
		{"phone", http.MethodPatch, "/api/v2/accounts/" + owner.User.ID, owner.AccessToken, map[string]any{"phoneCode": "pc"}, 200},
		{"table-code", http.MethodGet, "/api/v2/loyalty/table-code?tableId=" + table.ID, owner.AccessToken, nil, 200},
		{"code-settings", http.MethodPatch, "/api/v2/system/code-settings", owner.AccessToken, map[string]any{"envVersion": "develop", "expectedEnvVersion": "trial", "reason": "调试"}, 200},
	}
	for i, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			held := newHeldWechat()
			t.Cleanup(held.open)
			s.wechat = held

			result := make(chan *httptest.ResponseRecorder, 1)
			go func() { result <- call(t, s, c.method, c.path, c.bearer, "", c.body) }()
			select {
			case <-held.entered:
			case w := <-result:
				t.Fatalf("request finished without calling WeChat: %d %s", w.Code, w.Body.String())
			case <-time.After(2 * time.Second):
				t.Fatal("request never reached WeChat")
			}

			probes := map[string]func() *httptest.ResponseRecorder{
				"read": func() *httptest.ResponseRecorder {
					return call(t, s, http.MethodGet, "/api/v2/accounts/"+owner.User.ID, owner.AccessToken, "", nil)
				},
				"write": func() *httptest.ResponseRecorder {
					return call(t, s, http.MethodPost, "/api/v2/loyalty/actions", owner.AccessToken, "probe-"+c.name, map[string]any{"action": "preview_rule"})
				},
			}
			for name, probe := range probes {
				done := make(chan struct{})
				go func() { probe(); close(done) }()
				select {
				case <-done:
				case <-time.After(2 * time.Second):
					t.Fatalf("%s request blocked while case %d waited on WeChat", name, i)
				}
			}

			held.open()
			select {
			case w := <-result:
				if w.Code != c.want {
					t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
				}
			case <-time.After(2 * time.Second):
				t.Fatal("request did not finish after WeChat returned")
			}
		})
	}
}
