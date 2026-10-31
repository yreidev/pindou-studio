package app

import (
	"net/http"
	"testing"

	member "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/membership/application"
)

// 小票上的「本单结账后余额」（订单 memberCheckout.balanceAfter）：由不可改写的会员流水推出，不另存。
// 结账的响应、之后重读都是结账那一刻的数；之后又充值、本单整单退款都不改变它；列表不带（要读每位顾客的全部流水）。
func TestReceiptBalanceAfterCheckout(t *testing.T) {
	s := newTestServer(t)
	owner := register(t, s, "after-owner", "老板")
	if err := s.BootstrapOwner(owner.User.ID); err != nil {
		t.Fatal(err)
	}
	clerk := register(t, s, "after-clerk", "店员")
	setRoles(t, s, clerk.User.ID, Clerk)
	li := register(t, s, "after-li", "小李")
	rich := register(t, s, "after-rich", "小王")
	publishRule(t, s, owner.AccessToken, member.Rule{Kind: "earn", Name: "消费积分", AmountCents: 100, Points: 1, Scope: "all"})
	loyaltyOK(t, s, owner.AccessToken, loyaltyInput{Action: "adjust", AccountID: li.User.ID, PrincipalCents: 1000, Points: 7, Reason: "测试资产"})
	loyaltyOK(t, s, owner.AccessToken, loyaltyInput{Action: "adjust", AccountID: rich.User.ID, PrincipalCents: 9000, Reason: "测试资产"})

	balanceAfter := func(o map[string]any) map[string]any {
		t.Helper()
		after, ok := o["memberCheckout"].(map[string]any)["balanceAfter"].(map[string]any)
		if !ok {
			t.Fatalf("没有结账后余额：%v", o["memberCheckout"])
		}
		return after
	}

	// 先扣本金 10 元，线下补付 20 元走微信，本单送 30 积分
	orderID, version := draftWithLine(t, s, clerk.AccessToken, li.User.ID, 3000)
	quote := loyaltyOK(t, s, clerk.AccessToken, loyaltyInput{Action: "quote", TargetID: orderID, ExpectedVersion: version, UseBalance: true})
	order := loyaltyOK(t, s, clerk.AccessToken, loyaltyInput{Action: "checkout", TargetID: orderID, ExpectedVersion: version, QuoteVersion: quote["version"].(string), UseBalance: true, Method: "wechat"})["order"].(map[string]any)

	// 结账那一刻：本金 10 − 10 = 0，积分 7 + 30 = 37
	want := map[string]any{"principalCents": float64(0), "giftCents": float64(0), "points": float64(37)}
	same := func(when string, got map[string]any) {
		t.Helper()
		for k, v := range want {
			if got[k] != v {
				t.Fatalf("%s：%v", when, got)
			}
		}
	}
	same("结账的响应", balanceAfter(order))
	read := func() map[string]any {
		return decodeMap(t, call(t, s, http.MethodGet, "/api/v2/sales-orders/"+orderID, clerk.AccessToken, "", nil))
	}
	same("重读订单", balanceAfter(read()))
	// 之后又充了 50 元：现在的余额变了，小票上本单结账后的余额不变
	loyaltyOK(t, s, owner.AccessToken, loyaltyInput{Action: "adjust", AccountID: li.User.ID, PrincipalCents: 5000, Reason: "后来充值"})
	if b := memberOf(t, s, li.User.ID).Balance(li.User.ID, s.now()); b.PrincipalCents != 5000 {
		t.Fatalf("现在的余额：%+v", b)
	}
	same("之后充值", balanceAfter(read()))
	// 整单退款之后重印小票：仍是结账那一刻的
	current := read()
	loyaltyOK(t, s, owner.AccessToken, loyaltyInput{Action: "refund", TargetID: orderID, ExpectedVersion: current["version"].(string), Reason: "顾客要求"})
	same("本单退款之后", balanceAfter(read()))
	// 列表不带
	list := call(t, s, http.MethodGet, "/api/v2/sales-orders?status=refunded&pageSize=20", clerk.AccessToken, "", nil)
	for _, o := range decodeList(t, list) {
		if o["id"] == orderID {
			if _, has := o["memberCheckout"].(map[string]any)["balanceAfter"]; has {
				t.Fatal("列表不该带结账后余额")
			}
		}
	}

	// 余额付清、没有线下款的会员结账同样有：本金 90 − 30 = 60，送 30 积分
	paidUp, v := draftWithLine(t, s, clerk.AccessToken, rich.User.ID, 3000)
	q := loyaltyOK(t, s, clerk.AccessToken, loyaltyInput{Action: "quote", TargetID: paidUp, ExpectedVersion: v, UseBalance: true})
	done := loyaltyOK(t, s, clerk.AccessToken, loyaltyInput{Action: "checkout", TargetID: paidUp, ExpectedVersion: v, QuoteVersion: q["version"].(string), UseBalance: true})["order"].(map[string]any)
	if after := balanceAfter(done); after["principalCents"] != float64(6000) || after["giftCents"] != float64(0) || after["points"] != float64(30) {
		t.Fatalf("余额付清后的余额：%v", after)
	}
	// 普通收款（散客单）没有会员结账，也就没有结账后余额
	walkIn, wv := draftWithLine(t, s, clerk.AccessToken, "", 1000)
	w := call(t, s, http.MethodPost, "/api/v2/sales-orders/"+walkIn+"/payments", clerk.AccessToken, id(), map[string]any{"expectedVersion": wv, "method": "wechat", "amountCents": 1000})
	if w.Code != 201 {
		t.Fatalf("散客单收款：%d %s", w.Code, w.Body.String())
	}
	if _, has := decodeMap(t, w)["memberCheckout"]; has {
		t.Fatal("散客单不该有会员结账")
	}
}
