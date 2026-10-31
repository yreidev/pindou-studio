package app

import (
	"time"

	memberapp "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/membership/application"
	ordersapp "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/orders/application"
	ordersdomain "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/orders/domain"
	tablesdomain "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/tables/domain"
)

type Role string

const (
	Clerk   Role = "clerk"
	Manager Role = "manager"
	Owner   Role = "owner"
)

// User 是账户。退役的网页密码登录在旧账户 state 里留下的 loginName 等键，在账户下次被改写时自然去掉
// （对应的凭证列已由迁移 016 删掉）。
type User struct {
	ID                      string         `json:"id"`
	Nickname                string         `json:"nickname"`
	AvatarDataURL           string         `json:"avatarDataUrl,omitempty"`
	Phone                   string         `json:"-"`
	PhoneMasked             string         `json:"phoneMasked,omitempty"`
	PhoneVerificationStatus string         `json:"phoneVerificationStatus"`
	Roles                   []Role         `json:"roles"`
	DeveloperMode           string         `json:"developerMode,omitempty"`
	PrivacyContractVersion  string         `json:"-"`
	PrivacyAcceptedAt       time.Time      `json:"-"`
	CreatedAt               time.Time      `json:"-"`
	MemberOpening           *memberOpening `json:"memberOpening,omitempty"`
}

type memberOpening struct {
	ActorID   string    `json:"actorId"`
	CreatedAt time.Time `json:"createdAt"`
}

type authSession struct {
	UserID        string
	ExpiresAt     time.Time
	DeveloperMode string
	// Client 是 clientMiniapp 或 clientWeb；空值视为小程序（迁移 010 之前的会话）。
	Client string
}

const (
	clientMiniapp = "miniapp"
	clientWeb     = "web"
	// retiredClientH5 是已下线的顾客网页的会话（手机号 + 密码登录，2026-10-31 下线）：库里剩下的一律当无效，
	// 见 txn.authSession。下一次发后端用迁移删掉它们、收紧 client 的检查约束后去掉（docs/plan-split-release.md）。
	retiredClientH5 = "h5"
)

type roleAssignment struct {
	ID, UserID string
	Role       Role
	AssignedAt time.Time
}

// FloorArea 是平面图上的一个分区。名字由布局决定，不可改。
//
// ★ 原本还有 GridColumns / GridRows / Locked：员工端「布局管理」用网格摆桌、
//
//	用锁定防止误改。布局固定之后这三样没有意义了 —— 桌的位置是平面图上的热区，
//	不是格子。数据库列留着（历史行仍带着它们），结构体不再读写。
type FloorArea struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type Table struct {
	ID, AreaID string
	// Code 是布局里的稳定编码（区域字母 + 区内桌号，如 A1）。数据库主键是 UUID，
	// 建库时才生成，跨部署对不上；Code 才是「图上那个位置」的稳定身份。
	// reconcileLayout 按它把库里的桌和 layout/store-layout.json 对齐。
	Code              string
	Number, SeatCount int
	Enabled           bool
	// WholeTable 表示这张桌只能被一组客人整张拿走，桌上其余座号不再单独出售。
	//
	// ★★ 为什么需要它（2026-09-19）：顾客端平面图上「一个位置 = 一个可约单位」。
	//   A 区的双人位是一张有 2 个物理座的桌，顾客点图上那个位置就是把整张桌包下来。
	//   但座位占用一直是**按座号**判的（seatAvailable / Reservation.Blocks），
	//   所以顾客订走 1 号座之后，2 号座在后端仍然是空的 —— 扫码入座页会把它列给
	//   下一个进店的人，两拨互不相识的客人被拼到同一张桌上。
	//   顾客端为了躲开这个洞，一直要求「每桌恰好 1 座」，结果是店里真按双人桌建了
	//   2 座之后整张平面图直接不可用，而员工端的「按平面图同步」只会把座位数改大、
	//   不会改小，连修复按钮都不显示，门店就永久卡在那里。
	//   与其让顾客端用「1 座」假装双人桌只有一个座，不如让后端真的懂「整桌单位」。
	WholeTable bool
}

type TableSession = tablesdomain.Session

type OrderLine = ordersdomain.Line

type Discount = ordersdomain.Discount

type Payment = ordersdomain.Payment

type Refund = ordersdomain.Refund

type Order = ordersdomain.Order

// orderResponse 在订单之外附带服务端算好的展示值。附加字段不在 Order 里，
// 不进入版本摘要，也不落库。
type orderResponse struct {
	Order
	Version    string `json:"version"`
	Refunded   int64  `json:"refundedCents"`
	Refundable int64  `json:"refundableCents"`
	// Outstanding 是还差多少没收（应收 − 已收 − 免单）：待结账的就是应收，部分付款是收齐还差的数，其余为 0。
	Outstanding int64 `json:"outstandingCents"`
	// Payments 盖住 Order 里的付款：每笔另带会员结账标记和这笔已退、还能退多少（只供展示，见 paymentView）。
	Payments []paymentView `json:"payments,omitempty"`
	// Settlement 说明本单怎么收的款、退款走哪条路：member 是会员结账（会员流水里有指向本单的
	// checkout），用 /loyalty/actions 的 refund 按原付款比例退（可分多次）；standard 是其余订单
	// （普通收款、还没收款或已撤销），退款走 /sales-orders/{id}/refunds。
	Settlement string `json:"settlement"`
	// MemberCheckout 只有会员结账单才有：本单结账时动过的会员资产与线下补付（退款按它们的比例拆）。
	MemberCheckout *memberCheckoutView `json:"memberCheckout,omitempty"`
	// Customer 是关联顾客的称呼，散客单为 null。只供展示，不进入 version。
	Customer *accountLabel `json:"customer"`
	// CompCents 是免单免掉的金额，只有免单结清的订单才有。
	CompCents int64 `json:"compCents,omitempty"`
	// Timing 只有计时会话的草稿才有：系统此刻按计时算的计时费和说明（超时加收几块、自由计时几块、陪客费），
	// 以及草稿开头的计时明细是不是就是它（员工改过就不是，结账时核对）。
	Timing *timingView `json:"timing,omitempty"`
}

const (
	settlementStandard = "standard"
	settlementMember   = "member"
	// settlementComp 是免单结清：没有收钱，没有可退的。
	settlementComp = "comp"
)

// paymentView 是订单响应里的一笔付款：付款记录原样，加上服务端算好的展示值（不进入 version、不落库）。
type paymentView struct {
	Payment
	// RefundedCents、RefundableCents 是这笔已退、还能退多少：只在已付款（含部分退款）、已退款订单的现金、微信、支付宝付款上，
	// 不含会员结账那一笔（它按原付款比例一起退，见 memberCheckout.refundableCents），免单没有。
	RefundedCents   *int64 `json:"refundedCents,omitempty"`
	RefundableCents *int64 `json:"refundableCents,omitempty"`
}

type memberCheckoutView struct {
	memberapp.CheckoutSummary
	// OfflineCents 是随会员结账收的现金、微信、支付宝线下补付：系统只登记退款，钱由员工按原渠道退还。
	// 分笔付款时别人后来分笔付的不算在内（那几笔各退各的）。
	OfflineCents int64 `json:"offlineCents"`
	// RefundableCents 是会员结账那一笔还能退多少（会员退款的上限）。一次收齐的单就是订单的 refundableCents。
	RefundableCents int64 `json:"refundableCents"`
	// Refunded 是此前各次退款累计退回、收回的数，退过款才有。
	// RefundBlocked 非空表示现在退不了剩余全部（本单送的积分已被用掉），页面提前说明，并给出现在最多能退多少。
	// 这两项要扫这位顾客的全部流水，只在单张订单的响应里带（RefundBlocked 只在还没退完时核对），列表不带。
	Refunded      *memberapp.RefundPart `json:"refunded,omitempty"`
	RefundBlocked *memberRefundBlocked  `json:"refundBlocked,omitempty"`
	// BalanceAfter 是这位顾客在本单结账记完账那一刻的余额与可用积分（小票印「本单结账后余额」），
	// 由不可改写的会员流水推出、不另存；之后的充值、消费、退款都不改变它。只在单张订单的响应里带（要读这位顾客的全部流水）。
	BalanceAfter *memberBalanceAfter `json:"balanceAfter,omitempty"`
}

type memberBalanceAfter struct {
	PrincipalCents int64 `json:"principalCents"`
	GiftCents      int64 `json:"giftCents"`
	Points         int64 `json:"points"`
}

type memberRefundBlocked struct {
	Reason string `json:"reason"`
	// PointsShort 是这次按比例该收回的本单所送积分里，已被用掉、收不回的分数。
	PointsShort int64 `json:"pointsShort"`
	// SpentBy 是用掉这些积分的流水；先退掉其中的会员结账单，积分会回到本单的批次。
	SpentBy []memberapp.PointSpend `json:"spentBy"`
	// MaxRefundableCents 是现在收得回积分、能退的最大金额（0 表示一分也退不了）。
	MaxRefundableCents int64 `json:"maxRefundableCents"`
}

// orderViews 返回把订单变成响应的函数。orders 是要展示的订单：会员结账的汇总一次查出来，列表逐单调用不再重复查。
func (s *Server) orderViews(q *txn, orders ...*Order) func(Order) orderResponse {
	ids := make([]string, 0, len(orders))
	for _, o := range orders {
		ids = append(ids, o.ID)
	}
	checkouts := q.checkouts(ids)
	customers := make([]string, 0, len(orders))
	for _, o := range orders {
		customers = append(customers, o.UserID)
	}
	labels := q.accountLabels(customers)
	return func(o Order) orderResponse {
		v := orderResponse{Order: o, Version: o.Version(), Refunded: ordersapp.RefundedCents(o), Refundable: ordersapp.RefundableCents(o), Settlement: settlementStandard,
			Customer: labelOf(labels, o.UserID), Outstanding: ordersapp.OutstandingCents(o)}
		c, member := checkouts[o.ID]
		units := ordersapp.RefundUnits(o, member)
		v.Payments = paymentViews(o, units)
		if member {
			m := &memberCheckoutView{CheckoutSummary: c}
			for _, u := range units {
				if !u.Member {
					continue
				}
				m.RefundableCents = min(u.RefundableCents(), v.Refundable)
				for _, p := range o.Payments {
					if u.Has(p.ID) && p.Method != "balance" {
						m.OfflineCents += p.AmountCents
					}
				}
			}
			v.Settlement, v.MemberCheckout = settlementMember, m
		}
		if ordersapp.Comped(o) {
			v.CompCents = ordersapp.CompCents(o)
			// 整单免单（一分钱没收）才算免单结清；分笔付款收了一部分、剩下免单的照旧按收款的路子退（免单那部分不能退）
			if o.PaidCents == 0 {
				v.Settlement = settlementComp
			}
		}
		v.Timing = s.draftTiming(q, o)
		return v
	}
}

// paymentViews 是订单响应里的付款：会员结账那一笔里的标上 member，已付款订单的现金、微信、支付宝付款带上已退、还能退多少。
func paymentViews(o Order, units []ordersapp.RefundUnit) []paymentView {
	if len(o.Payments) == 0 {
		return nil
	}
	refundable := o.Status == ordersdomain.StatusPaid || o.Status == ordersdomain.StatusRefunded
	out := make([]paymentView, 0, len(o.Payments))
	for _, p := range o.Payments {
		view := paymentView{Payment: p}
		for _, u := range units {
			if !u.Has(p.ID) {
				continue
			}
			if u.Member {
				view.Member = true
			} else if refundable {
				refunded, left := u.RefundedCents, u.RefundableCents()
				view.RefundedCents, view.RefundableCents = &refunded, &left
			}
		}
		out = append(out, view)
	}
	return out
}

// orderView 是单张订单的响应，会员结账单另外补上退款情况（见 memberCheckoutState），并推出结账那一刻的余额。
func (s *Server) orderView(q *txn, o Order) orderResponse {
	v := s.orderViews(q, &o)(o)
	if v.MemberCheckout != nil {
		s.memberCheckoutState(q, o, v.MemberCheckout)
	}
	if v.MemberCheckout != nil && o.UserID != "" {
		if b, ok := q.memberAccount(o.UserID).BalanceAfterCheckout(o.UserID, o.ID); ok {
			v.MemberCheckout.BalanceAfter = &memberBalanceAfter{PrincipalCents: b.PrincipalCents, GiftCents: b.GiftCents, Points: b.Points}
		}
	}
	return v
}

type inventoryItem struct {
	ID, ProductID string
	Quantity      int64
	AlertAt       int64
}

type purchase struct {
	ID, SupplierName, Note string
	Items                  []purchaseItem
	CreatedAt              time.Time
}

type purchaseItem struct {
	ProductID     string `json:"productId"`
	Quantity      int64  `json:"quantity"`
	UnitCostCents int64  `json:"unitCostCents"`
}

type movement struct {
	ID, InventoryItemID, Kind, Reason string
	QuantityDelta                     int64
	CreatedAt                         time.Time
	// ActorID 是办这笔的员工。2026-10 之前的流水没有记。
	// 必须 omitempty：流水整条存在 stock_ledger_entries.state 里且不可改写（immutable_record 触发器），
	// 旧流水每次保存都会按原样重写一遍；多出一个空的 ActorID 键就算改写，整次保存被拒。
	ActorID string `json:",omitempty"`
}

type auditLog struct {
	ID, Action, ObjectID, Reason, RequestID, ActorID string
	CreatedAt                                        time.Time
}

type idemResponse struct {
	Fingerprint string
	Status      int
	ContentType string
	Body        []byte
	CreatedAt   time.Time
	// Replay 非空时 Body 不是原样的响应，重放时按它重新生成（见 replayReservationView）。
	Replay string `json:",omitempty"`
}

// replayReservationView：Body 只记了操作目标，重放时按当前状态重新生成预约视图。
const replayReservationView = "reservation-view"
