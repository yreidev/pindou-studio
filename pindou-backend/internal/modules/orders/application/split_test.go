package application

import (
	"errors"
	"slices"
	"testing"

	"github.com/yreidev/pindou-studio/pindou-backend/internal/modules/orders/domain"
)

// 分笔付款（多人合付，2026-10-06 业主定）：一单可以分几笔收，收齐才算付清，没收齐是部分付款。

// 每笔 1 分起、不超过还差的数；收齐（已收 + 免单 = 应收）才是 paid，之前是 partially_paid；收齐、撤销之后不能再收。
func TestCollectSplitsUntilSettled(t *testing.T) {
	cases := []struct {
		name      string
		amounts   []int64
		statuses  []string
		remaining []int64
	}{
		{"两笔付清", []int64{4000, 6000}, []string{domain.StatusPartiallyPaid, domain.StatusPaid}, []int64{6000, 0}},
		{"三笔付清", []int64{3333, 3333, 3334}, []string{domain.StatusPartiallyPaid, domain.StatusPartiallyPaid, domain.StatusPaid}, []int64{6667, 3334, 0}},
		{"一笔收齐和以前一样", []int64{10000}, []string{domain.StatusPaid}, []int64{0}},
		{"一分钱一笔", []int64{1, 9999}, []string{domain.StatusPartiallyPaid, domain.StatusPaid}, []int64{9999, 0}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			o := domain.Order{Status: domain.StatusDraft, ReceivableCents: 10000}
			if OutstandingCents(o) != 10000 {
				t.Fatalf("草稿还差的就是应收：%d", OutstandingCents(o))
			}
			for i, amount := range c.amounts {
				settled, err := Collect(&o, domain.Payment{ID: string(rune('a' + i)), Method: "wechat", AmountCents: amount})
				if err != nil {
					t.Fatalf("第 %d 笔：%v", i+1, err)
				}
				if o.Status != c.statuses[i] || OutstandingCents(o) != c.remaining[i] || settled != (c.remaining[i] == 0) {
					t.Fatalf("第 %d 笔后：%s 还差 %d 收齐 %v", i+1, o.Status, OutstandingCents(o), settled)
				}
			}
			if o.PaidCents != 10000 || len(o.Payments) != len(c.amounts) {
				t.Fatalf("实收 %d、%d 笔", o.PaidCents, len(o.Payments))
			}
			if _, err := Collect(&o, domain.Payment{Method: "cash", AmountCents: 1}); !errors.Is(err, ErrClosed) {
				t.Fatalf("收齐之后不能再收：%v", err)
			}
		})
	}
}

func TestCollectRejectsOverpayAndBadAmounts(t *testing.T) {
	o := domain.Order{Status: domain.StatusPartiallyPaid, ReceivableCents: 10000, PaidCents: 4000, Payments: []domain.Payment{{ID: "a", Method: "cash", AmountCents: 4000}}}
	before := o.Version()
	var overpay ErrOverpay
	if _, err := Collect(&o, domain.Payment{Method: "cash", AmountCents: 6001}); !errors.As(err, &overpay) || overpay.Outstanding != 6000 {
		t.Fatalf("超收：%v", err)
	}
	for _, bad := range []domain.Payment{{Method: "cash", AmountCents: 0}, {Method: "cash", AmountCents: -1}, {Method: domain.PaymentComp, AmountCents: 6000}} {
		if _, err := Collect(&o, bad); err == nil {
			t.Fatalf("应当拒收：%+v", bad)
		}
	}
	if o.Version() != before {
		t.Fatal("被拒的收款改了订单")
	}
	for _, status := range []string{domain.StatusPaid, domain.StatusRefunded, domain.StatusVoided} {
		closed := domain.Order{Status: status, ReceivableCents: 100}
		if _, err := Collect(&closed, domain.Payment{Method: "cash", AmountCents: 100}); !errors.Is(err, ErrClosed) || OutstandingCents(closed) != 0 {
			t.Fatalf("%s 不能收款：%v", status, err)
		}
	}
	// 收了一部分、剩下免单：还差 0，订单的实收只算收到的钱
	comped := domain.Order{Status: domain.StatusPartiallyPaid, ReceivableCents: 10000, PaidCents: 4000,
		Payments: []domain.Payment{{ID: "a", Method: "cash", AmountCents: 4000}, {ID: "c", Method: domain.PaymentComp, AmountCents: 6000}}}
	if OutstandingCents(comped) != 0 || CompCents(comped) != 6000 {
		t.Fatalf("对剩余免单后还差 %d、免单 %d", OutstandingCents(comped), CompCents(comped))
	}
}

// 可以单独退款的几笔：每笔现金、微信、支付宝各是一笔；会员结账那一笔（标了 member 的几条，一条没标的是一次收齐的旧单，全部算它）；
// 免单不算。退款记了 paymentId 的记到那一笔，没记的按付款先后依次抵扣。
func TestRefundUnits(t *testing.T) {
	split := domain.Order{Status: domain.StatusPaid, ReceivableCents: 10000, PaidCents: 7000, Payments: []domain.Payment{
		{ID: "p1", Method: "wechat", AmountCents: 4000},
		{ID: "p2", Method: "cash", AmountCents: 3000},
		{ID: "c", Method: domain.PaymentComp, AmountCents: 3000},
	}, Refunds: []domain.Refund{{AmountCents: 1000, PaymentID: "p2"}, {AmountCents: 500, PaymentID: "p1"}}}
	units := RefundUnits(split, false)
	if len(units) != 2 || units[0].ID() != "p1" || units[0].RefundableCents() != 3500 || units[1].ID() != "p2" || units[1].RefundableCents() != 2000 {
		t.Fatalf("两笔各退各的：%+v", units)
	}

	// 没记哪一笔的退款（以前的、旧版本登记的）按付款先后依次抵扣
	legacy := split
	legacy.Refunds = []domain.Refund{{AmountCents: 4500}}
	units = RefundUnits(legacy, false)
	if units[0].RefundableCents() != 0 || units[1].RefundableCents() != 2500 {
		t.Fatalf("没记哪一笔的按先后抵扣：%+v", units)
	}
	mixed := split
	mixed.Refunds = []domain.Refund{{AmountCents: 1000, PaymentID: "p1"}, {AmountCents: 3500}}
	units = RefundUnits(mixed, false)
	if units[0].RefundableCents() != 0 || units[1].RefundableCents() != 2500 {
		t.Fatalf("记了的先记、没记的再按先后抵扣：%+v", units)
	}

	// 会员结账一次收齐的旧单：储值和线下补付都是会员这一笔
	old := domain.Order{Status: domain.StatusPaid, PaidCents: 9700, Payments: []domain.Payment{
		{ID: "b", Method: "balance", AmountCents: 6000}, {ID: "o", Method: "cash", AmountCents: 3700},
	}, Refunds: []domain.Refund{{AmountCents: 1940}}}
	units = RefundUnits(old, true)
	if len(units) != 1 || !units[0].Member || units[0].AmountCents != 9700 || units[0].RefundableCents() != 7760 || !slices.Equal(units[0].PaymentIDs, []string{"b", "o"}) {
		t.Fatalf("一次收齐的会员结账单只有会员这一笔：%+v", units)
	}

	// 会员结账收了一部分、别人分笔付：标了 member 的是会员这一笔，其余各是一笔
	member := domain.Order{Status: domain.StatusPaid, PaidCents: 10000, Payments: []domain.Payment{
		{ID: "b", Method: "balance", AmountCents: 5000, Member: true},
		{ID: "o", Method: "wechat", AmountCents: 1000, Member: true},
		{ID: "f", Method: "alipay", AmountCents: 4000},
	}, Refunds: []domain.Refund{{AmountCents: 600, PaymentID: "b"}, {AmountCents: 4000, PaymentID: "f"}}}
	units = RefundUnits(member, true)
	if len(units) != 2 || !units[0].Member || units[0].AmountCents != 6000 || units[0].RefundableCents() != 5400 || units[1].Member || units[1].RefundableCents() != 0 {
		t.Fatalf("会员这一笔与别人那一笔：%+v", units)
	}
	if !units[0].Has("o") || units[0].Has("f") {
		t.Fatal("会员这一笔包含储值与随会员结账收的线下款")
	}
}

func TestRefundTarget(t *testing.T) {
	single := domain.Order{Status: domain.StatusPaid, PaidCents: 100, Payments: []domain.Payment{{ID: "p", Method: "cash", AmountCents: 100}}}
	if u, err := RefundTarget(RefundUnits(single, false), single, ""); err != nil || u.ID() != "p" {
		t.Fatalf("一笔收齐的单不用选：%v %+v", err, u)
	}
	split := domain.Order{Status: domain.StatusPaid, PaidCents: 100, Payments: []domain.Payment{
		{ID: "p1", Method: "cash", AmountCents: 60}, {ID: "p2", Method: "wechat", AmountCents: 40}, {ID: "c", Method: domain.PaymentComp, AmountCents: 20},
	}}
	units := RefundUnits(split, false)
	for name, c := range map[string]struct {
		payment string
		want    error
	}{
		"分几笔收的要选": {"", ErrChoosePayment},
		"不是这一单的":  {"nope", ErrUnknownPayment},
		"免单那一笔":   {"c", ErrCompPayment},
	} {
		if _, err := RefundTarget(units, split, c.payment); !errors.Is(err, c.want) {
			t.Fatalf("%s：%v", name, err)
		}
	}
	if u, err := RefundTarget(units, split, "p2"); err != nil || u.ID() != "p2" || u.RefundableCents() != 40 {
		t.Fatalf("选第二笔：%v %+v", err, u)
	}
	member := domain.Order{Status: domain.StatusPaid, PaidCents: 100, Payments: []domain.Payment{{ID: "b", Method: "balance", AmountCents: 100}}}
	if _, err := RefundTarget(RefundUnits(member, true), member, ""); !errors.Is(err, ErrMemberPayment) {
		t.Fatalf("会员结账那一笔走会员退款：%v", err)
	}
	comped := domain.Order{Status: domain.StatusPaid, Payments: []domain.Payment{{ID: "c", Method: domain.PaymentComp, AmountCents: 100}}}
	if _, err := RefundTarget(RefundUnits(comped, false), comped, ""); !errors.Is(err, ErrCompPayment) {
		t.Fatalf("整单免单没有可退的：%v", err)
	}
}

func TestFullyRefunded(t *testing.T) {
	o := domain.Order{Status: domain.StatusPaid, PaidCents: 100, Refunds: []domain.Refund{{AmountCents: 60}}}
	if FullyRefunded(o) {
		t.Fatal("还有 40 没退")
	}
	o.Refunds = append(o.Refunds, domain.Refund{AmountCents: 40})
	if !FullyRefunded(o) {
		t.Fatal("都退完了")
	}
	if FullyRefunded(domain.Order{Status: domain.StatusPaid}) {
		t.Fatal("没收到钱的单不按金额算退完")
	}
}
