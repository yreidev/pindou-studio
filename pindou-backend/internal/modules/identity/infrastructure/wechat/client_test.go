package wechat

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestExchangesStableIdentityAndPhone(t *testing.T) {
	transport := roundTripFunc(func(r *http.Request) (*http.Response, error) {
		body := ""
		switch r.URL.Path {
		case "/sns/jscode2session":
			body = `{"openid":"openid-1"}`
		case "/cgi-bin/stable_token":
			// 多个进程同时运行（迁移、彩排）时不能互相顶掉令牌：必须是 stable_token 且不强制刷新。
			var input map[string]any
			if r.Method != http.MethodPost || json.NewDecoder(r.Body).Decode(&input) != nil || input["force_refresh"] != false || input["grant_type"] != "client_credential" || input["appid"] != "app" {
				t.Errorf("stable token request: %s %v", r.Method, input)
			}
			body = `{"access_token":"token-1","expires_in":7200}`
		case "/wxa/business/getuserphonenumber":
			body = `{"phone_info":{"phoneNumber":"13800138000"}}`
		default:
			return &http.Response{StatusCode: 404, Body: io.NopCloser(strings.NewReader(""))}, nil
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body))}, nil
	})
	client, err := New("app", "secret")
	if err != nil {
		t.Fatal(err)
	}
	client.http = &http.Client{Transport: transport}
	openid, err := client.ExchangeLogin(context.Background(), "one-time-code")
	if err != nil || openid != "openid-1" {
		t.Fatalf("openid=%q err=%v", openid, err)
	}
	phone, err := client.ExchangePhone(context.Background(), "phone-code")
	if err != nil || phone != "13800138000" {
		t.Fatalf("phone=%q err=%v", phone, err)
	}
}

func TestTableCodeRejectsProviderJSONAndAcceptsImage(t *testing.T) {
	png := []byte{137, 80, 78, 71, 13, 10, 26, 10, 0}
	payload := []byte(`{"errcode":41030,"errmsg":"provider failure"}`)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/wxa/getwxacodeunlimit" {
			t.Errorf("unexpected code endpoint")
		}
		var input map[string]any
		_ = json.NewDecoder(r.Body).Decode(&input)
		// ★ 入座页在 pages/customer 分包里。分包重构时这里漏改，一直发的是老路径，
		//   微信校验路径找不到 → 2026-09-20 店里点「生成桌码」一直报错。
		if input["page"] != "pages/customer/experience/index" {
			t.Errorf("桌码指向的页面路径不对：%v", input["page"])
		}
		if input["env_version"] != "release" || input["check_path"] != true {
			t.Errorf("指向正式版时要校验路径：%v %v", input["env_version"], input["check_path"])
		}
		_, _ = w.Write(payload)
	}))
	defer server.Close()
	client, _ := New("test-app", "test-secret")
	client.baseURL = server.URL
	client.accessToken = "test-access"
	client.tokenExpires = time.Now().Add(time.Hour)
	err := func() error {
		_, e := client.TableCode(context.Background(), "11111111111141118111111111111111", EnvRelease)
		return e
	}()
	if err == nil {
		t.Fatal("provider JSON accepted as image")
	}
	// 微信说了什么必须带出来。只回一句「生成失败」的话，店里点不出桌码时
	// 没有任何东西可查 —— 2026-09-20 就是这样猜了两轮。
	if !strings.Contains(err.Error(), "41030") || !strings.Contains(err.Error(), "provider failure") || !strings.Contains(err.Error(), "正式版") {
		t.Errorf("错误里要带上指向的版本和微信的 errcode、errmsg：%v", err)
	}
	// 老板改版本前的试生成靠它分辨「微信拒绝」和「微信连不上」
	var rejected *CodeRejected
	if !errors.As(err, &rejected) || rejected.Code != 41030 || rejected.Env != EnvRelease {
		t.Errorf("微信回了 errcode 要是 CodeRejected：%#v", err)
	}
	payload = png
	got, err := client.TableCode(context.Background(), "11111111111141118111111111111111", EnvRelease)
	if err != nil || len(got) != len(png) {
		t.Fatal("image not returned")
	}
}

// 门店发布正式版之前，桌码只能指向体验版。
//
// check_path 的意思是「去**正式版**里查这个页面在不在」。还没有正式版时带上它一定失败，
// 店里点「生成桌码」只会看到一句红字。指向 trial 时必须把它去掉。
func TestTableCodeTargetsTrialWithoutCheckingReleasePath(t *testing.T) {
	var seen map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&seen)
		_, _ = w.Write([]byte{137, 80, 78, 71, 13, 10, 26, 10, 0})
	}))
	defer server.Close()
	client, _ := New("test-app", "test-secret")
	client.baseURL = server.URL
	client.accessToken = "test-access"
	client.tokenExpires = time.Now().Add(time.Hour)
	if _, err := client.TableCode(context.Background(), "11111111111141118111111111111111", EnvTrial); err != nil {
		t.Fatal(err)
	}
	if seen["env_version"] != "trial" {
		t.Errorf("应当指向体验版：%v", seen["env_version"])
	}
	// ★ 必须是显式的 false，不能是「没这个字段」：微信的默认值是 true，
	//   省略等于打开校验 —— 这正是 2026-09-20 那个 41030 invalid page 的原因。
	if seen["check_path"] != false {
		t.Errorf("指向体验版时要显式关掉 check_path（省略会被当成 true）：%v", seen["check_path"])
	}
	// 不认识的版本值不发给微信
	seen = nil
	if _, err := client.TableCode(context.Background(), "11111111111141118111111111111111", "产品版"); err == nil || seen != nil {
		t.Errorf("不认识的版本值不该发给微信：%v %v", err, seen)
	}
}

// 网页后台的登录码指向小程序的批准页（分包后的真实路径），版本和桌码同一个设置。
func TestWebLoginCodeTargetsTheApprovalPage(t *testing.T) {
	var seen map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&seen)
		_, _ = w.Write([]byte{137, 80, 78, 71, 13, 10, 26, 10, 0})
	}))
	defer server.Close()
	client, _ := New("test-app", "test-secret")
	client.baseURL = server.URL
	client.accessToken = "test-access"
	client.tokenExpires = time.Now().Add(time.Hour)
	if _, err := client.WebLoginCode(context.Background(), "22222222222242228222222222222222", EnvTrial); err != nil {
		t.Fatal(err)
	}
	if seen["page"] != "pages/staff/web-login/index" || seen["scene"] != "22222222222242228222222222222222" {
		t.Errorf("登录码的页面或 scene 不对：%v %v", seen["page"], seen["scene"])
	}
	if seen["env_version"] != "trial" || seen["check_path"] != false {
		t.Errorf("登录码按传进来的版本生成：%v %v", seen["env_version"], seen["check_path"])
	}
}

// 订阅消息：关键词按 {"key":{"value":...}} 发，带上版本和语言；微信回了 errcode 时把它带出来（不带 openid）。
func TestSendSubscribeMessage(t *testing.T) {
	var sent map[string]any
	reply := `{"errcode":0,"errmsg":"ok"}`
	transport := roundTripFunc(func(r *http.Request) (*http.Response, error) {
		body := `{"access_token":"token-1","expires_in":7200}`
		if r.URL.Path == "/cgi-bin/message/subscribe/send" {
			if r.URL.Query().Get("access_token") != "token-1" {
				t.Errorf("access token: %s", r.URL.RawQuery)
			}
			if err := json.NewDecoder(r.Body).Decode(&sent); err != nil {
				t.Error(err)
			}
			body = reply
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body))}, nil
	})
	client, err := New("app", "secret")
	if err != nil {
		t.Fatal(err)
	}
	client.http = &http.Client{Transport: transport}
	message := SubscribeMessage{ToUser: "openid-1", TemplateID: "tpl", Page: MyReservationsPage, State: MessageState(EnvTrial),
		Data: map[string]string{"time14": "2026年10月21日 15:00", "thing4": "EXAMPLE 示例工坊"}}
	if err := client.SendSubscribeMessage(context.Background(), message); err != nil {
		t.Fatal(err)
	}
	data, _ := sent["data"].(map[string]any)
	time14, _ := data["time14"].(map[string]any)
	if sent["touser"] != "openid-1" || sent["template_id"] != "tpl" || sent["page"] != "pages/customer/my-reservations/index" ||
		sent["miniprogram_state"] != "trial" || sent["lang"] != "zh_CN" || time14["value"] != "2026年10月21日 15:00" {
		t.Fatalf("请求体：%v", sent)
	}
	reply = `{"errcode":43101,"errmsg":"user refuse to accept the msg"}`
	err = client.SendSubscribeMessage(context.Background(), message)
	var rejected *MessageRejected
	if !errors.As(err, &rejected) || rejected.Code != 43101 || strings.Contains(err.Error(), "openid-1") {
		t.Fatalf("微信不收：%v", err)
	}
	if MessageState(EnvRelease) != "formal" || MessageState(EnvDevelop) != "developer" {
		t.Fatal("版本写法")
	}
}
