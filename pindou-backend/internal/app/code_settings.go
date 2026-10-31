package app

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	wechatapi "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/identity/infrastructure/wechat"
	"github.com/yreidev/pindou-studio/pindou-backend/internal/storage/queries"
)

// 小程序码指向的版本（迁移 023）：桌码和网页后台的登录码都按它生成。老板在网页后台「桌码」页改，
// 改错了顾客扫桌码打不开入座页、员工扫不了网页后台的登录码，所以要填原因，保存前先用新版本试生成一次。

// defaultCodeEnv 是老板没改过时的版本：小程序还没有正式版，指向正式版的码一定生成失败。
const defaultCodeEnv = wechatapi.EnvTrial

// envCheckScene 是保存前试生成用的 scene：只看微信收不收，生成的码不给任何人。
const envCheckScene = "envcheck"

// codeSettings 是小程序码指向的版本；UpdatedAt 为 nil 表示老板没改过。
type codeSettings struct {
	Env       string
	UpdatedAt *time.Time
}

func (q *txn) codeSettings() codeSettings {
	rows := must(q.db().MiniprogramCodeSettings(q.ctx))
	if len(rows) == 0 {
		return codeSettings{Env: defaultCodeEnv}
	}
	at := rows[0].UpdatedAt
	return codeSettings{Env: rows[0].EnvVersion, UpdatedAt: &at}
}

func (q *txn) saveCodeEnv(env, actor string) {
	q.fail(q.dbWrite().SaveMiniprogramCodeSettings(q.ctx, queries.SaveMiniprogramCodeSettingsParams{EnvVersion: env, UpdatedBy: actor, UpdatedAt: q.now()}))
}

// ConfigureCustomerWebsite 设定顾客域名的地址（如 https://pindou.example.invalid）：网页桌码印的就是它，
// 网页后台从 /system/code-settings 读，不自己写死。
func (s *Server) ConfigureCustomerWebsite(url string) {
	s.customerWebsite = strings.TrimRight(url, "/")
}

// ConfigureLinkVerification 设定微信「扫普通链接二维码打开小程序」的校验文件：公众平台添加规则
// （前缀 <顾客域名>/t）时下载，文件名和内容由部署配置给，name 为空表示没配。微信要求放在规则地址的
// 最后一级子目录下，没有子目录时放根目录，两处都给，免得猜错它怎么算子目录。
func (s *Server) ConfigureLinkVerification(name, content string) {
	s.linkVerifyFile, s.linkVerifyContent = name, content
}

// serveLinkVerification 在顾客域名下回校验文件；不是校验文件的路径返回 false。
func (s *Server) serveLinkVerification(w http.ResponseWriter, r *http.Request) bool {
	if s.linkVerifyFile == "" || (r.Method != http.MethodGet && r.Method != http.MethodHead) {
		return false
	}
	if r.URL.Path != "/"+s.linkVerifyFile && r.URL.Path != "/t/"+s.linkVerifyFile {
		return false
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = io.WriteString(w, s.linkVerifyContent)
	return true
}

func (s *Server) codeSettingsView(set codeSettings) map[string]any {
	return map[string]any{"envVersion": set.Env, "customerWebsite": s.customerWebsite, "updatedAt": set.UpdatedAt}
}

// getCodeSettings 给员工看桌码页：小程序码指向的版本、网页桌码印的地址。
func (s *Server) getCodeSettings(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.staffMember(w, r); !ok {
		return
	}
	writeJSON(w, 200, s.codeSettingsView(s.tx(r).codeSettings()))
}

// saveCodeSettings 是老板改小程序码指向的版本。先在事务外用新版本试生成桌码和登录码（调微信不能占着事务，
// 见 routes.go），微信不收就不保存；再开写事务核对没被别人改过、保存并记审计。
func (s *Server) saveCodeSettings(w http.ResponseWriter, r *http.Request) {
	var in struct {
		EnvVersion         string `json:"envVersion"`
		ExpectedEnvVersion string `json:"expectedEnvVersion"`
		Reason             string `json:"reason"`
	}
	if err := decode(r, &in); err != nil {
		s.writeError(w, r, 400, "invalid_request", err)
		return
	}
	in.Reason = strings.TrimSpace(in.Reason)
	switch {
	case !wechatapi.ValidEnv(in.EnvVersion) || !wechatapi.ValidEnv(in.ExpectedEnvVersion):
		s.writeError(w, r, 400, "invalid_request", errors.New("小程序版本只能是正式版、体验版或开发版"))
		return
	case in.Reason == "" || utf8.RuneCountInString(in.Reason) > 200:
		s.writeError(w, r, 400, "invalid_request", errors.New("请写明为什么改（200 字以内）"))
		return
	}
	owner := func(w http.ResponseWriter, r *http.Request) (*User, bool) {
		u, ok := s.signedIn(w, r)
		if ok && !hasRole(u, Owner) {
			s.writeError(w, r, 403, "forbidden", errors.New("只有老板可以修改小程序码指向的版本"))
			return nil, false
		}
		return u, ok
	}
	conflict := func(w http.ResponseWriter, r *http.Request, current string) bool {
		if current == in.ExpectedEnvVersion {
			return false
		}
		s.writeError(w, r, 409, "code_settings_conflict", fmt.Errorf("小程序码的版本刚被改成了%s，请刷新后重新确认", wechatapi.EnvName(current)))
		return true
	}
	if _, ok := owner(w, r); !ok {
		return
	}
	var current codeSettings
	if err := s.read(r.Context(), func(q *txn) { current = q.codeSettings() }); err != nil {
		s.writeError(w, r, 503, "persistence_failed", errors.New("数据暂时读不出来，请重试"))
		return
	}
	if conflict(w, r, current.Env) {
		return
	}
	if in.EnvVersion == current.Env {
		writeJSON(w, 200, s.codeSettingsView(current))
		return
	}
	// 本机开发与测试没有微信（s.wechat 为 nil），跳过试生成
	if s.wechat != nil {
		if _, err := s.wechat.TableCode(r.Context(), envCheckScene, in.EnvVersion); err != nil {
			s.refuseCodeEnv(w, r, in.EnvVersion, err)
			return
		}
		if _, err := s.wechat.WebLoginCode(r.Context(), envCheckScene, in.EnvVersion); err != nil {
			s.refuseCodeEnv(w, r, in.EnvVersion, err)
			return
		}
	}
	s.serveTx(w, r, true, "code-settings", func(w http.ResponseWriter, r *http.Request) {
		// 试生成期间不在事务里，老板的任命和设置都可能变了，开事务后重新核对。
		u, ok := owner(w, r)
		if !ok {
			return
		}
		q := s.tx(r)
		from := q.codeSettings().Env
		if conflict(w, r, from) {
			return
		}
		q.saveCodeEnv(in.EnvVersion, u.ID)
		q.audit(u.ID, "miniprogram.env_changed", "", wechatapi.EnvName(from)+" → "+wechatapi.EnvName(in.EnvVersion)+"："+in.Reason, requestID(r))
		writeJSON(w, 200, s.codeSettingsView(q.codeSettings()))
	})
}

// refuseCodeEnv 说明试生成为什么没过：微信明确拒绝回 409（多半是那个版本里没有入座页或登录批准页，
// 例如正式版还没发布），连不上微信回 503。
func (s *Server) refuseCodeEnv(w http.ResponseWriter, r *http.Request, env string, err error) {
	var rejected *wechatapi.CodeRejected
	if errors.As(err, &rejected) {
		s.writeError(w, r, 409, "code_check_failed", fmt.Errorf("没有保存：用%s试生成小程序码，微信拒绝了（errcode %d，%s）。多半是%s里还没有入座页或登录批准页，例如正式版还没发布", wechatapi.EnvName(env), rejected.Code, rejected.Message, wechatapi.EnvName(env)))
		return
	}
	s.writeError(w, r, 503, "wechat_unavailable", fmt.Errorf("没有保存：试生成小程序码时%w", err))
}
