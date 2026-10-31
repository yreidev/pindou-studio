package app

import (
	"context"
	"errors"
	"fmt"
	"log"
	"sort"
	"strings"

	"github.com/yreidev/pindou-studio/pindou-backend/internal/layout"
)

// errLayoutFixed 是所有「想改布局」的请求得到的答复。
//
// 契约违反类保持英文（见 error_copy_test.go），但这条是**店员在员工端会看到的**：
// 他点了某个还没来得及删干净的入口，得知道为什么没反应。
var errLayoutFixed = errors.New("桌位布局是固定的，只能停用或启用；要改布局请更新门店布局文件并重新部署")

// zoneKeyOf 从桌位编码取分区字母（A1 → A）。编码由布局保证形如「字母+数字」。
func zoneKeyOf(code string) string {
	if code == "" {
		return ""
	}
	return code[:1]
}

// ReconcileLayout 把数据库里的区域与桌位对齐到 layout/store-layout.json。
//
// ★★ 布局是固定的（见 internal/layout/layout.go 的包注释）。这个函数是「文件是唯一真相」
//
//	这句话在运行时的兑现方式：启动时按 Code 逐张核对，缺的建、对不上的改正。
//
// ★ 刻意**不碰 Enabled**：停用/启用是店里唯一保留的运营操作，归店员，不归布局。
//
// ★ 遇到布局之外的桌或区域就**拒绝启动**，不静默容忍。迁移 006 之后库里不该再有这种行，
//
//	出现即配置错误；静默留着会让员工端列出图上不存在的桌，顾客却永远约不到它。
//	本仓库对启动期配置错误一贯 fail-fast（见 PINDOU_DEVELOPER_ACCOUNT_IDS、WeChat 凭据）。
func (s *Server) ReconcileLayout(ctx context.Context) error {
	var createdAreas, createdTables, corrected int
	err := s.writeTx(ctx, func(q *txn) error {
		createdAreas, createdTables, corrected = 0, 0, 0
		// 滚动发布时新旧副本可能同时启动：只让一个做校正，另一个等它提交后看到的已经是对齐的。
		q.fail(q.dbWrite().TransactionLock(q.ctx, int64(layoutLock)))
		l := layout.Get()
		areas, tables := q.allAreas(), q.allTables()
		byName := map[string]*FloorArea{}
		areaByID := map[string]*FloorArea{}
		for _, a := range areas {
			byName[a.Name] = a
			areaByID[a.ID] = a
		}
		byCode := map[string]*Table{}
		for _, t := range tables {
			if t.Code != "" {
				byCode[t.Code] = t
			}
		}

		// ① 库里有、布局里没有的，先查出来一并报，别让人修一个重启一次。
		var strays []string
		wantCodes := map[string]bool{}
		wantAreas := map[string]bool{}
		for _, t := range l.Tables {
			wantCodes[t.Code] = true
		}
		for _, z := range l.Zones {
			wantAreas[z.Name] = true
		}
		for _, t := range tables {
			if !wantCodes[t.Code] {
				name := "(无区域)"
				if a := areaByID[t.AreaID]; a != nil {
					name = a.Name
				}
				strays = append(strays, fmt.Sprintf("%s %d 号桌（code=%q）", name, t.Number, t.Code))
			}
		}
		for _, a := range areas {
			if !wantAreas[a.Name] {
				strays = append(strays, fmt.Sprintf("区域 %q", a.Name))
			}
		}
		if len(strays) > 0 {
			sort.Strings(strays)
			return fmt.Errorf("数据库里有布局之外的桌位或区域，拒绝启动：%s。"+
				"布局是固定的（layout/store-layout.json），历史残留应由迁移清理，不要手改",
				strings.Join(strays, "、"))
		}

		// ② 缩座位数之前先确认没人正坐在将要消失的座号上。
		var seated []string
		for _, want := range l.Tables {
			t := byCode[want.Code]
			if t == nil || want.SeatCount >= t.SeatCount {
				continue
			}
			for _, x := range q.liveSessionsOnTable(t.ID) {
				if x.SeatNumber > want.SeatCount {
					seated = append(seated, fmt.Sprintf("%s 的 %d 号座", want.Code, x.SeatNumber))
				}
			}
		}
		if len(seated) > 0 {
			sort.Strings(seated)
			return fmt.Errorf("这些座位上还有进行中的会话，按布局缩座位数会把客人留在不存在的座号上，拒绝启动：%s。"+
				"先在员工端结束这些会话", strings.Join(seated, "、"))
		}

		// ③ 建区域、建桌、校正。
		for _, z := range l.Zones {
			if byName[z.Name] == nil {
				a := &FloorArea{ID: id(), Name: z.Name}
				q.addArea(a)
				byName[z.Name] = a
				createdAreas++
			}
		}
		for _, want := range l.Tables {
			z, _ := l.ZoneOf(want.Zone)
			area := byName[z.Name]
			t := byCode[want.Code]
			if t == nil {
				t = &Table{ID: id(), Code: want.Code, Enabled: true}
				q.addTable(t)
				byCode[want.Code] = t
				createdTables++
			} else if t.AreaID == area.ID && t.Number == want.Number &&
				t.SeatCount == want.SeatCount && t.WholeTable == want.WholeTable {
				continue
			} else {
				corrected++
			}
			t.AreaID, t.Number, t.SeatCount, t.WholeTable = area.ID, want.Number, want.SeatCount, want.WholeTable
		}
		return nil
	})
	if err != nil {
		return err
	}
	if createdAreas+createdTables+corrected > 0 {
		log.Printf("layout reconciled: %d areas created, %d tables created, %d corrected", createdAreas, createdTables, corrected)
	}
	return nil
}

// layoutLock 是启动时校正布局持有的事务级咨询锁。
const layoutLock = 7_310_202_611
