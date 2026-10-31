package wechat

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sync"
	"time"
)

type Client struct {
	appID, secret string
	baseURL       string
	http          *http.Client
	mu            sync.Mutex
	accessToken   string
	tokenExpires  time.Time
}

// 小程序码指向的小程序版本（微信的 env_version）。桌码和网页后台的登录码用同一个，由老板在网页后台「桌码」页
// 设置（迁移 023），每次生成时传进来。还没有正式版时必须用 trial，否则微信拿 release 去校验页面、必然找不到。
const (
	EnvRelease = "release"
	EnvTrial   = "trial"
	EnvDevelop = "develop"
)

// ValidEnv 是不是微信认的版本值。
func ValidEnv(env string) bool { return env == EnvRelease || env == EnvTrial || env == EnvDevelop }

// EnvName 是版本的中文名（正式版、体验版、开发版）。
func EnvName(env string) string {
	return map[string]string{EnvRelease: "正式版", EnvTrial: "体验版", EnvDevelop: "开发版"}[env]
}

// CodeRejected 是微信拒绝生成小程序码（回了 errcode）：多半是指向的版本里没有这个页面（41030 invalid page）。
type CodeRejected struct {
	Env     string
	Code    int
	Message string
}

func (e *CodeRejected) Error() string {
	return fmt.Sprintf("小程序码生成失败（当前指向%s）：微信 errcode %d，%s", EnvName(e.Env), e.Code, e.Message)
}

func New(appID, secret string) (*Client, error) {
	if appID == "" || secret == "" {
		return nil, errors.New("WeChat app ID and secret are required")
	}
	return &Client{appID: appID, secret: secret, baseURL: "https://api.weixin.qq.com", http: &http.Client{Timeout: 10 * time.Second}}, nil
}

func (c *Client) ExchangeLogin(ctx context.Context, code string) (string, error) {
	query := url.Values{"appid": {c.appID}, "secret": {c.secret}, "js_code": {code}, "grant_type": {"authorization_code"}}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"/sns/jscode2session?"+query.Encode(), nil)
	if err != nil {
		return "", err
	}
	var response struct {
		OpenID       string `json:"openid"`
		ErrorCode    int    `json:"errcode"`
		ErrorMessage string `json:"errmsg"`
	}
	if err := c.do(request, &response); err != nil {
		return "", err
	}
	if response.ErrorCode != 0 || response.OpenID == "" {
		return "", fmt.Errorf("WeChat login exchange failed: %s", response.ErrorMessage)
	}
	return response.OpenID, nil
}

func (c *Client) ExchangePhone(ctx context.Context, code string) (string, error) {
	accessToken, err := c.getAccessToken(ctx)
	if err != nil {
		return "", err
	}
	body, _ := json.Marshal(map[string]string{"code": code})
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/wxa/business/getuserphonenumber?access_token="+url.QueryEscape(accessToken), bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	request.Header.Set("Content-Type", "application/json")
	var response struct {
		ErrorCode    int    `json:"errcode"`
		ErrorMessage string `json:"errmsg"`
		PhoneInfo    struct {
			PhoneNumber string `json:"phoneNumber"`
		} `json:"phone_info"`
	}
	if err := c.do(request, &response); err != nil {
		return "", err
	}
	if response.ErrorCode != 0 || response.PhoneInfo.PhoneNumber == "" {
		return "", fmt.Errorf("WeChat phone exchange failed: %s", response.ErrorMessage)
	}
	return response.PhoneInfo.PhoneNumber, nil
}

func (c *Client) getAccessToken(ctx context.Context) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.accessToken != "" && time.Now().Before(c.tokenExpires) {
		return c.accessToken, nil
	}
	// ★ 用 stable_token，不用 /cgi-bin/token：后者每取一次新令牌，别处手里的旧令牌 5 分钟后就作废。
	//   迁移服务器、彩排、本机带真实凭证调试时会有两个进程同时运行，互相把对方的令牌顶掉，
	//   手机号授权和桌码就间歇失败。stable_token 在 force_refresh=false 时大家拿到同一个令牌。
	body, err := json.Marshal(map[string]any{"grant_type": "client_credential", "appid": c.appID, "secret": c.secret, "force_refresh": false})
	if err != nil {
		return "", err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/cgi-bin/stable_token", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	request.Header.Set("Content-Type", "application/json")
	var response struct {
		AccessToken  string `json:"access_token"`
		ExpiresIn    int    `json:"expires_in"`
		ErrorCode    int    `json:"errcode"`
		ErrorMessage string `json:"errmsg"`
	}
	if err := c.do(request, &response); err != nil {
		return "", err
	}
	if response.ErrorCode != 0 || response.AccessToken == "" {
		return "", fmt.Errorf("WeChat access token failed: %s", response.ErrorMessage)
	}
	c.accessToken = response.AccessToken
	c.tokenExpires = time.Now().Add(time.Duration(response.ExpiresIn-60) * time.Second)
	return c.accessToken, nil
}

func (c *Client) do(request *http.Request, target any) error {
	response, err := c.http.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("WeChat HTTP status %d", response.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(target)
}

// SubscribeMessage 是一条订阅消息（POST /cgi-bin/message/subscribe/send）：ToUser 是 openid，Page 是点消息打开的页面
// （不带开头的斜杠，可带参数），State 是打开哪个版本（formal、trial、developer），Data 是关键词编号 → 内容。
type SubscribeMessage struct {
	ToUser, TemplateID, Page, State string
	Data                            map[string]string
}

// MessageRejected 是微信没收这条订阅消息（回了 errcode）：43101 顾客没订阅或次数用完、47003 内容格式不对、45168 内容不合规等。
type MessageRejected struct {
	Code    int
	Message string
}

func (e *MessageRejected) Error() string {
	return fmt.Sprintf("微信订阅消息发送失败：errcode %d，%s", e.Code, e.Message)
}

// 订阅消息打开的小程序版本（miniprogram_state），和小程序码的 env_version 是同一件事的两套写法。
var messageStates = map[string]string{EnvRelease: "formal", EnvTrial: "trial", EnvDevelop: "developer"}

// MessageState 把小程序码的版本（release、trial、develop）换成订阅消息的写法。
func MessageState(env string) string { return messageStates[env] }

// SendSubscribeMessage 发一条订阅消息。openid 只放在请求体里，不进日志、不进返回的错误。
func (c *Client) SendSubscribeMessage(ctx context.Context, m SubscribeMessage) error {
	token, err := c.getAccessToken(ctx)
	if err != nil {
		return errors.New("微信接口令牌暂时取不到")
	}
	data := make(map[string]map[string]string, len(m.Data))
	for key, value := range m.Data {
		data[key] = map[string]string{"value": value}
	}
	body, err := json.Marshal(map[string]any{"touser": m.ToUser, "template_id": m.TemplateID, "page": m.Page,
		"miniprogram_state": m.State, "lang": "zh_CN", "data": data})
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/cgi-bin/message/subscribe/send?access_token="+url.QueryEscape(token), bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	var response struct {
		ErrorCode    int    `json:"errcode"`
		ErrorMessage string `json:"errmsg"`
	}
	if err := c.do(request, &response); err != nil {
		return errors.New("微信订阅消息请求失败")
	}
	if response.ErrorCode != 0 {
		return &MessageRejected{Code: response.ErrorCode, Message: response.ErrorMessage}
	}
	return nil
}

// 小程序码指向的页面。都是分包后的真实路径（见 .claude/skills/wx-acode）。
const (
	// TablePage 是桌码打开的入座页。
	TablePage = "pages/customer/experience/index"
	// WebLoginPage 是网页后台登录码打开的批准页：员工用微信扫一扫电脑上的码，直接进这一页。
	WebLoginPage = "pages/staff/web-login/index"
	// MyReservationsPage 是预约通知点开的「我的预约」。
	MyReservationsPage = "pages/customer/my-reservations/index"
)

// TableCode 是桌码：scene 为去掉连字符的桌位编号，env 是指向的小程序版本。
func (c *Client) TableCode(ctx context.Context, scene, env string) ([]byte, error) {
	return c.code(ctx, TablePage, scene, env)
}

// WebLoginCode 是网页后台的登录码：scene 为去掉连字符的登录挑战编号，env 与桌码同一个。
func (c *Client) WebLoginCode(ctx context.Context, scene, env string) ([]byte, error) {
	return c.code(ctx, WebLoginPage, scene, env)
}

// code returns only image bytes; provider payloads and credentials are not exposed.
// env 是指向的小程序版本（桌码和登录码同一个）：正式版发布前是 trial，否则微信去正式版里找页面。
func (c *Client) code(ctx context.Context, page, scene, env string) ([]byte, error) {
	if !ValidEnv(env) {
		return nil, fmt.Errorf("小程序版本不对：%q", env)
	}
	token, err := c.getAccessToken(ctx)
	if err != nil {
		return nil, errors.New("微信小程序码服务暂不可用")
	}
	// ★ 入座页在 pages/customer 分包里，路径是 pages/customer/experience/index。
	//   分包重构时这里漏改了，一直发的是分包之前的老路径，微信校验路径必然找不到。
	// ★★ check_path 必须**显式**给值，不能靠省略。
	//   微信这个参数**默认为 true** —— 2026-09-20 我以为「不传就是不校验」，
	//   于是非 release 时省略了它，结果微信照样去校验页面、照样回 41030 invalid page。
	//   省略不等于关掉。
	payload := map[string]any{
		"scene":       scene,
		"page":        page,
		"env_version": env,
		"check_path":  env == EnvRelease,
		"width":       430,
	}
	body, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, "POST", c.baseURL+"/wxa/getwxacodeunlimit?access_token="+url.QueryEscape(token), bytes.NewReader(body))
	if err != nil {
		return nil, errors.New("无法创建小程序码请求")
	}
	req.Header.Set("Content-Type", "application/json")
	response, err := c.http.Do(req)
	if err != nil {
		return nil, errors.New("微信小程序码请求失败")
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 2<<20))
	isImage := len(data) >= 8 && (bytes.Equal(data[:8], []byte{137, 80, 78, 71, 13, 10, 26, 10}) || (data[0] == 0xff && data[1] == 0xd8 && data[2] == 0xff))
	if err == nil && response.StatusCode == 200 && isImage {
		return data, nil
	}
	// ★ 把微信自己的 errcode/errmsg 带出来。
	//   在这之前这里只回一句「生成失败，请确认配置正确」，微信说的话被整个丢掉 ——
	//   2026-09-20 业主点不出桌码，我们只能靠猜（猜了两轮）。errcode 不是机密，
	//   它是唯一能定位的东西；access_token 和密钥不在这条路径上，不会被带出去。
	var failure struct {
		ErrorCode    int    `json:"errcode"`
		ErrorMessage string `json:"errmsg"`
	}
	if json.Unmarshal(data, &failure) == nil && failure.ErrorCode != 0 {
		return nil, &CodeRejected{Env: env, Code: failure.ErrorCode, Message: failure.ErrorMessage}
	}
	return nil, fmt.Errorf("小程序码生成失败（当前指向%s）：微信返回 HTTP %d，内容不是图片", EnvName(env), response.StatusCode)
}
