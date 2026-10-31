package application

import (
	"errors"
	"math"
	"testing"

	"github.com/yreidev/pindou-studio/pindou-backend/internal/modules/orders/domain"
)

func TestUpdateRejectsOverflowWithoutMutatingOrder(t *testing.T) {
	o := domain.Order{Status: "draft", Lines: []domain.Line{{Quantity: 1, UnitPriceCents: 100}}, ReceivableCents: 100}
	before := o.Version()
	if _, err := UpdateLines(o, []domain.Line{{Quantity: 2, UnitPriceCents: math.MaxInt64}}, before); err == nil {
		t.Fatal("overflow accepted")
	}
	if o.Version() != before {
		t.Fatal("failed edit mutated order")
	}
	o.Discounts = []domain.Discount{{Kind: "percentage", RateBasisPoints: 1000}}
	o.Lines = []domain.Line{{Quantity: 1, UnitPriceCents: math.MaxInt64}}
	if err := Reprice(&o); err != nil || o.ReceivableCents != math.MaxInt64-math.MaxInt64/10 {
		t.Fatal("large integer discount overflowed")
	}
}

// 已退与还可退由服务端按退款记录算：部分退款后仍是已付款，可退的是已付减已退；
// 草稿、已撤销或已退完的单不能再退。
func TestRefundedAndRefundableCents(t *testing.T) {
	draft := domain.Order{Status: "draft", ReceivableCents: 500}
	if RefundedCents(draft) != 0 || RefundableCents(draft) != 0 {
		t.Fatal("草稿订单不应有已退或可退金额")
	}
	partial := domain.Order{Status: "paid", PaidCents: 30000, Refunds: []domain.Refund{{AmountCents: 15000}, {AmountCents: 10000}}}
	if RefundedCents(partial) != 25000 || RefundableCents(partial) != 5000 {
		t.Fatalf("部分退款：已退 %d 可退 %d", RefundedCents(partial), RefundableCents(partial))
	}
	done := domain.Order{Status: "refunded", PaidCents: 30000, Refunds: []domain.Refund{{AmountCents: 30000}}}
	if RefundableCents(done) != 0 {
		t.Fatal("已全额退款的订单不应还能退")
	}
	voided := domain.Order{Status: "voided", PaidCents: 100}
	if RefundableCents(voided) != 0 {
		t.Fatal("已撤销订单不能退款")
	}
}

// 现金实收与找零：选填；只有现金能填；实收不少于收款金额，找零不超过 ¥1,000；找零可以是 0。
func TestCashTender(t *testing.T) {
	ptr := func(v int64) *int64 { return &v }
	p := domain.Payment{Method: "cash", AmountCents: 2990}
	if err := CashTender(&p, nil); err != nil || p.CashReceivedCents != nil || p.ChangeCents != nil {
		t.Fatalf("没填实收：%v %+v", err, p)
	}
	if err := CashTender(&p, ptr(5000)); err != nil || *p.CashReceivedCents != 5000 || *p.ChangeCents != 2010 {
		t.Fatalf("实收 50 元：%v %+v", err, p)
	}
	exact := domain.Payment{Method: "cash", AmountCents: 2990}
	if err := CashTender(&exact, ptr(2990)); err != nil || *exact.ChangeCents != 0 {
		t.Fatalf("刚好：%v %+v", err, exact)
	}
	top := domain.Payment{Method: "cash", AmountCents: 2990}
	if err := CashTender(&top, ptr(2990+MaxCashChangeCents)); err != nil || *top.ChangeCents != MaxCashChangeCents {
		t.Fatalf("找零正好 1000 元：%v %+v", err, top)
	}
	for name, c := range map[string]struct {
		method   string
		received int64
	}{
		"微信不能填":       {"wechat", 5000},
		"支付宝不能填":      {"alipay", 5000},
		"少于收款金额":      {"cash", 2989},
		"找零超过 1000 元": {"cash", 2990 + MaxCashChangeCents + 1},
	} {
		p := domain.Payment{Method: c.method, AmountCents: 2990}
		var tender ErrCashTender
		if err := CashTender(&p, ptr(c.received)); !errors.As(err, &tender) || p.CashReceivedCents != nil || p.ChangeCents != nil {
			t.Fatalf("%s：%v %+v", name, err, p)
		}
	}
}
