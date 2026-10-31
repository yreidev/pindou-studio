package app

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yreidev/pindou-studio/pindou-backend/internal/layout"
)

// 嵌入的布局副本必须与仓库根那份**字节相同**。
//
// ★ go:embed 出不了模块目录、也不认符号链接，所以后端只能放一份副本。
//
//	两份漂了就是两份真相，而「只有一份真相」正是这次改造的全部意义。
//	改布局固定两步：改 layout/store-layout.json，再 cp 到 internal/layout/。
func TestEmbeddedLayoutMatchesRepositoryRoot(t *testing.T) {
	root, err := os.ReadFile(filepath.Join("..", "..", "..", "layout", "store-layout.json"))
	if err != nil {
		t.Fatalf("读仓库根布局文件: %v", err)
	}
	if string(root) != string(layout.Raw()) {
		t.Fatal("internal/layout/store-layout.json 与 layout/store-layout.json 不一致。\n" +
			"  改布局要两步：改仓库根那份，再 cp 到 internal/layout/。")
	}
}

// 布局文件本身要自洽。validate() 在包初始化时就跑过（不自洽直接 panic），
// 这里钉的是**这家店当前的形状**（店主 2026-09-26 的最终版）：21 个可约单位，
// 只有包间里 D 区的两张双人桌是整桌单位，其余都是单人位。
func TestLayoutDescribesThisStore(t *testing.T) {
	l := layout.Get()
	if len(l.Tables) != 21 {
		t.Fatalf("门店是 21 个可约单位，布局里有 %d 个", len(l.Tables))
	}
	counts := map[string]int{}
	for _, table := range l.Tables {
		counts[table.Zone]++
	}
	for zone, want := range map[string]int{"A": 6, "B": 7, "C": 3, "D": 2, "E": 3} {
		if counts[zone] != want {
			t.Errorf("%s 区应有 %d 张桌，布局里是 %d", zone, want, counts[zone])
		}
	}
	for _, table := range l.Tables {
		if (table.Zone == "D") != table.WholeTable {
			t.Errorf("%s: 只有 D 区（包间）的双人桌是整桌单位，实得 wholeTable=%v", table.Code, table.WholeTable)
		}
	}
}

// 空库启动：建出 5 个区、21 张桌，全部启用。
func TestReconcileLayoutBuildsTheStoreFromEmpty(t *testing.T) {
	s := newTestServer(t)
	if err := s.ReconcileLayout(context.Background()); err != nil {
		t.Fatalf("首次校正失败: %v", err)
	}
	if areas, tables := areasOf(t, s), tablesOf(t, s); len(areas) != 5 || len(tables) != 21 {
		t.Fatalf("应建出 5 区 21 桌，实得 %d 区 %d 桌", len(areas), len(tables))
	}
	byCode := map[string]*Table{}
	for _, table := range tablesOf(t, s) {
		byCode[table.Code] = table
		if !table.Enabled {
			t.Errorf("%s 新建的桌应当启用", table.Code)
		}
	}
	for _, want := range layout.Get().Tables {
		got := byCode[want.Code]
		if got == nil {
			t.Fatalf("缺 %s", want.Code)
		}
		if got.Number != want.Number || got.SeatCount != want.SeatCount || got.WholeTable != want.WholeTable {
			t.Errorf("%s 对不上布局：%d 号 %d 座 whole=%v", want.Code, got.Number, got.SeatCount, got.WholeTable)
		}
	}
}

// 幂等：跑第二遍不该再改任何东西。
func TestReconcileLayoutIsIdempotent(t *testing.T) {
	s := newTestServer(t)
	ctx := context.Background()
	if err := s.ReconcileLayout(ctx); err != nil {
		t.Fatal(err)
	}
	before := s.snapshotData()
	if err := s.ReconcileLayout(ctx); err != nil {
		t.Fatal(err)
	}
	if string(before) != string(s.snapshotData()) {
		t.Fatal("第二次校正改动了数据 —— 校正不是幂等的，每次重启都会写一次库")
	}
}

// 座位数、整桌、桌号对不上布局，校正要改回来；Enabled 不能碰。
// A1 照旧布局（9 月 15 日那版）是双人整桌，新布局里是单人位：从旧布局升上来走的就是这条。
func TestReconcileLayoutCorrectsDriftButLeavesEnabledAlone(t *testing.T) {
	s := newTestServer(t)
	ctx := context.Background()
	if err := s.ReconcileLayout(ctx); err != nil {
		t.Fatal(err)
	}
	pair, single := tableByCode(t, s, "D1").ID, tableByCode(t, s, "A1").ID
	edit(t, s, func(q *txn) {
		d1 := q.table(pair)
		d1.SeatCount, d1.WholeTable, d1.Number = 1, false, 9
		// ★ 停用是店里的运营状态，不是布局的一部分：校正必须原样留着，
		//   否则店员刚停掉一张坏桌，一次重启就被系统悄悄打开了。
		d1.Enabled = false
		a1 := q.table(single)
		a1.SeatCount, a1.WholeTable = 2, true
	})

	if err := s.ReconcileLayout(ctx); err != nil {
		t.Fatal(err)
	}
	d1 := tableOf(t, s, pair)
	if d1.SeatCount != 2 || !d1.WholeTable || d1.Number != 1 {
		t.Errorf("D1 的布局字段没被校正回来：%d 号 %d 座 whole=%v", d1.Number, d1.SeatCount, d1.WholeTable)
	}
	if d1.Enabled {
		t.Error("校正把停用状态改掉了 —— Enabled 归店员，不归布局")
	}
	if a1 := tableOf(t, s, single); a1.SeatCount != 1 || a1.WholeTable {
		t.Errorf("旧布局的双人桌 A1 没改成单人位：%d 座 whole=%v", a1.SeatCount, a1.WholeTable)
	}
}

// 库里有布局之外的桌 → 拒绝启动，并把它报出来。
func TestReconcileLayoutRefusesStrayTables(t *testing.T) {
	s := newTestServer(t)
	ctx := context.Background()
	if err := s.ReconcileLayout(ctx); err != nil {
		t.Fatal(err)
	}
	seedTable(t, s, "", "包间", 1, 1, false)
	err := s.ReconcileLayout(ctx)
	if err == nil {
		t.Fatal("布局外的桌应当拒绝启动")
	}
	if !strings.Contains(err.Error(), "包间") {
		t.Errorf("错误里要指出是哪张桌，实得：%v", err)
	}
}

// 有人正坐在将被缩掉的座号上 → 拒绝启动。
func TestReconcileLayoutRefusesToShrinkASeatSomeoneIsOn(t *testing.T) {
	s := newTestServer(t)
	ctx := context.Background()
	if err := s.ReconcileLayout(ctx); err != nil {
		t.Fatal(err)
	}
	b1 := tableByCode(t, s, "B1")
	// 有人把 B1 撑成了 3 座并且 3 号座上还坐着人；布局要求 1 座。
	edit(t, s, func(q *txn) {
		q.table(b1.ID).SeatCount = 3
		q.addSession(&TableSession{ID: id(), TableID: b1.ID, SeatNumber: 3, Status: "active", StartedAt: s.now()})
	})

	err := s.ReconcileLayout(ctx)
	if err == nil {
		t.Fatal("客人坐在将被缩掉的座号上时应当拒绝启动")
	}
	if !strings.Contains(err.Error(), "B1") {
		t.Errorf("错误里要指出是哪个座，实得：%v", err)
	}
}

// 布局固定 = 改布局的端点全部关掉，只留停用/启用。
//
// ★ 关键是 PATCH **不能静默忽略**多余字段：店员改了座位数看到 200，以为成功了，
//
//	下次重启 ReconcileLayout 又把它改回去，看起来像系统在跟人捣乱。明确拒绝。
func TestLayoutEndpointsAreClosedExceptEnableDisable(t *testing.T) {
	s := newTestServer(t)
	owner := register(t, s, "owner", "Owner")
	if err := s.BootstrapOwner(owner.User.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.ReconcileLayout(context.Background()); err != nil {
		t.Fatal(err)
	}
	table := tableByCode(t, s, "C1")
	path := "/api/v2/service-tables/" + table.ID

	for _, tc := range []struct {
		name, method, url string
		body              map[string]any
		want              int
	}{
		{"建区域", "POST", "/api/v2/floor-areas", map[string]any{"name": "新区"}, 405},
		{"改区域", "PATCH", "/api/v2/floor-areas/" + table.AreaID, map[string]any{"name": "改名"}, 405},
		{"建桌", "POST", "/api/v2/service-tables", map[string]any{"floorAreaId": table.AreaID, "seatCount": 1}, 405},
		{"改座位数", "PATCH", path, map[string]any{"seatCount": 4}, 400},
		{"改桌号", "PATCH", path, map[string]any{"number": 9}, 400},
		{"改整桌单位", "PATCH", path, map[string]any{"wholeTable": true}, 400},
		{"改格子", "PATCH", path, map[string]any{"gridX": 2}, 400},
		{"停用夹带座位数", "PATCH", path, map[string]any{"enabled": false, "seatCount": 4}, 400},
		{"只停用", "PATCH", path, map[string]any{"enabled": false}, 200},
		{"只启用", "PATCH", path, map[string]any{"enabled": true}, 200},
	} {
		r := call(t, s, tc.method, tc.url, owner.AccessToken, "", tc.body)
		if r.Code != tc.want {
			t.Errorf("%s: 期望 %d，实得 %d %s", tc.name, tc.want, r.Code, r.Body.String())
		}
	}

	// 被拒的那些请求一个字段都不许改到
	table = tableOf(t, s, table.ID)
	if table.SeatCount != 1 || table.Number != 1 || table.WholeTable {
		t.Errorf("被拒绝的 PATCH 改动了桌位：%d 号 %d 座 whole=%v", table.Number, table.SeatCount, table.WholeTable)
	}
	if !table.Enabled {
		t.Error("最后一步是启用，桌应当是启用状态")
	}
}

// 顾客端和员工端都要能拿到 code 与 zone —— 平面图按 code 对位，没有它就回到了
// 「按区域名加桌号猜」的老路。
func TestTableViewsCarryTheLayoutCode(t *testing.T) {
	s := newTestServer(t)
	if err := s.ReconcileLayout(context.Background()); err != nil {
		t.Fatal(err)
	}
	table := tableByCode(t, s, "A1")
	if v := tableViewOf(t, s, table.ID); v["code"] != "A1" || v["zone"] != "A" {
		t.Errorf("员工端视图缺 code/zone：%v", v)
	}
	var found bool
	for _, row := range view(t, s, s.loyaltyTables) {
		if row["code"] == "A1" {
			found = true
			if row["zone"] != "A" {
				t.Errorf("顾客端视图 zone 不对：%v", row)
			}
		}
	}
	if !found {
		t.Error("顾客端视图里找不到 A1")
	}
}

// 快照往返：Code 必须活过一次 save → load。
//
// ★★ 2026-09-19 发布事故的那条。迁移 006 只给 service_tables 加了 code **列**并回填，
//
//	没写 state JSON —— 而应用启动读的是 state（records.go 的 loadSQL 用
//	jsonb_object_agg(id, state)，那些列只是给 SQL 查询用的投影）。20 张真桌在内存里
//	Code 全是空的，ReconcileLayout 把它们当成布局之外的桌，拒绝启动，生产宕了约 90 秒。
//
//	这条测试拦的就是「某个字段没进快照」：Table 结构体没有 json tag，字段名即键名，
//	改名或改成小写不导出都会让它从快照里消失，而那在编译期毫无提示。
func TestTableCodeSurvivesASnapshotRoundTrip(t *testing.T) {
	s := newTestServer(t)
	if err := s.ReconcileLayout(context.Background()); err != nil {
		t.Fatal(err)
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, s.snapshotData()); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(compact.String(), `"Code":"A1"`) {
		t.Fatal("快照里没有 Code 字段 —— 存进库的 state 就不带它，重启后 ReconcileLayout 会把所有桌当成布局外的桌")
	}

	restored := serverOn(t, s.postgres)
	codes := map[string]bool{}
	for _, table := range tablesOf(t, restored) {
		codes[table.Code] = true
	}
	for _, want := range layout.Get().Tables {
		if !codes[want.Code] {
			t.Fatalf("还原之后丢了 %s 的编码", want.Code)
		}
	}
	// 还原出来的状态必须直接能通过校正，且不产生任何改动 —— 真实重启走的就是这条路。
	before := restored.snapshotData()
	if err := restored.ReconcileLayout(context.Background()); err != nil {
		t.Fatalf("还原后的数据应当直接通过布局校正：%v", err)
	}
	if string(before) != string(restored.snapshotData()) {
		t.Fatal("还原后校正又改了数据 —— 每次重启都会写一次库")
	}
}
