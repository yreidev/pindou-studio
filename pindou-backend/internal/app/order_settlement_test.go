package app

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	member "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/membership/application"
)

// 订单接口标出会员结账单（settlement=member），并带上本单动过的会员资产（memberCheckout）：
// 网页据此把退款引到会员退款（按原付款比例，可分多次），确认前展示将退回的本金、赠送与积分，不在前端推算。
// 两个字段只读现有会员流水，不进入订单版本，也不落库。
func TestOrderViewMarksMemberCheckout(t *testing.T) {
	s := newTestServer(t)
	owner := register(t, s, "settle-owner", "老板")
	if err := s.BootstrapOwner(owner.User.ID); err != nil {
		t.Fatal(err)
	}
	manager := register(t, s, "settle-manager", "店长")
	setRoles(t, s, manager.User.ID, Manager)
	clerk := register(t, s, "settle-clerk", "店员")
	setRoles(t, s, clerk.User.ID, Clerk)
	customer := register(t, s, "settle-customer", "顾客")

	publishRule(t, s, owner.AccessToken, member.Rule{Kind: "earn", Name: "消费积分", AmountCents: 100, Points: 1, Scope: "all", ValidDays: 30})
	publishRule(t, s, owner.AccessToken, member.Rule{Kind: "redeem", Name: "抵扣", AmountCents: 100, Points: 10, MaxBasisPoints: 5000, Stack: true})
	loyaltyOK(t, s, owner.AccessToken, loyaltyInput{Action: "adjust", AccountID: customer.User.ID, PrincipalCents: 5000, GiftCents: 1000, Points: 30, Reason: "测试资产"})

	product := decodeMap(t, call(t, s, "POST", "/api/v2/catalog-items", owner.AccessToken, id(), map[string]any{"name": "拼豆材料包", "unitPriceCents": 2000}))["id"].(string)
	stock := &inventoryItem{ID: id(), ProductID: product, Quantity: 5}
	edit(t, s, func(q *txn) { q.addStockItem(stock) })
	// 被拒的请求会整体回滚、换掉内存里的对象，之后一律按 ID 重新取，不拿旧指针
	version := func(o *Order) string { return orderOf(t, s, o.ID).Version() }

	now := s.now()
	memberOrder := &Order{ID: id(), UserID: customer.User.ID, Status: "draft", CreatedAt: now, ReceivableCents: 10000, Lines: []OrderLine{
		{ProductID: product, Name: "拼豆材料包", Quantity: 2, UnitPriceCents: 2000},
		{Name: "计时服务费", Quantity: 1, UnitPriceCents: 6000},
	}}
	standardOrder := &Order{ID: id(), Status: "draft", CreatedAt: now, ReceivableCents: 3000, Lines: []OrderLine{{Name: "服务费", Quantity: 1, UnitPriceCents: 3000}}}
	draftOrder := &Order{ID: id(), UserID: customer.User.ID, Status: "draft", CreatedAt: now, ReceivableCents: 1000, Lines: []OrderLine{{Name: "服务费", Quantity: 1, UnitPriceCents: 1000}}}
	for _, o := range []*Order{memberOrder, standardOrder, draftOrder} {
		edit(t, s, func(q *txn) { q.addOrder(o) })
	}

	// 会员结账：抵扣 30 积分（¥3），本金 ¥50、赠送 ¥10，线下补付 ¥37；按实付 ¥97 送 97 积分。
	quote := loyaltyOK(t, s, manager.AccessToken, loyaltyInput{Action: "quote", TargetID: memberOrder.ID, ExpectedVersion: version(memberOrder), Points: 30, UseBalance: true})
	loyaltyOK(t, s, manager.AccessToken, loyaltyInput{Action: "checkout", TargetID: memberOrder.ID, ExpectedVersion: version(memberOrder), Points: 30, UseBalance: true, QuoteVersion: quote["version"].(string), Method: "cash"})
	if w := call(t, s, "POST", "/api/v2/sales-orders/"+standardOrder.ID+"/payments", manager.AccessToken, id(),
		map[string]any{"expectedVersion": version(standardOrder), "method": "cash", "amountCents": 3000}); w.Code != 201 {
		t.Fatalf("普通收款：%d %s", w.Code, w.Body.String())
	}

	wantCheckout := map[string]any{"principalCents": float64(5000), "giftCents": float64(1000), "pointsUsed": float64(30), "pointsEarned": float64(97), "offlineCents": float64(3700)}
	for key, value := range map[string]any{"principalCents": quote["principalCents"], "giftCents": quote["giftCents"], "pointsUsed": quote["pointsUsed"], "pointsEarned": quote["earnedPoints"], "offlineCents": quote["offlineCents"]} {
		if wantCheckout[key] != value {
			t.Fatalf("夹具与结账预览不一致：%s 预览 %v，期望 %v", key, value, wantCheckout[key])
		}
	}
	assertMember := func(where string, view map[string]any) {
		t.Helper()
		if view["settlement"] != "member" {
			t.Fatalf("%s：会员结账单应标为 member：%v", where, view["settlement"])
		}
		got, _ := view["memberCheckout"].(map[string]any)
		// 原结账的五个数；单张订单另带结账那一刻的余额（balanceAfter），退过款的另带累计已退回（refunded），都在下面单独核对，列表不带；
		// 会员这一笔还能退多少（refundableCents，分笔付款时只算会员这一笔）每处都带，随退款变：没退过时是全部实付，退完为 0
		fields := len(got)
		for _, key := range []string{"balanceAfter", "refunded", "refundableCents"} {
			if _, ok := got[key]; ok {
				fields--
			}
		}
		if left, ok := got["refundableCents"].(float64); !ok || (left != 9700 && left != view["refundableCents"]) {
			t.Fatalf("%s：会员这一笔还能退 %v，订单还能退 %v", where, got["refundableCents"], view["refundableCents"])
		}
		if fields != len(wantCheckout) {
			t.Fatalf("%s：memberCheckout %v", where, view["memberCheckout"])
		}
		for key, value := range wantCheckout {
			if got[key] != value {
				t.Fatalf("%s：memberCheckout.%s = %v，期望 %v", where, key, got[key], value)
			}
		}
	}
	assertStandard := func(where string, view map[string]any) {
		t.Helper()
		if view["settlement"] != "standard" {
			t.Fatalf("%s：应标为 standard：%v", where, view["settlement"])
		}
		if _, ok := view["memberCheckout"]; ok {
			t.Fatalf("%s：普通订单不应带 memberCheckout：%v", where, view["memberCheckout"])
		}
	}
	listOf := func(path, bearer string) map[string]map[string]any {
		t.Helper()
		w := call(t, s, "GET", path, bearer, "", nil)
		var rows []map[string]any
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &rows) != nil {
			t.Fatalf("%s：%d %s", path, w.Code, w.Body.String())
		}
		out := map[string]map[string]any{}
		for _, row := range rows {
			out[row["id"].(string)] = row
		}
		return out
	}

	rows := listOf("/api/v2/sales-orders", clerk.AccessToken)
	assertMember("列表", rows[memberOrder.ID])
	if _, ok := rows[memberOrder.ID]["memberCheckout"].(map[string]any)["balanceAfter"]; ok {
		t.Fatal("列表不带结账后余额")
	}
	assertStandard("列表·普通收款", rows[standardOrder.ID])
	assertStandard("列表·待结账", rows[draftOrder.ID])
	detail := decodeMap(t, call(t, s, "GET", "/api/v2/sales-orders/"+memberOrder.ID, clerk.AccessToken, "", nil))
	assertMember("详情", detail)
	// 结账那一刻：本金 50、赠送 10 全部用掉，积分 30 − 30 + 97
	if after := detail["memberCheckout"].(map[string]any)["balanceAfter"]; !equalJSON(after, map[string]any{"principalCents": 0, "giftCents": 0, "points": 97}) {
		t.Fatalf("详情的结账后余额：%v", after)
	}
	if detail["version"] != version(memberOrder) {
		t.Fatal("附加的结算方式不应改变订单版本")
	}
	assertStandard("详情·普通收款", decodeMap(t, call(t, s, "GET", "/api/v2/sales-orders/"+standardOrder.ID, clerk.AccessToken, "", nil)))
	// 顾客读自己的订单也是同一份响应
	assertMember("顾客本人的订单", listOf("/api/v2/accounts/"+customer.User.ID+"/sales-orders", customer.AccessToken)[memberOrder.ID])

	// 普通退款接口仍然拒绝会员结账单
	if w := call(t, s, "POST", "/api/v2/sales-orders/"+memberOrder.ID+"/refunds", manager.AccessToken, id(),
		map[string]any{"expectedVersion": version(memberOrder), "amountCents": 100, "reason": "退款"}); w.Code != 409 || decodeMap(t, w)["code"] != "loyalty_conflict" {
		t.Fatalf("普通退款应拒绝会员结账单：%d %s", w.Code, w.Body.String())
	}

	refund := loyaltyInput{Action: "refund", AccountID: customer.User.ID, TargetID: memberOrder.ID, ExpectedVersion: version(memberOrder), Reason: "顾客不要了", ReturnedProducts: map[string]int64{product: 1}}
	// 店员不能办会员退款
	if w := loyaltyCall(t, s, clerk.AccessToken, refund); w.Code != 403 {
		t.Fatalf("店员办了会员退款：%d %s", w.Code, w.Body.String())
	}
	// 版本过期：和普通退款一样回 order_version_conflict，什么都不改
	before := s.snapshotData()
	stale := refund
	stale.ExpectedVersion = strings.Repeat("0", 64)
	if w := loyaltyCall(t, s, manager.AccessToken, stale); w.Code != 409 || decodeMap(t, w)["code"] != "order_version_conflict" {
		t.Fatalf("过期版本：%d %s", w.Code, w.Body.String())
	}
	if !bytes.Equal(before, s.snapshotData()) {
		t.Fatal("过期版本的会员退款改动了数据")
	}

	done := loyaltyOK(t, s, manager.AccessToken, refund)
	assertMember("退款响应", done)
	// 不带金额就是退剩余全部：累计退回的正好是原结账的五个数
	refunded, _ := done["memberCheckout"].(map[string]any)["refunded"].(map[string]any)
	for key, value := range map[string]any{"offlineCents": float64(3700), "principalCents": float64(5000), "giftCents": float64(1000), "pointsRestored": float64(30), "pointsClawedBack": float64(97)} {
		if refunded[key] != value {
			t.Fatalf("整单退款后 refunded.%s = %v，期望 %v", key, refunded[key], value)
		}
	}
	if done["status"] != "refunded" || done["refundedCents"] != float64(9700) || done["refundableCents"] != float64(0) {
		t.Fatalf("退款后：%v", done)
	}
	refunds, _ := done["refunds"].([]any)
	if len(refunds) != 1 || refunds[0].(map[string]any)["returnedProducts"].(map[string]any)[product] != float64(1) {
		t.Fatalf("退款记录：%v", done["refunds"])
	}
	if b := memberOf(t, s, customer.User.ID).Balance(customer.User.ID, s.now()); b.PrincipalCents != 5000 || b.GiftCents != 1000 || b.Points != 30 {
		t.Fatalf("退款后会员资产：%+v", b)
	}
	if left := stockByProductOf(t, s, product).Quantity; left != 4 {
		t.Fatalf("库存：卖出 2 件、点回 1 件后应为 4，实际 %d", left)
	}
	// 退满的单再退：订单已变，重新读取后也不能再退
	again := refund
	again.ExpectedVersion = version(memberOrder)
	if w := loyaltyCall(t, s, manager.AccessToken, again); w.Code != 409 || decodeMap(t, w)["code"] != "loyalty_conflict" {
		t.Fatalf("重复退款：%d %s", w.Code, w.Body.String())
	}
	assertMember("退款后的详情", decodeMap(t, call(t, s, "GET", "/api/v2/sales-orders/"+memberOrder.ID, manager.AccessToken, "", nil)))
}

// equalJSON：两个值编成 JSON 后相同（解码出来的数字是 float64，期望值写成整数也能比）。
func equalJSON(a, b any) bool {
	x, errX := json.Marshal(a)
	y, errY := json.Marshal(b)
	return errX == nil && errY == nil && bytes.Equal(x, y)
}
