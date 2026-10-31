package application

import (
	"errors"
	"fmt"
	"math/rand/v2"
	"testing"
	"time"
)

// refundCase 是一张会员结账单：线下、本金、赠送三样实付，抵扣用掉的积分（可能来自几个批次），本单送出的积分。
type refundCase struct {
	offline, principal, gift int64
	used                     []PointChange // 抵扣时从各批次扣的（负数），按扣除先后
	earned                   int64
}

func (c refundCase) paid() int64 { return c.offline + c.principal + c.gift }

// ledger 是这张单的退款账：原流水不变，每退一次追加冲正流水和退款金额。
func (c refundCase) ledger() *CheckoutRefund {
	checkout := Entry{ID: "checkout", AccountID: "u", Kind: "checkout", SourceID: "order", PrincipalCents: -c.principal, GiftCents: -c.gift, Points: c.used}
	earned := Entry{ID: "earned", AccountID: "u", Kind: "earned", SourceID: "order", Points: Grant("earned", c.earned, 30, time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC))}
	return &CheckoutRefund{PaidCents: c.paid(), OfflineCents: c.offline, Originals: []Entry{checkout, earned}}
}

// refund 退 amount，把冲正流水记进账里，返回这次的结果。
func refund(t *testing.T, l *CheckoutRefund, amount int64) RefundSplit {
	t.Helper()
	split, err := l.Split(amount)
	if err != nil {
		t.Fatalf("退 %d：%v", amount, err)
	}
	for i, e := range split.Entries {
		e.ID = fmt.Sprintf("refund-%d-%d", len(l.Previous), i)
		e.Kind = "refund"
		l.Previous = append(l.Previous, e)
	}
	l.RefundedCents += amount
	return split
}

// lotTotals 是冲正流水在每个积分批次上的净变动。
func lotTotals(entries []Entry) map[string]int64 {
	out := map[string]int64{}
	for _, e := range entries {
		for _, p := range e.Points {
			out[p.LotID] += p.Delta
		}
	}
	return out
}

// 文档里的例子：实付 ¥100 = 线下 ¥30 + 本金 ¥50 + 赠送 ¥20，抵扣用掉 100 积分（先扣快到期的 60 分，再扣永久的 40 分），
// 送出 97 积分。分三次退 ¥33.33、¥33.33、¥33.34。
func TestSplitRefundExample(t *testing.T) {
	expiry := time.Date(2026, 12, 31, 0, 0, 0, 0, time.UTC)
	c := refundCase{offline: 3000, principal: 5000, gift: 2000, earned: 97,
		used: []PointChange{{LotID: "early", Delta: -60, ExpiresAt: &expiry}, {LotID: "late", Delta: -40}}}
	l := c.ledger()

	// ¥33.33 占实付的 33.33%：线下 999.9、本金 1666.5、赠送 666.6 分，向下取整共 3331 分，
	// 少的 2 分给小数部分最大的线下（.9）和赠送（.6）。积分 33.33 → 33，收回 32.33 → 32。
	first := refund(t, l, 3333)
	want := RefundPart{OfflineCents: 1000, PrincipalCents: 1666, GiftCents: 667, PointsRestored: 33, PointsClawedBack: 32}
	if first.RefundPart != want || first.Settles {
		t.Fatalf("第一次：%+v", first)
	}
	// 恢复的积分先回到最后扣的批次（永久的 40 分），带着原批次
	if got := lotTotals(first.Entries); got["late"] != 33 || got["early"] != 0 || got["earned"] != -32 {
		t.Fatalf("第一次的批次：%v", got)
	}
	// 第二次同样按比例向下取整，少的 2 分补给累计最欠的：退后累计应退本金 3333、线下 1999.8、赠送 1333.2，
	// 取整后本金欠 1 分、线下欠 0.8 分，各补 1 分。累计 2000 / 3333 / 1333，贴着原付款比例。
	second := refund(t, l, 3333)
	if second.RefundPart != (RefundPart{OfflineCents: 1000, PrincipalCents: 1667, GiftCents: 666, PointsRestored: 33, PointsClawedBack: 32}) {
		t.Fatalf("第二次：%+v", second)
	}
	if got := lotTotals(second.Entries); got["late"] != 7 || got["early"] != 26 {
		t.Fatalf("第二次的批次：%v", got)
	}
	for _, e := range second.Entries {
		for _, p := range e.Points {
			if p.LotID == "early" && (p.ExpiresAt == nil || !p.ExpiresAt.Equal(expiry)) {
				t.Fatalf("退回的积分要保留原到期时间：%+v", p)
			}
		}
	}
	// 最后一次把单退满，零头在这次结清
	last := refund(t, l, 3334)
	if last.RefundPart != (RefundPart{OfflineCents: 1000, PrincipalCents: 1667, GiftCents: 667, PointsRestored: 34, PointsClawedBack: 33}) || !last.Settles {
		t.Fatalf("最后一次：%+v", last)
	}
	if got := l.Refunded(); got != (RefundPart{OfflineCents: 3000, PrincipalCents: 5000, GiftCents: 2000, PointsRestored: 100, PointsClawedBack: 97}) {
		t.Fatalf("累计：%+v", got)
	}
	if l.RemainingCents() != 0 {
		t.Fatal("退满后不该还能退")
	}
	if _, err := l.Split(1); !errors.Is(err, ErrInvalid) {
		t.Fatalf("退满后再退应被拒：%v", err)
	}
}

func TestSplitRefundRejectsOutOfRange(t *testing.T) {
	l := refundCase{offline: 500, principal: 500, earned: 10}.ledger()
	for _, amount := range []int64{-1, 0, 1001} {
		if _, err := l.Split(amount); !errors.Is(err, ErrInvalid) {
			t.Fatalf("退 %d 应被拒：%v", amount, err)
		}
	}
	refund(t, l, 400)
	if _, err := l.Split(601); !errors.Is(err, ErrInvalid) {
		t.Fatal("超过剩余可退应被拒")
	}
	if split := refund(t, l, 600); !split.Settles {
		t.Fatal("退剩余全部就是把单退满")
	}
}

// 全用积分抵扣的单实付是 0：只能整单退（金额 0），抵扣的积分全数退回。
func TestSplitRefundZeroPaid(t *testing.T) {
	l := refundCase{used: []PointChange{{LotID: "a", Delta: -500}}}.ledger()
	if _, err := l.Split(1); !errors.Is(err, ErrInvalid) {
		t.Fatal("实付 0 的单不能按金额退")
	}
	split := refund(t, l, 0)
	if !split.Settles || split.PointsRestored != 500 || split.OfflineCents != 0 {
		t.Fatalf("实付 0 整单退：%+v", split)
	}
}

// 本金、赠送各回各的：只用了赠送余额的单，退款不会退成本金。
func TestSplitRefundKeepsPrincipalAndGiftApart(t *testing.T) {
	l := refundCase{gift: 999, offline: 1}.ledger()
	for range 3 {
		split := refund(t, l, 1)
		if split.PrincipalCents != 0 {
			t.Fatalf("没用本金，不该退本金：%+v", split)
		}
	}
	if got := l.Refunded(); got.PrincipalCents != 0 || got.GiftCents+got.OfflineCents != 3 {
		t.Fatalf("累计：%+v", got)
	}
}

// 性质：任意一张单、任意拆成几次退满，每一次都合规，退满时各来源（积分细到批次）的总数和一次整单退款完全相同。
func TestSplitRefundAnyPartitionEqualsWholeRefund(t *testing.T) {
	r := rand.New(rand.NewPCG(20261006, 1))
	pick := func(max int64) int64 {
		switch r.IntN(4) {
		case 0:
			return 0
		case 1:
			return r.Int64N(10) + 1
		default:
			return r.Int64N(max) + 1
		}
	}
	for n := range 3000 {
		scale := int64(100_000)
		if n%10 == 0 {
			scale = Limit / 3
		}
		c := refundCase{offline: pick(scale), principal: pick(scale), gift: pick(scale), earned: pick(scale)}
		for i := range r.IntN(4) {
			c.used = append(c.used, PointChange{LotID: fmt.Sprintf("lot-%d", i), Delta: -(r.Int64N(scale) + 1)})
		}
		if c.paid() == 0 {
			c.offline = 1
		}
		name := fmt.Sprintf("#%d %+v", n, c)

		whole, err := c.ledger().Split(c.paid())
		if err != nil {
			t.Fatalf("%s 整单退：%v", name, err)
		}
		wholeLots := lotTotals(whole.Entries)

		l := c.ledger()
		var total RefundPart
		for l.RemainingCents() > 0 {
			left := l.RemainingCents()
			amount := left
			if r.IntN(3) > 0 {
				switch r.IntN(3) {
				case 0:
					amount = r.Int64N(min(left, 5)) + 1
				default:
					amount = r.Int64N(left) + 1
				}
			}
			split := refund(t, l, amount)
			p := split.RefundPart
			if p.OfflineCents < 0 || p.PrincipalCents < 0 || p.GiftCents < 0 || p.PointsRestored < 0 || p.PointsClawedBack < 0 {
				t.Fatalf("%s 退 %d 出现负数：%+v", name, amount, p)
			}
			if p.OfflineCents+p.PrincipalCents+p.GiftCents != amount {
				t.Fatalf("%s 退 %d 钱的三项合计不对：%+v", name, amount, p)
			}
			if !split.Settles {
				used := int64(0)
				for _, u := range c.used {
					used -= u.Delta
				}
				// 没退满的那几次，积分就是按比例向下取整
				if p.PointsRestored != mulDiv(used, amount, c.paid()) || p.PointsClawedBack != mulDiv(c.earned, amount, c.paid()) {
					t.Fatalf("%s 退 %d 积分不是按比例向下取整：%+v", name, amount, p)
				}
				// 钱每项按比例向下取整，至多再补几分零头
				for _, x := range []struct{ part, total int64 }{{p.OfflineCents, c.offline}, {p.PrincipalCents, c.principal}, {p.GiftCents, c.gift}} {
					if floor := mulDiv(x.total, amount, c.paid()); x.part < floor || x.part > floor+2 {
						t.Fatalf("%s 退 %d 钱偏离比例：%+v", name, amount, p)
					}
				}
			}
			total.OfflineCents += p.OfflineCents
			total.PrincipalCents += p.PrincipalCents
			total.GiftCents += p.GiftCents
			total.PointsRestored += p.PointsRestored
			total.PointsClawedBack += p.PointsClawedBack
			cum := l.Refunded()
			if cum != total {
				t.Fatalf("%s 累计对不上：%+v vs %+v", name, cum, total)
			}
			// 累计退的钱始终贴着原付款比例：与「原数 × 累计 ÷ 实付」相差不到 2 分
			for _, x := range []struct{ cum, total int64 }{{cum.OfflineCents, c.offline}, {cum.PrincipalCents, c.principal}, {cum.GiftCents, c.gift}} {
				if gap := x.cum*c.paid() - x.total*l.RefundedCents; gap <= -2*c.paid() || gap >= 2*c.paid() {
					t.Fatalf("%s 累计 %d 偏离原付款比例：%+v", name, l.RefundedCents, cum)
				}
			}
			if cum.OfflineCents > c.offline || cum.PrincipalCents > c.principal || cum.GiftCents > c.gift || cum.PointsClawedBack > c.earned {
				t.Fatalf("%s 累计超过原数：%+v", name, cum)
			}
			for lot, delta := range lotTotals(l.Previous) {
				if lot != "earned" && delta > wholeLots[lot] {
					t.Fatalf("%s 批次 %s 累计退回 %d 超过原扣除 %d", name, lot, delta, wholeLots[lot])
				}
			}
		}
		if total != whole.RefundPart {
			t.Fatalf("%s 分次退满 %+v ≠ 一次退 %+v", name, total, whole.RefundPart)
		}
		got := lotTotals(l.Previous)
		if len(got) != len(wholeLots) {
			t.Fatalf("%s 批次：%v vs %v", name, got, wholeLots)
		}
		for lot, delta := range wholeLots {
			if got[lot] != delta {
				t.Fatalf("%s 批次 %s：分次 %d ≠ 一次 %d", name, lot, got[lot], delta)
			}
		}
	}
}

// 一分一分地退也不会越退越偏：零头补给累计最欠的来源，两项轮着拿。
func TestSplitRefundTinyRefundsStayProportional(t *testing.T) {
	l := refundCase{offline: 1000, principal: 1000}.ledger()
	for range 1000 {
		refund(t, l, 1)
	}
	if got := l.Refunded(); got.OfflineCents != 500 || got.PrincipalCents != 500 {
		t.Fatalf("退一半时各退一半：%+v", got)
	}
	if split := refund(t, l, 500); split.OfflineCents != 250 || split.PrincipalCents != 250 {
		t.Fatalf("再退 ¥5：%+v", split)
	}
}

// 本单送的积分已被用掉一部分：按比例要收回的超过批次剩下的就算缺口；SpentFrom 扣掉已经退回的部分。
func TestPointsShortAndSpentFromAfterPartialRefund(t *testing.T) {
	s := New()
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	earned := Entry{ID: "earned-a", AccountID: "u", Kind: "earned", SourceID: "order-a", Points: Grant("lot-a", 100, 30, now)}
	spend := Entry{ID: "checkout-b", AccountID: "u", Kind: "checkout", SourceID: "order-b", Points: []PointChange{{LotID: "lot-a", Delta: -80}}, CreatedAt: now.Add(time.Minute)}
	for _, e := range []Entry{earned, spend} {
		if err := s.Append(e, now); err != nil {
			t.Fatal(err)
		}
	}
	clawback := func(n int64) []Entry {
		return []Entry{{AccountID: "u", SourceID: earned.ID, Points: []PointChange{{LotID: "lot-a", Delta: -n}}}}
	}
	if short, lots := s.PointsShort("u", clawback(20)); short != 0 || !lots["lot-a"] {
		t.Fatalf("剩 20 分收回 20 分不缺：%d %v", short, lots)
	}
	if short, _ := s.PointsShort("u", clawback(50)); short != 30 {
		t.Fatalf("剩 20 分收回 50 分缺 30：%d", short)
	}
	if err := s.CanApply("u", clawback(50), now); !errors.Is(err, ErrBalance) {
		t.Fatalf("缺分时不能记账：%v", err)
	}
	// 用分的那张单部分退款退回了 30 分：spentBy 只剩 50 分
	if err := s.Append(Entry{ID: "refund-b", AccountID: "u", Kind: "refund", SourceID: spend.ID, Points: []PointChange{{LotID: "lot-a", Delta: 30}}}, now); err != nil {
		t.Fatal(err)
	}
	got := s.SpentFrom("u", map[string]bool{"lot-a": true})
	if len(got) != 1 || got[0].SourceID != "order-b" || got[0].Points != 50 {
		t.Fatalf("spentBy：%+v", got)
	}
	if short, _ := s.PointsShort("u", clawback(50)); short != 0 {
		t.Fatalf("退回 30 分后剩 50 分，不缺：%d", short)
	}
}
