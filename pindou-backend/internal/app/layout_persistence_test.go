package app

import (
	"context"
	"strings"
	"testing"
)

// 布局校正产出的快照，必须能真的存进 Postgres 再取回来。
//
// ★★ 2026-09-19 线上事故的那条。改造把 floor_areas 的 grid_columns / grid_rows 和
//
//	service_tables 的 grid_x / grid_y 退役（布局固定之后桌的位置是平面图热区，
//	不是员工端摆的格子），结构体不再读写，于是给列加了 DEFAULT 好让 upsert 省略它们。
//	但 floor_areas 上有 CHECK：grid_columns BETWEEN 4 AND 48、grid_rows BETWEEN 4 AND 80,
//	而我给的默认值是 **0** —— 默认值本身就违反约束。
//
//	读不检查约束，所以服务起得来、页面看得到，但**每一次写请求**在保存快照时都失败：
//	切身份、开台、下单全挂。更糟的是那条失败路径只返回 503 不打日志（httpx.go），
//	线上一条错误都看不到，只能从「老板点切换弹服务暂时不可用」这一个症状倒推。
//
// ★ 为什么之前没拦住：这类测试要真 Postgres，而那时没设 PINDOU_TEST_DATABASE_URL 会静默跳过 ——
//
//	改了持久层 SQL 却从没在真库上跑过，`make verify` 照样全绿。现在没配测试库时测试直接失败。
func TestLayoutSnapshotSurvivesRealPostgres(t *testing.T) {
	ctx := context.Background()
	server := newTestServer(t)
	if err := server.ReconcileLayout(ctx); err != nil {
		t.Fatalf("布局校正: %v", err)
	}
	// 再改一次桌位（停用再启用）：区域与桌位的写入要真的过一遍库的约束。
	// 退役列的默认值、NOT NULL、CHECK —— 任何一条不满足都在这里炸。
	owner := register(t, server, "layout-owner", "老板")
	if err := server.BootstrapOwner(owner.User.ID); err != nil {
		t.Fatal(err)
	}
	a1 := tableByCode(t, server, "A1")
	for _, enabled := range []bool{false, true} {
		if r := call(t, server, "PATCH", "/api/v2/service-tables/"+a1.ID, owner.AccessToken, "", map[string]any{"enabled": enabled}); r.Code != 200 {
			t.Fatalf("写桌位失败 —— 线上表现为每次写请求都 503：%d %s", r.Code, r.Body.String())
		}
	}

	// 另一个进程读回来的必须还是那 21 张桌，且编码都在。
	reloaded := serverOn(t, server.postgres)
	if tables, areas := tablesOf(t, reloaded), areasOf(t, reloaded); len(tables) != 21 || len(areas) != 5 {
		t.Fatalf("取回来是 %d 桌 %d 区，应当是 21 桌 5 区", len(tables), len(areas))
	}
	var missing []string
	codes := map[string]bool{}
	for _, table := range tablesOf(t, reloaded) {
		codes[table.Code] = true
	}
	for _, want := range []string{"A1", "A6", "B7", "C3", "D2", "E3"} {
		if !codes[want] {
			missing = append(missing, want)
		}
	}
	if len(missing) > 0 {
		t.Fatalf("取回来之后丢了这些编码：%s", strings.Join(missing, "、"))
	}
	// 重启后的校正不该再改动任何东西，否则每次重启都写一次库。
	before := reloaded.Snapshot()
	if err := reloaded.ReconcileLayout(ctx); err != nil {
		t.Fatalf("重新加载后的数据应当直接通过校正：%v", err)
	}
	if string(before) != string(reloaded.Snapshot()) {
		t.Fatal("重新加载后校正又改了数据")
	}
}
