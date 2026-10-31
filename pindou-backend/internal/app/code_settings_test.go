package app

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	wechatapi "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/identity/infrastructure/wechat"
)

// envWechat 记下每次生成小程序码用的版本；reject 里的版本由微信拒绝（41030），down 为真时连不上微信。
type envWechat struct {
	envs   []string
	reject map[string]bool
	down   bool
}

func (f *envWechat) ExchangeLogin(context.Context, string) (string, error) {
	return "", errors.New("not used")
}
func (f *envWechat) ExchangePhone(context.Context, string) (string, error) {
	return "", errors.New("not used")
}
func (f *envWechat) TableCode(_ context.Context, _, env string) ([]byte, error) { return f.code(env) }
func (f *envWechat) WebLoginCode(_ context.Context, _, env string) ([]byte, error) {
	return f.code(env)
}
func (f *envWechat) code(env string) ([]byte, error) {
	f.envs = append(f.envs, env)
	if f.down {
		return nil, errors.New("微信小程序码请求失败")
	}
	if f.reject[env] {
		return nil, &wechatapi.CodeRejected{Env: env, Code: 41030, Message: "invalid page"}
	}
	return []byte{137, 80, 78, 71, 13, 10, 26, 10, 0}, nil
}

// 小程序码指向的版本由老板在网页后台改：员工都能看（连同网页桌码印的地址），只有老板能改，要写原因；
// 保存前用新版本试生成桌码和登录码，微信不收就不保存；改完桌码、登录码都按新版本生成，并留审计。
func TestOwnerSetsTheMiniProgramVersionOfCodes(t *testing.T) {
	s := newTestServer(t)
	s.ConfigureCustomerWebsite("https://pindou.example.invalid/")
	owner := register(t, s, "code-owner", "老板")
	manager := register(t, s, "code-manager", "店长")
	clerk := register(t, s, "code-clerk", "店员")
	customer := register(t, s, "code-customer", "顾客")
	if err := s.BootstrapOwner(owner.User.ID); err != nil {
		t.Fatal(err)
	}
	setRoles(t, s, manager.User.ID, Manager)
	setRoles(t, s, clerk.User.ID, Clerk)
	table := seedTable(t, s, "B1", "B", 1, 1, false)
	fake := &envWechat{reject: map[string]bool{"release": true}}
	s.wechat = fake

	get := func(bearer string) *httptest.ResponseRecorder {
		return call(t, s, http.MethodGet, "/api/v2/system/code-settings", bearer, "", nil)
	}
	put := func(bearer string, body map[string]any) *httptest.ResponseRecorder {
		return call(t, s, http.MethodPatch, "/api/v2/system/code-settings", bearer, "", body)
	}

	// 没改过：体验版（小程序还没有正式版），网页桌码的地址来自部署配置
	w := get(clerk.AccessToken)
	if w.Code != http.StatusOK {
		t.Fatalf("clerk reads: %d %s", w.Code, w.Body.String())
	}
	if got := decodeMap(t, w); got["envVersion"] != "trial" || got["customerWebsite"] != "https://pindou.example.invalid" || got["updatedAt"] != nil {
		t.Fatalf("default settings: %v", got)
	}
	if w := get(customer.AccessToken); w.Code != http.StatusForbidden {
		t.Fatalf("customer reads: %d", w.Code)
	}
	if w := get(""); w.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous reads: %d", w.Code)
	}

	change := func(to, expected, reason string) map[string]any {
		return map[string]any{"envVersion": to, "expectedEnvVersion": expected, "reason": reason}
	}
	audits := len(auditsOf(t, s))
	for name, c := range map[string]struct {
		bearer string
		body   map[string]any
		status int
		code   string
	}{
		"店长不能改":   {manager.AccessToken, change("develop", "trial", "调试"), 403, "forbidden"},
		"没写原因":    {owner.AccessToken, change("develop", "trial", "  "), 400, "invalid_request"},
		"不认识的版本":  {owner.AccessToken, change("beta", "trial", "调试"), 400, "invalid_request"},
		"别人已经改过":  {owner.AccessToken, change("develop", "release", "调试"), 409, "code_settings_conflict"},
		"正式版还没发布": {owner.AccessToken, change("release", "trial", "正式版发布了"), 409, "code_check_failed"},
	} {
		w := put(c.bearer, c.body)
		if w.Code != c.status || decodeMap(t, w)["code"] != c.code {
			t.Fatalf("%s: %d %s", name, w.Code, w.Body.String())
		}
	}
	if w := put(owner.AccessToken, change("release", "trial", "正式版发布了")); !strings.Contains(w.Body.String(), "41030") {
		t.Fatalf("微信拒绝的原因要带出来：%s", w.Body.String())
	}
	fake.down = true
	if w := put(owner.AccessToken, change("develop", "trial", "调试")); w.Code != http.StatusServiceUnavailable {
		t.Fatalf("WeChat down: %d %s", w.Code, w.Body.String())
	}
	fake.down = false
	if got := decodeMap(t, get(owner.AccessToken))["envVersion"]; got != "trial" || len(auditsOf(t, s)) != audits {
		t.Fatalf("refused changes must not be saved: %v, %d audits", got, len(auditsOf(t, s))-audits)
	}

	// 微信收了：保存，桌码和登录码都按新版本生成
	fake.reject = nil
	fake.envs = nil
	w = put(owner.AccessToken, change("release", "trial", "正式版已发布"))
	if w.Code != http.StatusOK {
		t.Fatalf("owner saves: %d %s", w.Code, w.Body.String())
	}
	if got := decodeMap(t, w); got["envVersion"] != "release" || got["updatedAt"] == nil {
		t.Fatalf("saved settings: %v", got)
	}
	if strings.Join(fake.envs, ",") != "release,release" {
		t.Fatalf("保存前要用新版本试生成桌码和登录码：%v", fake.envs)
	}
	last := lastAudit(t, s)
	if last.Action != "miniprogram.env_changed" || last.ActorID != owner.User.ID || last.Reason != "体验版 → 正式版：正式版已发布" {
		t.Fatalf("audit: %+v", last)
	}
	fake.envs = nil
	if w := call(t, s, http.MethodGet, "/api/v2/loyalty/table-code?tableId="+table.ID, clerk.AccessToken, "", nil); w.Code != http.StatusOK {
		t.Fatalf("table code: %d %s", w.Code, w.Body.String())
	}
	if strings.Join(fake.envs, ",") != "release" {
		t.Fatalf("桌码要按新版本生成：%v", fake.envs)
	}

	// 改成现在的值什么都不做：不调微信、不记审计
	fake.envs = nil
	audits = len(auditsOf(t, s))
	if w := put(owner.AccessToken, change("release", "release", "再点一次")); w.Code != http.StatusOK || len(fake.envs) != 0 || len(auditsOf(t, s)) != audits {
		t.Fatalf("unchanged: %d %v", w.Code, fake.envs)
	}

	// 本机开发没有微信：不试生成，直接保存
	s.wechat = nil
	if w := put(owner.AccessToken, change("trial", "release", "退回体验版")); w.Code != http.StatusOK || decodeMap(t, w)["envVersion"] != "trial" {
		t.Fatalf("without WeChat: %d %s", w.Code, w.Body.String())
	}
}
