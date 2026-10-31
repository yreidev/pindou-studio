package app

import (
	"errors"
	"time"

	member "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/membership/application"
	reserve "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/reservations/domain"
)

// 套餐用来开台、预约时的时长和能不能用（2026-10-10 业主定，见 docs/plan-timing-without-billing.md）。

// errPastClose 是「到打烊」的套餐在打烊以后开台。
var errPastClose = errors.New("已过今天的打烊时间，「到打烊」的套餐不能再开；请改用别的套餐，或老板在「营业与预约」里改每天结束时间")

// packageMinutes 是套餐从 start 起用多少分钟：定时套餐就是它的时长；「到打烊」的套餐到当天打烊为止（见
// reserve.Settings.MinutesUntilClose），已过打烊回 errPastClose。
func packageMinutes(q *txn, rule member.Rule, start time.Time) (int, error) {
	if !rule.UntilClose {
		return rule.DurationMinutes, nil
	}
	if n := q.reservationSettings().MinutesUntilClose(start); n > 0 {
		return n, nil
	}
	return 0, errPastClose
}

// packageUsable 核对套餐此刻能不能用来开台、预约：系统内收费开着时，没填价的套餐不能用（关着时价格不用填）。
func packageUsable(q *txn, rule member.Rule) error {
	if rule.AmountCents == 0 && q.billingEnabled() {
		return errors.New("套餐「" + rule.Name + "」还没定价：系统内收费开着时不能用它，请老板先在经营规则里填价")
	}
	return nil
}

// offeredRules 是给顾客看、给员工开台和预约选的已发布规则：系统内收费开着时去掉没定价的套餐（看不到，也不能用）。
// 老板的经营规则页照旧列出全部。
func offeredRules(q *txn, rules []member.Rule) []member.Rule {
	if !q.billingEnabled() {
		return rules
	}
	out := make([]member.Rule, 0, len(rules))
	for _, r := range rules {
		if r.Kind != "package" || r.AmountCents > 0 {
			out = append(out, r)
		}
	}
	return out
}

// couponOf 整理请求里的团购记录（见 reserve.NormalizeCoupon），给入座申请用。
func couponOf(c *reserve.Coupon) (*member.Coupon, error) {
	c, err := reserve.NormalizeCoupon(c)
	if err != nil || c == nil {
		return nil, err
	}
	out := member.Coupon(*c)
	return &out, nil
}

// reservationCoupon 是预约里记的团购记录换成入座申请的（顾客约过这个座位再来入座时带过去）。
func reservationCoupon(x *Reservation) *member.Coupon {
	if x == nil || x.Coupon == nil {
		return nil
	}
	out := member.Coupon(*x.Coupon)
	return &out
}
