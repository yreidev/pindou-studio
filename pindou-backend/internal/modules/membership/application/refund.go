package application

import "time"

// 会员结账单的退款：一次退 amount（分），按这单原始实付的构成等比例拆到各来源，可以分多次退。
//
// 来源有五样：线下补付、储值本金、赠送余额（这三样加起来就是本单实付 paid），抵扣用掉的积分（按同一比例
// 退回原批次，保留原到期时间——也就是把这次退的比例按抵扣时的兑换比例折回积分），以及本单送出的消费积分
// （按同一比例收回）。
//
// 取整，全部是整数：
//   - 每个来源先算「原数 × amount ÷ paid」，向下取整；
//   - 积分不凑整，零头留到把这单退满的那一次结清；
//   - 钱的三项加起来必须正好是 amount：向下取整少掉的 1～2 分，一分一分补给累计退得比原付款比例欠得最多的
//     来源（一样欠时依次是本金、赠送、线下，和结账扣款的先后一致）。这样分多少次退，各来源累计退的钱都贴着
//     原付款比例，不会因为总把零头给同一项而越退越偏；任何来源累计都不超过原数；
//   - 把这单退满的那一次（此前已退 + amount = paid），各来源一律退「原数 − 此前已退」。
//
// 所以不论分几次、每次退多少，退满时各来源（积分细到每个批次）的总数都和一次整单退款完全相同。

// RefundPart 是一次（或累计几次）会员退款从各来源退回、收回的数。
type RefundPart struct {
	// OfflineCents 是线下补付里要退的钱：系统只登记，由员工按原付款方式退还顾客。
	OfflineCents int64 `json:"offlineCents"`
	// PrincipalCents、GiftCents 退回储值本金、赠送余额，按原流水各回各的账户，不会把赠送退成本金。
	PrincipalCents int64 `json:"principalCents"`
	GiftCents      int64 `json:"giftCents"`
	// PointsRestored 是恢复的抵扣积分，回到原批次、保留原到期时间。
	PointsRestored int64 `json:"pointsRestored"`
	// PointsClawedBack 是收回的本单所送消费积分。
	PointsClawedBack int64 `json:"pointsClawedBack"`
}

// CheckoutRefund 是一张会员结账单退款时要看的账。
type CheckoutRefund struct {
	// PaidCents 是本单实付：线下补付 + 储值本金 + 赠送余额（不含积分抵扣的部分）。
	PaidCents int64
	// OfflineCents 是线下补付（现金、微信、支付宝）。
	OfflineCents int64
	// RefundedCents 是此前各次退款的金额之和。
	RefundedCents int64
	// Originals 是本单的结账扣款（checkout）与消费送分（earned）流水，按记账顺序。
	Originals []Entry
	// Previous 是此前冲正这些流水的退款（refund）流水。
	Previous []Entry
}

// RemainingCents 是这单还能退的金额。
func (c CheckoutRefund) RemainingCents() int64 { return c.PaidCents - c.RefundedCents }

// Refunded 是此前各次退款累计退回、收回的数。线下部分是退款金额减去退回储值的部分。
func (c CheckoutRefund) Refunded() RefundPart {
	var out RefundPart
	for _, e := range c.Previous {
		out.PrincipalCents += e.PrincipalCents
		out.GiftCents += e.GiftCents
		for _, p := range e.Points {
			if p.Delta > 0 {
				out.PointsRestored += p.Delta
			} else {
				out.PointsClawedBack -= p.Delta
			}
		}
	}
	out.OfflineCents = c.RefundedCents - out.PrincipalCents - out.GiftCents
	return out
}

// RefundSplit 是一次退款算出来的结果。
type RefundSplit struct {
	RefundPart
	// Settles 表示这次把这单退满：各来源的零头在这次结清。
	Settles bool
	// Entries 是要记的冲正流水，每条原流水一条（没有变动的不记）：SourceID 指向原流水，钱和积分方向与原流水相反，
	// 积分记在原批次上并带着原到期时间。ID、种类、原因、时间由调用方填。
	Entries []Entry
}

// Split 算退 amount 分时各来源退回、收回多少，并给出要记的冲正流水。不改任何状态。
// amount 须在 1 到 RemainingCents 之间；实付为 0 的单（全用积分抵扣）只能整单退，amount 为 0。
func (c CheckoutRefund) Split(amount int64) (RefundSplit, error) {
	paid, remaining := c.PaidCents, c.RemainingCents()
	// 金额、积分都不超过 Limit（结账时就核对过），乘积放得下 int64
	if paid < 0 || paid > Limit || c.OfflineCents < 0 || c.RefundedCents < 0 || remaining < 0 || amount < 0 || amount > remaining || (amount == 0 && paid != 0) {
		return RefundSplit{}, ErrInvalid
	}
	settles := amount == remaining

	// 每条原流水各来源的原数和此前已退的数
	type lot struct {
		id string
		// origin 是原流水里这个批次的那一笔：冲正照抄批次和到期时间
		origin PointChange
		// sign 是冲正的方向：抵扣用掉的（原流水为负）退回为正，送出的（原流水为正）收回为负
		sign        int64
		total, done int64
		part        int64
	}
	type original struct {
		entry                   Entry
		principal, gift         int64
		principalDone, giftDone int64
		principalPart, giftPart int64
		lots                    []*lot
	}
	byID := map[string]*original{}
	originals := make([]*original, 0, len(c.Originals))
	for _, e := range c.Originals {
		if e.PrincipalCents > 0 || e.GiftCents > 0 || byID[e.ID] != nil {
			return RefundSplit{}, ErrInvalid
		}
		o := &original{entry: e, principal: -e.PrincipalCents, gift: -e.GiftCents}
		index := map[string]*lot{}
		points := int64(0)
		for _, p := range e.Points {
			if p.Delta == 0 {
				continue
			}
			if points += abs(p.Delta); points > Limit {
				return RefundSplit{}, ErrInvalid
			}
			l := index[p.LotID]
			if l == nil {
				l = &lot{id: p.LotID, origin: p, sign: -sign(p.Delta)}
				index[p.LotID] = l
				o.lots = append(o.lots, l)
			}
			if -sign(p.Delta) != l.sign {
				return RefundSplit{}, ErrInvalid
			}
			l.total += abs(p.Delta)
		}
		byID[e.ID] = o
		originals = append(originals, o)
	}
	for _, e := range c.Previous {
		o := byID[e.SourceID]
		if o == nil {
			continue
		}
		o.principalDone += e.PrincipalCents
		o.giftDone += e.GiftCents
		for _, p := range e.Points {
			for _, l := range o.lots {
				if l.id == p.LotID {
					l.done += p.Delta * l.sign
				}
			}
		}
	}

	// 钱：本金、赠送按原流水汇总，线下按订单
	principal := &moneySource{}
	gift := &moneySource{}
	for _, o := range originals {
		if o.principalDone < 0 || o.principalDone > o.principal || o.giftDone < 0 || o.giftDone > o.gift {
			return RefundSplit{}, ErrInvalid
		}
		principal.total += o.principal
		principal.done += o.principalDone
		gift.total += o.gift
		gift.done += o.giftDone
		for _, l := range o.lots {
			if l.done < 0 || l.done > l.total {
				return RefundSplit{}, ErrInvalid
			}
		}
	}
	offline := &moneySource{total: c.OfflineCents, done: c.RefundedCents - principal.done - gift.done}
	if principal.total+gift.total+offline.total != paid || offline.done < 0 || offline.done > offline.total {
		return RefundSplit{}, ErrInvalid
	}
	splitMoney(amount, c.RefundedCents, paid, settles, []*moneySource{principal, gift, offline})
	// 本金、赠送的这次退款按记账顺序分给原流水（实际只有一条结账扣款）
	principalLeft, giftLeft := principal.part, gift.part
	for _, o := range originals {
		o.principalPart = min(principalLeft, o.principal-o.principalDone)
		principalLeft -= o.principalPart
		o.giftPart = min(giftLeft, o.gift-o.giftDone)
		giftLeft -= o.giftPart
	}

	// 积分：每条原流水按比例向下取整，退满时结清；批次按扣除、发放的逆序（后进先出）
	for _, o := range originals {
		total, done := int64(0), int64(0)
		for _, l := range o.lots {
			total += l.total
			done += l.done
		}
		n := total - done
		if !settles {
			n = min(n, mulDiv(total, amount, paid))
		}
		for i := len(o.lots) - 1; i >= 0 && n > 0; i-- {
			l := o.lots[i]
			l.part = min(n, l.total-l.done)
			n -= l.part
		}
	}

	out := RefundSplit{Settles: settles, Entries: []Entry{}}
	out.OfflineCents = offline.part
	for _, o := range originals {
		e := Entry{AccountID: o.entry.AccountID, SourceID: o.entry.ID, PrincipalCents: o.principalPart, GiftCents: o.giftPart, Points: []PointChange{}}
		out.PrincipalCents += o.principalPart
		out.GiftCents += o.giftPart
		for _, l := range o.lots {
			if l.part == 0 {
				continue
			}
			change := l.origin
			change.Delta = l.part * l.sign
			e.Points = append(e.Points, change)
			if l.sign > 0 {
				out.PointsRestored += l.part
			} else {
				out.PointsClawedBack += l.part
			}
		}
		if e.PrincipalCents != 0 || e.GiftCents != 0 || len(e.Points) > 0 {
			out.Entries = append(out.Entries, e)
		}
	}
	return out, nil
}

// moneySource 是钱的一个来源：原数、此前已退、这次退。
type moneySource struct {
	total, done, part int64
}

// splitMoney 把 amount 拆给 sources（顺序就是一样欠时的先后）。refunded 是此前已退的金额，退满时各退余下的全部。
func splitMoney(amount, refunded, paid int64, settles bool, sources []*moneySource) {
	if settles {
		for _, s := range sources {
			s.part = s.total - s.done
		}
		return
	}
	short := amount
	for _, s := range sources {
		s.part = min(s.total*amount/paid, s.total-s.done)
		short -= s.part
	}
	// 向下取整少掉的几分（通常 1～2 分）一分一分补：每次补给累计退得比原付款比例欠得最多的来源。
	// 欠多少 = 原数 × 退后累计 ÷ 实付 − (此前已退 + 这次已分)，两边同乘实付比较，全是整数。
	cumulative := refunded + amount
	for range 2 * len(sources) {
		if short == 0 {
			break
		}
		var best *moneySource
		bestBehind := int64(0)
		for _, s := range sources {
			if s.part >= s.total-s.done {
				continue
			}
			if behind := s.total*cumulative - paid*(s.done+s.part); best == nil || behind > bestBehind {
				best, bestBehind = s, behind
			}
		}
		if best == nil {
			break
		}
		best.part++
		short--
	}
	// 还有剩（有来源已经退到原数被截住）：依次补给还有余量的来源。余量合计是这单还能退的钱，一定够。
	for _, s := range sources {
		add := min(short, s.total-s.done-s.part)
		s.part += add
		short -= add
	}
}

// mulDiv 是 a × b ÷ c 向下取整（0 ≤ a、b ≤ Limit，c > 0）：乘积不超过 10^18，int64 放得下。
func mulDiv(a, b, c int64) int64 {
	if a <= 0 || b <= 0 || c <= 0 {
		return 0
	}
	return a * b / c
}

func sign(n int64) int64 {
	if n < 0 {
		return -1
	}
	return 1
}

func abs(n int64) int64 {
	if n < 0 {
		return -n
	}
	return n
}

// CanApply 核对按顺序记 entries（同一位顾客的流水）现在能不能记账，不改任何状态。和 Append 是同一套校验。
func (s *State) CanApply(user string, entries []Entry, now time.Time) error {
	l := s.ledger(user, now)
	for _, e := range entries {
		if err := l.apply(e, now); err != nil {
			return err
		}
	}
	return nil
}

// PointsShort 是记 entries 时各积分批次不够扣的分数之和，以及涉及扣分的批次。
// 退款收回本单所送积分时，据此说明还缺多少。
func (s *State) PointsShort(user string, entries []Entry) (int64, map[string]bool) {
	lots := s.Lots(user)
	need := map[string]int64{}
	for _, e := range entries {
		for _, p := range e.Points {
			if p.Delta < 0 {
				need[p.LotID] -= p.Delta
			}
		}
	}
	short := int64(0)
	touched := map[string]bool{}
	for lot, n := range need {
		touched[lot] = true
		if left := lots[lot].Delta; left < n {
			short += n - left
		}
	}
	return short, touched
}
