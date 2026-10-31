package app

import (
	"net/http"
	"strings"
	"testing"
	"time"

	catalogapp "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/catalog/application"
	member "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/membership/application"
)

// 2026-10-06 业主定的收费政策：超时按续时方案自动加收（宽限 10 分钟）、自由计时按时长收、陪客收陪客费，
// 草稿跟着计时走，停止计时后冻结；免单单独记一条结清记录。计价规则本身的边界由 tables/domain/charge_test.go
// 的表驱动测试守着，这里走完整的接口：建单、读出、收款、续时、暂停与版本冲突。

type policyShop struct {
	s     *Server
	clock *time.Time
	owner sessionResponse
	t0    time.Time
}

func newPolicyShop(t *testing.T) *policyShop {
	t.Helper()
	t0 := time.Date(2026, 10, 6, 10, 0, 0, 0, time.UTC)
	clock := t0
	s := newTestServer(t)
	s.now = func() time.Time { return clock }
	o := register(t, s, "policy-owner", "老板")
	if err := s.BootstrapOwner(o.User.ID); err != nil {
		t.Fatal(err)
	}
	enableBilling(t, s, o.User.ID)
	return &policyShop{s: s, clock: &clock, owner: o, t0: t0}
}

// at 把时钟拨到开台后 d。
func (p *policyShop) at(d time.Duration) { *p.clock = p.t0.Add(d) }

// renewalPackage 发布「1小时 ¥29.90，续时 30 分钟 ¥15.00，超时按续时方案自动加收、宽限 10 分钟」。
func (p *policyShop) renewalPackage(t *testing.T) member.Rule {
	t.Helper()
	return publishRule(t, p.s, p.owner.AccessToken, member.Rule{Kind: "package", Name: "1小时", AmountCents: 2990,
		DurationMinutes: 60, RenewalMinutes: 30, RenewalCents: 1500, PauseLimitMinutes: 10, Overtime: "renewal", OvertimeGraceMinutes: 10})
}

func (p *policyShop) open(t *testing.T, code string, body map[string]any) string {
	t.Helper()
	table := seedTable(t, p.s, code, "A", len(code)+int(code[len(code)-1]), 2, false)
	body["serviceTableId"] = table.ID
	w := call(t, p.s, http.MethodPost, "/api/v2/venue-sessions", p.owner.AccessToken, "", body)
	if w.Code != 201 {
		t.Fatalf("开台失败：%d %s", w.Code, w.Body.String())
	}
	return decodeMap(t, w)["id"].(string)
}

func (p *policyShop) checkout(t *testing.T, session string) map[string]any {
	t.Helper()
	w := call(t, p.s, http.MethodPost, "/api/v2/sales-orders", p.owner.AccessToken, id(), map[string]any{"venueSessionId": session})
	if w.Code != 200 && w.Code != 201 {
		t.Fatalf("建单失败：%d %s", w.Code, w.Body.String())
	}
	return decodeMap(t, w)
}

func (p *policyShop) order(t *testing.T, orderID string) map[string]any {
	t.Helper()
	w := call(t, p.s, http.MethodGet, "/api/v2/sales-orders/"+orderID, p.owner.AccessToken, "", nil)
	if w.Code != 200 {
		t.Fatalf("读订单失败：%d %s", w.Code, w.Body.String())
	}
	return decodeMap(t, w)
}

func receivable(order map[string]any) int64 { return int64(order["receivableCents"].(float64)) }

func timingSummary(order map[string]any) string {
	timing, _ := order["timing"].(map[string]any)
	if timing == nil {
		return ""
	}
	return timing["summary"].(string)
}

func TestOvertimeChargedByRenewalBlocksAfterGrace(t *testing.T) {
	p := newPolicyShop(t)
	p.renewalPackage(t)
	session := p.open(t, "A1", map[string]any{"timingMode": "timed", "durationMinutes": 60})
	p.at(5 * time.Minute)
	draft := p.checkout(t, session)
	if receivable(draft) != 2990 || draft["autoLines"].(float64) != 1 || !strings.Contains(timingSummary(draft), "未超时") {
		t.Fatalf("开台 5 分钟建单：套餐 ¥29.90、开头 1 行系统生成：%v %v %q", receivable(draft), draft["autoLines"], timingSummary(draft))
	}
	orderID := draft["id"].(string)

	p.at(70 * time.Minute) // 超时正好 10 分钟：宽限内
	inGrace := p.order(t, orderID)
	if receivable(inGrace) != 2990 || timingSummary(inGrace) != "超时 10 分钟，在宽限 10 分钟内，不加收" {
		t.Fatalf("超时 10 分钟整不收：%v %q", receivable(inGrace), timingSummary(inGrace))
	}

	p.at(71*time.Minute - time.Second) // 超时 10 分 59 秒：边界按整分钟，零头不算，仍在宽限内
	if almost := p.order(t, orderID); receivable(almost) != 2990 || timingSummary(almost) != "超时 10 分钟，在宽限 10 分钟内，不加收" || almost["version"] != inGrace["version"] {
		t.Fatalf("超时 10 分 59 秒按 10 分钟算、不收，版本不变：%v %q", receivable(almost), timingSummary(almost))
	}

	p.at(71 * time.Minute) // 超时满 11 分钟：从套餐结束起整段算，加收 1 块
	over := p.order(t, orderID)
	if receivable(over) != 4490 || lineNames(over)[1] != "1小时 · 超时加收" || timingSummary(over) != "超时 11 分钟（宽限 10 分钟），按续时 30 分钟 ¥15.00 加收 1 块" {
		t.Fatalf("超过宽限应加收 1 块 ¥15.00：%v %v %q", receivable(over), lineNames(over), timingSummary(over))
	}
	if over["version"] == inGrace["version"] {
		t.Fatal("计时费变了，版本要变")
	}
	// 只读请求不落库：库里还是上次写的，读出来的都按此刻算
	if stored := view(t, p.s, func(q *txn) int64 {
		var cents int64
		q.fail(q.tx.QueryRow(q.ctx, `SELECT receivable_cents FROM sales_orders WHERE id = $1`, orderID).Scan(&cents))
		return cents
	}); stored != 2990 {
		t.Fatalf("只读请求不该写库：%d", stored)
	}

	// 看板的报价同一个算法
	board := decodeList(t, call(t, p.s, http.MethodGet, "/api/v2/service-tables", p.owner.AccessToken, "", nil))
	for _, table := range board {
		if table["code"] == "A1" {
			charge := table["charge"].(map[string]any)
			if table["estimatedCents"] != float64(4490) || charge["blocks"] != float64(1) || charge["graceMinutes"] != float64(10) {
				t.Fatalf("看板报价应为 ¥44.90、超时 1 块：%v %v", table["estimatedCents"], charge)
			}
		}
	}

	// 拿着宽限内那一版去收款：金额已变，拦下重读
	stale := call(t, p.s, http.MethodPost, "/api/v2/sales-orders/"+orderID+"/payments", p.owner.AccessToken, "pay-stale",
		map[string]any{"expectedVersion": inGrace["version"], "method": "cash", "amountCents": 2990})
	if stale.Code != 409 || decodeMap(t, stale)["code"] != "order_version_conflict" {
		t.Fatalf("计时费变了，旧版本收款应 409：%d %s", stale.Code, stale.Body.String())
	}
	p.at(95 * time.Minute) // 超时 35 分钟：2 块
	current := p.order(t, orderID)
	if receivable(current) != 5990 {
		t.Fatalf("超时 35 分钟加收 2 块，应收 ¥59.90：%v", receivable(current))
	}
	paid := call(t, p.s, http.MethodPost, "/api/v2/sales-orders/"+orderID+"/payments", p.owner.AccessToken, "pay-now",
		map[string]any{"expectedVersion": current["version"], "method": "wechat", "amountCents": 5990})
	if paid.Code != 201 {
		t.Fatalf("按重读的金额收款：%d %s", paid.Code, paid.Body.String())
	}
	if _, present := decodeMap(t, paid)["timing"]; present {
		t.Fatal("已付款的订单不带计时说明")
	}
	// 收款即结清：之后时间再走，已付订单不变
	p.at(5 * time.Hour)
	after := p.order(t, orderID)
	if after["status"] != "paid" || receivable(after) != 5990 || after["paidCents"].(float64) != 5990 {
		t.Fatalf("已付款订单不能再变：%v %v", after["status"], receivable(after))
	}
}

func TestOvertimeExcludesPausesAndCountsExtensions(t *testing.T) {
	t.Run("暂停的时间不计", func(t *testing.T) {
		p := newPolicyShop(t)
		p.renewalPackage(t)
		session := p.open(t, "A2", map[string]any{"timingMode": "timed", "durationMinutes": 60})
		patch := func(body map[string]any) {
			t.Helper()
			if w := call(t, p.s, http.MethodPatch, "/api/v2/venue-sessions/"+session, p.owner.AccessToken, id(), body); w.Code != 200 {
				t.Fatalf("改计时失败：%d %s", w.Code, w.Body.String())
			}
		}
		p.at(50 * time.Minute)
		patch(map[string]any{"status": "paused"})
		p.at(80 * time.Minute)
		patch(map[string]any{"status": "active"})
		p.at(85 * time.Minute) // 用了 55 分钟
		draft := p.checkout(t, session)
		if receivable(draft) != 2990 {
			t.Fatalf("扣掉 30 分钟暂停只用了 55 分钟，不超时：%v %q", receivable(draft), timingSummary(draft))
		}
		p.at(101 * time.Minute) // 用了 71 分钟：超过宽限 1 分钟
		if got := p.order(t, draft["id"].(string)); receivable(got) != 4490 {
			t.Fatalf("用了 71 分钟应加收 1 块：%v %q", receivable(got), timingSummary(got))
		}
	})

	t.Run("续过的时长算进套餐时长，草稿随续时重算", func(t *testing.T) {
		p := newPolicyShop(t)
		p.renewalPackage(t)
		session := p.open(t, "A3", map[string]any{"timingMode": "timed", "durationMinutes": 60})
		p.at(75 * time.Minute) // 超时 15 分钟：已加收 1 块
		draft := p.checkout(t, session)
		if receivable(draft) != 4490 {
			t.Fatalf("前置条件：超时 15 分钟加收 1 块：%v", receivable(draft))
		}
		w := call(t, p.s, http.MethodPatch, "/api/v2/venue-sessions/"+session, p.owner.AccessToken, "extend-30",
			map[string]any{"extendMinutes": 30, "expectedDurationMinutes": 60})
		if w.Code != 200 {
			t.Fatalf("续时：%d %s", w.Code, w.Body.String())
		}
		note := decodeMap(t, w)["draftOrder"].(map[string]any)
		if note["repriced"] != true || note["receivableCents"].(float64) != 4490 {
			t.Fatalf("续 30 分钟后是套餐 + 续时一行，不再超时：%v", note)
		}
		got := p.order(t, draft["id"].(string))
		if names := lineNames(got); len(names) != 2 || names[1] != "1小时 · 续时" {
			t.Fatalf("续时行替掉了超时加收行：%v", names)
		}
		p.at(100 * time.Minute) // 约定 90 分钟、用了 100：宽限内
		if got := p.order(t, draft["id"].(string)); receivable(got) != 4490 {
			t.Fatalf("超时 10 分钟在宽限内：%v %q", receivable(got), timingSummary(got))
		}
		p.at(121 * time.Minute) // 超时 31 分钟：2 块
		if got := p.order(t, draft["id"].(string)); receivable(got) != 7490 {
			t.Fatalf("续后超时 31 分钟加收 2 块，应收 ¥74.90：%v %q", receivable(got), timingSummary(got))
		}
	})

	t.Run("旧套餐（超时提示员工）不自动加收", func(t *testing.T) {
		p := newPolicyShop(t)
		publishRule(t, p.s, p.owner.AccessToken, member.Rule{Kind: "package", Name: "1小时", AmountCents: 2990, DurationMinutes: 60, RenewalMinutes: 30, RenewalCents: 1500, Overtime: "manual"})
		session := p.open(t, "A4", map[string]any{"timingMode": "timed", "durationMinutes": 60})
		p.at(3 * time.Hour)
		draft := p.checkout(t, session)
		if receivable(draft) != 2990 || timingSummary(draft) != "超时 120 分钟；这个套餐超时由员工处理，不自动加收" {
			t.Fatalf("超时提示员工的套餐照旧只收套餐价：%v %q", receivable(draft), timingSummary(draft))
		}
	})
}

func TestFreeTimingChargedPerHalfHour(t *testing.T) {
	p := newPolicyShop(t)
	publishRule(t, p.s, p.owner.AccessToken, member.Rule{Kind: "free_timing", Name: "自由计时", AmountCents: 1000, DurationMinutes: 30})
	session := p.open(t, "B1", map[string]any{"timingMode": "free"})
	draft := p.checkout(t, session) // 刚开台：算第一块
	orderID := draft["id"].(string)
	if receivable(draft) != 1000 || lineNames(draft)[0] != "自由计时 · 每 30 分钟" {
		t.Fatalf("刚开台算第一块 ¥10.00：%v %v", receivable(draft), lineNames(draft))
	}
	for _, c := range []struct {
		at   time.Duration
		want int64
	}{{29 * time.Minute, 1000}, {30 * time.Minute, 1000}, {31*time.Minute - time.Second, 1000}, {31 * time.Minute, 2000}, {90 * time.Minute, 3000}} {
		p.at(c.at)
		if got := p.order(t, orderID); receivable(got) != c.want {
			t.Fatalf("自由计时 %v 应收 %d，实际 %d（%q）", c.at, c.want, receivable(got), timingSummary(got))
		}
	}
	// 暂停的时间不计：90 分钟时暂停，停到 150 分钟，再到 155 分钟时仍按 95 分钟算 4 块
	if w := call(t, p.s, http.MethodPatch, "/api/v2/venue-sessions/"+session, p.owner.AccessToken, id(), map[string]any{"status": "paused"}); w.Code != 200 {
		t.Fatalf("暂停：%d %s", w.Code, w.Body.String())
	}
	p.at(150 * time.Minute)
	if got := p.order(t, orderID); receivable(got) != 3000 {
		t.Fatalf("暂停中时间不走：%v", receivable(got))
	}
	if w := call(t, p.s, http.MethodPatch, "/api/v2/venue-sessions/"+session, p.owner.AccessToken, id(), map[string]any{"status": "active"}); w.Code != 200 {
		t.Fatalf("继续：%d %s", w.Code, w.Body.String())
	}
	p.at(155 * time.Minute)
	got := p.order(t, orderID)
	if receivable(got) != 4000 || timingSummary(got) != "已用 95 分钟（不含暂停），每 30 分钟 ¥10.00，计 4 块" {
		t.Fatalf("不含暂停用了 95 分钟，4 块：%v %q", receivable(got), timingSummary(got))
	}
	board := decodeList(t, call(t, p.s, http.MethodGet, "/api/v2/service-tables", p.owner.AccessToken, "", nil))
	for _, table := range board {
		if table["code"] == "B1" && table["estimatedCents"] != float64(4000) {
			t.Fatalf("自由计时发布了价，看板也报价：%v", table["estimatedCents"])
		}
	}
}

func TestCompanionChargedTheCompanionFee(t *testing.T) {
	p := newPolicyShop(t)
	p.renewalPackage(t)
	publishRule(t, p.s, p.owner.AccessToken, member.Rule{Kind: "companion", Name: "陪客", AmountCents: 2000})
	session := p.open(t, "C1", map[string]any{"timingMode": "timed", "durationMinutes": 60})
	draft := p.checkout(t, session)
	if receivable(draft) != 2990 {
		t.Fatalf("前置条件：%v", receivable(draft))
	}
	w := call(t, p.s, http.MethodPatch, "/api/v2/venue-sessions/"+session, p.owner.AccessToken, id(), map[string]any{"status": "companion"})
	if w.Code != 200 {
		t.Fatalf("标记陪客：%d %s", w.Code, w.Body.String())
	}
	note := decodeMap(t, w)["draftOrder"].(map[string]any)
	if note["repriced"] != true || note["receivableCents"].(float64) != 2000 {
		t.Fatalf("标记陪客后草稿换成陪客费 ¥20.00：%v", note)
	}
	p.at(5 * time.Hour) // 陪客不计时：坐多久都是陪客费
	got := p.order(t, draft["id"].(string))
	if receivable(got) != 2000 || lineNames(got)[0] != "陪客" || timingSummary(got) != "陪客不计时，陪客费 ¥20.00" {
		t.Fatalf("陪客收固定陪客费：%v %v %q", receivable(got), lineNames(got), timingSummary(got))
	}
	paid := call(t, p.s, http.MethodPost, "/api/v2/sales-orders/"+draft["id"].(string)+"/payments", p.owner.AccessToken, id(),
		map[string]any{"expectedVersion": got["version"], "method": "cash", "amountCents": 2000})
	if paid.Code != 201 {
		t.Fatalf("陪客单现在收得了款：%d %s", paid.Code, paid.Body.String())
	}
}

func TestStaffEditedTimingLinesStopFollowing(t *testing.T) {
	p := newPolicyShop(t)
	p.renewalPackage(t)
	session := p.open(t, "D1", map[string]any{"timingMode": "timed", "durationMinutes": 60})
	draft := p.checkout(t, session)
	orderID := draft["id"].(string)

	// 加一瓶水在后面：计时行没动，照旧跟着走，超时加收插在计时行里、水留在最后
	lines := append([]any{}, draft["lines"].([]any)...)
	lines = append(lines, map[string]any{"name": "矿泉水", "quantity": 1, "unitPriceCents": 300})
	w := call(t, p.s, http.MethodPatch, "/api/v2/sales-orders/"+orderID, p.owner.AccessToken, id(), map[string]any{"expectedVersion": draft["version"], "lines": lines})
	if w.Code != 200 || decodeMap(t, w)["autoLines"].(float64) != 1 {
		t.Fatalf("加商品不影响计时行：%d %s", w.Code, w.Body.String())
	}
	p.at(85 * time.Minute)
	got := p.order(t, orderID)
	if names := lineNames(got); receivable(got) != 4790 || len(names) != 3 || names[1] != "1小时 · 超时加收" || names[2] != "矿泉水" {
		t.Fatalf("套餐 + 超时 1 块 + 矿泉水 ¥47.90：%v %v", receivable(got), names)
	}

	// 员工删掉超时加收那一行（自己决定不收）：计时行改过了，之后不再自动改
	edited := []any{got["lines"].([]any)[0], got["lines"].([]any)[2]}
	w = call(t, p.s, http.MethodPatch, "/api/v2/sales-orders/"+orderID, p.owner.AccessToken, id(), map[string]any{"expectedVersion": got["version"], "lines": edited})
	if w.Code != 200 {
		t.Fatalf("改明细：%d %s", w.Code, w.Body.String())
	}
	saved := decodeMap(t, w)
	if saved["autoLines"].(float64) != 0 || receivable(saved) != 3290 {
		t.Fatalf("改过计时行的草稿记为 0：%v %v", saved["autoLines"], receivable(saved))
	}
	p.at(3 * time.Hour)
	later := p.order(t, orderID)
	timing := later["timing"].(map[string]any)
	if later["version"] != saved["version"] || timing["applied"] != false || timing["totalCents"].(float64) != 2990+4*1500 {
		t.Fatalf("员工改过的计时行不自动改，说明里给出系统算的数供核对：%v %v", later["version"] == saved["version"], timing)
	}
}

// 0.0.18 建的草稿没有 autoLines：读出来不随时间重算（滚动发布时旧版本照常读写它），续时照旧按建单时刻的生成结果比对。
func TestLegacyDraftIsNotRepricedByTime(t *testing.T) {
	p := newPolicyShop(t)
	p.renewalPackage(t)
	session := p.open(t, "E1", map[string]any{"timingMode": "timed", "durationMinutes": 60})
	orderID := id()
	edit(t, p.s, func(q *txn) {
		o := &Order{ID: orderID, TableSessionID: session, Status: "draft", CreatedAt: q.now(), ReceivableCents: 2990,
			Lines: []OrderLine{{Name: "1小时", Quantity: 1, UnitPriceCents: 2990}}}
		q.addOrder(o)
	})
	p.at(2 * time.Hour)
	got := p.order(t, orderID)
	if receivable(got) != 2990 || got["timing"].(map[string]any)["applied"] != false {
		t.Fatalf("旧草稿不随时间重算：%v %v", receivable(got), got["timing"])
	}
	w := call(t, p.s, http.MethodPatch, "/api/v2/venue-sessions/"+session, p.owner.AccessToken, "legacy-extend", map[string]any{"extendMinutes": 60, "expectedDurationMinutes": 60})
	if w.Code != 200 || decodeMap(t, w)["draftOrder"].(map[string]any)["repriced"] != true {
		t.Fatalf("旧草稿续时照旧跟着改：%d %s", w.Code, w.Body.String())
	}
	if got := p.order(t, orderID); got["autoLines"].(float64) != 2 || receivable(got) != 5990 {
		t.Fatalf("续时后记下系统生成的行数，从此跟着计时走：%v %v", got["autoLines"], receivable(got))
	}
}

// 按座会话（扫码入座）：按入座时的套餐快照算超时，停止计时后冻结在停止那一刻，会员结账按冻结的金额。
func TestSeatOvertimeFreezesWhenStopped(t *testing.T) {
	p := newPolicyShop(t)
	pack := p.renewalPackage(t)
	customer := register(t, p.s, "policy-customer", "顾客")
	table := seedTable(t, p.s, "F1", "F", 1, 2, false)
	request := loyaltyOK(t, p.s, customer.AccessToken, loyaltyInput{Action: "request", TargetID: pack.ID, TableID: table.ID, SeatNumber: 1})
	confirmed := loyaltyOK(t, p.s, p.owner.AccessToken, loyaltyInput{Action: "confirm", TargetID: request["id"].(string)})
	session := confirmed["venueSessionId"].(string)
	order := orderOfSession(t, p.s, session)
	if order.AutoLines == nil || *order.AutoLines != 1 {
		t.Fatalf("确认入座建的草稿记下系统生成 1 行：%v", order.AutoLines)
	}
	// 套餐改成超时不加钱再发布：已经入座的照旧按快照（renewal）算
	pack.Overtime, pack.OvertimeGraceMinutes = "free", 0
	loyaltyOK(t, p.s, p.owner.AccessToken, loyaltyInput{Action: "save_rule", Rule: pack})
	loyaltyOK(t, p.s, p.owner.AccessToken, loyaltyInput{Action: "publish", TargetID: pack.ID, Reason: "改为超时不加钱"})

	p.at(85 * time.Minute)
	x := sessionOf(t, p.s, session)
	loyaltyOK(t, p.s, p.owner.AccessToken, loyaltyInput{Action: "stop", TargetID: session, ExpectedVersion: member.Version(x)})
	stopped := p.order(t, order.ID)
	if receivable(stopped) != 4490 || stopped["timing"].(map[string]any)["frozenAt"] == nil {
		t.Fatalf("停止时超时 25 分钟，按快照加收 1 块并冻结：%v %v", receivable(stopped), stopped["timing"])
	}
	if stored := orderOf(t, p.s, order.ID); stored.ReceivableCents != 4490 {
		t.Fatal("停止计时时就把冻结的金额存下")
	}
	p.at(4 * time.Hour)
	later := p.order(t, order.ID)
	if receivable(later) != 4490 || later["version"] != stopped["version"] {
		t.Fatalf("停止计时后计价冻结：%v", receivable(later))
	}
	quote := loyaltyOK(t, p.s, p.owner.AccessToken, loyaltyInput{Action: "quote", TargetID: order.ID, ExpectedVersion: later["version"].(string)})
	if quote["originalCents"].(float64) != 4490 {
		t.Fatalf("会员结账按冻结的金额报价：%v", quote["originalCents"])
	}
}

func TestCompSettlesWithoutMoney(t *testing.T) {
	p := newPolicyShop(t)
	p.renewalPackage(t)
	clerk := register(t, p.s, "policy-clerk", "店员")
	setRoles(t, p.s, clerk.User.ID, Clerk)
	manager := register(t, p.s, "policy-manager", "店长")
	setRoles(t, p.s, manager.User.ID, Manager)
	// 一件商品在库里，免单时照常出库
	var stockID, productID string
	edit(t, p.s, func(q *txn) {
		item := &catalogapp.Item{ID: id(), Name: "贴纸", UnitPriceCents: 500}
		q.addCatalogItem(item)
		productID = item.ID
		stock := &inventoryItem{ID: id(), ProductID: item.ID, Quantity: 3}
		q.addStockItem(stock)
		stockID = stock.ID
	})
	session := p.open(t, "G1", map[string]any{"timingMode": "timed", "durationMinutes": 60})
	draft := p.checkout(t, session)
	orderID := draft["id"].(string)
	lines := append([]any{}, draft["lines"].([]any)...)
	lines = append(lines, map[string]any{"productId": productID, "name": "贴纸", "quantity": 1, "unitPriceCents": 500})
	w := call(t, p.s, http.MethodPatch, "/api/v2/sales-orders/"+orderID, p.owner.AccessToken, id(), map[string]any{"expectedVersion": draft["version"], "lines": lines})
	if w.Code != 200 {
		t.Fatalf("加商品：%d %s", w.Code, w.Body.String())
	}
	current := decodeMap(t, w)
	comp := func(bearer, key string, body map[string]any) (int, map[string]any) {
		t.Helper()
		w := call(t, p.s, http.MethodPost, "/api/v2/sales-orders/"+orderID+"/comps", bearer, key, body)
		return w.Code, decodeMap(t, w)
	}
	body := map[string]any{"expectedVersion": current["version"], "reason": "老顾客生日，店长同意免单"}
	if code, out := comp(clerk.AccessToken, "comp-clerk", body); code != 403 {
		t.Fatalf("店员不能免单：%d %v", code, out)
	}
	if code, out := comp(manager.AccessToken, "comp-noreason", map[string]any{"expectedVersion": current["version"], "reason": "  "}); code != 400 {
		t.Fatalf("免单必须写原因：%d %v", code, out)
	}
	if code, out := comp(manager.AccessToken, "comp-stale", map[string]any{"expectedVersion": draft["version"], "reason": "x"}); code != 409 || out["code"] != "order_version_conflict" {
		t.Fatalf("旧版本免单要重读：%d %v", code, out)
	}
	code, out := comp(manager.AccessToken, "comp-ok", body)
	if code != 201 || out["status"] != "paid" || out["settlement"] != "comp" || out["paidCents"].(float64) != 0 || receivable(out) != 3490 || out["compCents"].(float64) != 3490 {
		t.Fatalf("免单结清：应收照旧 ¥34.90、实收 0、免掉 ¥34.90：%d %v", code, out)
	}
	payment := out["payments"].([]any)[0].(map[string]any)
	if payment["method"] != "comp" || payment["amountCents"].(float64) != 3490 || payment["reason"] != "老顾客生日，店长同意免单" {
		t.Fatalf("免单记成一条结清记录：%v", payment)
	}
	// 幂等：同键同内容重放，同键不同内容 409
	if again, replay := comp(manager.AccessToken, "comp-ok", body); again != 201 || replay["id"] != orderID {
		t.Fatalf("同键重放：%d %v", again, replay)
	}
	if again, conflict := comp(manager.AccessToken, "comp-ok", map[string]any{"expectedVersion": current["version"], "reason": "换个原因"}); again != 409 || conflict["code"] != "idempotency_conflict" {
		t.Fatalf("同键不同内容：%d %v", again, conflict)
	}
	if again, closed := comp(manager.AccessToken, "comp-again", map[string]any{"expectedVersion": out["version"], "reason": "再免一次"}); again != 409 || closed["code"] != "order_closed" {
		t.Fatalf("已结清的不能再免单：%d %v", again, closed)
	}
	// 另一台设备拿着免单前读到的版本收款：版本已变，拦下，不会又收一次钱
	late := call(t, p.s, http.MethodPost, "/api/v2/sales-orders/"+orderID+"/payments", clerk.AccessToken, "pay-after-comp",
		map[string]any{"expectedVersion": current["version"], "method": "cash", "amountCents": 3490})
	if late.Code != 409 || decodeMap(t, late)["code"] != "order_version_conflict" {
		t.Fatalf("免单之后拿旧版本收款应 409：%d %s", late.Code, late.Body.String())
	}
	if x := sessionOf(t, p.s, session); x.Status != "settled" {
		t.Fatalf("免单结清会话：%s", x.Status)
	}
	if stock := stockOf(t, p.s, stockID); stock.Quantity != 2 {
		t.Fatalf("免单的商品照常出库：%d", stock.Quantity)
	}
	comped := 0
	for _, a := range auditsOf(t, p.s) {
		if a.Action == "order.comped" && a.ObjectID == orderID && a.ActorID == manager.User.ID && strings.Contains(a.Reason, "¥34.90") && strings.Contains(a.Reason, "老顾客生日") {
			comped++
		}
	}
	if comped != 1 {
		t.Fatalf("免单记一条审计（重放不重复记）：%d", comped)
	}
	// 没收到钱，没有可退的
	refund := call(t, p.s, http.MethodPost, "/api/v2/sales-orders/"+orderID+"/refunds", manager.AccessToken, id(),
		map[string]any{"expectedVersion": out["version"], "amountCents": 100, "reason": "试退"})
	if refund.Code != 409 || decodeMap(t, refund)["code"] != "comp_not_refundable" {
		t.Fatalf("免单不能退款：%d %s", refund.Code, refund.Body.String())
	}
	// 单独可查：按结清方式筛出免单
	list := call(t, p.s, http.MethodGet, "/api/v2/sales-orders?settlement=comp&pageSize=20", manager.AccessToken, "", nil)
	if found := decodeList(t, list); len(found) != 1 || found[0]["id"] != orderID || list.Header().Get("X-Total-Count") != "1" {
		t.Fatalf("按免单筛选：%v", found)
	}
	if w := call(t, p.s, http.MethodGet, "/api/v2/sales-orders?settlement=member", manager.AccessToken, "", nil); w.Code != 400 {
		t.Fatalf("不认识的结清方式筛选：%d", w.Code)
	}
}

func TestCompRejectsZeroReceivable(t *testing.T) {
	p := newPolicyShop(t)
	session := p.open(t, "H1", map[string]any{"timingMode": "free"}) // 没发布自由计时价：0 元占位
	draft := p.checkout(t, session)
	w := call(t, p.s, http.MethodPost, "/api/v2/sales-orders/"+draft["id"].(string)+"/comps", p.owner.AccessToken, id(),
		map[string]any{"expectedVersion": draft["version"], "reason": "试免"})
	if w.Code != 400 {
		t.Fatalf("应收为 0 的单不用免单：%d %s", w.Code, w.Body.String())
	}
}

func TestChargingRulesValidation(t *testing.T) {
	p := newPolicyShop(t)
	save := func(r member.Rule) int {
		t.Helper()
		return loyaltyCall(t, p.s, p.owner.AccessToken, loyaltyInput{Action: "save_rule", Rule: r}).Code
	}
	base := member.Rule{Kind: "package", Name: "1小时", AmountCents: 2990, DurationMinutes: 60, RenewalMinutes: 30, RenewalCents: 1500, Overtime: "renewal", OvertimeGraceMinutes: 10}
	noRenewal := base
	noRenewal.RenewalMinutes, noRenewal.RenewalCents = 0, 0
	graceOnFree := base
	graceOnFree.Overtime = "free"
	freeWrongBlock := member.Rule{Kind: "free_timing", Name: "自由计时", AmountCents: 1000, DurationMinutes: 60}
	for name, r := range map[string]member.Rule{"没有续时方案不能自动加收": noRenewal, "宽限只给自动加收": graceOnFree, "自由计时价每块 30 分钟": freeWrongBlock,
		"陪客费要大于 0": {Kind: "companion", Name: "陪客"}} {
		if code := save(r); code != 409 {
			t.Fatalf("%s：应拒收，实际 %d", name, code)
		}
	}
	preview := loyaltyOK(t, p.s, p.owner.AccessToken, loyaltyInput{Action: "preview_rule", Rule: base})["preview"].(string)
	if !strings.Contains(preview, "超出不超过 10 分钟不收") || !strings.Contains(preview, "超时 25 分钟加收 1 块共 15.00 元") {
		t.Fatalf("套餐计算示例写清宽限与加收：%s", preview)
	}
	free := member.Rule{Kind: "free_timing", Name: "自由计时", AmountCents: 1000, DurationMinutes: 30}
	if preview := loyaltyOK(t, p.s, p.owner.AccessToken, loyaltyInput{Action: "preview_rule", Rule: free})["preview"].(string); !strings.Contains(preview, "折合每小时 20.00 元") {
		t.Fatalf("自由计时价示例写折合每小时：%s", preview)
	}
	publishRule(t, p.s, p.owner.AccessToken, free)
	second := loyaltyOK(t, p.s, p.owner.AccessToken, loyaltyInput{Action: "save_rule", Rule: member.Rule{Kind: "free_timing", Name: "自由计时（周末）", AmountCents: 1500, DurationMinutes: 30}})
	w := loyaltyCall(t, p.s, p.owner.AccessToken, loyaltyInput{Action: "publish", TargetID: second["id"].(string), Reason: "周末价"})
	if w.Code != 409 || !strings.Contains(decodeMap(t, w)["message"].(string), "自由计时价") {
		t.Fatalf("自由计时价同时只能生效一项：%d %s", w.Code, w.Body.String())
	}
}

// 整桌定时会话的响应带开台时记下的续时方案（两端按它给「续 N 分钟」），续过之后照样带；不能续时的不带。
func TestWholeTableSessionCarriesRenewalPlan(t *testing.T) {
	p := newPolicyShop(t)
	p.renewalPackage(t)
	plan := func(t *testing.T, body map[string]any) map[string]any {
		t.Helper()
		got, _ := body["renewal"].(map[string]any)
		return got
	}
	session := p.open(t, "B1", map[string]any{"timingMode": "timed", "durationMinutes": 60})
	read := func(t *testing.T) map[string]any {
		t.Helper()
		w := call(t, p.s, http.MethodGet, "/api/v2/venue-sessions/"+session, p.owner.AccessToken, "", nil)
		if w.Code != 200 {
			t.Fatalf("读会话：%d %s", w.Code, w.Body.String())
		}
		return decodeMap(t, w)
	}
	if got := plan(t, read(t)); got == nil || got["minutes"].(float64) != 30 || got["amountCents"].(float64) != 1500 || got["packageName"] != "1小时" {
		t.Fatalf("开 60 分钟对上「1小时」套餐，带它的续时方案：%v", got)
	}
	if _, ok := read(t)["tariff"]; ok {
		t.Fatal("开台价表只供后端计价，不进响应")
	}

	// 价改了不影响已开的台：续时方案按开台时记下的
	publishRule(t, p.s, p.owner.AccessToken, member.Rule{Kind: "package", Name: "1小时", AmountCents: 3990, DurationMinutes: 60, RenewalMinutes: 60, RenewalCents: 2000, Overtime: "free"})
	w := call(t, p.s, http.MethodPatch, "/api/v2/venue-sessions/"+session, p.owner.AccessToken, "renew-30", map[string]any{"extendMinutes": 30, "expectedDurationMinutes": 60})
	if w.Code != 200 {
		t.Fatalf("续时：%d %s", w.Code, w.Body.String())
	}
	if got := plan(t, decodeMap(t, w)); got == nil || got["minutes"].(float64) != 30 {
		t.Fatalf("续过一次（90 分钟 = 套餐 + 1 次续时）照旧按开台时的方案续：%v", got)
	}
	list := call(t, p.s, http.MethodGet, "/api/v2/venue-sessions?status=live", p.owner.AccessToken, "", nil)
	if !strings.Contains(list.Body.String(), `"renewal":{"minutes":30,"amountCents":1500,"packageName":"1小时"}`) {
		t.Fatalf("进行中的会话列表同样带续时方案：%s", list.Body.String())
	}

	free := p.open(t, "B2", map[string]any{"timingMode": "free"})
	odd := p.open(t, "B3", map[string]any{"timingMode": "timed", "durationMinutes": 45})
	for name, id := range map[string]string{"自由计时": free, "对不上套餐": odd} {
		w := call(t, p.s, http.MethodGet, "/api/v2/venue-sessions/"+id, p.owner.AccessToken, "", nil)
		if got := plan(t, decodeMap(t, w)); got != nil {
			t.Fatalf("%s的不带续时方案：%v", name, got)
		}
	}
	w = call(t, p.s, http.MethodPatch, "/api/v2/venue-sessions/"+session, p.owner.AccessToken, "stop-b1", map[string]any{"stop": true})
	if w.Code != 200 {
		t.Fatalf("停止计时：%d %s", w.Code, w.Body.String())
	}
	if got := plan(t, decodeMap(t, w)); got != nil {
		t.Fatalf("停止计时后不能续时，不带续时方案：%v", got)
	}
}
