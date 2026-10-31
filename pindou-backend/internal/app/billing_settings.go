package app

import (
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/yreidev/pindou-studio/pindou-backend/internal/storage/queries"
)

// 门店开关「系统内收费」（迁移 024，2026-10-10 业主决定）：门店的钱都在美团、大众点评收，现在关着。
// 关着时确认入座、到店开台不建草稿单，店员点「结束」放座；开着时照以前，结账才放座。行为按操作那一刻的开关，
// 不给会话记快照。结账、订单接口一直在，关着时只是前端不进。老板在网页后台「系统设置」改，要写原因、记审计。

// billingSettings 是收费开关；UpdatedAt 为 nil 表示老板没改过（按关）。
type billingSettings struct {
	Enabled   bool
	UpdatedAt *time.Time
}

func (q *txn) billingSettings() billingSettings {
	rows := must(q.db().BillingSettings(q.ctx))
	if len(rows) == 0 {
		return billingSettings{}
	}
	at := rows[0].UpdatedAt
	return billingSettings{Enabled: rows[0].Enabled, UpdatedAt: &at}
}

// billingEnabled 报告此刻系统内收费是否开着。
func (q *txn) billingEnabled() bool { return q.billingSettings().Enabled }

func (q *txn) saveBilling(enabled bool, actor string) {
	q.fail(q.dbWrite().SaveBillingSettings(q.ctx, queries.SaveBillingSettingsParams{Enabled: enabled, UpdatedBy: actor, UpdatedAt: q.now()}))
}

func billingSettingsView(set billingSettings) map[string]any {
	return map[string]any{"enabled": set.Enabled, "updatedAt": set.UpdatedAt}
}

// getBillingSettings 是收费开关，不用登录：顾客端据此藏价格、把底部「订单」改成「我的预约」。
func (s *Server) getBillingSettings(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, billingSettingsView(s.tx(r).billingSettings()))
}

// saveBillingSettings 是老板开关系统内收费：带读到的开关（expectedEnabled），被别人改过就 409；要写原因，记审计。
func (s *Server) saveBillingSettings(w http.ResponseWriter, r *http.Request) {
	u, ok := s.signedIn(w, r)
	if !ok {
		return
	}
	if !hasRole(u, Owner) {
		s.writeError(w, r, 403, "forbidden", errors.New("只有老板可以开关系统内收费"))
		return
	}
	var in struct {
		Enabled         *bool  `json:"enabled"`
		ExpectedEnabled *bool  `json:"expectedEnabled"`
		Reason          string `json:"reason"`
	}
	if err := decode(r, &in); err != nil {
		s.writeError(w, r, 400, "invalid_request", err)
		return
	}
	in.Reason = strings.TrimSpace(in.Reason)
	switch {
	case in.Enabled == nil || in.ExpectedEnabled == nil:
		s.writeError(w, r, 400, "invalid_request", errors.New("要带上开还是关（enabled）和读到的状态（expectedEnabled）"))
		return
	case in.Reason == "" || utf8.RuneCountInString(in.Reason) > 200:
		s.writeError(w, r, 400, "invalid_request", errors.New("请写明为什么改（200 字以内）"))
		return
	}
	q := s.tx(r)
	current := q.billingSettings()
	if current.Enabled != *in.ExpectedEnabled {
		s.writeError(w, r, 409, "billing_settings_conflict", errors.New("系统内收费刚被别人改成了"+onOff(current.Enabled)+"，请刷新后重新确认"))
		return
	}
	if current.Enabled == *in.Enabled {
		writeJSON(w, 200, billingSettingsView(current))
		return
	}
	q.saveBilling(*in.Enabled, u.ID)
	q.audit(u.ID, "billing.toggled", "", onOff(current.Enabled)+" → "+onOff(*in.Enabled)+"："+in.Reason, requestID(r))
	writeJSON(w, 200, billingSettingsView(q.billingSettings()))
}

func onOff(enabled bool) string {
	if enabled {
		return "开"
	}
	return "关"
}
