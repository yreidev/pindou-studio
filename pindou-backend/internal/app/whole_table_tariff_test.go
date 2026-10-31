package app

import (
	"net/http"
	"testing"
	"time"

	member "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/membership/application"
)

// 整桌开台按开台时的价算（2026-10-06 业主定）：开台那一刻生效的套餐（含续时方案、超时处理与宽限）、自由计时价、
// 陪客费记在会话的 state 里（TableSession.Tariff），之后老板改价发布不影响这一台；续时、标陪客也按它算。
// 没有价表的旧会话按此刻生效的规则算。价表走数据库存取（每次请求一个事务），不进接口响应。
func TestWholeTableKeepsOpeningPrices(t *testing.T) {
	p := newPolicyShop(t)
	pack := p.renewalPackage(t)
	free := publishRule(t, p.s, p.owner.AccessToken, member.Rule{Kind: "free_timing", Name: "自由计时", AmountCents: 1000, DurationMinutes: 30})
	companion := publishRule(t, p.s, p.owner.AccessToken, member.Rule{Kind: "companion", Name: "陪客", AmountCents: 2000})

	timed := p.open(t, "T1", map[string]any{"timingMode": "timed", "durationMinutes": 60})
	freeSession := p.open(t, "T2", map[string]any{"timingMode": "free"})
	toCompanion := p.open(t, "T3", map[string]any{"timingMode": "timed", "durationMinutes": 60})

	// 价表记进了库里的 state，接口不返回它
	stored := view(t, p.s, func(q *txn) string {
		var tariff string
		q.fail(q.tx.QueryRow(q.ctx, `SELECT COALESCE(state->'tariff'->'packages'->0->>'amountCents','') FROM venue_sessions WHERE id = $1`, timed).Scan(&tariff))
		return tariff
	})
	if stored != "2990" {
		t.Fatalf("开台价表应记进会话 state：%q", stored)
	}
	got := call(t, p.s, http.MethodGet, "/api/v2/venue-sessions/"+timed, p.owner.AccessToken, "", nil)
	if _, leaked := decodeMap(t, got)["tariff"]; got.Code != 200 || leaked {
		t.Fatalf("接口不返回价表：%d %s", got.Code, got.Body.String())
	}

	// 老板改价重新发布：套餐涨到 ¥39.90、续时 ¥20.00、超时改成不加钱；自由计时 ¥15.00；陪客费 ¥30.00
	p.at(time.Minute)
	pack.AmountCents, pack.RenewalCents, pack.Overtime, pack.OvertimeGraceMinutes = 3990, 2000, "free", 0
	free.AmountCents = 1500
	companion.AmountCents = 3000
	for _, r := range []member.Rule{pack, free, companion} {
		loyaltyOK(t, p.s, p.owner.AccessToken, loyaltyInput{Action: "save_rule", Rule: r})
		loyaltyOK(t, p.s, p.owner.AccessToken, loyaltyInput{Action: "publish", TargetID: r.ID, Reason: "调价"})
	}
	later := p.open(t, "T4", map[string]any{"timingMode": "timed", "durationMinutes": 60})

	// 改价之前开的台：建单、续时、超时加收都按开台时的价
	draft := p.checkout(t, timed)
	if receivable(draft) != 2990 {
		t.Fatalf("改价前开的台按开台时的套餐价 ¥29.90：%v %v", receivable(draft), lineNames(draft))
	}
	w := call(t, p.s, http.MethodPatch, "/api/v2/venue-sessions/"+timed, p.owner.AccessToken, "tariff-extend",
		map[string]any{"extendMinutes": 30, "expectedDurationMinutes": 60})
	if w.Code != 200 {
		t.Fatalf("续时：%d %s", w.Code, w.Body.String())
	}
	if _, leaked := decodeMap(t, w)["tariff"]; leaked {
		t.Fatal("改计时的响应也不带价表")
	}
	if note := decodeMap(t, w)["draftOrder"].(map[string]any); note["receivableCents"].(float64) != 4490 {
		t.Fatalf("续时按开台时的续时方案 ¥15.00 追加：%v", note)
	}
	// 自由计时：按开台时的每 30 分钟 ¥10.00
	p.at(31 * time.Minute)
	if got := p.checkout(t, freeSession); receivable(got) != 2000 {
		t.Fatalf("自由计时按开台时的价 2 块 ¥20.00：%v %q", receivable(got), timingSummary(got))
	}

	// 改价后才标的陪客：按开台时的陪客费 ¥20.00
	if w := call(t, p.s, http.MethodPatch, "/api/v2/venue-sessions/"+toCompanion, p.owner.AccessToken, id(), map[string]any{"status": "companion"}); w.Code != 200 {
		t.Fatalf("标记陪客：%d %s", w.Code, w.Body.String())
	}
	if got := p.checkout(t, toCompanion); receivable(got) != 2000 {
		t.Fatalf("陪客费按开台时的 ¥20.00：%v", receivable(got))
	}

	// 改价之后开的台按新价
	if got := p.checkout(t, later); receivable(got) != 3990 {
		t.Fatalf("改价后开的台按新价 ¥39.90：%v", receivable(got))
	}

	p.at(115 * time.Minute) // 约定 90 分钟、用了 115：超时 25 分钟，按开台时的「按续时方案自动加收」加收 1 块
	if got := p.order(t, draft["id"].(string)); receivable(got) != 5990 || timingSummary(got) != "超时 25 分钟（宽限 10 分钟），按续时 30 分钟 ¥15.00 加收 1 块" {
		t.Fatalf("超时按开台时的超时处理与续时价加收：%v %q", receivable(got), timingSummary(got))
	}
	if table := tableViewOf(t, p.s, sessionOf(t, p.s, timed).TableID); table["estimatedCents"] != int64(5990) {
		t.Fatalf("看板报价同样按开台时的价：%v", table["estimatedCents"])
	}

	// 没有价表的旧会话（之前的版本开的台）：按此刻生效的规则算
	legacy := p.open(t, "T5", map[string]any{"timingMode": "timed", "durationMinutes": 60})
	edit(t, p.s, func(q *txn) { q.session(legacy).Tariff = nil })
	if x := sessionOf(t, p.s, legacy); x.Tariff != nil {
		t.Fatal("前置条件：旧会话没有价表")
	}
	if got := p.checkout(t, legacy); receivable(got) != 3990 {
		t.Fatalf("旧会话按现在生效的套餐价：%v", receivable(got))
	}
}
