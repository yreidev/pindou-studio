package domain

import (
	"fmt"
	"time"
)

// 会话计价：一次计时按业主 2026-10-06 定的收费政策该收哪几行、各多少钱。
//
// 这里只做「按已发布的价查表、按时长数块」，所有价都来自老板发布的规则（套餐、续时方案、自由计时价、陪客费）；
// 对不上任何已发布的价时照旧留 0 元占位行，把时长写进名字让员工填价，**不按分钟折算**——那等于替老板定价。
//
//   - 定时套餐：按约定时长（含已续的）对上套餐，带套餐行和续时行。到点后还在用的，套餐的超时处理是
//     「按续时方案自动加收」（renewal）时，超出不超过宽限（GraceMinutes，默认 10 分钟）不收；超过宽限就从套餐
//     结束那一刻起按续时方案分块加收，不足一块按一块。超时处理是 free（不加钱）、manual（提示员工）的不自动加。
//   - 自由计时：发布了自由计时价（每 30 分钟 ¥X）就按实际使用时长分块，不足一块按一块；没发布照旧 0 元占位。
//   - 陪客：不计时，发布了陪客费就收这个固定价，没发布照旧 0 元一行。
//
// 使用时长由调用方按会话算好（UsedSeconds）：暂停的时间照现有规则不计（整桌会话全部不计，按座会话只有
// 套餐允许的累计暂停上限内不计），停止计时后按停止那一刻算（计价随之冻结）。
// 边界按整分钟算（2026-10-06 业主定）：使用时长、超时时长先向下取整到整分钟，不足一分钟的零头不算，再和宽限、
// 块长比。宽限 10 分钟时超时 10 分 59 秒仍不收、11 分 0 秒收 1 块；一块 30 分钟时 30 分 59 秒算 1 块、31 分 0 秒算 2 块。
// 说明里写的也是这个整分钟数，和收的块数对得上。

// 超时处理（套餐规则的 overtime）。
const (
	OvertimeFree    = "free"    // 超时不加钱
	OvertimeManual  = "manual"  // 超时提示员工处理，不自动加钱
	OvertimeRenewal = "renewal" // 按续时方案自动加收
)

// 计价方式（Charge.Kind）。
const (
	ChargePackage   = "package"   // 按套餐（含续时与超时加收）
	ChargeFree      = "free"      // 自由计时按时长分块
	ChargeCompanion = "companion" // 陪客收固定陪客费
	ChargeUnpriced  = "unpriced"  // 对不上已发布的价：0 元占位，结账时由员工填价
)

// Package 是计价用的计时套餐：整桌会话用开台时记下的价表里的套餐，按座会话用入座申请时记下的套餐快照。
// JSON 键是整桌会话 state 里开台价表（Session.Tariff）的存储格式，改名会让已开的台读不出原来的价。
type Package struct {
	Name            string `json:"name"`
	DurationMinutes int    `json:"durationMinutes"`
	AmountCents     int64  `json:"amountCents"`
	RenewalMinutes  int    `json:"renewalMinutes,omitempty"`
	RenewalCents    int64  `json:"renewalCents,omitempty"`
	Overtime        string `json:"overtime,omitempty"`
	GraceMinutes    int    `json:"graceMinutes,omitempty"`
}

// FreeRate 是自由计时价：每 BlockMinutes 分钟 BlockCents，不足一块按一块。
type FreeRate struct {
	Name         string `json:"name"`
	BlockMinutes int    `json:"blockMinutes"`
	BlockCents   int64  `json:"blockCents"`
}

// CompanionFee 是陪客费：陪客会话不计时，收这一个固定价。
type CompanionFee struct {
	Name        string `json:"name"`
	AmountCents int64  `json:"amountCents"`
}

// Tariff 是整桌会话计价用的全部价：开台那一刻已发布的套餐（含续时方案、超时处理与宽限）、自由计时价、陪客费。
// 没发布的项为空。
type Tariff struct {
	Packages  []Package     `json:"packages,omitempty"`
	Free      *FreeRate     `json:"free,omitempty"`
	Companion *CompanionFee `json:"companion,omitempty"`
}

// Usage 是一次计时到计价时刻为止的用量。
type Usage struct {
	Companion       bool
	Free            bool
	DurationMinutes int   // 定时的约定时长，含已续的
	UsedSeconds     int64 // 实际使用的秒数，不计的暂停已扣掉
}

// ChargeLine 是一行计时明细。
type ChargeLine struct {
	Name           string
	Quantity       int
	UnitPriceCents int64
}

// Charge 是一次计时该收的明细，和给员工看的说明。
type Charge struct {
	Kind  string
	Lines []ChargeLine
	// UsedSeconds 是计价按的使用时长（陪客为 0）。
	UsedSeconds int64
	// OvertimeSeconds 是定时超出约定时长的秒数（没超时为 0）。
	OvertimeSeconds int64
	// GraceMinutes 是按续时方案加收时的宽限（只有超时处理为 renewal 的套餐才有）。
	GraceMinutes int
	// BlockMinutes、BlockCents、Blocks：超时加收（按续时方案）或自由计时的块长、每块价与收的块数；不按块收时为 0。
	BlockMinutes int
	BlockCents   int64
	Blocks       int
	// Summary 是写给员工看的一句话，两端原样显示，如「超时 25 分钟（宽限 10 分钟），按续时 30 分钟 ¥15.00 加收 1 块」。
	Summary string
}

// Priced 报告这次计时的明细是不是都有价（没有 0 元占位行）。
func (c Charge) Priced() bool {
	if len(c.Lines) == 0 {
		return false
	}
	for _, l := range c.Lines {
		if l.UnitPriceCents <= 0 {
			return false
		}
	}
	return true
}

// TotalCents 是明细合计。
func (c Charge) TotalCents() int64 {
	var total int64
	for _, l := range c.Lines {
		total += l.UnitPriceCents * int64(l.Quantity)
	}
	return total
}

// OvertimeBlocks 是超时 overtimeSeconds 秒、宽限 graceMinutes 分钟、每块 blockMinutes 分钟时要加收几块。
// 超时先按整分钟算（不足一分钟的零头不算）：不超过宽限（含正好等于）不收；超过宽限就从套餐结束那一刻起整段分块，
// 不足一块按一块。
func OvertimeBlocks(overtimeSeconds int64, graceMinutes, blockMinutes int) int {
	over := wholeMinutes(overtimeSeconds)
	if over <= int64(graceMinutes) || blockMinutes <= 0 {
		return 0
	}
	return int(ceilDiv(over, int64(blockMinutes)))
}

// FreeBlocks 是自由计时用了 usedSeconds 秒、每块 blockMinutes 分钟时收几块。使用时长先按整分钟算（不足一分钟的
// 零头不算），不足一块按一块，开台即算第一块。
func FreeBlocks(usedSeconds int64, blockMinutes int) int {
	if blockMinutes <= 0 {
		return 0
	}
	return int(max(1, ceilDiv(wholeMinutes(usedSeconds), int64(blockMinutes))))
}

// WholeTableCharge 是整桌会话（员工从桌位开的台）按已发布价该收的明细。
func WholeTableCharge(u Usage, t Tariff) Charge {
	used := max(int64(0), u.UsedSeconds)
	switch {
	case u.Companion:
		if t.Companion != nil {
			return Charge{Kind: ChargeCompanion, Lines: []ChargeLine{{Name: t.Companion.Name, Quantity: 1, UnitPriceCents: t.Companion.AmountCents}},
				Summary: fmt.Sprintf("陪客不计时，陪客费 %s", yuan(t.Companion.AmountCents))}
		}
		return Charge{Kind: ChargeCompanion, Lines: []ChargeLine{{Name: "陪客", Quantity: 1, UnitPriceCents: 0}},
			Summary: "陪客不计时；没有发布陪客费，按 0 元"}
	case u.Free:
		if t.Free != nil && t.Free.BlockMinutes > 0 {
			blocks := FreeBlocks(used, t.Free.BlockMinutes)
			return Charge{Kind: ChargeFree, UsedSeconds: used, BlockMinutes: t.Free.BlockMinutes, BlockCents: t.Free.BlockCents, Blocks: blocks,
				Lines:   []ChargeLine{{Name: fmt.Sprintf("%s · 每 %d 分钟", t.Free.Name, t.Free.BlockMinutes), Quantity: blocks, UnitPriceCents: t.Free.BlockCents}},
				Summary: fmt.Sprintf("已用 %d 分钟（不含暂停），每 %d 分钟 %s，计 %d 块", wholeMinutes(used), t.Free.BlockMinutes, yuan(t.Free.BlockCents), blocks)}
		}
		// 没发布自由计时价：和以前一样留 0 元占位，名字写已用的整分钟（不足 1 分钟的零头不写）
		return Charge{Kind: ChargeUnpriced, UsedSeconds: used,
			Lines:   []ChargeLine{{Name: fmt.Sprintf("自由计时 · 已用 %d 分钟", wholeMinutes(used)), Quantity: 1, UnitPriceCents: 0}},
			Summary: fmt.Sprintf("已用 %d 分钟（不含暂停）；没有发布自由计时价，结账时填价", wholeMinutes(used))}
	}
	minutes := u.DurationMinutes
	if pkg, ok := packageFor(t.Packages, minutes); ok {
		return withOvertime(Charge{Kind: ChargePackage, UsedSeconds: used, Lines: []ChargeLine{{Name: pkg.Name, Quantity: 1, UnitPriceCents: pkg.AmountCents}}}, pkg, minutes, used)
	}
	if pkg, times, ok := renewalPackageFor(t.Packages, minutes); ok {
		return withOvertime(Charge{Kind: ChargePackage, UsedSeconds: used, Lines: []ChargeLine{
			{Name: pkg.Name, Quantity: 1, UnitPriceCents: pkg.AmountCents},
			{Name: pkg.Name + " · 续时", Quantity: times, UnitPriceCents: pkg.RenewalCents},
		}}, pkg, minutes, used)
	}
	return Charge{Kind: ChargeUnpriced, UsedSeconds: used, OvertimeSeconds: max(0, used-int64(minutes)*60),
		Lines:   []ChargeLine{{Name: fmt.Sprintf("计时 %d 分钟", minutes), Quantity: 1, UnitPriceCents: 0}},
		Summary: fmt.Sprintf("计时 %d 分钟对不上已发布的套餐，结账时填价", minutes)}
}

// SeatCharge 是按座会话（扫码入座、到店开台）按入座时的套餐快照该收的明细：套餐一行，每续一次一行
// （和续时时追加的明细一样），超时按快照里的超时处理。
func SeatCharge(u Usage, pkg Package) Charge {
	used := max(int64(0), u.UsedSeconds)
	lines := []ChargeLine{{Name: pkg.Name, Quantity: 1, UnitPriceCents: pkg.AmountCents}}
	if pkg.RenewalMinutes > 0 && u.DurationMinutes > pkg.DurationMinutes {
		for range (u.DurationMinutes - pkg.DurationMinutes) / pkg.RenewalMinutes {
			lines = append(lines, ChargeLine{Name: pkg.Name + " · 续时", Quantity: 1, UnitPriceCents: pkg.RenewalCents})
		}
	}
	return withOvertime(Charge{Kind: ChargePackage, UsedSeconds: used, Lines: lines}, pkg, u.DurationMinutes, used)
}

// withOvertime 按套餐的超时处理补上超时加收的一行和说明。minutes 是约定时长（含已续的）。
// 超时不足一分钟按没超时算（边界按整分钟）。
func withOvertime(c Charge, pkg Package, minutes int, used int64) Charge {
	over := max(0, used-int64(minutes)*60)
	c.OvertimeSeconds = over
	if wholeMinutes(over) == 0 {
		c.Summary = fmt.Sprintf("已用 %d 分钟（不含暂停），约定 %d 分钟，未超时", wholeMinutes(used), minutes)
		if pkg.Overtime == OvertimeRenewal {
			c.GraceMinutes = pkg.GraceMinutes
		}
		return c
	}
	switch pkg.Overtime {
	case OvertimeRenewal:
		c.GraceMinutes = pkg.GraceMinutes
		blocks := OvertimeBlocks(over, pkg.GraceMinutes, pkg.RenewalMinutes)
		if blocks == 0 {
			c.Summary = fmt.Sprintf("超时 %d 分钟，在宽限 %d 分钟内，不加收", wholeMinutes(over), pkg.GraceMinutes)
			return c
		}
		c.BlockMinutes, c.BlockCents, c.Blocks = pkg.RenewalMinutes, pkg.RenewalCents, blocks
		c.Lines = append(c.Lines, ChargeLine{Name: pkg.Name + " · 超时加收", Quantity: blocks, UnitPriceCents: pkg.RenewalCents})
		c.Summary = fmt.Sprintf("超时 %d 分钟（宽限 %d 分钟），按续时 %d 分钟 %s 加收 %d 块", wholeMinutes(over), pkg.GraceMinutes, pkg.RenewalMinutes, yuan(pkg.RenewalCents), blocks)
	case OvertimeManual:
		c.Summary = fmt.Sprintf("超时 %d 分钟；这个套餐超时由员工处理，不自动加收", wholeMinutes(over))
	default:
		c.Summary = fmt.Sprintf("超时 %d 分钟；这个套餐超时不加收", wholeMinutes(over))
	}
	return c
}

// packageFor 找时长正好等于 minutes 的套餐。同一时长命中多个时取最便宜的（对顾客有利，结果确定），
// 价相同取先列出的（调用方按规则编号排好）。
func packageFor(packages []Package, minutes int) (Package, bool) {
	var best Package
	found := false
	for _, p := range packages {
		if p.DurationMinutes != minutes || minutes <= 0 {
			continue
		}
		if !found || p.AmountCents < best.AmountCents {
			best, found = p, true
		}
	}
	return best, found
}

// RenewalPlan 是整桌定时会话约定 minutes 分钟（含已续的）时按价表 t 续时用的套餐：先找时长正好相等、有续时方案的
// 套餐，再找「套餐 + k 次续时」对得上的（同 WholeTableCharge 查表的顺序）。按它续整块（续时分钟的整数倍）后，
// 时长仍对得上套餐加续时、照样有价。对不上、套餐都没有续时方案时 ok 为 false：员工只能自己填分钟，结账时填价。
func RenewalPlan(t Tariff, minutes int) (Package, bool) {
	if pkg, ok := packageFor(t.Packages, minutes); ok && pkg.RenewalMinutes > 0 {
		return pkg, true
	}
	pkg, _, ok := renewalPackageFor(t.Packages, minutes)
	return pkg, ok
}

// renewalPackageFor 找「套餐时长 + k 次续时」正好等于 minutes 的套餐：开 90 分钟而只发布了 60 分钟套餐
// （续时 30 分钟）时，是套餐一行加续时一行，不是 0 元占位。多个都对得上时取合计最便宜的。
func renewalPackageFor(packages []Package, minutes int) (Package, int, bool) {
	var best Package
	bestTimes, found := 0, false
	for _, p := range packages {
		if p.RenewalMinutes <= 0 || p.DurationMinutes <= 0 || minutes <= p.DurationMinutes {
			continue
		}
		extra := minutes - p.DurationMinutes
		if extra%p.RenewalMinutes != 0 {
			continue
		}
		times := extra / p.RenewalMinutes
		total := p.AmountCents + int64(times)*p.RenewalCents
		bestTotal := best.AmountCents + int64(bestTimes)*best.RenewalCents
		if !found || total < bestTotal {
			best, bestTimes, found = p, times, true
		}
	}
	return best, bestTimes, found
}

// UsedSeconds 是到 at 为止计时用掉的秒数：扣掉已完成的暂停（PausedSeconds）和正在进行的这次暂停。
// pauseAllowance 不小于 0 时，正在进行的暂停最多再扣这么多秒（按座会话：套餐允许的累计暂停上限还剩多少）；
// 小于 0 表示不限（整桌会话的暂停全部不计）。时钟倒退时不扣成负数。
func (s Session) UsedSeconds(at time.Time, pauseAllowance int64) int64 {
	pause := s.PausedSeconds
	if s.Status == "paused" && s.PausedAt != nil && at.After(*s.PausedAt) {
		current := int64(at.Sub(*s.PausedAt) / time.Second)
		if pauseAllowance >= 0 {
			current = min(current, pauseAllowance)
		}
		pause += current
	}
	return max(0, int64(at.Sub(s.StartedAt)/time.Second)-pause)
}

func ceilDiv(a, b int64) int64 {
	if a <= 0 {
		return 0
	}
	return (a + b - 1) / b
}

// wholeMinutes 是秒数换成整分钟、不足一分钟的零头不算（边界按整分钟：计价和说明里的分钟数都用它）。
func wholeMinutes(seconds int64) int64 { return max(0, seconds) / 60 }

func yuan(cents int64) string { return fmt.Sprintf("¥%d.%02d", cents/100, cents%100) }
