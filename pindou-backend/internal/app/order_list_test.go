package app

import (
	"fmt"
	"net/http"
	"testing"
	"time"
)

// 员工订单列表按状态、关键字筛选，新的在前；带 pageSize 时只回那一页，总数与实际页码在响应头里。
// 不带参数时回全部（小程序旧版本这样取），返回体始终是数组。
func TestOrderListFiltersAndPages(t *testing.T) {
	s := newTestServer(t)
	owner := register(t, s, "list-owner", "老板")
	if err := s.BootstrapOwner(owner.User.ID); err != nil {
		t.Fatal(err)
	}
	customer := register(t, s, "list-customer", "小李同学")
	edit(t, s, func(q *txn) { q.user(customer.User.ID).Phone = "13912347788" })

	base := time.Date(2026, 10, 1, 4, 0, 0, 0, time.UTC)
	ids := make([]string, 25)
	for i := range ids {
		o := &Order{ID: fmt.Sprintf("%08x-0000-4000-8000-000000000000", i+1), Status: "paid", CreatedAt: base.Add(time.Duration(i) * time.Hour),
			Lines: []OrderLine{{Name: "计时服务", Quantity: 1, UnitPriceCents: 1000}}}
		switch i {
		case 3:
			o.Status = "draft"
		case 7:
			o.Status, o.UserID = "refunded", customer.User.ID
			o.Lines = []OrderLine{{Name: "钥匙扣配件", Quantity: 2, UnitPriceCents: 500}}
		}
		ids[i] = o.ID
		edit(t, s, func(q *txn) { q.addOrder(o) })
	}
	list := func(query string) ([]map[string]any, http.Header) {
		t.Helper()
		w := call(t, s, http.MethodGet, "/api/v2/sales-orders"+query, owner.AccessToken, "", nil)
		if w.Code != http.StatusOK {
			t.Fatalf("%s: %d %s", query, w.Code, w.Body.String())
		}
		return decodeList(t, w), w.Header()
	}
	idsOf := func(rows []map[string]any) []string {
		out := []string{}
		for _, row := range rows {
			out = append(out, row["id"].(string))
		}
		return out
	}

	// 不带参数：全部，新的在前，不带分页响应头
	all, header := list("")
	if len(all) != 25 || all[0]["id"] != ids[24] || all[24]["id"] != ids[0] || header.Get("X-Total-Count") != "" {
		t.Fatalf("全部：%d 条，首 %v 末 %v，头 %q", len(all), all[0]["id"], all[24]["id"], header.Get("X-Total-Count"))
	}

	// 分页：第 2 页 10 条；页码超出落到最后一页
	page, header := list("?pageSize=10&page=2")
	if got := idsOf(page); len(got) != 10 || got[0] != ids[14] || got[9] != ids[5] || header.Get("X-Total-Count") != "25" || header.Get("X-Page") != "2" {
		t.Fatalf("第 2 页：%v，头 %v", got, header)
	}
	last, header := list("?pageSize=10&page=9")
	if len(last) != 5 || last[4]["id"] != ids[0] || header.Get("X-Page") != "3" {
		t.Fatalf("超出页码应落到第 3 页：%d 条，头 %v", len(last), header)
	}

	// 状态筛选
	if drafts, header := list("?status=draft&pageSize=20"); len(drafts) != 1 || drafts[0]["id"] != ids[3] || header.Get("X-Total-Count") != "1" {
		t.Fatalf("待结账：%v", idsOf(drafts))
	}
	// 关键字：订单编号、明细名称、顾客昵称、打码手机号的尾号，忽略大小写；完整手机号搜不到
	for _, q := range []string{"00000008-", "钥匙扣", "小李", "7788"} {
		if got, _ := list("?q=" + q); len(got) != 1 || got[0]["id"] != ids[7] {
			t.Fatalf("q=%s：%v", q, idsOf(got))
		}
	}
	if got, _ := list("?q=13912347788"); len(got) != 0 {
		t.Fatalf("完整手机号不应能搜到：%v", idsOf(got))
	}
	if got, _ := list("?q=%E9%92%A5%E5%8C%99&status=paid"); len(got) != 0 {
		t.Fatalf("钥匙扣那单已退款，按已付款筛不到：%v", idsOf(got))
	}

	for _, bad := range []string{"?status=lost", "?pageSize=0", "?pageSize=101", "?page=0", "?page=x&pageSize=10"} {
		if w := call(t, s, http.MethodGet, "/api/v2/sales-orders"+bad, owner.AccessToken, "", nil); w.Code != http.StatusBadRequest {
			t.Fatalf("%s 应 400：%d", bad, w.Code)
		}
	}
	if w := call(t, s, http.MethodGet, "/api/v2/sales-orders?pageSize=10", customer.AccessToken, "", nil); w.Code != http.StatusForbidden {
		t.Fatalf("顾客不能列全部订单：%d", w.Code)
	}
}

// 审计与库存流水同订单一样在服务端筛选、分页：带 pageSize 只回那一页，总数在 X-Total-Count。
func TestAuditAndMovementListsFilterAndPageOnTheServer(t *testing.T) {
	s := newTestServer(t)
	owner := register(t, s, "paging-owner", "老板阿贝")
	if err := s.BootstrapOwner(owner.User.ID); err != nil {
		t.Fatal(err)
	}
	clerk := register(t, s, "paging-clerk", "店员小林")
	base := time.Date(2026, 10, 1, 4, 0, 0, 0, time.UTC)
	for i := 0; i < 12; i++ {
		actor, action, reason := owner.User.ID, "stock.adjusted", "盘点"
		if i%3 == 0 {
			actor, action, reason = clerk.User.ID, "order.lines.updated", "应收变化"
		}
		a := &auditLog{ID: id(), Action: action, ActorID: actor, Reason: reason, RequestID: id(), CreatedAt: base.Add(time.Duration(i) * time.Minute)}
		edit(t, s, func(q *txn) { q.audits = append(q.audits, a) })
	}
	audit := func(query string) ([]map[string]any, http.Header) {
		t.Helper()
		w := call(t, s, http.MethodGet, "/api/v2/system/audit-events"+query, owner.AccessToken, "", nil)
		if w.Code != http.StatusOK {
			t.Fatalf("%s: %d %s", query, w.Code, w.Body.String())
		}
		return decodeList(t, w), w.Header()
	}
	all, _ := audit("")
	if len(all) != 13 { // 12 条加上初始化老板那条
		t.Fatalf("all audits: %d", len(all))
	}
	page, header := audit("?pageSize=5&page=1")
	if len(page) != 5 || header.Get("X-Total-Count") != "13" || page[0]["createdAt"].(string) < page[4]["createdAt"].(string) {
		t.Fatalf("first page newest first: %v %v", len(page), header)
	}
	// 关键字匹配操作人昵称；动作代码由网页按中文名换好传来
	if got, header := audit("?q=%E5%B0%8F%E6%9E%97&pageSize=20"); len(got) != 4 || header.Get("X-Total-Count") != "4" {
		t.Fatalf("by actor nickname: %d", len(got))
	}
	if got, _ := audit("?actions=order.lines.updated,role.bootstrap-owner"); len(got) != 5 {
		t.Fatalf("by action codes: %d", len(got))
	}
	if w := call(t, s, http.MethodGet, "/api/v2/system/audit-events?pageSize=0", owner.AccessToken, "", nil); w.Code != http.StatusBadRequest {
		t.Fatalf("bad page size: %d", w.Code)
	}

	// 流水：按类型筛选、分页
	item := &inventoryItem{ID: id(), ProductID: id(), Quantity: 50}
	edit(t, s, func(q *txn) { q.addStockItem(item) })
	for i := 0; i < 7; i++ {
		kind := "purchase"
		if i%2 == 1 {
			kind = "sale"
		}
		m := &movement{ID: id(), InventoryItemID: item.ID, Kind: kind, QuantityDelta: 1, CreatedAt: base.Add(time.Duration(i) * time.Minute)}
		edit(t, s, func(q *txn) { q.addMovementRecord(m) })
	}
	w := call(t, s, http.MethodGet, "/api/v2/stock-movements?kind=sale&pageSize=2&page=2", owner.AccessToken, "", nil)
	if rows := decodeList(t, w); w.Code != http.StatusOK || len(rows) != 1 || rows[0]["kind"] != "sale" || w.Header().Get("X-Total-Count") != "3" || w.Header().Get("X-Page") != "2" {
		t.Fatalf("sales page 2: %d %s %v", w.Code, w.Body.String(), w.Header())
	}
	if w := call(t, s, http.MethodGet, "/api/v2/stock-movements?kind=lost", owner.AccessToken, "", nil); w.Code != http.StatusBadRequest {
		t.Fatalf("unknown kind: %d", w.Code)
	}
}
