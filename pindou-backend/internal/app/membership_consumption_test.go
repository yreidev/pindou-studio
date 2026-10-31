package app

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	member "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/membership/application"
)

func storedNumber(n int64) *int64 { return &n }
func storedDate(s string) *string { return &s }

func consumptionInput(account, date, pack string, amount, uses int64) loyaltyInput {
	return loyaltyInput{Action: "consume", AccountID: account, ServiceDate: storedDate(date), Reason: "补录消费", Consumption: &loyaltyConsumptionInput{PackageID: pack, Headcount: 1, DayType: "workday", AmountCents: storedNumber(amount), BoardUses: storedNumber(uses)}}
}

func lastMemberEntry(t *testing.T, s *Server, account, kind string) member.Entry {
	t.Helper()
	entries := memberOf(t, s, account).History(account)
	for i := len(entries) - 1; i >= 0; i-- {
		if entries[i].Kind == kind {
			return entries[i]
		}
	}
	t.Fatalf("没有 %s 流水", kind)
	return member.Entry{}
}

func storedWantError(t *testing.T, s *Server, status int, code string, fn func() *httptest.ResponseRecorder) {
	t.Helper()
	before := s.snapshotData()
	w := fn()
	if w.Code != status || codeOf(t, w) != code {
		t.Fatalf("应回 %d %s，实际 %d %s", status, code, w.Code, w.Body.String())
	}
	if !bytes.Equal(before, s.snapshotData()) {
		t.Fatal("失败后业务数据有变化")
	}
}

func TestStoredValueConsumptionAndReversal(t *testing.T) {
	s := newTestServer(t)
	clock := time.Date(2026, 10, 27, 2, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return clock }
	owner := ownerFixture(t, s)
	customer := register(t, s, "消费顾客", "顾客")
	clerk := register(t, s, "消费店员", "店员")
	setRoles(t, s, clerk.User.ID, Clerk)
	manager := register(t, s, "消费店长", "店长")
	setRoles(t, s, manager.User.ID, Manager)
	recharge := publishRule(t, s, owner.AccessToken, member.Rule{Kind: "recharge", Name: "充五百", AmountCents: 50000, GiftCents: 8800, BoardUses: 2})
	pack := publishRule(t, s, owner.AccessToken, member.Rule{Kind: "package", Name: "三小时", DurationMinutes: 180, Overtime: "manual"})
	loyaltyOK(t, s, clerk.AccessToken, loyaltyInput{Action: "recharge", AccountID: customer.User.ID, TargetID: recharge.ID, Method: "wechat", ServiceDate: storedDate("2026-10-20")})
	charge := lastMemberEntry(t, s, customer.User.ID, "recharge")
	if charge.ServiceDate != "2026-10-20" || charge.BoardUses != 2 || charge.BalanceAfter == nil || charge.BalanceAfter.PrincipalCents != 50000 || charge.BalanceAfter.GiftCents != 8800 || charge.BalanceAfter.BoardUses != 2 {
		t.Fatalf("充值流水 = %+v", charge)
	}
	clock = clock.Add(time.Second)
	in := consumptionInput(customer.User.ID, "2026-10-25", pack.ID, 55000, 1)
	in.ExpectedVersion = accountVersionOf(t, s, customer.User.ID)
	key := id()
	first := call(t, s, "POST", "/api/v2/loyalty/actions", clerk.AccessToken, key, in)
	if first.Code != 200 {
		t.Fatal(first.Body.String())
	}
	replay := call(t, s, "POST", "/api/v2/loyalty/actions", clerk.AccessToken, key, in)
	if replay.Code != 200 || !bytes.Equal(bytes.TrimSpace(first.Body.Bytes()), bytes.TrimSpace(replay.Body.Bytes())) {
		t.Fatalf("幂等重放失败：%d %s", replay.Code, replay.Body.String())
	}
	entry := lastMemberEntry(t, s, customer.User.ID, "consume")
	if entry.PrincipalCents != -50000 || entry.GiftCents != -5000 || entry.BoardUses != -1 || entry.ServiceDate != "2026-10-25" || entry.Consumption.PackageName != "三小时" || entry.Consumption.ExtraCents != 0 || entry.BalanceAfter.GiftCents != 3800 || entry.BalanceAfter.BoardUses != 1 {
		t.Fatalf("消费流水 = %+v", entry)
	}
	if a := lastAudit(t, s); a.ActorID != clerk.User.ID || a.ObjectID != customer.User.ID || !strings.Contains(a.Reason, "-50000") {
		t.Fatalf("消费审计 = %+v", a)
	}
	storedWantError(t, s, 409, "idempotency_conflict", func() *httptest.ResponseRecorder {
		changed := in
		changed.Reason = "不同内容"
		return call(t, s, "POST", "/api/v2/loyalty/actions", clerk.AccessToken, key, changed)
	})
	storedWantError(t, s, 409, "loyalty_conflict", func() *httptest.ResponseRecorder { return loyaltyCall(t, s, clerk.AccessToken, in) })
	// 别人的资产变化不影响这位顾客读到的确认版本。
	clock = clock.Add(time.Second)
	next := consumptionInput(customer.User.ID, "2026-10-26", "", 5000, 1)
	next.ExpectedVersion = accountVersionOf(t, s, customer.User.ID)
	loyaltyOK(t, s, clerk.AccessToken, loyaltyInput{Action: "adjust", AccountID: clerk.User.ID, PrincipalCents: 1, Reason: "另一位顾客"})
	loyaltyOK(t, s, clerk.AccessToken, next)
	last := lastMemberEntry(t, s, customer.User.ID, "consume")
	if last.PrincipalCents != 0 || last.GiftCents != -3800 || last.Consumption.ExtraCents != 1200 || last.Consumption.PackageName != "其他" || *last.BalanceAfter != (member.BalanceAfter{}) {
		t.Fatalf("余额不足的消费 = %+v", last)
	}
	storedWantError(t, s, 409, "loyalty_conflict", func() *httptest.ResponseRecorder {
		return loyaltyCall(t, s, clerk.AccessToken, consumptionInput(customer.User.ID, "2026-10-27", pack.ID, 0, 1))
	})
	reverse := loyaltyInput{Action: "consume_reverse", AccountID: customer.User.ID, TargetID: entry.ID, Reason: "登记错了"}
	storedWantError(t, s, 403, "forbidden", func() *httptest.ResponseRecorder { return loyaltyCall(t, s, clerk.AccessToken, reverse) })
	storedWantError(t, s, 403, "forbidden", func() *httptest.ResponseRecorder {
		return loyaltyCall(t, s, customer.AccessToken, consumptionInput(customer.User.ID, "2026-10-27", pack.ID, 1, 0))
	})
	clock = clock.Add(time.Second)
	reverse.ExpectedVersion = accountVersionOf(t, s, customer.User.ID)
	reverseKey := id()
	ok := call(t, s, "POST", "/api/v2/loyalty/actions", manager.AccessToken, reverseKey, reverse)
	if ok.Code != 200 {
		t.Fatal(ok.Body.String())
	}
	reverted := lastMemberEntry(t, s, customer.User.ID, "consume_reverse")
	if reverted.SourceID != entry.ID || reverted.PrincipalCents != 50000 || reverted.GiftCents != 5000 || reverted.BoardUses != 1 || *reverted.Consumption != *entry.Consumption {
		t.Fatalf("撤销流水 = %+v", reverted)
	}
	if old := memberOf(t, s, customer.User.ID).Entries[entry.ID]; member.Version(old) != member.Version(entry) {
		t.Fatal("撤销改写了原消费流水")
	}
	storedWantError(t, s, 409, "loyalty_conflict", func() *httptest.ResponseRecorder {
		reverse.ExpectedVersion = ""
		return loyaltyCall(t, s, manager.AccessToken, reverse)
	})
	setRoles(t, s, manager.User.ID, Clerk)
	storedWantError(t, s, 403, "forbidden", func() *httptest.ResponseRecorder {
		return call(t, s, "POST", "/api/v2/loyalty/actions", manager.AccessToken, reverseKey, reverse)
	})
	// 套餐之后改名、停用，不影响消费快照。
	pack.Name = "改名后"
	publishRule(t, s, owner.AccessToken, pack)
	if got := memberOf(t, s, customer.User.ID).Entries[entry.ID].Consumption.PackageName; got != "三小时" {
		t.Fatalf("消费快照被改名：%s", got)
	}
}

func TestStoredValueDatePermissionsAndValidation(t *testing.T) {
	s := newTestServer(t)
	// UTC 仍是 26 日，门店已到 27 日。
	s.now = func() time.Time { return time.Date(2026, 10, 26, 16, 30, 0, 0, time.UTC) }
	owner := ownerFixture(t, s)
	clerk := register(t, s, "日期店员", "店员")
	setRoles(t, s, clerk.User.ID, Clerk)
	manager := register(t, s, "日期店长", "店长")
	setRoles(t, s, manager.User.ID, Manager)
	customer := register(t, s, "日期顾客", "顾客")
	for _, date := range []string{"2026-10-20", "2026-10-27"} {
		loyaltyOK(t, s, clerk.AccessToken, consumptionInput(customer.User.ID, date, "", 100, 0))
	}
	for _, date := range []string{"2026-10-19", "2020-01-01"} {
		storedWantError(t, s, 403, "forbidden", func() *httptest.ResponseRecorder {
			return loyaltyCall(t, s, clerk.AccessToken, consumptionInput(customer.User.ID, date, "", 100, 0))
		})
		loyaltyOK(t, s, manager.AccessToken, consumptionInput(customer.User.ID, date, "", 100, 0))
	}
	pack := publishRule(t, s, owner.AccessToken, member.Rule{Kind: "package", Name: "停用套餐", DurationMinutes: 60, Overtime: "free"})
	loyaltyOK(t, s, owner.AccessToken, loyaltyInput{Action: "disable", TargetID: pack.ID, Reason: "停用"})
	for _, c := range []struct {
		name   string
		change func(*loyaltyInput)
	}{
		{"将来", func(in *loyaltyInput) { in.ServiceDate = storedDate("2026-10-28") }},
		{"错误日期", func(in *loyaltyInput) { in.ServiceDate = storedDate("2026-02-30") }},
		{"没日期", func(in *loyaltyInput) { in.ServiceDate = nil }},
		{"没消费内容", func(in *loyaltyInput) { in.Consumption = nil }},
		{"没金额", func(in *loyaltyInput) { in.Consumption.AmountCents = nil }},
		{"没次数", func(in *loyaltyInput) { in.Consumption.BoardUses = nil }},
		{"零消费", func(in *loyaltyInput) { in.Consumption.AmountCents = storedNumber(0) }},
		{"负金额", func(in *loyaltyInput) { in.Consumption.AmountCents = storedNumber(-1) }},
		{"超上限金额", func(in *loyaltyInput) { in.Consumption.AmountCents = storedNumber(member.Limit + 1) }},
		{"次数过多", func(in *loyaltyInput) { in.Consumption.BoardUses = storedNumber(101) }},
		{"负次数", func(in *loyaltyInput) { in.Consumption.BoardUses = storedNumber(-1) }},
		{"人数", func(in *loyaltyInput) { in.Consumption.Headcount = 3 }},
		{"日期类型", func(in *loyaltyInput) { in.Consumption.DayType = "未知" }},
		{"其他没备注", func(in *loyaltyInput) { in.Reason = " " }},
		{"未发布套餐", func(in *loyaltyInput) { in.Consumption.PackageID = id() }},
		{"停用套餐", func(in *loyaltyInput) { in.Consumption.PackageID = pack.ID }},
		{"错用次数", func(in *loyaltyInput) { in.BoardUses = storedNumber(0) }},
	} {
		t.Run(c.name, func(t *testing.T) {
			in := consumptionInput(customer.User.ID, "2026-10-27", "", 100, 0)
			c.change(&in)
			storedWantError(t, s, 400, "invalid_request", func() *httptest.ResponseRecorder { return loyaltyCall(t, s, clerk.AccessToken, in) })
		})
	}
	for _, in := range []loyaltyInput{
		{Action: "adjust", AccountID: customer.User.ID, Reason: "错误字段", ServiceDate: storedDate("2026-10-27")},
		{Action: "adjust", AccountID: customer.User.ID, Reason: "错误字段", Consumption: consumptionInput("", "", "", 100, 0).Consumption},
		{Action: "consume_reverse", AccountID: customer.User.ID, Reason: "错误字段", BoardUses: storedNumber(0)},
		{Action: "save_rule", Rule: member.Rule{Kind: "package", Name: "错送次数", BoardUses: 1, DurationMinutes: 60, Overtime: "free"}},
	} {
		storedWantError(t, s, 400, "invalid_request", func() *httptest.ResponseRecorder { return loyaltyCall(t, s, owner.AccessToken, in) })
	}
	// 成功的老补录重放也要重新查权限。
	in := consumptionInput(customer.User.ID, "2026-10-19", "", 100, 0)
	in.ExpectedVersion = accountVersionOf(t, s, customer.User.ID)
	key := id()
	if w := call(t, s, "POST", "/api/v2/loyalty/actions", manager.AccessToken, key, in); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	setRoles(t, s, manager.User.ID, Clerk)
	storedWantError(t, s, 403, "forbidden", func() *httptest.ResponseRecorder {
		return call(t, s, "POST", "/api/v2/loyalty/actions", manager.AccessToken, key, in)
	})
}

func TestStoredValueRechargeRefundAndBoardAdjust(t *testing.T) {
	s := newTestServer(t)
	s.now = func() time.Time { return time.Date(2026, 10, 27, 0, 0, 0, 0, time.UTC) }
	owner := ownerFixture(t, s)
	clerk := register(t, s, "充值店员", "店员")
	setRoles(t, s, clerk.User.ID, Clerk)
	customer := register(t, s, "充值顾客", "顾客")
	rule := publishRule(t, s, owner.AccessToken, member.Rule{Kind: "recharge", Name: "送两次", AmountCents: 88800, GiftCents: 12000, BoardUses: 2})
	storedWantError(t, s, 403, "forbidden", func() *httptest.ResponseRecorder {
		return loyaltyCall(t, s, clerk.AccessToken, loyaltyInput{Action: "recharge", AccountID: customer.User.ID, TargetID: rule.ID, Method: "cash", ServiceDate: storedDate("2026-10-19")})
	})
	loyaltyOK(t, s, clerk.AccessToken, loyaltyInput{Action: "recharge", AccountID: customer.User.ID, TargetID: rule.ID, Method: "cash"})
	charge := lastMemberEntry(t, s, customer.User.ID, "recharge")
	if charge.ServiceDate != "2026-10-27" {
		t.Fatal("充值默认日期不对")
	}
	loyaltyOK(t, s, clerk.AccessToken, consumptionInput(customer.User.ID, "2026-10-27", "", 0, 1))
	refund := loyaltyInput{Action: "recharge_refund", AccountID: customer.User.ID, TargetID: charge.ID, Reason: "退充值"}
	storedWantError(t, s, 409, "loyalty_conflict", func() *httptest.ResponseRecorder { return loyaltyCall(t, s, owner.AccessToken, refund) })
	loyaltyOK(t, s, clerk.AccessToken, loyaltyInput{Action: "adjust", AccountID: customer.User.ID, BoardUses: storedNumber(1), Reason: "补回次数"})
	storedWantError(t, s, 409, "loyalty_conflict", func() *httptest.ResponseRecorder {
		return loyaltyCall(t, s, clerk.AccessToken, loyaltyInput{Action: "adjust", AccountID: customer.User.ID, BoardUses: storedNumber(-3), Reason: "扣成负数"})
	})
	for _, n := range []int64{-1001, 1001} {
		storedWantError(t, s, 400, "invalid_request", func() *httptest.ResponseRecorder {
			return loyaltyCall(t, s, clerk.AccessToken, loyaltyInput{Action: "adjust", AccountID: customer.User.ID, BoardUses: storedNumber(n), Reason: "超过单次上限"})
		})
	}
	loyaltyOK(t, s, owner.AccessToken, refund)
	if b := memberOf(t, s, customer.User.ID).Balance(customer.User.ID, s.now()); b.PrincipalCents != 0 || b.GiftCents != 0 || b.BoardUses != 0 {
		t.Fatalf("退款后余额 = %+v", b)
	}
	reversed := lastMemberEntry(t, s, customer.User.ID, "recharge_refund")
	if reversed.BoardUses != -2 || reversed.BalanceAfter == nil || reversed.BalanceAfter.BoardUses != 0 {
		t.Fatalf("退款没收回次数：%+v", reversed)
	}
}

func TestStoredValueConcurrentConsumptionUsesAccountVersion(t *testing.T) {
	s := newTestServer(t)
	owner := ownerFixture(t, s)
	customer := register(t, s, "并发消费", "顾客")
	loyaltyOK(t, s, owner.AccessToken, loyaltyInput{Action: "adjust", AccountID: customer.User.ID, PrincipalCents: 1000, BoardUses: storedNumber(1), Reason: "初始资产"})
	in := consumptionInput(customer.User.ID, s.now().In(time.FixedZone("门店", 8*3600)).Format("2006-01-02"), "", 100, 1)
	in.ExpectedVersion = accountVersionOf(t, s, customer.User.ID)
	other := serverOn(t, s.postgres)
	var wg sync.WaitGroup
	responses := make(chan *httptest.ResponseRecorder, 2)
	for _, server := range []*Server{s, other} {
		wg.Go(func() { responses <- call(t, server, "POST", "/api/v2/loyalty/actions", owner.AccessToken, id(), in) })
	}
	wg.Wait()
	close(responses)
	counts := map[int]int{}
	for w := range responses {
		counts[w.Code]++
	}
	if counts[200] != 1 || counts[409] != 1 {
		t.Fatalf("并发结果 = %v", counts)
	}
	if b := memberOf(t, s, customer.User.ID).Balance(customer.User.ID, s.now()); b.PrincipalCents != 900 || b.BoardUses != 0 {
		t.Fatalf("并发扣重了：%+v", b)
	}
}

func TestStoredValueLegacyRequestFingerprintUnchanged(t *testing.T) {
	old := `{"action":"adjust","accountId":"11111111-1111-4111-8111-111111111111","expectedVersion":"旧版本","reason":"手动调整","principalCents":100}`
	var in loyaltyInput
	if err := json.Unmarshal([]byte(old), &in); err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(in)
	if err != nil || string(encoded) != old {
		t.Fatalf("旧请求编码变了：%s %v", encoded, err)
	}
}

func TestStoredValueReversalValidationAndRollback(t *testing.T) {
	s := newTestServer(t)
	owner := ownerFixture(t, s)
	customer := register(t, s, "撤销顾客", "顾客")
	other := register(t, s, "撤销另一位", "另一位")
	loyaltyOK(t, s, owner.AccessToken, loyaltyInput{Action: "adjust", AccountID: customer.User.ID, PrincipalCents: 100, BoardUses: storedNumber(1), Reason: "初始资产"})
	adjustment := lastMemberEntry(t, s, customer.User.ID, "adjust")
	date := s.now().In(time.FixedZone("门店", 8*3600)).Format("2006-01-02")
	loyaltyOK(t, s, owner.AccessToken, consumptionInput(customer.User.ID, date, "", 100, 1))
	original := lastMemberEntry(t, s, customer.User.ID, "consume")
	for _, in := range []loyaltyInput{
		{Action: "consume_reverse", AccountID: customer.User.ID, TargetID: original.ID},
		{Action: "consume_reverse", AccountID: other.User.ID, TargetID: original.ID, Reason: "别人的消费"},
		{Action: "consume_reverse", AccountID: customer.User.ID, TargetID: adjustment.ID, Reason: "不是消费"},
		{Action: "consume_reverse", AccountID: customer.User.ID, TargetID: id(), Reason: "不存在"},
	} {
		storedWantError(t, s, 400, "invalid_request", func() *httptest.ResponseRecorder { return loyaltyCall(t, s, owner.AccessToken, in) })
	}
	in := loyaltyInput{Action: "consume_reverse", AccountID: customer.User.ID, TargetID: original.ID, Reason: "撤销"}
	in.ExpectedVersion = "旧版本"
	storedWantError(t, s, 409, "loyalty_conflict", func() *httptest.ResponseRecorder { return loyaltyCall(t, s, owner.AccessToken, in) })
	// 消费后另加满本金，撤销会超过上限：不得退一半，也不能记下已撤销。
	loyaltyOK(t, s, owner.AccessToken, loyaltyInput{Action: "adjust", AccountID: customer.User.ID, PrincipalCents: member.Limit, Reason: "补足本金"})
	in.ExpectedVersion = ""
	storedWantError(t, s, 409, "loyalty_conflict", func() *httptest.ResponseRecorder { return loyaltyCall(t, s, owner.AccessToken, in) })
}
