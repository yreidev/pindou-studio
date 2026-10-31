package domain

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"time"
)

type Line struct {
	ProductID      string `json:"productId,omitempty"`
	Name           string `json:"name,omitempty"`
	Quantity       int    `json:"quantity"`
	UnitPriceCents int64  `json:"unitPriceCents"`
}
type Discount struct {
	ID              string    `json:"id"`
	Kind            string    `json:"kind"`
	Reason          string    `json:"reason"`
	AmountCents     int64     `json:"amountCents,omitempty"`
	RateBasisPoints int64     `json:"rateBasisPoints,omitempty"`
	CreatedAt       time.Time `json:"createdAt"`
}
type Payment struct {
	ID          string    `json:"id"`
	Method      string    `json:"method"`
	AmountCents int64     `json:"amountCents"`
	CreatedAt   time.Time `json:"createdAt"`
	// 现金收款时员工可选填的实收现金与由此算出的找零（找零 = 实收 − AmountCents），整数分。
	// 没填、或不是现金时都为空、不出现在 JSON 里：已付订单整条存在 state 里、只能追加退款，
	// 总会出现的新键会让旧订单的退款被触发器拒绝（TestPaidOrderShapeIsFrozen）。找零可能是 0，所以用指针。
	CashReceivedCents *int64 `json:"cashReceivedCents,omitempty"`
	ChangeCents       *int64 `json:"changeCents,omitempty"`
	// Reason 只有免单（method 为 comp）才有：店长、老板写的免单原因。omitempty 同上。
	Reason string `json:"reason,omitempty"`
	// Member 标出会员结账那一笔里的付款（储值、随会员结账一起收的线下补付），只在会员结账没把订单收齐、
	// 余下的还要分笔收时才记（分笔付款，2026-10-06 业主定）：会员这一笔退款按原付款比例拆到储值、积分与线下，
	// 别人分笔付的钱各退各的。会员结账一次收齐的单不记，和以前的订单一样（那时全部付款都是会员这一笔）。omitempty 同上。
	Member bool `json:"member,omitempty"`
}

// PaymentComp 是免单：店长、老板把这一单直接结清、不收钱（2026-10-06 业主定）。它是一条结清记录，
// AmountCents 记免掉的金额，不是收到的钱：不计入 PaidCents（实收），也就退不了款；对账时和现金、微信、支付宝分开列。
// 分笔付款收了一部分之后，也可以对剩下没付的免单（金额就是还差的那部分）。
const PaymentComp = "comp"

// 订单状态。draft 待结账（明细、折扣、顾客都能改，计时明细跟着计时走）；partially_paid 部分付款：收了第一笔、
// 还没收齐（2026-10-06 业主定，一单可以分几笔付）。收第一笔时计价与明细就冻结了，之后不再随时间重算、也不能改明细、
// 折扣或顾客，只能继续收下一笔或对剩余免单；收齐（已收 + 免单 = 应收）才是 paid。部分退款后仍是 paid，退完为 refunded；
// voided 是撤销开台时作废的草稿。旧版本只认 draft 才收款、改单，见到 partially_paid 一律当作已结束，不会再整单收一次。
const (
	StatusDraft         = "draft"
	StatusPartiallyPaid = "partially_paid"
	StatusPaid          = "paid"
	StatusRefunded      = "refunded"
	StatusVoided        = "voided"
)

type Refund struct {
	ID          string `json:"id"`
	Reason      string `json:"reason"`
	AmountCents int64  `json:"amountCents"`
	// PaymentID 是这次退的是哪一笔付款（会员结账那一笔记它的第一条付款）。只在订单分几笔收款时才记：
	// 一笔收齐的单不用选，退款记录和以前一样（omitempty，见 TestPaidOrderShapeIsFrozen）。
	// 没记的退款（以前的、或滚动发布时旧版本登记的）按付款先后依次抵扣各笔可退的钱。
	PaymentID string `json:"paymentId,omitempty"`
	// 本次退款实际退回并可再售的商品数量，按商品 ID 记。退的是服务费或拆封后不能再卖的
	// 材料时为空：金额退了不等于货回了，库存只认员工明确点过的件数。
	ReturnedProducts map[string]int64 `json:"returnedProducts,omitempty"`
	CreatedAt        time.Time        `json:"createdAt"`
}
type Order struct {
	ID              string     `json:"id"`
	TableSessionID  string     `json:"venueSessionId,omitempty"`
	UserID          string     `json:"accountId,omitempty"`
	Status          string     `json:"status"`
	ReceivableCents int64      `json:"receivableCents"`
	PaidCents       int64      `json:"paidCents"`
	RefundedCents   int64      `json:"-"`
	Lines           []Line     `json:"lines,omitempty"`
	Discounts       []Discount `json:"discounts,omitempty"`
	Payments        []Payment  `json:"payments,omitempty"`
	Refunds         []Refund   `json:"refunds,omitempty"`
	CreatedAt       time.Time  `json:"createdAt"`
	// AutoLines 是开头几行明细是系统按计时生成、员工没改过的（计时会话的草稿才有）：这几行跟着计时重算
	// （续时、改时长、标记陪客，以及时间流逝带来的超时加收、自由计时的块数）。0 表示员工改过计时行，不再自动改；
	// 没有（nil）是 0.0.18 及更早建的草稿，照旧只在改计时时按建单时刻的生成结果比对。
	// omitempty：没有这个键的旧订单编码不变（已付订单不能多出总会出现的键，见 TestPaidOrderShapeIsFrozen）。
	AutoLines *int `json:"autoLines,omitempty"`
}

// The revision is derived without changing append-only persisted records.
func (o Order) Version() string {
	data, _ := json.Marshal(o)
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}
