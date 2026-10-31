package application

import (
	"errors"
	"testing"
	"time"
)

func TestPointLotsExpiryAndRefund(t *testing.T) {
	s := New()
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	_ = s.Append(Entry{ID: "grant", AccountID: "u", Points: Grant("early", 20, 1, now)}, now)
	_ = s.Append(Entry{ID: "permanent", AccountID: "u", Points: Grant("late", 30, 0, now)}, now)
	spend, err := s.SpendPoints("u", 25, now)
	if err != nil || spend[0].LotID != "early" || spend[0].Delta != -20 || spend[1].Delta != -5 {
		t.Fatalf("expiry priority %+v %v", spend, err)
	}
	_ = s.Append(Entry{ID: "spend", AccountID: "u", Points: spend}, now)
	for i := range spend {
		spend[i].Delta = -spend[i].Delta
	}
	_ = s.Append(Entry{ID: "refund", AccountID: "u", Points: spend}, now.AddDate(0, 0, 2))
	if s.Balance("u", now.AddDate(0, 0, 2)).Points != 30 {
		t.Fatal("expired points resurrected")
	}
	if _, err := s.SpendPoints("u", 31, now.AddDate(0, 0, 2)); err == nil {
		t.Fatal("expired points spendable")
	}
}
func TestRulesRejectOverflowAndUnsupportedPolicies(t *testing.T) {
	for _, r := range []Rule{{Kind: "recharge", Name: "x", AmountCents: Limit + 1}, {Kind: "redeem", Name: "x", AmountCents: 1, Points: 0, MaxBasisPoints: 10000}, {Kind: "tier", Name: "x", AmountCents: 100, Mode: "any", RateBasisPoints: 9000}, {Kind: "package", Name: "x", AmountCents: 1, DurationMinutes: 180, Overtime: "auto"}, {Kind: "birthday", Name: "x", Mode: "month", Scope: "points", Points: 10, PerUserLimit: 1}} {
		if Validate(r) == nil {
			t.Fatalf("invalid rule accepted %+v", r)
		}
	}
}
func TestBalanceAppendRejectsNegativeAndQuoteUsesWholeBlocks(t *testing.T) {
	s := New()
	now := time.Now()
	if s.Append(Entry{ID: "x", AccountID: "u", PrincipalCents: -1}, now) == nil {
		t.Fatal("negative balance")
	}
	r := Rule{ID: "redeem", Kind: "redeem", Enabled: true, AmountCents: 100, Points: 10, MaxBasisPoints: 5000, Stack: true}
	s.Publications["r"] = Publication{Rule: r}
	_ = s.Append(Entry{ID: "p", AccountID: "u", Points: Grant("p", 100, 0, now)}, now)
	if _, err := s.QuoteConsumption("u", 1000, 0, 1000, 11, false, nil, now); err == nil {
		t.Fatal("fractional block")
	}
	if _, err := s.QuoteConsumption("u", 1000, 0, 1000, 100, false, nil, now); err == nil {
		t.Fatal("redemption cap")
	}
}

// CanReverse 与 Append 同一套校验但不记账；SpentFrom 只列出还没被冲正的用分流水。
func TestCanReverseAndSpentFrom(t *testing.T) {
	s := New()
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	earned := Entry{ID: "earned", AccountID: "u", Kind: "earned", SourceID: "order-a", Points: Grant("lot-a", 100, 30, now)}
	if err := s.Append(earned, now); err != nil {
		t.Fatal(err)
	}
	if err := s.CanReverse("u", []Entry{earned}, now); err != nil {
		t.Fatalf("积分没动过，应能冲正：%v", err)
	}
	// 另一单抵扣 50 分，随后退款冲正；再兑换用掉 20 分
	spend := Entry{ID: "checkout-b", AccountID: "u", Kind: "checkout", SourceID: "order-b", Points: []PointChange{{LotID: "lot-a", Delta: -50}}}
	refund := Reverse(spend)
	refund.ID, refund.Kind = "refund-b", "refund"
	exchange := Entry{ID: "exchange", AccountID: "u", Kind: "exchange", SourceID: "rule-x", Points: []PointChange{{LotID: "lot-a", Delta: -20}}, CreatedAt: now.Add(time.Minute)}
	for _, e := range []Entry{spend, refund, exchange} {
		if err := s.Append(e, now); err != nil {
			t.Fatal(err)
		}
	}
	before := len(s.Entries)
	if err := s.CanReverse("u", []Entry{earned}, now); !errors.Is(err, ErrBalance) {
		t.Fatalf("批次只剩 80 分，冲正 100 分应被拒：%v", err)
	}
	if len(s.Entries) != before || s.Balance("u", now).Points != 80 {
		t.Fatal("CanReverse 不应记账")
	}
	got := s.SpentFrom("u", map[string]bool{"lot-a": true})
	if len(got) != 1 || got[0].Kind != "exchange" || got[0].SourceID != "rule-x" || got[0].Points != 20 {
		t.Fatalf("应只列出没被冲正的兑换：%+v", got)
	}
}

// Balances 一次算出的余额与逐个 Balance 一致（含积分批次到期、充值退款与等级）。
func TestBalancesMatchPerAccountBalance(t *testing.T) {
	s := New()
	now := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	tier := Rule{ID: "tier", Kind: "tier", Name: "银卡", AmountCents: 10000, RateBasisPoints: 9500, ValidDays: 365}
	for i, account := range []string{"a", "b", "c"} {
		at := now.Add(time.Duration(i) * time.Hour)
		_ = s.Append(Entry{ID: account + "-recharge", AccountID: account, Kind: "recharge", PrincipalCents: int64(5000 * (i + 1)), GiftCents: 500, Points: Grant(account+"-lot", int64(10*(i+1)), 10, at), CreatedAt: at}, at)
		_ = s.Append(Entry{ID: account + "-tier", AccountID: account, Kind: "tier", SourceID: account + "-recharge", Rule: &tier, CreatedAt: at}, at)
	}
	_ = s.Append(Entry{ID: "b-refund", AccountID: "b", Kind: "recharge_refund", SourceID: "b-recharge", PrincipalCents: -10000, GiftCents: -500, CreatedAt: now.Add(5 * time.Hour)}, now.Add(5*time.Hour))
	later := now.AddDate(0, 0, 20) // 第一批积分已过期
	all := s.Balances(later)
	for _, account := range []string{"a", "b", "c"} {
		if all[account] != s.Balance(account, later) {
			t.Fatalf("%s: Balances %+v, Balance %+v", account, all[account], s.Balance(account, later))
		}
	}
	if _, ok := all["nobody"]; ok || EmptyBalance() != s.Balance("nobody", later) {
		t.Fatal("an account without entries should have the empty balance")
	}
}

// 小票上的「本单结账后余额」由流水推出：取到本单的结账扣款与送分为止，之后的充值、别的结账、本单退款都不算；
// 积分按结账那一刻有没有到期算（结账之后才到期的照算）；同一时刻别的流水分不出先后，不算。
func TestBalanceAfterCheckoutIsDerivedFromTheLedger(t *testing.T) {
	s := New()
	t0 := time.Date(2026, 10, 1, 10, 0, 0, 0, time.UTC)
	at := t0.Add(time.Hour)
	must := func(e Entry, when time.Time) {
		t.Helper()
		e.CreatedAt = when
		if err := s.Append(e, when); err != nil {
			t.Fatal(err)
		}
	}
	must(Entry{ID: "recharge", AccountID: "u", Kind: "recharge", PrincipalCents: 5000, GiftCents: 500}, t0)
	// 两批积分：一批结账后一天到期（结账那一刻还能用），一批结账前就过期了
	expiring := t0.Add(25 * time.Hour)
	s.Entries["lot-soon"] = Entry{ID: "lot-soon", AccountID: "u", Kind: "adjust", CreatedAt: t0, Points: []PointChange{{LotID: "lot-soon", Delta: 40, ExpiresAt: &expiring}}}
	gone := t0.Add(30 * time.Minute)
	s.Entries["lot-gone"] = Entry{ID: "lot-gone", AccountID: "u", Kind: "adjust", CreatedAt: t0, Points: []PointChange{{LotID: "lot-gone", Delta: 15, ExpiresAt: &gone}}}
	spend, err := s.SpendPoints("u", 10, at)
	if err != nil {
		t.Fatal(err)
	}
	must(Entry{ID: "checkout", AccountID: "u", Kind: "checkout", SourceID: "order-a", PrincipalCents: -3000, Points: spend}, at)
	must(Entry{ID: "earned", AccountID: "u", Kind: "earned", SourceID: "order-a", Points: Grant("earned", 30, 0, at)}, at)
	want := Balance{PrincipalCents: 2000, GiftCents: 500, Points: 60}
	check := func(when string) {
		t.Helper()
		b, ok := s.BalanceAfterCheckout("u", "order-a")
		if !ok || b.PrincipalCents != want.PrincipalCents || b.GiftCents != want.GiftCents || b.Points != want.Points {
			t.Fatalf("%s：%+v %v", when, b, ok)
		}
	}
	check("刚结完")
	// 同一时刻别的请求记下的流水分不出先后：不算
	must(Entry{ID: "same-instant", AccountID: "u", Kind: "adjust", PrincipalCents: 7}, at)
	check("同一时刻的别的流水")
	// 之后充值、再结一单、本单整单退款、积分到期：都不改结账那一刻的数
	later := at.Add(48 * time.Hour)
	must(Entry{ID: "recharge-2", AccountID: "u", Kind: "recharge", PrincipalCents: 10000}, later)
	must(Entry{ID: "checkout-b", AccountID: "u", Kind: "checkout", SourceID: "order-b", PrincipalCents: -500}, later.Add(time.Minute))
	refund := Reverse(s.Entries["checkout"])
	refund.ID, refund.Kind = "refund", "refund"
	must(refund, later.Add(2*time.Minute))
	check("之后有别的流水")
	if b, ok := s.BalanceAfterCheckout("u", "order-b"); !ok || b.PrincipalCents != 2000+7+10000-500 {
		t.Fatalf("第二单：%+v %v", b, ok)
	}
	if _, ok := s.BalanceAfterCheckout("u", "never-checked-out"); ok {
		t.Fatal("没有会员结账的订单推不出")
	}
}
