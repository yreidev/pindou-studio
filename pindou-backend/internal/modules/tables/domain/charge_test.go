package domain

import (
	"slices"
	"testing"
	"time"
)

// 门店示例价：1 小时 ¥29.90，续时 30 分钟 ¥15.00；自由计时每 30 分钟 ¥10.00；陪客费 ¥20.00。
var (
	hourRenewal = Package{Name: "1小时", DurationMinutes: 60, AmountCents: 2990, RenewalMinutes: 30, RenewalCents: 1500, Overtime: OvertimeRenewal, GraceMinutes: 10}
	hourFree    = Package{Name: "1小时", DurationMinutes: 60, AmountCents: 2990, RenewalMinutes: 30, RenewalCents: 1500, Overtime: OvertimeFree}
	hourManual  = Package{Name: "1小时", DurationMinutes: 60, AmountCents: 2990, RenewalMinutes: 30, RenewalCents: 1500, Overtime: OvertimeManual}
	freeRate    = &FreeRate{Name: "自由计时", BlockMinutes: 30, BlockCents: 1000}
	companion   = &CompanionFee{Name: "陪客", AmountCents: 2000}
)

func minutes(m int) int64 { return int64(m) * 60 }

func TestOvertimeBlocks(t *testing.T) {
	cases := []struct {
		name     string
		overtime int64
		grace    int
		block    int
		want     int
	}{
		{"没超时", 0, 10, 30, 0},
		{"超出不到宽限", minutes(9) + 59, 10, 30, 0},
		{"超出正好 10 分钟整：不收", minutes(10), 10, 30, 0},
		{"超时 10 分 30 秒：零头不算，按 10 分钟，不收", minutes(10) + 30, 10, 30, 0},
		{"超时 10 分 59 秒（差 1 秒满 11 分钟）：不收", minutes(11) - 1, 10, 30, 0},
		{"超时 11 分 0 秒（刚好整分）：从套餐结束起整段算，1 块", minutes(11), 10, 30, 1},
		{"超时 25 分钟：1 块", minutes(25), 10, 30, 1},
		{"超时 30 分钟整：1 块", minutes(30), 10, 30, 1},
		{"超时 30 分 59 秒（差 1 秒满 31 分钟）：1 块", minutes(31) - 1, 10, 30, 1},
		{"超时 31 分 0 秒（刚好整分）：2 块", minutes(31), 10, 30, 2},
		{"跨多块：超时 95 分钟，4 块", minutes(95), 10, 30, 4},
		{"宽限 0：超时 59 秒不足一分钟，不收", 59, 0, 30, 0},
		{"宽限 0：超时满 1 分钟收 1 块", minutes(1), 0, 30, 1},
		{"宽限比一块还长：超时 45 分钟、宽限 40、块 15，按整段 3 块", minutes(45), 40, 15, 3},
		{"续时块长为 0（不会发布成这样）：不收", minutes(60), 10, 0, 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := OvertimeBlocks(c.overtime, c.grace, c.block); got != c.want {
				t.Fatalf("OvertimeBlocks(%d 秒, 宽限 %d, 块 %d) = %d，应为 %d", c.overtime, c.grace, c.block, got, c.want)
			}
		})
	}
}

func TestFreeBlocks(t *testing.T) {
	cases := []struct {
		name string
		used int64
		want int
	}{
		{"刚开台：算第一块", 0, 1},
		{"29 分钟：1 块", minutes(29), 1},
		{"30 分钟整：1 块", minutes(30), 1},
		{"30 分 1 秒：零头不算，1 块", minutes(30) + 1, 1},
		{"30 分 59 秒（差 1 秒满 31 分钟）：1 块", minutes(31) - 1, 1},
		{"31 分 0 秒（刚好整分）：2 块", minutes(31), 2},
		{"90 分钟：3 块", minutes(90), 3},
		{"90 分 59 秒：3 块", minutes(91) - 1, 3},
		{"91 分钟：4 块", minutes(91), 4},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := FreeBlocks(c.used, 30); got != c.want {
				t.Fatalf("FreeBlocks(%d 秒) = %d，应为 %d", c.used, got, c.want)
			}
		})
	}
}

func TestWholeTableCharge(t *testing.T) {
	cases := []struct {
		name    string
		usage   Usage
		tariff  Tariff
		kind    string
		lines   []ChargeLine
		blocks  int
		summary string
	}{
		{
			name: "定时 60 分钟、用了 45 分钟：套餐价", usage: Usage{DurationMinutes: 60, UsedSeconds: minutes(45)},
			tariff: Tariff{Packages: []Package{hourRenewal}}, kind: ChargePackage,
			lines:   []ChargeLine{{"1小时", 1, 2990}},
			summary: "已用 45 分钟（不含暂停），约定 60 分钟，未超时",
		},
		{
			name: "超时正好 10 分钟（宽限边界）：不加收", usage: Usage{DurationMinutes: 60, UsedSeconds: minutes(70)},
			tariff: Tariff{Packages: []Package{hourRenewal}}, kind: ChargePackage,
			lines:   []ChargeLine{{"1小时", 1, 2990}},
			summary: "超时 10 分钟，在宽限 10 分钟内，不加收",
		},
		{
			name: "超时 10 分 59 秒（差 1 秒满 11 分钟）：零头不算，不加收，说明里写 10 分钟", usage: Usage{DurationMinutes: 60, UsedSeconds: minutes(71) - 1},
			tariff: Tariff{Packages: []Package{hourRenewal}}, kind: ChargePackage,
			lines:   []ChargeLine{{"1小时", 1, 2990}},
			summary: "超时 10 分钟，在宽限 10 分钟内，不加收",
		},
		{
			name: "超时 11 分 0 秒（刚好整分）：加收 1 块，说明里写 11 分钟", usage: Usage{DurationMinutes: 60, UsedSeconds: minutes(71)},
			tariff: Tariff{Packages: []Package{hourRenewal}}, kind: ChargePackage, blocks: 1,
			lines:   []ChargeLine{{"1小时", 1, 2990}, {"1小时 · 超时加收", 1, 1500}},
			summary: "超时 11 分钟（宽限 10 分钟），按续时 30 分钟 ¥15.00 加收 1 块",
		},
		{
			name: "超时不足 1 分钟：按没超时写", usage: Usage{DurationMinutes: 60, UsedSeconds: minutes(60) + 59},
			tariff: Tariff{Packages: []Package{hourRenewal}}, kind: ChargePackage,
			lines:   []ChargeLine{{"1小时", 1, 2990}},
			summary: "已用 60 分钟（不含暂停），约定 60 分钟，未超时",
		},
		{
			name: "超时 25 分钟：加收 1 块", usage: Usage{DurationMinutes: 60, UsedSeconds: minutes(85)},
			tariff: Tariff{Packages: []Package{hourRenewal}}, kind: ChargePackage, blocks: 1,
			lines:   []ChargeLine{{"1小时", 1, 2990}, {"1小时 · 超时加收", 1, 1500}},
			summary: "超时 25 分钟（宽限 10 分钟），按续时 30 分钟 ¥15.00 加收 1 块",
		},
		{
			name: "跨多块：超时 65 分钟加收 3 块", usage: Usage{DurationMinutes: 60, UsedSeconds: minutes(125)},
			tariff: Tariff{Packages: []Package{hourRenewal}}, kind: ChargePackage, blocks: 3,
			lines:   []ChargeLine{{"1小时", 1, 2990}, {"1小时 · 超时加收", 3, 1500}},
			summary: "超时 65 分钟（宽限 10 分钟），按续时 30 分钟 ¥15.00 加收 3 块",
		},
		{
			name: "已续的时长计入：续到 90 分钟、用了 100 分钟，在宽限内", usage: Usage{DurationMinutes: 90, UsedSeconds: minutes(100)},
			tariff: Tariff{Packages: []Package{hourRenewal}}, kind: ChargePackage,
			lines:   []ChargeLine{{"1小时", 1, 2990}, {"1小时 · 续时", 1, 1500}},
			summary: "超时 10 分钟，在宽限 10 分钟内，不加收",
		},
		{
			name: "续到 90 分钟、用了 125 分钟：从续后的结束时刻起加收 2 块", usage: Usage{DurationMinutes: 90, UsedSeconds: minutes(125)},
			tariff: Tariff{Packages: []Package{hourRenewal}}, kind: ChargePackage, blocks: 2,
			lines:   []ChargeLine{{"1小时", 1, 2990}, {"1小时 · 续时", 1, 1500}, {"1小时 · 超时加收", 2, 1500}},
			summary: "超时 35 分钟（宽限 10 分钟），按续时 30 分钟 ¥15.00 加收 2 块",
		},
		{
			name: "旧套餐超时不加钱：超时 40 分钟也只收套餐", usage: Usage{DurationMinutes: 60, UsedSeconds: minutes(100)},
			tariff: Tariff{Packages: []Package{hourFree}}, kind: ChargePackage,
			lines:   []ChargeLine{{"1小时", 1, 2990}},
			summary: "超时 40 分钟；这个套餐超时不加收",
		},
		{
			name: "旧套餐超时提示员工：不自动加", usage: Usage{DurationMinutes: 60, UsedSeconds: minutes(100)},
			tariff: Tariff{Packages: []Package{hourManual}}, kind: ChargePackage,
			lines:   []ChargeLine{{"1小时", 1, 2990}},
			summary: "超时 40 分钟；这个套餐超时由员工处理，不自动加收",
		},
		{
			name: "对不上套餐：0 元占位，不按分钟折算", usage: Usage{DurationMinutes: 45, UsedSeconds: minutes(80)},
			tariff: Tariff{Packages: []Package{hourRenewal}}, kind: ChargeUnpriced,
			lines:   []ChargeLine{{"计时 45 分钟", 1, 0}},
			summary: "计时 45 分钟对不上已发布的套餐，结账时填价",
		},
		{
			name: "自由计时 29 分钟：1 块", usage: Usage{Free: true, UsedSeconds: minutes(29)},
			tariff: Tariff{Free: freeRate}, kind: ChargeFree, blocks: 1,
			lines:   []ChargeLine{{"自由计时 · 每 30 分钟", 1, 1000}},
			summary: "已用 29 分钟（不含暂停），每 30 分钟 ¥10.00，计 1 块",
		},
		{
			name: "自由计时 30 分钟整：1 块", usage: Usage{Free: true, UsedSeconds: minutes(30)},
			tariff: Tariff{Free: freeRate}, kind: ChargeFree, blocks: 1,
			lines:   []ChargeLine{{"自由计时 · 每 30 分钟", 1, 1000}},
			summary: "已用 30 分钟（不含暂停），每 30 分钟 ¥10.00，计 1 块",
		},
		{
			name: "自由计时 30 分 59 秒（差 1 秒满 31 分钟）：零头不算，1 块", usage: Usage{Free: true, UsedSeconds: minutes(31) - 1},
			tariff: Tariff{Free: freeRate}, kind: ChargeFree, blocks: 1,
			lines:   []ChargeLine{{"自由计时 · 每 30 分钟", 1, 1000}},
			summary: "已用 30 分钟（不含暂停），每 30 分钟 ¥10.00，计 1 块",
		},
		{
			name: "自由计时 31 分 0 秒（刚好整分）：2 块", usage: Usage{Free: true, UsedSeconds: minutes(31)},
			tariff: Tariff{Free: freeRate}, kind: ChargeFree, blocks: 2,
			lines:   []ChargeLine{{"自由计时 · 每 30 分钟", 2, 1000}},
			summary: "已用 31 分钟（不含暂停），每 30 分钟 ¥10.00，计 2 块",
		},
		{
			name: "没发布自由计时价：照旧 0 元占位，名字写已用整分钟", usage: Usage{Free: true, UsedSeconds: minutes(25) + 40},
			tariff: Tariff{Packages: []Package{hourRenewal}}, kind: ChargeUnpriced,
			lines:   []ChargeLine{{"自由计时 · 已用 25 分钟", 1, 0}},
			summary: "已用 25 分钟（不含暂停）；没有发布自由计时价，结账时填价",
		},
		{
			name: "陪客：收固定陪客费，不看时长", usage: Usage{Companion: true, DurationMinutes: 60, UsedSeconds: minutes(300)},
			tariff: Tariff{Packages: []Package{hourRenewal}, Companion: companion}, kind: ChargeCompanion,
			lines:   []ChargeLine{{"陪客", 1, 2000}},
			summary: "陪客不计时，陪客费 ¥20.00",
		},
		{
			name: "没发布陪客费：照旧 0 元一行", usage: Usage{Companion: true, DurationMinutes: 60},
			tariff: Tariff{Packages: []Package{hourRenewal}}, kind: ChargeCompanion,
			lines:   []ChargeLine{{"陪客", 1, 0}},
			summary: "陪客不计时；没有发布陪客费，按 0 元",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := WholeTableCharge(c.usage, c.tariff)
			if got.Kind != c.kind || !slices.Equal(got.Lines, c.lines) || got.Blocks != c.blocks || got.Summary != c.summary {
				t.Fatalf("得到 %s %v 块 %d「%s」\n应为 %s %v 块 %d「%s」", got.Kind, got.Lines, got.Blocks, got.Summary, c.kind, c.lines, c.blocks, c.summary)
			}
		})
	}
}

func TestWholeTableChargePicksCheapestPackage(t *testing.T) {
	cheap := Package{Name: "1小时 特价", DurationMinutes: 60, AmountCents: 1990, RenewalMinutes: 30, RenewalCents: 1500, Overtime: OvertimeFree}
	got := WholeTableCharge(Usage{DurationMinutes: 60, UsedSeconds: minutes(90)}, Tariff{Packages: []Package{hourRenewal, cheap}})
	if !slices.Equal(got.Lines, []ChargeLine{{"1小时 特价", 1, 1990}}) || got.Blocks != 0 {
		t.Fatalf("同一时长取最便宜的套餐，超时按它的处理：%v", got)
	}
}

func TestRenewalPlan(t *testing.T) {
	twoHours := Package{Name: "2小时", DurationMinutes: 120, AmountCents: 4990, RenewalMinutes: 60, RenewalCents: 2500}
	threeHours := Package{Name: "3小时", DurationMinutes: 180, AmountCents: 6990}
	cases := []struct {
		name     string
		packages []Package
		minutes  int
		want     string // 续时用的套餐名，空表示没有续时方案
	}{
		{"时长正好是套餐：按它的续时方案", []Package{hourRenewal, twoHours}, 120, "2小时"},
		{"续过一次（套餐 + 续时）：还按那个套餐续", []Package{hourRenewal}, 90, "1小时"},
		{"正好相等的套餐不能续：找套餐 + 续时对得上的", []Package{twoHours, threeHours}, 180, "2小时"},
		{"正好相等的不能续、也没有别的对得上", []Package{threeHours}, 180, ""},
		{"对不上任何套餐", []Package{hourRenewal}, 45, ""},
		{"没有价表", nil, 60, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			pkg, ok := RenewalPlan(Tariff{Packages: c.packages}, c.minutes)
			if got := map[bool]string{true: pkg.Name}[ok]; got != c.want {
				t.Fatalf("续时用的套餐 = %q（ok=%v），想要 %q", got, ok, c.want)
			}
			if ok && pkg.RenewalMinutes <= 0 {
				t.Fatalf("给出的套餐必须有续时方案：%v", pkg)
			}
		})
	}
}

func TestSeatCharge(t *testing.T) {
	cases := []struct {
		name  string
		usage Usage
		pkg   Package
		lines []ChargeLine
	}{
		{"刚确认：套餐一行", Usage{DurationMinutes: 60}, hourRenewal, []ChargeLine{{"1小时", 1, 2990}}},
		{"续过两次：每次一行", Usage{DurationMinutes: 120, UsedSeconds: minutes(100)}, hourRenewal,
			[]ChargeLine{{"1小时", 1, 2990}, {"1小时 · 续时", 1, 1500}, {"1小时 · 续时", 1, 1500}}},
		{"超时 25 分钟：加收 1 块", Usage{DurationMinutes: 60, UsedSeconds: minutes(85)}, hourRenewal,
			[]ChargeLine{{"1小时", 1, 2990}, {"1小时 · 超时加收", 1, 1500}}},
		{"续过一次再超时 31 分钟：2 块", Usage{DurationMinutes: 90, UsedSeconds: minutes(121)}, hourRenewal,
			[]ChargeLine{{"1小时", 1, 2990}, {"1小时 · 续时", 1, 1500}, {"1小时 · 超时加收", 2, 1500}}},
		{"超时 10 分 59 秒：按整分钟算在宽限内", Usage{DurationMinutes: 60, UsedSeconds: minutes(71) - 1}, hourRenewal,
			[]ChargeLine{{"1小时", 1, 2990}}},
		{"快照里超时不加钱：照旧", Usage{DurationMinutes: 60, UsedSeconds: minutes(200)}, hourFree, []ChargeLine{{"1小时", 1, 2990}}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := SeatCharge(c.usage, c.pkg); !slices.Equal(got.Lines, c.lines) {
				t.Fatalf("得到 %v，应为 %v", got.Lines, c.lines)
			}
		})
	}
}

func TestChargePricedAndTotal(t *testing.T) {
	priced := WholeTableCharge(Usage{DurationMinutes: 60, UsedSeconds: minutes(85)}, Tariff{Packages: []Package{hourRenewal}})
	if !priced.Priced() || priced.TotalCents() != 4490 {
		t.Fatalf("套餐 + 超时 1 块应为 ¥44.90：%v %d", priced.Priced(), priced.TotalCents())
	}
	unpriced := WholeTableCharge(Usage{Free: true, UsedSeconds: minutes(10)}, Tariff{})
	if unpriced.Priced() {
		t.Fatal("0 元占位行不算有价")
	}
}

func TestUsedSeconds(t *testing.T) {
	start := time.Date(2026, 10, 6, 10, 0, 0, 0, time.UTC)
	at := start.Add(90 * time.Minute)
	paused := start.Add(70 * time.Minute)
	cases := []struct {
		name      string
		session   Session
		allowance int64
		want      int64
	}{
		{"没暂停", Session{Status: "active", StartedAt: start}, -1, minutes(90)},
		{"已完成的暂停 15 分钟不计", Session{Status: "active", StartedAt: start, PausedSeconds: minutes(15)}, -1, minutes(75)},
		{"整桌：暂停中的 20 分钟全部不计", Session{Status: "paused", StartedAt: start, PausedSeconds: minutes(5), PausedAt: &paused}, -1, minutes(65)},
		{"按座：这次暂停只扣到上限剩下的 10 分钟", Session{Status: "paused", StartedAt: start, PausedSeconds: minutes(5), PausedAt: &paused}, minutes(10), minutes(75)},
		{"时钟倒退：不出负数", Session{Status: "active", StartedAt: at.Add(time.Minute)}, -1, 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := c.session.UsedSeconds(at, c.allowance); got != c.want {
				t.Fatalf("UsedSeconds = %d，应为 %d", got, c.want)
			}
		})
	}
}
