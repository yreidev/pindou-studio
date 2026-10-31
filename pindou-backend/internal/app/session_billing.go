package app

import (
	"slices"
	"time"

	member "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/membership/application"
	ordersapp "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/orders/application"
	tables "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/tables/domain"
)

// 桌位会话的计时怎么变成账单上的行（计价规则本身在 tables/domain/charge.go）。
//
// 以前店员从桌位开台建出来的订单是一张白单，要在「自定义服务」里手打计时费；现在建单时按计时自动带上明细。
// ★ 这里只做「查表」，不做「算价」：价都来自老板发布的规则——套餐与续时方案、套餐的超时处理（按续时方案
//   自动加收时的宽限）、自由计时价（每 30 分钟 ¥X）、陪客费。对不上任何已发布的价就留一条 0 价占位行，
//   把时长写在名字里让店员自己填，**不按分钟折算、不按比例推**：那等于替老板定价。
//
// 按哪一版价：按座会话按入座申请时记下的套餐快照；整桌会话按开台那一刻记下的价表（TableSession.Tariff，
// 2026-10-06 起开的台），之后老板改价发布不影响这一台。没有价表的旧整桌会话按此刻生效的规则算。
//
// 草稿跟着计时走：开头那几行系统生成的明细（Order.AutoLines）在续时、改时长、标记陪客时重算（tables.go 的
// followDraft），时间流逝带来的超时加收、自由计时的块数在每次读出草稿时重算（followTime）；停止计时后按停止
// 那一刻算，计价随之冻结（按座会话、整桌会话都能停止计时）。员工改过计时行的草稿不自动改。

// chargeTime 是会话计价按的时刻：停止计时的按停止那一刻（冻结），否则按现在。
func chargeTime(x *TableSession, now time.Time) time.Time {
	if x.StoppedAt != nil {
		return *x.StoppedAt
	}
	return now
}

// packageOf 把套餐规则（已发布的，或入座申请里的快照）换成计价用的套餐。
func packageOf(r member.Rule) tables.Package {
	return tables.Package{Name: r.Name, DurationMinutes: r.DurationMinutes, AmountCents: r.AmountCents, RenewalMinutes: r.RenewalMinutes,
		RenewalCents: r.RenewalCents, Overtime: r.Overtime, GraceMinutes: r.OvertimeGraceMinutes}
}

// tariffOf 是整桌会话计价用的已发布价：全部套餐（按规则编号排好，同价时结果确定）、自由计时价、陪客费。
// 开台时记成这一台的价表（TableSession.Tariff）。
func tariffOf(rules []member.Rule) tables.Tariff {
	var t tables.Tariff
	for _, r := range rules {
		switch r.Kind {
		case "package":
			if r.DurationMinutes > 0 {
				t.Packages = append(t.Packages, packageOf(r))
			}
		case "free_timing":
			if t.Free == nil && r.DurationMinutes > 0 {
				t.Free = &tables.FreeRate{Name: r.Name, BlockMinutes: r.DurationMinutes, BlockCents: r.AmountCents}
			}
		case "companion":
			if t.Companion == nil {
				t.Companion = &tables.CompanionFee{Name: r.Name, AmountCents: r.AmountCents}
			}
		}
	}
	return t
}

// wholeTableTariff 是整桌会话计价按的价：开台时记下的价表；没有价表的旧会话（2026-10-06 之前的版本开的台，
// 或滚动发布时被旧版本改写过、丢了价表的）按此刻生效的规则算，和以前一样。
func wholeTableTariff(q *txn, x *TableSession) tables.Tariff {
	if x.Tariff != nil {
		return *x.Tariff
	}
	return tariffOf(q.membership().Rules())
}

// wholeTableUsage 是整桌会话到 at 为止的用量：暂停的时间全部不计。
func wholeTableUsage(x *TableSession, at time.Time) tables.Usage {
	return tables.Usage{Companion: x.Status == "companion", Free: x.TimingMode == "free", DurationMinutes: x.DurationMinutes, UsedSeconds: x.UsedSeconds(at, -1)}
}

// sessionLines 是整桌会话按价表 tariff 在 at 时刻（停止计时的按停止那一刻）该带的计时明细。
// 返回 nil 表示会话不存在；其余情况至少一行，哪怕价是 0：账单上有一行 0 元比一张白单诚实。
func sessionLines(x *TableSession, tariff tables.Tariff, at time.Time) []OrderLine {
	if x == nil {
		return nil
	}
	return chargeLines(tables.WholeTableCharge(wholeTableUsage(x, chargeTime(x, at)), tariff))
}

func chargeLines(c tables.Charge) []OrderLine {
	out := make([]OrderLine, 0, len(c.Lines))
	for _, l := range c.Lines {
		out = append(out, OrderLine{Name: l.Name, Quantity: l.Quantity, UnitPriceCents: l.UnitPriceCents})
	}
	return out
}

// sessionCharge 是会话此刻（停止计时的按停止那一刻）该收的计时明细与说明。按座会话按入座申请时的套餐快照算，
// 暂停只有套餐允许的累计上限内不计；整桌会话按开台时记下的价表算（旧会话按现在已发布的价），暂停全部不计。
func (s *Server) sessionCharge(q *txn, x *TableSession) tables.Charge {
	at := chargeTime(x, q.now())
	if x.AdmissionID != "" {
		a, ok := q.admission(x.AdmissionID)
		if !ok {
			// 读不到入座申请（不该发生）：不拿整桌的价去换按座订单的明细，照订单原样
			return tables.Charge{Kind: tables.ChargeUnpriced, Summary: "读不到这次入座的套餐快照，计时费以订单明细为准"}
		}
		allowance := max(int64(0), int64(a.Package.PauseLimitMinutes)*60-x.PausedSeconds)
		return tables.SeatCharge(tables.Usage{DurationMinutes: x.DurationMinutes, UsedSeconds: x.UsedSeconds(at, allowance)}, packageOf(a.Package))
	}
	return tables.WholeTableCharge(wholeTableUsage(x, at), wholeTableTariff(q, x))
}

// autoLines 记下草稿开头 n 行是系统生成的计时明细。
func autoLines(n int) *int { return &n }

// replaceAutoLines 把草稿开头 AutoLines 记着的那几行换成 lines、重算应收；员工加在后面的商品照留。
// 一样的不动（版本不变）；重算失败（金额溢出）或已有的人工折扣会把应收减到 0 时也不动。返回改没改。
func replaceAutoLines(o *Order, lines []OrderLine) bool {
	if o.AutoLines == nil || *o.AutoLines <= 0 || *o.AutoLines > len(o.Lines) || len(lines) == 0 {
		return false
	}
	n := *o.AutoLines
	if slices.Equal(o.Lines[:n], lines) {
		return false
	}
	candidate, ok := withAutoLines(*o, n, lines)
	if ok {
		*o = candidate
	}
	return ok
}

// withAutoLines 是把草稿开头 n 行换成 lines、重算应收后的订单，开头 len(lines) 行记为系统生成。
// 重算失败（金额溢出）或已有的人工折扣会把应收减到 0 时 ok 为 false。
func withAutoLines(o Order, n int, lines []OrderLine) (Order, bool) {
	candidate := o
	candidate.Lines = append(append([]OrderLine(nil), lines...), o.Lines[n:]...)
	candidate.AutoLines = autoLines(len(lines))
	if ordersapp.Reprice(&candidate) != nil || ordersapp.DiscountedToZero(candidate) {
		return o, false
	}
	return candidate, true
}

// followTime 让读出来的草稿跟上时间：超时加收、自由计时的块数随时间变，没有事件通知，所以每次读出草稿时按
// 此刻重算开头那几行系统生成的计时明细（停止计时的按停止那一刻，结果不再变）。只读请求只改这次读到的副本、
// 不落库，显示的金额和版本与此刻收款时会核对的一致；写请求里改了随请求一起保存。
//
// 只动 AutoLines 记着有几行的草稿：员工改过计时行的（0）、0.0.18 及更早建的（没有）都不动。
// 会话已结束（已结账、已撤销）的不动；按此刻对不上已发布的价（0 元占位，等员工填价）的也不动。
func (q *txn) followTime(orders []*Order) []*Order {
	for _, o := range orders {
		if o.Status != "draft" || o.AutoLines == nil || *o.AutoLines <= 0 || o.TableSessionID == "" {
			continue
		}
		x := q.session(o.TableSessionID)
		if x == nil || !liveSession(x) {
			continue
		}
		c := q.s.sessionCharge(q, x)
		if c.Kind == tables.ChargeUnpriced {
			// 0 元占位行等员工填价，自己不随时间变（自由计时的占位名字里写着已用分钟，跟着改反倒让员工保存时撞上版本冲突）
			continue
		}
		replaceAutoLines(o, chargeLines(c))
	}
	return orders
}

// chargeView 是「计时费怎么算的」：后端算好的说明与数字，两端原样显示（桌位视图的 charge、草稿订单的 timing）。
// 不进入 version、不落库。
type chargeView struct {
	Kind            string `json:"kind"`
	Summary         string `json:"summary"`
	UsedSeconds     int64  `json:"usedSeconds"`
	OvertimeSeconds int64  `json:"overtimeSeconds"`
	GraceMinutes    int    `json:"graceMinutes,omitempty"`
	BlockMinutes    int    `json:"blockMinutes,omitempty"`
	BlockCents      int64  `json:"blockCents,omitempty"`
	Blocks          int    `json:"blocks,omitempty"`
	// TotalCents 是系统按计时算出的计时费（没有 0 元占位行时才有）。
	TotalCents *int64 `json:"totalCents,omitempty"`
	// FrozenAt 是停止计时的时刻：计价按它算、不再变。没停止计时的，计价算到收款（或免单）那一刻。
	FrozenAt *time.Time `json:"frozenAt,omitempty"`
}

// timingView 是草稿订单上的计时说明。
type timingView struct {
	chargeView
	// Applied 是这张草稿开头的计时明细是不是就是系统算的这几行：false 时员工改过计时行（或是旧版本建的草稿），
	// 不会自动跟着计时改，结账时请核对。
	Applied bool `json:"applied"`
}

func viewOfCharge(c tables.Charge, x *TableSession) chargeView {
	v := chargeView{Kind: c.Kind, Summary: c.Summary, UsedSeconds: c.UsedSeconds, OvertimeSeconds: c.OvertimeSeconds,
		GraceMinutes: c.GraceMinutes, BlockMinutes: c.BlockMinutes, BlockCents: c.BlockCents, Blocks: c.Blocks, FrozenAt: x.StoppedAt}
	if c.Priced() {
		total := c.TotalCents()
		v.TotalCents = &total
	}
	return v
}

// draftTiming 是一张计时会话草稿的计时说明；不是草稿、没有会话或会话已结束时为 nil。
func (s *Server) draftTiming(q *txn, o Order) *timingView {
	if o.Status != "draft" || o.TableSessionID == "" {
		return nil
	}
	x := q.session(o.TableSessionID)
	if x == nil || !liveSession(x) {
		return nil
	}
	c := s.sessionCharge(q, x)
	lines := chargeLines(c)
	applied := o.AutoLines != nil && *o.AutoLines == len(lines) && len(o.Lines) >= len(lines) && slices.Equal(o.Lines[:len(lines)], lines)
	return &timingView{chargeView: viewOfCharge(c, x), Applied: applied}
}
