package application

import (
	"errors"
	"testing"
	"time"
)

// 会员只用储值付自己那份（2026-10-06 业主定，多人合付）：报价可以限定这次最多用多少储值（本金 + 赠送）。
// 不填照旧能用多少用多少；填了先扣本金、后扣赠送，余下的走线下补付；超过可用储值、超过这一笔应付、没勾用储值都拒绝。
func TestQuoteBalanceCap(t *testing.T) {
	now := time.Date(2026, 10, 6, 10, 0, 0, 0, time.UTC)
	s := New()
	// 本金 ¥50、赠送 ¥10
	if err := s.Append(Entry{ID: "charge", AccountID: "u", PrincipalCents: 5000, GiftCents: 1000}, now); err != nil {
		t.Fatal(err)
	}
	limit := func(v int64) *int64 { return &v }
	cases := []struct {
		name                     string
		amount                   int64
		useBalance               bool
		cap                      *int64
		principal, gift, offline int64
		capError                 bool
	}{
		{"不填：能用多少用多少", 10000, true, nil, 5000, 1000, 4000, false},
		{"只用 ¥30：全从本金扣", 10000, true, limit(3000), 3000, 0, 7000, false},
		{"用 ¥55：本金扣完再扣赠送 ¥5", 10000, true, limit(5500), 5000, 500, 4500, false},
		{"用满可用储值 ¥60", 10000, true, limit(6000), 5000, 1000, 4000, false},
		{"填 0：不用储值", 10000, true, limit(0), 0, 0, 10000, false},
		{"正好等于这一笔应付", 2000, true, limit(2000), 2000, 0, 0, false},
		{"超过可用储值", 10000, true, limit(6001), 0, 0, 0, true},
		{"超过这一笔应付", 2000, true, limit(2001), 0, 0, 0, true},
		{"没勾用储值却填了", 10000, false, limit(1000), 0, 0, 0, true},
		{"负数", 10000, true, limit(-1), 0, 0, 0, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			q, err := s.QuoteConsumption("u", c.amount, 0, c.amount, 0, c.useBalance, c.cap, now)
			var capErr ErrBalanceCap
			if c.capError {
				if !errors.As(err, &capErr) || capErr.Error() == "" {
					t.Fatalf("应拒绝并说明：%v", err)
				}
				return
			}
			if err != nil || q.PrincipalCents != c.principal || q.GiftCents != c.gift || q.OfflineCents != c.offline {
				t.Fatalf("本金 %d 赠送 %d 线下 %d：%v", q.PrincipalCents, q.GiftCents, q.OfflineCents, err)
			}
		})
	}
	// 用多少储值算进报价版本：同样的单、不同的上限是两份报价
	a, _ := s.QuoteConsumption("u", 10000, 0, 10000, 0, true, limit(3000), now)
	b, _ := s.QuoteConsumption("u", 10000, 0, 10000, 0, true, limit(4000), now)
	if a.Version == b.Version {
		t.Fatal("储值上限不同，报价版本应不同")
	}
}
