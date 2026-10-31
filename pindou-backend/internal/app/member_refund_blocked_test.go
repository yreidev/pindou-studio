package app

import (
	"bytes"
	"testing"

	member "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/membership/application"
)

// 会员结账单送出的积分被后来的结账用掉后，退剩余全部收不回这部分积分：订单详情提前说明缺多少、被哪张单用掉、
// 现在最多能退多少，提交退款照样被拒且不改数据；先退掉用了积分的那张单，积分回到原批次，这单就能退了。
func TestMemberRefundBlockedWhenEarnedPointsSpent(t *testing.T) {
	s := newTestServer(t)
	owner := register(t, s, "blocked-owner", "老板")
	if err := s.BootstrapOwner(owner.User.ID); err != nil {
		t.Fatal(err)
	}
	manager := register(t, s, "blocked-manager", "店长")
	setRoles(t, s, manager.User.ID, Manager)
	customer := register(t, s, "blocked-customer", "顾客")

	publishRule(t, s, owner.AccessToken, member.Rule{Kind: "earn", Name: "消费积分", AmountCents: 100, Points: 1, Scope: "all", ValidDays: 30})
	publishRule(t, s, owner.AccessToken, member.Rule{Kind: "redeem", Name: "抵扣", AmountCents: 100, Points: 10, MaxBasisPoints: 5000, Stack: true})

	now := s.now()
	first := &Order{ID: id(), UserID: customer.User.ID, Status: "draft", CreatedAt: now, ReceivableCents: 10000, Lines: []OrderLine{{Name: "计时服务费", Quantity: 1, UnitPriceCents: 10000}}}
	second := &Order{ID: id(), UserID: customer.User.ID, Status: "draft", CreatedAt: now, ReceivableCents: 2000, Lines: []OrderLine{{Name: "材料包", Quantity: 1, UnitPriceCents: 2000}}}
	edit(t, s, func(q *txn) { q.addOrder(first) })
	edit(t, s, func(q *txn) { q.addOrder(second) })
	// 被拒的请求会整体回滚、换掉内存里的对象，之后一律按 ID 重新取
	version := func(o *Order) string { return orderOf(t, s, o.ID).Version() }
	checkout := func(o *Order, points int64) {
		t.Helper()
		quote := loyaltyOK(t, s, manager.AccessToken, loyaltyInput{Action: "quote", TargetID: o.ID, ExpectedVersion: version(o), Points: points})
		loyaltyOK(t, s, manager.AccessToken, loyaltyInput{Action: "checkout", TargetID: o.ID, ExpectedVersion: version(o), Points: points, QuoteVersion: quote["version"].(string), Method: "cash"})
	}
	detail := func(o *Order) map[string]any {
		t.Helper()
		return decodeMap(t, call(t, s, "GET", "/api/v2/sales-orders/"+o.ID, manager.AccessToken, "", nil))
	}
	blockedOf := func(view map[string]any) map[string]any {
		blocked, _ := view["memberCheckout"].(map[string]any)["refundBlocked"].(map[string]any)
		return blocked
	}

	// 第一单现金结账，按实付 ¥100 送 100 积分；第二单用其中 50 分抵 ¥5
	checkout(first, 0)
	if b := blockedOf(detail(first)); b != nil {
		t.Fatalf("积分还没用，不该拦：%v", b)
	}
	checkout(second, 50)

	// 退剩余全部要收回 100 分，批次只剩 50 分：缺 50 分。按比例收回不超过 50 分的最多能退 ¥50.99
	reason := memberRefundBlockedReason(100, 50, 5099)
	blocked := blockedOf(detail(first))
	if blocked == nil || blocked["reason"] != reason || blocked["pointsShort"] != float64(50) || blocked["maxRefundableCents"] != float64(5099) {
		t.Fatalf("积分被用掉后应提前说明：%v", blocked)
	}
	spent, _ := blocked["spentBy"].([]any)
	if len(spent) != 1 {
		t.Fatalf("spentBy：%v", blocked["spentBy"])
	}
	if by := spent[0].(map[string]any); by["kind"] != "checkout" || by["sourceId"] != second.ID || by["points"] != float64(50) {
		t.Fatalf("spentBy 应指向第二单：%v", by)
	}
	// 列表不做这项核对（要扫这位顾客的全部流水）
	var rows []map[string]any
	for _, row := range decodeList(t, call(t, s, "GET", "/api/v2/sales-orders", manager.AccessToken, "", nil)) {
		rows = append(rows, row)
		if row["id"] == first.ID && blockedOf(row) != nil {
			t.Fatalf("列表不该带 refundBlocked：%v", row)
		}
	}
	if len(rows) == 0 {
		t.Fatal("列表为空")
	}

	// 照样提交：拒绝，原因同一句话，数据不变
	before := s.snapshotData()
	refundFirst := loyaltyInput{Action: "refund", AccountID: customer.User.ID, TargetID: first.ID, ExpectedVersion: version(first), Reason: "顾客要退"}
	w := loyaltyCall(t, s, manager.AccessToken, refundFirst)
	if body := decodeMap(t, w); w.Code != 409 || body["code"] != "loyalty_conflict" || body["message"] != reason {
		t.Fatalf("应拒绝并说明原因：%d %v", w.Code, body)
	}
	if !bytes.Equal(before, s.snapshotData()) {
		t.Fatal("被拒的会员退款改动了数据")
	}

	// 先退第二单：抵扣的 50 分回到第一单送分的批次，第一单就能退了
	loyaltyOK(t, s, manager.AccessToken, loyaltyInput{Action: "refund", AccountID: customer.User.ID, TargetID: second.ID, ExpectedVersion: version(second), Reason: "先退这单"})
	if b := blockedOf(detail(first)); b != nil {
		t.Fatalf("第二单退掉后不该再拦：%v", b)
	}
	refundFirst.ExpectedVersion = version(first)
	if done := loyaltyOK(t, s, manager.AccessToken, refundFirst); done["status"] != "refunded" {
		t.Fatalf("第一单应能退：%v", done)
	}
	if b := memberOf(t, s, customer.User.ID).Balance(customer.User.ID, s.now()); b.Points != 0 {
		t.Fatalf("两单都退后积分应归零：%+v", b)
	}
	// 已退的单不再核对
	if b := blockedOf(detail(first)); b != nil {
		t.Fatalf("已退款的单不该带 refundBlocked：%v", b)
	}
}
