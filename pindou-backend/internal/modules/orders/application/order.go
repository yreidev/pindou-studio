package application

import (
	"errors"
	"fmt"
	"math"
	"slices"

	"github.com/yreidev/pindou-studio/pindou-backend/internal/modules/orders/domain"
)

var ErrVersionConflict = errors.New("订单已被修改，请重新读取并确认")
var ErrClosed = errors.New("只有草稿订单可以修改")
var ErrInsufficientStock = errors.New("商品库存不足，请先核对商品数量并登记采购入库；计时或服务费请选择自定义服务后保存明细")

// ErrZeroReceivable 是人工折扣把应收减到了 0。应收为 0 的单收不了款（收款至少 1 分），草稿会一直挂在待结账里。
// 整单不收钱是单独的「免单」（2026-10-06 业主定：店长、老板写明原因，记一条免单结清记录），不是把折扣打到 100%。
var ErrZeroReceivable = errors.New("折扣不能把应收减到 0，请至少留 0.01 元；整单不收钱请用「免单」（店长、老板，写明原因）")

// DiscountedToZero 报告人工折扣是不是把一张有金额的单减成了 0。
// 明细本身就是 0 元（陪客、待填价的占位行）的单不算：那不是折扣减出来的。
func DiscountedToZero(order domain.Order) bool {
	if len(order.Discounts) == 0 || order.ReceivableCents > 0 {
		return false
	}
	for _, line := range order.Lines {
		if line.UnitPriceCents > 0 {
			return true
		}
	}
	return false
}

func CheckVersion(order domain.Order, expected string) error {
	if order.Version() != expected {
		return ErrVersionConflict
	}
	return nil
}

func UpdateLines(order domain.Order, lines []domain.Line, expected string) (domain.Order, error) {
	if err := CheckVersion(order, expected); err != nil {
		return order, err
	}
	if order.Status != domain.StatusDraft {
		return order, ErrClosed
	}
	order.Lines = append([]domain.Line(nil), lines...)
	if err := Reprice(&order); err != nil {
		return domain.Order{}, err
	}
	return order, nil
}

// RefundedCents 是本单各次退款记录的金额之和。退款只追加记录，不改写已付金额，
// 所以已退多少以退款记录为准。
func RefundedCents(order domain.Order) int64 {
	var total int64
	for _, refund := range order.Refunds {
		total += refund.AmountCents
	}
	return total
}

// RefundableCents 是这一单还能登记退款的金额上限：已付减已退。只有已付款（含部分退款）
// 和已退款的订单有值，其余为 0（部分付款的单要先收齐或对剩余免单才能退）。登记退款按它校验，接口也原样下发，前端不自行加减。
func RefundableCents(order domain.Order) int64 {
	if order.Status != domain.StatusPaid && order.Status != domain.StatusRefunded {
		return 0
	}
	if left := order.PaidCents - RefundedCents(order); left > 0 {
		return left
	}
	return 0
}

// FullyRefunded 报告收到的钱是不是都退完了（订单因此变为 refunded）。没收到钱的单（免单、全用积分抵扣）不算：
// 全用积分抵扣的会员结账单由会员退款自己判断。
func FullyRefunded(order domain.Order) bool {
	return order.PaidCents > 0 && RefundedCents(order) >= order.PaidCents
}

// Open 报告订单还没收齐：待结账，或部分付款（分笔付款收了一部分）。
func Open(order domain.Order) bool {
	return order.Status == domain.StatusDraft || order.Status == domain.StatusPartiallyPaid
}

// OutstandingCents 是还差多少没收：应收 − 已收 − 免单。草稿就是应收（计时的还会随时间变），部分付款是收齐还差的数；
// 已结清、已撤销的为 0。收款、免单都按它核对，接口原样下发，前端不自行加减。
func OutstandingCents(order domain.Order) int64 {
	if !Open(order) {
		return 0
	}
	if left := order.ReceivableCents - order.PaidCents - CompCents(order); left > 0 {
		return left
	}
	return 0
}

// ErrOverpay：这一笔超过了还差的数。多人分笔付款时两个人同时收、或页面过期，都可能撞上；什么都不登记。
type ErrOverpay struct{ Outstanding int64 }

func (e ErrOverpay) Error() string {
	return fmt.Sprintf("这一笔超过了还差的 ¥%d.%02d，请核对金额", e.Outstanding/100, e.Outstanding%100)
}

// Collect 记下一笔收到的钱（现金、微信、支付宝、储值），返回订单是不是因此收齐。只认还没收齐的单（待结账、部分付款），
// 金额 1 分起、不超过还差的数；收齐（已收 + 免单 = 应收）订单就是 paid，没收齐是 partially_paid。
// 收第一笔之前的准备（核对库存并出库、计时停在这一刻）由调用方做：那是订单之外的事。
func Collect(order *domain.Order, p domain.Payment) (bool, error) {
	if !Open(*order) {
		return false, ErrClosed
	}
	outstanding := OutstandingCents(*order)
	if p.AmountCents < 1 || p.Method == domain.PaymentComp {
		return false, errors.New("收款金额无效")
	}
	if p.AmountCents > outstanding {
		return false, ErrOverpay{Outstanding: outstanding}
	}
	order.Payments = append(order.Payments, p)
	order.PaidCents += p.AmountCents
	settled := p.AmountCents == outstanding
	order.Status = domain.StatusPartiallyPaid
	if settled {
		order.Status = domain.StatusPaid
	}
	return settled, nil
}

// RefundUnit 是可以单独退款的一笔收款：一笔现金、微信或支付宝付款，或会员结账那一笔（储值与随会员结账一起收的
// 线下补付，退款时按原付款比例一起退）。免单不是收到的钱，不算。
type RefundUnit struct {
	// PaymentIDs 是这一笔包含的付款记录，按付款先后；会员结账那一笔可能有两条（储值、线下补付）。第一条的编号就是这一笔的编号。
	PaymentIDs []string
	Member     bool
	// AmountCents 是这一笔收到的钱，RefundedCents 是已经退掉的。
	AmountCents   int64
	RefundedCents int64
}

// ID 是这一笔的编号：它的第一条付款记录。
func (u RefundUnit) ID() string { return u.PaymentIDs[0] }

// RefundableCents 是这一笔还能退多少。
func (u RefundUnit) RefundableCents() int64 { return max(0, u.AmountCents-u.RefundedCents) }

// Has 报告这一笔包不包含这条付款记录。
func (u RefundUnit) Has(paymentID string) bool { return slices.Contains(u.PaymentIDs, paymentID) }

// RefundUnits 把订单收到的钱分成可以单独退款的几笔，并把已有的退款记到各笔上。memberCheckout 表示这一单经会员结账收的款。
//
// 会员结账那一笔：付款记录里标了 member 的几条；一条都没标的是会员结账一次收齐的单（以前的单都是这样），全部付款都算它。
// 其余每条现金、微信、支付宝付款各是一笔。退款记了 paymentId 的记到那一笔上；没记的（一笔收齐的单、以前的退款、
// 滚动发布时旧版本登记的）按付款先后依次抵扣各笔还能退的钱。
func RefundUnits(order domain.Order, memberCheckout bool) []RefundUnit {
	flagged := false
	for _, p := range order.Payments {
		flagged = flagged || p.Member
	}
	var units []RefundUnit
	memberAt := -1
	for _, p := range order.Payments {
		if p.Method == domain.PaymentComp {
			continue
		}
		if memberCheckout && (p.Member || !flagged) {
			if memberAt < 0 {
				memberAt = len(units)
				units = append(units, RefundUnit{Member: true})
			}
			units[memberAt].PaymentIDs = append(units[memberAt].PaymentIDs, p.ID)
			units[memberAt].AmountCents += p.AmountCents
			continue
		}
		units = append(units, RefundUnit{PaymentIDs: []string{p.ID}, AmountCents: p.AmountCents})
	}
	var unattributed int64
	for _, r := range order.Refunds {
		at := -1
		if r.PaymentID != "" {
			at = slices.IndexFunc(units, func(u RefundUnit) bool { return u.Has(r.PaymentID) })
		}
		if at < 0 {
			unattributed += r.AmountCents
			continue
		}
		units[at].RefundedCents += r.AmountCents
	}
	for i := range units {
		take := min(unattributed, units[i].RefundableCents())
		units[i].RefundedCents += take
		unattributed -= take
	}
	return units
}

var (
	// ErrChoosePayment：分几笔收的单退款要说清退哪一笔。
	ErrChoosePayment = errors.New("这一单分几笔收的款，请选择退哪一笔")
	// ErrUnknownPayment：选的付款不是这一单收到的钱。
	ErrUnknownPayment = errors.New("这一单没有这笔付款，请刷新后重新选择")
	// ErrMemberPayment：会员结账那一笔要走会员退款（按原付款比例退回储值、积分与线下）。
	ErrMemberPayment = errors.New("会员结账那一笔要按原付款比例退回储值和积分，请用会员退款办理")
	// ErrCompPayment：免单那一笔没有收到钱。
	ErrCompPayment = errors.New("免单那一笔没有收到钱，不能退款")
)

// RefundTarget 找出普通退款要退的那一笔：paymentID 是员工选的付款；没选时只有一笔可退才认它，分几笔收的单要选。
func RefundTarget(units []RefundUnit, order domain.Order, paymentID string) (RefundUnit, error) {
	if paymentID != "" {
		for _, p := range order.Payments {
			if p.ID == paymentID && p.Method == domain.PaymentComp {
				return RefundUnit{}, ErrCompPayment
			}
		}
		at := slices.IndexFunc(units, func(u RefundUnit) bool { return u.Has(paymentID) })
		if at < 0 {
			return RefundUnit{}, ErrUnknownPayment
		}
		if units[at].Member {
			return RefundUnit{}, ErrMemberPayment
		}
		return units[at], nil
	}
	switch {
	case len(units) == 0:
		return RefundUnit{}, ErrCompPayment
	case len(units) > 1:
		return RefundUnit{}, ErrChoosePayment
	case units[0].Member:
		return RefundUnit{}, ErrMemberPayment
	}
	return units[0], nil
}

// PaymentComp 是免单的结清记录（见 domain.PaymentComp）。
const PaymentComp = domain.PaymentComp

// Comped 报告这一单有没有免单结清。
func Comped(order domain.Order) bool {
	for _, p := range order.Payments {
		if p.Method == domain.PaymentComp {
			return true
		}
	}
	return false
}

// CompCents 是这一单免单免掉的金额（没有免单为 0）。
func CompCents(order domain.Order) int64 {
	var total int64
	for _, p := range order.Payments {
		if p.Method == domain.PaymentComp {
			total += p.AmountCents
		}
	}
	return total
}

// MaxLineQuantity 是一行明细的数量上限。数量列是 integer，超出范围要到落库才失败，
// 店员只会看到「数据没能保存，请重试」，重试也没用。
const MaxLineQuantity = 9999

func Reprice(order *domain.Order) error {
	var total int64
	for _, line := range order.Lines {
		if line.Quantity < 1 || line.Quantity > MaxLineQuantity || line.UnitPriceCents < 0 || line.UnitPriceCents > (math.MaxInt64-total)/int64(line.Quantity) {
			return errors.New("订单数量或金额无效")
		}
		total += int64(line.Quantity) * line.UnitPriceCents
	}
	for _, discount := range order.Discounts {
		if discount.Kind == "fixed" {
			if discount.AmountCents >= total {
				total = 0
			} else {
				total -= discount.AmountCents
			}
		} else {
			rate := discount.RateBasisPoints
			total -= total/10000*rate + (total%10000)*rate/10000
		}
	}
	order.ReceivableCents = total
	return nil
}

// MaxCashChangeCents 是现金找零的上限（¥1,000.00）：实收现金最多比本次收款金额多这么多。
// 门店的单子多在几十到几百元，找零超过它多半是多打了一个 0 或把元当成了分，进门就拒，让员工核对。
const MaxCashChangeCents int64 = 100_000

// ErrCashTender 标出实收现金填得不对（请求本身的问题，回 400）。
type ErrCashTender struct{ msg string }

func (e ErrCashTender) Error() string { return e.msg }

// CashTender 核对一笔线下收款附带的实收现金，并把实收与找零记到付款记录上。received 为空表示没填：
// 什么都不记（实收现金是选填的）。只有现金能填；实收不能少于本次收款金额，找零不超过 MaxCashChangeCents。
// 找零 = 实收 − 收款金额，由这里算好记下，前端只显示。
func CashTender(p *domain.Payment, received *int64) error {
	if received == nil {
		return nil
	}
	if p.Method != "cash" {
		return ErrCashTender{"只有现金收款可以填实收现金"}
	}
	if *received < p.AmountCents {
		return ErrCashTender{"实收现金不能少于本次收款金额"}
	}
	change := *received - p.AmountCents
	if change > MaxCashChangeCents {
		return ErrCashTender{"找零不能超过 ¥1,000.00，请核对实收现金"}
	}
	cash := *received
	p.CashReceivedCents, p.ChangeCents = &cash, &change
	return nil
}
