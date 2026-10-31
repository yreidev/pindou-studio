package app

import (
	"net/http"
	"strings"
	"testing"

	member "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/membership/application"
)

// 员工总览带出规则的发布与停用记录（新的在前），网页后台的「发布历史」据此列出
// 时间、操作人、当时的规则内容和影响说明。保存草稿不算发布，不进记录。
func TestStaffLoyaltyListsPublicationHistoryNewestFirst(t *testing.T) {
	s := newTestServer(t)
	owner := register(t, s, "publication-owner", "老板")
	if err := s.BootstrapOwner(owner.User.ID); err != nil {
		t.Fatal(err)
	}
	clerk := register(t, s, "publication-clerk", "店员")
	if w := call(t, s, http.MethodPost, "/api/v2/staff-role-assignments", owner.AccessToken, id(), map[string]any{"accountId": clerk.User.ID, "role": "clerk"}); w.Code != http.StatusCreated {
		t.Fatalf("assign clerk: %d %s", w.Code, w.Body.String())
	}

	// 还没有任何发布：是空数组而不是 null，前端直接当列表用。
	before := decodeMap(t, call(t, s, http.MethodGet, "/api/v2/loyalty/settings", clerk.AccessToken, "", nil))
	if history, ok := before["publications"].([]any); !ok || len(history) != 0 {
		t.Fatalf("publications before any publish = %#v, want []", before["publications"])
	}

	rule := publishRule(t, s, owner.AccessToken, member.Rule{Kind: "recharge", Name: "充 100", AmountCents: 10000, GiftCents: 1000})
	loyaltyOK(t, s, owner.AccessToken, loyaltyInput{Action: "disable", TargetID: rule.ID, Reason: "换季停售，已充值的余额照常使用"})
	loyaltyOK(t, s, owner.AccessToken, loyaltyInput{Action: "save_rule", Rule: member.Rule{Kind: "recharge", Name: "只是草稿", AmountCents: 20000}})

	view := decodeMap(t, call(t, s, http.MethodGet, "/api/v2/loyalty/settings", clerk.AccessToken, "", nil))
	history, ok := view["publications"].([]any)
	if !ok || len(history) != 2 {
		t.Fatalf("publications = %#v, want the publish and the disable", view["publications"])
	}
	latest, first := history[0].(map[string]any), history[1].(map[string]any)
	if latest["impact"] != "换季停售，已充值的余额照常使用" || latest["rule"].(map[string]any)["enabled"] != false {
		t.Fatalf("newest record should be the disable: %#v", latest)
	}
	if first["impact"] != "保留已有权益，适用于新交易" || first["rule"].(map[string]any)["enabled"] != true {
		t.Fatalf("oldest record should be the publish: %#v", first)
	}
	for _, record := range history {
		p := record.(map[string]any)
		if p["actorId"] != owner.User.ID || p["rule"].(map[string]any)["id"] != rule.ID || p["createdAt"] == "" {
			t.Fatalf("record lacks who, which rule or when: %#v", p)
		}
	}
}

// 停用记录存的是停用那一刻正在生效的版本：草稿里还没发布的修改不能混进历史；
// 没生效的规则不用停用。
func TestDisablingRecordsTheLiveVersionNotTheDraft(t *testing.T) {
	s := newTestServer(t)
	owner := register(t, s, "disable-live-owner", "老板")
	if err := s.BootstrapOwner(owner.User.ID); err != nil {
		t.Fatal(err)
	}
	rule := publishRule(t, s, owner.AccessToken, member.Rule{Kind: "recharge", Name: "充 100", AmountCents: 10000, GiftCents: 1000})
	// 草稿改了金额，还没发布
	edited := rule
	edited.Name = "充 200（未发布）"
	edited.AmountCents = 20000
	loyaltyOK(t, s, owner.AccessToken, loyaltyInput{Action: "save_rule", Rule: edited})

	out := loyaltyOK(t, s, owner.AccessToken, loyaltyInput{Action: "disable", TargetID: rule.ID, Reason: "换季停售"})
	recorded := out["rule"].(map[string]any)
	if recorded["name"] != "充 100" || recorded["amountCents"] != float64(10000) || recorded["enabled"] != false {
		t.Fatalf("disable recorded %#v, want the live version turned off", recorded)
	}
	draft := view(t, s, func(q *txn) member.Rule { return q.membership().Drafts[rule.ID] })
	_, stillLive := ruleOf(t, s, rule.ID)
	if draft.Name != "充 200（未发布）" || draft.Enabled || stillLive {
		t.Fatalf("draft = %#v live=%v: the draft keeps its edits, marked off, and the rule is no longer live", draft, stillLive)
	}
	if r := loyaltyCall(t, s, owner.AccessToken, loyaltyInput{Action: "disable", TargetID: rule.ID, Reason: "再停一次"}); r.Code != http.StatusConflict || !strings.Contains(r.Body.String(), "无需停用") {
		t.Fatalf("disabling a rule that is not live: %d %s", r.Code, r.Body.String())
	}
}
