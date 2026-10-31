package application

import (
	"fmt"
	"time"
)

type Admission struct {
	ID         string    `json:"id"`
	AccountID  string    `json:"accountId"`
	TableID    string    `json:"serviceTableId"`
	SeatNumber int       `json:"seatNumber"`
	Package    Rule      `json:"package"`
	Status     string    `json:"status"`
	SessionID  string    `json:"venueSessionId,omitempty"`
	CreatedAt  time.Time `json:"createdAt"`
	// Coupon 是顾客扫码入座时填的团购记录（选填，约过这个座位的从预约带过来），员工确认时可以改。
	// 没填时不写进 JSON：旧申请的编码和会员资产版本不变。
	Coupon *Coupon `json:"coupon,omitempty"`
}

// Coupon 是团购记录：平台（meituan、dianping、in_store）和券码；校验与预约的同一套（reservations/domain.NormalizeCoupon），
// 这里只是同样形状的一份，免得会员模块依赖预约模块。
type Coupon struct {
	Platform string `json:"platform"`
	Code     string `json:"code,omitempty"`
}

// AdmissionWindow 是顾客扫码申请之后，员工必须确认的时限。超过就作废，顾客得重扫重选。
const AdmissionWindow = 30 * time.Minute

// Display 是这条申请**此刻**对人的状态。
//
// ★ Status 只有被人点过才会变（确认/拒绝/取消），过期是时间到了自然发生的，没人点。
// 所以 pending 会一直是 pending —— 2026-09-20 业主看到顾客端写着「等待员工确认」、
// 员工端还摆着「确认开台」，点下去才报「申请已过期」。更糟的是工作台那个
// 「待确认开台 N」会永远挂着一个下不去的数字。
// 过期必须在**读的时候**算出来，和预约的 Reservation.Display 是同一套做法。
func (a Admission) Display(now time.Time) string {
	if a.Status == "pending" && !now.Before(a.CreatedAt.Add(AdmissionWindow)) {
		return "expired"
	}
	return a.Status
}

type Quote struct {
	OriginalCents   int64  `json:"originalCents"`
	DiscountCents   int64  `json:"discountCents"`
	PointsUsed      int64  `json:"pointsUsed"`
	PointsCents     int64  `json:"pointsCents"`
	PrincipalCents  int64  `json:"principalCents"`
	GiftCents       int64  `json:"giftCents"`
	OfflineCents    int64  `json:"offlineCents"`
	EarnedPoints    int64  `json:"earnedPoints"`
	PointsValidDays int    `json:"pointsValidDays"`
	BirthdayEntryID string `json:"birthdayEntryId,omitempty"`
	Version         string `json:"version"`
}

// ErrBalanceCap 是「这次用多少储值」填得不对：超过可用储值或这一笔应付，或没勾用储值却填了。请求本身的问题。
type ErrBalanceCap struct{ msg string }

func (e ErrBalanceCap) Error() string { return e.msg }

func yuan(cents int64) string { return fmt.Sprintf("¥%d.%02d", cents/100, cents%100) }

// QuoteConsumption uses integer cents only; points are redeemed in whole blocks.
//
// balanceCap 是这次最多用多少储值（本金 + 赠送，整数分）：不填（nil）照旧能用多少用多少；填了就是会员只用储值付自己那份
// （2026-10-06 业主定，多人合付），余下的走线下补付。它不能超过可用储值，也不能超过会员优惠、积分抵扣之后这一笔应付的；
// 扣的先后照旧先本金、后赠送。要勾用储值（useBalance）才能填。
func (s *State) QuoteConsumption(user string, amount, goods, service, points int64, useBalance bool, balanceCap *int64, now time.Time) (Quote, error) {
	if amount < 0 || amount > Limit || points < 0 || points > Limit {
		return Quote{}, ErrInvalid
	}
	if balanceCap != nil && (!useBalance || *balanceCap < 0 || *balanceCap > Limit) {
		return Quote{}, ErrBalanceCap{"要先选用储值，再填这次用多少储值（不小于 0 的金额）"}
	}
	b := s.Balance(user, now)
	q := Quote{OriginalCents: amount, PointsUsed: points}
	rate := b.RateBasisPoints
	used := map[string]bool{}
	for _, e := range s.History(user) {
		if e.Kind == "birthday_used" {
			used[e.SourceID] = true
		}
	}
	for _, e := range s.History(user) {
		if e.Kind == "birthday" && e.Rule != nil && e.Rule.Scope == "discount" && !used[e.ID] && now.Before(e.CreatedAt.AddDate(0, 0, e.Rule.ValidDays)) && e.Rule.RateBasisPoints < rate {
			rate = e.Rule.RateBasisPoints
			q.BirthdayEntryID = e.ID
		}
	}
	due := amount * rate / 10000
	q.DiscountCents = amount - due
	if points > 0 {
		r, ok := s.Kind("redeem")
		if !ok || points < r.MinimumPoints || points%r.Points != 0 || points > b.Points || (!r.Stack && q.DiscountCents > 0) {
			return q, ErrInvalid
		}
		q.PointsCents = points / r.Points * r.AmountCents
		if q.PointsCents > due*r.MaxBasisPoints/10000 || q.PointsCents > due {
			return q, ErrInvalid
		}
		due -= q.PointsCents
	}
	if useBalance {
		limit := b.PrincipalCents + b.GiftCents
		if balanceCap != nil {
			if *balanceCap > b.PrincipalCents+b.GiftCents {
				return q, ErrBalanceCap{fmt.Sprintf("这次用的储值 %s 超过了可用储值 %s（本金加赠送）", yuan(*balanceCap), yuan(b.PrincipalCents+b.GiftCents))}
			}
			if *balanceCap > due {
				return q, ErrBalanceCap{fmt.Sprintf("这次用的储值 %s 超过了这一笔应付的 %s（会员优惠、积分抵扣之后）", yuan(*balanceCap), yuan(due))}
			}
			limit = *balanceCap
		}
		q.PrincipalCents = min(due, b.PrincipalCents, limit)
		due -= q.PrincipalCents
		q.GiftCents = min(due, b.GiftCents, limit-q.PrincipalCents)
		due -= q.GiftCents
	}
	q.OfflineCents = due
	var err error
	if q.EarnedPoints, q.PointsValidDays, err = s.EarnedPoints(amount-q.DiscountCents-q.PointsCents, goods, service); err != nil {
		return q, err
	}
	q.Version = Version(struct {
		Q       Quote
		B       Balance
		Rules   []Rule
		History []Entry
	}{q, b, s.Rules(), s.History(user)})
	return q, nil
}

// EarnedPoints 是实付 paid（扣除优惠和积分抵扣后真正付的钱：储值本金、赠送余额、线下款）该送的消费积分与有效天数。
// 商品／服务范围按原明细金额（goods、service）占比分摊，金额和积分向下取整；没有生效的消费积分规则时为 0。
// 会员结账一次收齐时 paid 就是报价的应付；分笔付款时只按会员结账那一笔收到的钱算（别人分笔付的不给这位会员送积分）。
func (s *State) EarnedPoints(paid, goods, service int64) (int64, int, error) {
	r, ok := s.Kind("earn")
	if !ok {
		return 0, 0, nil
	}
	if paid < 0 || paid > Limit {
		return 0, 0, ErrInvalid
	}
	eligible := goods + service
	if r.Scope == "goods" {
		eligible = goods
	}
	if r.Scope == "service" {
		eligible = service
	}
	var base int64
	if goods+service > 0 {
		base = paid * eligible / (goods + service)
	}
	points := base / r.AmountCents * r.Points
	if points > Limit {
		return 0, 0, ErrInvalid
	}
	return points, r.ValidDays, nil
}

// CheckoutSummary 是一张订单经会员结账时动过的会员资产，按该订单的 checkout、earned 流水合计。
// 会员结账单退款（refund 动作）按这几项的比例冲回这两类流水（可分多次，见 refund.go），退满时正好全部冲回。
type CheckoutSummary struct {
	// PrincipalCents、GiftCents 是从储值本金、赠送余额扣的钱，退款时退回原账户。
	PrincipalCents int64 `json:"principalCents"`
	GiftCents      int64 `json:"giftCents"`
	// PointsUsed 是抵扣用掉的积分，退款时按原批次恢复（保留原到期时间）。
	PointsUsed int64 `json:"pointsUsed"`
	// PointsEarned 是本单送的积分，退款时收回；已被用掉时退款会被拒绝。
	PointsEarned int64 `json:"pointsEarned"`
}

// Checkouts 按订单 ID 汇总会员结账，一次扫完全部流水，列表逐单查表即可。
//
// 会员结账无论用没用到余额和积分，都会写一条 SourceID 指向订单的 checkout 流水，普通收款不写；
// 普通退款接口也凭这一条拒绝会员结账单。所以只有带 checkout 流水的订单才算会员结账，
// earned 流水只并入已经算上的订单。
func (s *State) Checkouts() map[string]CheckoutSummary {
	out := map[string]CheckoutSummary{}
	for _, e := range s.Entries {
		if e.Kind != "checkout" {
			continue
		}
		c := out[e.SourceID]
		c.PrincipalCents -= e.PrincipalCents
		c.GiftCents -= e.GiftCents
		for _, p := range e.Points {
			c.PointsUsed -= p.Delta
		}
		out[e.SourceID] = c
	}
	for _, e := range s.Entries {
		c, ok := out[e.SourceID]
		if e.Kind != "earned" || !ok {
			continue
		}
		for _, p := range e.Points {
			c.PointsEarned += p.Delta
		}
		out[e.SourceID] = c
	}
	return out
}

// BalanceAfterCheckout 是 user 在 orderID 这笔会员结账记完账那一刻的余额与可用积分（小票上的「本单结账后余额」）。
//
// 由不可改写的会员流水推出，不另存快照：按记账顺序取这笔结账之前的全部流水，加上本单的结账扣款（checkout）
// 与消费送分（earned）——同一请求里一起记下、时间相同；积分按那一刻有没有到期算。之后的充值、消费、退款
// （包括本单自己的退款，不论整单还是分几次部分退）都记在更晚的时刻，不影响它，所以事后重印小票还是结账那一刻的数。
// 同一时刻别的请求记下的流水分不出先后，不算在内（实际不会撞到同一纳秒）。没有本单的结账流水时 ok 为 false。
func (s *State) BalanceAfterCheckout(user, orderID string) (Balance, bool) {
	history := s.History(user)
	var at time.Time
	found := false
	for _, e := range history {
		if e.Kind == "checkout" && e.SourceID == orderID {
			at, found = e.CreatedAt, true
			break
		}
	}
	if !found {
		return Balance{}, false
	}
	upTo := make([]Entry, 0, len(history))
	for _, e := range history {
		ours := e.SourceID == orderID && (e.Kind == "checkout" || e.Kind == "earned")
		if e.CreatedAt.Before(at) || (e.CreatedAt.Equal(at) && ours) {
			upTo = append(upTo, e)
		}
	}
	return balanceOf(upTo, at), true
}
