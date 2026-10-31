// Package layout 持有门店布局这份唯一真相。
//
// ★★ 为什么固定（2026-09-19）：店只有一家、平面图只有一张、桌就是那 20 张。
//
//	在此之前布局有两份真相 —— 前端 seatmap.ts 写死 20 个位置与坐标，后端 floor_areas /
//	service_tables 又允许店员任意增删改。为了让两边对得上，长出了整套对账机器：
//	员工端「布局管理」（建区域、加桌、拖格子、改座数、锁定、按平面图同步）、
//	前端 plannedAreas/planSyncSteps/syncPending、mapSeats 里五个「对不上就整张图拒绝」
//	的分支。三个文件 1579 行，约一半只为对账服务，而这套动态能力**从没被用来做过
//	布局管理**，只被用来修对不上的账。
//
//	2026-09-19 现场的门店卡死（顾客端拒绝服务、员工端认为无事可做、修复按钮甚至不渲染）
//	就是对账失败的一种表现。改成单一真相之后，这些分支全部消失。
//
// ★ 这份 JSON 与仓库根 layout/store-layout.json **必须字节相同**。go:embed 出不了模块
//
//	目录、也不认符号链接，所以只能放副本；layout_test.go 会逐字节比对，漏同步就红。
package layout

import (
	_ "embed"
	"encoding/json"
	"fmt"
)

//go:embed store-layout.json
var raw []byte

// Zone 是平面图上的一个分区。
type Zone struct {
	Key          string `json:"key"`
	Name         string `json:"name"`
	Desc         string `json:"desc"`
	Color        string `json:"color"`
	SeatsPerUnit int    `json:"seatsPerUnit"`
}

// Table 是布局里的一张桌。Code 是稳定编码（区域字母 + 区内桌号），
// 它才是跨部署稳定的身份；数据库主键是 UUID，建库时才生成。
type Table struct {
	Code       string `json:"code"`
	Zone       string `json:"zone"`
	Number     int    `json:"number"`
	SeatCount  int    `json:"seatCount"`
	WholeTable bool   `json:"wholeTable"`
}

// Layout 是整份布局。后端只用 Zones 与 Tables；plan/facilities/hotspot 是顾客端画图用的，
// 这里不解析，但它们和本结构共用同一个文件，改布局只有一处要改。
type Layout struct {
	Zones  []Zone  `json:"zones"`
	Tables []Table `json:"tables"`
}

var loaded = mustLoad()

func mustLoad() Layout {
	var l Layout
	if err := json.Unmarshal(raw, &l); err != nil {
		panic(fmt.Sprintf("布局文件解析失败: %v", err))
	}
	if err := l.validate(); err != nil {
		panic(fmt.Sprintf("布局文件不自洽: %v", err))
	}
	return l
}

// Get 返回布局。它在包初始化时就校验过，调用方不必再判错。
func Get() Layout { return loaded }

// Raw 返回嵌入的原始字节，供测试与仓库根那份比对。
func Raw() []byte { return raw }

// ZoneOf 按 key 找分区。
func (l Layout) ZoneOf(key string) (Zone, bool) {
	for _, z := range l.Zones {
		if z.Key == key {
			return z, true
		}
	}
	return Zone{}, false
}

// validate 把「布局文件写错」挡在启动期。
//
// ★ 写错的后果很重：reconcileLayout 会按它校正数据库，一个错的座位数就能让顾客端
//
//	整张图拒绝服务，或者让真桌被当成布局外的桌而拒绝启动。所以宁可开不起来。
func (l Layout) validate() error {
	if len(l.Zones) == 0 {
		return fmt.Errorf("没有分区")
	}
	if len(l.Tables) == 0 {
		return fmt.Errorf("没有桌位")
	}
	seen := map[string]bool{}
	for _, t := range l.Tables {
		if seen[t.Code] {
			return fmt.Errorf("桌位编码重复: %s", t.Code)
		}
		seen[t.Code] = true
		z, ok := l.ZoneOf(t.Zone)
		if !ok {
			return fmt.Errorf("%s 所属分区 %q 不存在", t.Code, t.Zone)
		}
		if want := fmt.Sprintf("%s%d", t.Zone, t.Number); t.Code != want {
			return fmt.Errorf("桌位编码 %s 与分区加桌号 %s 对不上", t.Code, want)
		}
		if t.SeatCount != z.SeatsPerUnit {
			return fmt.Errorf("%s 有 %d 座，但 %s的每单位座数是 %d", t.Code, t.SeatCount, z.Name, z.SeatsPerUnit)
		}
		// 多于一座的桌必须是整桌单位，否则后端按座号判占用，顾客订走 1 号座之后
		// 2 号座仍会被扫码入座卖给别人，两拨客人被拼到同一张桌上。
		if t.WholeTable != (t.SeatCount > 1) {
			return fmt.Errorf("%s 有 %d 座但 wholeTable=%v，多于一座必须是整桌单位", t.Code, t.SeatCount, t.WholeTable)
		}
	}
	return nil
}
