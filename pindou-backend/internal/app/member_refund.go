package app

import (
	"errors"
	"fmt"
	"strings"

	member "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/membership/application"
	ordersapp "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/orders/application"
)

// 会员结账单的退款（/loyalty/actions 的 refund，店长、老板）：可以像普通订单一样分多次退，每次退的金额按这单
// 原始实付的构成等比例拆到线下补付、储值本金、赠送余额和积分（算法见会员模块 refund.go）。
// 不带金额时退剩余全部，也就是原来的「整单退款」。refund_quote 只算不写，确认前给页面看这次将退回什么。
//
// 并发确认只看订单版本：拆分只取决于订单和它自己的结账、送分、退款流水，而这些流水只随这张单的退款变，
// 退款又一定改订单。顾客别处的积分变动不让版本失效——收回积分够不够在提交时照实核对。

// memberRefundQuote 是会员退款的预览：这次将退回、收回什么，以及收不回积分时的说明。
type memberRefundQuote struct {
	// OrderVersion 是这份预览依据的订单版本，提交退款时原样带回 expectedVersion。
	OrderVersion string `json:"orderVersion"`
	AmountCents  int64  `json:"amountCents"`
	// RefundableCents 是这次退款之前还能退的金额。
	RefundableCents int64 `json:"refundableCents"`
	// SettlesOrder 表示这次把这单退满：各来源的零头在这次结清。
	SettlesOrder bool `json:"settlesOrder"`
	member.RefundPart
	// Blocked 非空表示这次退不了：本单送出的积分已被用掉，收不回按比例该收回的分数。
	Blocked *memberRefundBlocked `json:"blocked,omitempty"`
}

// memberRefundTarget 取会员退款要退的订单并核对：版本过期单独报 order_version_conflict（页面据此保留输入、
// 重读后让人再确认）；已付、是会员结账、顾客对得上。
func (s *Server) memberRefundTarget(q *txn, in loyaltyInput) (*Order, member.CheckoutRefund, error) {
	o := q.order(in.TargetID)
	if o != nil {
		if err := ordersapp.CheckVersion(*o, in.ExpectedVersion); err != nil {
			return nil, member.CheckoutRefund{}, err
		}
	}
	if o == nil || o.UserID == "" || o.Status != "paid" {
		return nil, member.CheckoutRefund{}, errors.New("请选择还没退完的已付会员结账单，刷新后重试")
	}
	if in.AccountID != "" && in.AccountID != o.UserID {
		return nil, member.CheckoutRefund{}, invalidInput{errors.New("顾客与订单不符，请刷新后重试")}
	}
	basis, ok := s.memberRefundBasis(q, *o)
	if !ok {
		return nil, member.CheckoutRefund{}, errors.New("这张订单不是会员结账，请用普通退款办理")
	}
	if basis.PaidCents > 0 && basis.RemainingCents() <= 0 {
		// 分笔付款的单：会员这一笔退完了，别人付的还没退完，订单仍是已付款
		return nil, member.CheckoutRefund{}, invalidInput{errors.New("会员结账那一笔已经退完了，别人分笔付的请选那一笔办普通退款")}
	}
	return o, basis, nil
}

// memberRefundBasis 是会员结账单的退款账：本单的结账扣款（checkout）与消费送分（earned）流水、此前冲正它们的
// 退款流水，以及会员结账那一笔的实付、线下补付、已退金额。不是会员结账单时返回 false。读出这位顾客的全部流水。
//
// 分笔付款（多人合付）的单只算会员结账那一笔（储值和随会员结账收的线下款）：别人分笔付的钱各退各的（普通退款），
// 不进这里的比例。会员结账一次收齐的单（以前的单都是）全部付款都是这一笔，和以前一样。
func (s *Server) memberRefundBasis(q *txn, o Order) (member.CheckoutRefund, bool) {
	unit, _ := memberUnit(o)
	basis := member.CheckoutRefund{PaidCents: unit.AmountCents, RefundedCents: unit.RefundedCents}
	if len(unit.PaymentIDs) == 0 {
		// 全用积分抵扣、没收钱的单：没有付款记录，退款金额都是 0
		basis.RefundedCents = ordersapp.RefundedCents(o)
	}
	for _, p := range o.Payments {
		if unit.Has(p.ID) && p.Method != "balance" {
			basis.OfflineCents += p.AmountCents
		}
	}
	history := q.memberAccount(o.UserID).History(o.UserID)
	originals := map[string]bool{}
	checkout := false
	for _, e := range history {
		if e.SourceID == o.ID && (e.Kind == "checkout" || e.Kind == "earned") {
			basis.Originals = append(basis.Originals, e)
			originals[e.ID] = true
			checkout = checkout || e.Kind == "checkout"
		}
	}
	for _, e := range history {
		if e.Kind == "refund" && originals[e.SourceID] {
			basis.Previous = append(basis.Previous, e)
		}
	}
	return basis, checkout
}

// memberUnit 是会员结账单里会员结账那一笔（见 ordersapp.RefundUnits），以及订单一共分成了几笔可退的收款。
// 全用积分抵扣、没收钱的单没有这一笔（PaymentIDs 为空）。
func memberUnit(o Order) (ordersapp.RefundUnit, int) {
	units := ordersapp.RefundUnits(o, true)
	for _, u := range units {
		if u.Member {
			return u, len(units)
		}
	}
	return ordersapp.RefundUnit{}, len(units)
}

// memberRefundAmount 是这次要退的金额：没带就是剩余全部（整单退款）。
func memberRefundAmount(basis member.CheckoutRefund, amount *int64) (int64, error) {
	remaining := basis.RemainingCents()
	if amount == nil {
		return remaining, nil
	}
	if *amount < 1 || *amount > remaining {
		return 0, invalidInput{fmt.Errorf("退款金额须在 ¥0.01 到 ¥%s（本单还可退）之间", yuanText(remaining))}
	}
	return *amount, nil
}

// errMemberRefundRecords：本单的结账、退款流水与订单金额对不上（不该出现），不能按比例退。
var errMemberRefundRecords = errors.New("这张订单的会员结账记录与金额对不上，不能按比例退款，请联系老板核对")

// splitMemberRefund 算退 amount 时各来源退回、收回多少。
func splitMemberRefund(basis member.CheckoutRefund, amount int64) (member.RefundSplit, error) {
	split, err := basis.Split(amount)
	if err != nil {
		return member.RefundSplit{}, errMemberRefundRecords
	}
	return split, nil
}

// memberRefundShortage 核对这次退款按比例该收回的本单所送积分收不收得回：收不回时说明缺多少、被哪些流水用掉、
// 现在最多能退多少。和真正退款记账时是同一套核对。
func (s *Server) memberRefundShortage(q *txn, o Order, basis member.CheckoutRefund, split member.RefundSplit) *memberRefundBlocked {
	m := q.memberAccount(o.UserID)
	short, lots := m.PointsShort(o.UserID, split.Entries)
	if short == 0 {
		return nil
	}
	// 收回的积分随退款金额只增不减，二分找出现在收得回的最大金额
	feasible := func(amount int64) bool {
		trial, err := basis.Split(amount)
		if err != nil {
			return false
		}
		n, _ := m.PointsShort(o.UserID, trial.Entries)
		return n == 0
	}
	low, high := int64(0), basis.RemainingCents()
	for low < high {
		mid := low + (high-low+1)/2
		if feasible(mid) {
			low = mid
		} else {
			high = mid - 1
		}
	}
	return &memberRefundBlocked{
		Reason:             memberRefundBlockedReason(split.PointsClawedBack, short, low),
		PointsShort:        short,
		SpentBy:            m.SpentFrom(o.UserID, lots),
		MaxRefundableCents: low,
	}
}

// memberRefundBlockedReason 是收不回积分时给人看的话：订单详情、退款预览与提交被拒时是同一句。
// 老板纠错调整加的积分是新开批次，补不回本单的批次；只有退掉用了这些积分的结账单，积分才会回到原批次。
func memberRefundBlockedReason(clawBack, short, maxCents int64) string {
	text := fmt.Sprintf("本单送出的积分已被用掉：这次退款要按比例收回 %d 积分，还缺 %d 积分，暂时不能退。先把用掉这些积分的会员结账单退款，积分回到本单后再退", clawBack, short)
	if maxCents > 0 {
		text += fmt.Sprintf("；或者这次少退一些，现在最多能退 ¥%s", yuanText(maxCents))
	}
	return text
}

// loyaltyRefundQuote 是会员退款的预览（refund_quote，只读）：退 amountCents（不填为剩余全部）时各来源退回、
// 收回多少，收不回积分时一并说明。
func (s *Server) loyaltyRefundQuote(q *txn, in loyaltyInput) (any, error) {
	o, basis, err := s.memberRefundTarget(q, in)
	if err != nil {
		return nil, err
	}
	amount, err := memberRefundAmount(basis, in.AmountCents)
	if err != nil {
		return nil, err
	}
	split, err := splitMemberRefund(basis, amount)
	if err != nil {
		return nil, err
	}
	return memberRefundQuote{
		OrderVersion:    o.Version(),
		AmountCents:     amount,
		RefundableCents: basis.RemainingCents(),
		SettlesOrder:    split.Settles,
		RefundPart:      split.RefundPart,
		Blocked:         s.memberRefundShortage(q, *o, basis, split),
	}, nil
}

// loyaltyRefund 办一次会员退款：按比例记冲正流水（退回本金、赠送，恢复抵扣积分，收回所送积分），按员工逐件填写的
// 件数回补库存，订单追加一笔退款记录；退满时订单变为已退款。原结账流水与已有退款记录都不改写。
func (s *Server) loyaltyRefund(q *txn, u *User, in loyaltyInput) (any, error) {
	o, basis, err := s.memberRefundTarget(q, in)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(in.Reason) == "" {
		return nil, invalidInput{errors.New("请填写退款原因")}
	}
	amount, err := memberRefundAmount(basis, in.AmountCents)
	if err != nil {
		return nil, err
	}
	split, err := splitMemberRefund(basis, amount)
	if err != nil {
		return nil, err
	}
	if blocked := s.memberRefundShortage(q, *o, basis, split); blocked != nil {
		return nil, errors.New(blocked.Reason)
	}
	m := q.memberAccount(o.UserID)
	now := q.now()
	for _, e := range split.Entries {
		e.ID, e.Kind, e.Reason, e.CreatedAt = id(), "refund", in.Reason, now
		if err := m.Append(e, now); err != nil {
			return nil, errors.New("退回后余额或积分会超出上限，不能退款，请联系老板核对")
		}
	}
	// 回补库存与金额分摊无关：只认员工逐件填写的件数，同一单累计不超过售出件数（和普通退款同一套规则）
	returned, err := refundReturns(q, o, in.ReturnedProducts)
	if err != nil {
		return nil, invalidInput{err}
	}
	for product, n := range returned {
		if err := s.loyaltyStock(q, product, n, o.ID, u.ID); err != nil {
			return nil, err
		}
	}
	refund := Refund{ID: id(), Reason: in.Reason, AmountCents: amount, ReturnedProducts: returned, CreatedAt: now}
	// 分笔付款的单记下退的是会员结账那一笔，别人分笔付的照旧可以各自退；一次收齐的单不记，和以前一样
	if unit, units := memberUnit(*o); units > 1 {
		refund.PaymentID = unit.ID()
	}
	o.Refunds = append(o.Refunds, refund)
	o.RefundedCents = ordersapp.RefundedCents(*o)
	// 收到的钱都退完了订单才是已退款：分笔付款的单，会员这一笔退满了，别人付的还没退时仍是已付款。
	// 全用积分抵扣、没收钱的单退满（积分退回）就是已退款。
	if ordersapp.FullyRefunded(*o) || (split.Settles && o.PaidCents == 0) {
		o.Status = "refunded"
	}
	return s.orderView(q, *o), nil
}

// memberCheckoutState 补上单张会员结账单的退款情况：已退回、收回的累计，以及现在退剩余全部办不办得了。
// 要读这位顾客的全部流水，所以只在单张订单的响应里做，列表不带。
func (s *Server) memberCheckoutState(q *txn, o Order, view *memberCheckoutView) {
	basis, ok := s.memberRefundBasis(q, o)
	if !ok {
		return
	}
	if len(o.Refunds) > 0 {
		refunded := basis.Refunded()
		view.Refunded = &refunded
	}
	if o.Status != "paid" {
		return
	}
	if split, err := basis.Split(basis.RemainingCents()); err == nil {
		view.RefundBlocked = s.memberRefundShortage(q, o, basis, split)
	}
}
