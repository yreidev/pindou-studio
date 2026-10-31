package app

import (
	"bytes"
	"net/http"
	"testing"

	member "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/membership/application"
)

// 现金实收与找零（迁移 017）：现金收款时员工可选填顾客给的现金，后端算出找零，和实收一起记在付款记录上、
// 订单视图原样返回（网页小票照印）。只有现金能填，实收不能少于收款金额，找零不超过 ¥1,000；填错了什么都不登记。

func cents(v int64) *int64 { return &v }

// draftWithLine 建一张散客或某位顾客的草稿单，一行自定义服务，返回订单编号与版本。
func draftWithLine(t *testing.T, s *Server, bearer, account string, price int64) (string, string) {
	t.Helper()
	body := map[string]any{}
	if account != "" {
		body["accountId"] = account
	}
	created := decodeMap(t, call(t, s, http.MethodPost, "/api/v2/sales-orders", bearer, id(), body))
	w := call(t, s, http.MethodPatch, "/api/v2/sales-orders/"+created["id"].(string), bearer, id(), map[string]any{
		"expectedVersion": created["version"], "lines": []map[string]any{{"name": "计时服务费", "quantity": 1, "unitPriceCents": price}},
	})
	if w.Code != 200 {
		t.Fatalf("明细：%d %s", w.Code, w.Body.String())
	}
	return created["id"].(string), decodeMap(t, w)["version"].(string)
}

// tenderOf 是库里这笔付款的实收与找零两列（"" 表示没记）。
func tenderOf(t *testing.T, s *Server, paymentID string) string {
	t.Helper()
	return view(t, s, func(q *txn) string {
		return scalar[string](q, `SELECT COALESCE(cash_received_cents::text || '/' || change_cents::text, '') FROM payment_records WHERE id = $1`, paymentID)
	})
}

func TestCashPaymentRecordsTenderAndChange(t *testing.T) {
	s := newTestServer(t)
	owner := register(t, s, "tender-owner", "老板")
	if err := s.BootstrapOwner(owner.User.ID); err != nil {
		t.Fatal(err)
	}
	clerk := register(t, s, "tender-clerk", "店员")
	setRoles(t, s, clerk.User.ID, Clerk)
	orderID, version := draftWithLine(t, s, clerk.AccessToken, "", 2990)
	pay := func(body map[string]any) *httpResponse {
		w := call(t, s, http.MethodPost, "/api/v2/sales-orders/"+orderID+"/payments", clerk.AccessToken, id(), body)
		return &httpResponse{code: w.Code, body: w.Body.Bytes(), decoded: func() map[string]any { return decodeMap(t, w) }}
	}

	before := s.snapshotData()
	for name, body := range map[string]map[string]any{
		"微信不能填实收":     {"expectedVersion": version, "method": "wechat", "amountCents": 2990, "cashReceivedCents": 5000},
		"支付宝不能填实收":    {"expectedVersion": version, "method": "alipay", "amountCents": 2990, "cashReceivedCents": 5000},
		"实收少于收款金额":    {"expectedVersion": version, "method": "cash", "amountCents": 2990, "cashReceivedCents": 2989},
		"找零超过 1000 元": {"expectedVersion": version, "method": "cash", "amountCents": 2990, "cashReceivedCents": 2990 + 100001},
		"实收为 0（不是没填）": {"expectedVersion": version, "method": "cash", "amountCents": 2990, "cashReceivedCents": 0},
	} {
		if w := pay(body); w.code != 400 || w.decoded()["code"] != "invalid_request" {
			t.Fatalf("%s：%d %s", name, w.code, w.body)
		}
	}
	// 别的写请求不能夹带实收现金
	if w := call(t, s, http.MethodPatch, "/api/v2/sales-orders/"+orderID, clerk.AccessToken, id(), map[string]any{
		"expectedVersion": version, "lines": []map[string]any{{"name": "计时服务费", "quantity": 1, "unitPriceCents": 2990}}, "cashReceivedCents": 5000,
	}); w.Code != 400 || decodeMap(t, w)["code"] != "invalid_request" {
		t.Fatalf("改明细夹带实收：%d %s", w.Code, w.Body.String())
	}
	if !bytes.Equal(before, s.snapshotData()) {
		t.Fatal("被拒的收款改动了数据")
	}

	// 顾客给 50 元：找零 20.10，记在付款上，订单视图原样返回
	paid := pay(map[string]any{"expectedVersion": version, "method": "cash", "amountCents": 2990, "cashReceivedCents": 5000})
	if paid.code != 201 {
		t.Fatalf("现金收款：%d %s", paid.code, paid.body)
	}
	payment := paid.decoded()["payments"].([]any)[0].(map[string]any)
	if payment["method"] != "cash" || payment["amountCents"] != float64(2990) || payment["cashReceivedCents"] != float64(5000) || payment["changeCents"] != float64(2010) {
		t.Fatalf("付款：%v", payment)
	}
	if got := tenderOf(t, s, payment["id"].(string)); got != "5000/2010" {
		t.Fatalf("库里的实收与找零：%q", got)
	}
	again := decodeMap(t, call(t, s, http.MethodGet, "/api/v2/sales-orders/"+orderID, clerk.AccessToken, "", nil))
	if p := again["payments"].([]any)[0].(map[string]any); p["changeCents"] != float64(2010) || p["cashReceivedCents"] != float64(5000) {
		t.Fatalf("重读订单：%v", p)
	}

	// 刚好给够：找零 0 也照记（0 不是没记）；不填实收的现金、微信收款照旧，不带这两个字段
	exact, v2 := draftWithLine(t, s, clerk.AccessToken, "", 1500)
	w := call(t, s, http.MethodPost, "/api/v2/sales-orders/"+exact+"/payments", clerk.AccessToken, id(), map[string]any{"expectedVersion": v2, "method": "cash", "amountCents": 1500, "cashReceivedCents": 1500})
	if p := decodeMap(t, w)["payments"].([]any)[0].(map[string]any); w.Code != 201 || p["changeCents"] != float64(0) || p["cashReceivedCents"] != float64(1500) {
		t.Fatalf("刚好给够：%d %s", w.Code, w.Body.String())
	}
	plain, v3 := draftWithLine(t, s, clerk.AccessToken, "", 800)
	w = call(t, s, http.MethodPost, "/api/v2/sales-orders/"+plain+"/payments", clerk.AccessToken, id(), map[string]any{"expectedVersion": v3, "method": "cash", "amountCents": 800})
	p := decodeMap(t, w)["payments"].([]any)[0].(map[string]any)
	if _, has := p["cashReceivedCents"]; w.Code != 201 || has || p["changeCents"] != nil {
		t.Fatalf("没填实收：%d %s", w.Code, w.Body.String())
	}
	if got := tenderOf(t, s, p["id"].(string)); got != "" {
		t.Fatalf("没填实收时两列应为空：%q", got)
	}
}

// 会员结账的线下补付走现金时同样可填实收；别的情况带了实收都是请求不对（400，什么都不改）。
func TestMemberCheckoutCashTender(t *testing.T) {
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

	orderID, version := draftWithLine(t, s, clerk.AccessToken, li.User.ID, 3000)
	// 报价：先扣本金 10 元，线下补付 20 元，本单送 30 积分
	quote := loyaltyOK(t, s, clerk.AccessToken, loyaltyInput{Action: "quote", TargetID: orderID, ExpectedVersion: version, UseBalance: true})
	if quote["principalCents"] != float64(1000) || quote["offlineCents"] != float64(2000) || quote["earnedPoints"] != float64(30) {
		t.Fatalf("报价：%v", quote)
	}
	checkout := loyaltyInput{Action: "checkout", TargetID: orderID, ExpectedVersion: version, QuoteVersion: quote["version"].(string), UseBalance: true}

	before := s.snapshotData()
	for name, in := range map[string]loyaltyInput{
		"补付走微信不能填实收": func() loyaltyInput { c := checkout; c.Method, c.CashReceivedCents = "wechat", cents(5000); return c }(),
		"实收少于补付":     func() loyaltyInput { c := checkout; c.Method, c.CashReceivedCents = "cash", cents(1999); return c }(),
		"找零超过 1000 元": func() loyaltyInput {
			c := checkout
			c.Method, c.CashReceivedCents = "cash", cents(2000+100001)
			return c
		}(),
		"报价不能带实收":   {Action: "quote", TargetID: orderID, ExpectedVersion: version, UseBalance: true, CashReceivedCents: cents(5000)},
		"别的动作不能带实收": {Action: "adjust", AccountID: li.User.ID, PrincipalCents: 1, Reason: "x", CashReceivedCents: cents(5000)},
	} {
		if w := loyaltyCall(t, s, owner.AccessToken, in); w.Code != 400 || decodeMap(t, w)["code"] != "invalid_request" {
			t.Fatalf("%s：%d %s", name, w.Code, w.Body.String())
		}
	}
	if !bytes.Equal(before, s.snapshotData()) {
		t.Fatal("被拒的会员结账改动了数据")
	}

	// 顾客给 50 元现金补 20 元：找零 30 元记在现金那笔付款上，储值支付那笔不带
	checkout.Method, checkout.CashReceivedCents = "cash", cents(5000)
	out := loyaltyOK(t, s, clerk.AccessToken, checkout)
	order := out["order"].(map[string]any)
	var cash, balance map[string]any
	for _, p := range order["payments"].([]any) {
		switch p := p.(map[string]any); p["method"] {
		case "cash":
			cash = p
		case "balance":
			balance = p
		}
	}
	if cash["amountCents"] != float64(2000) || cash["cashReceivedCents"] != float64(5000) || cash["changeCents"] != float64(3000) {
		t.Fatalf("现金补付：%v", cash)
	}
	if _, has := balance["cashReceivedCents"]; has || balance["amountCents"] != float64(1000) {
		t.Fatalf("储值支付：%v", balance)
	}
	if got := tenderOf(t, s, cash["id"].(string)); got != "5000/3000" {
		t.Fatalf("库里的实收与找零：%q", got)
	}

	// 余额付清、不用收线下款：带实收是请求不对
	paidUp, v := draftWithLine(t, s, clerk.AccessToken, rich.User.ID, 3000)
	q := loyaltyOK(t, s, clerk.AccessToken, loyaltyInput{Action: "quote", TargetID: paidUp, ExpectedVersion: v, UseBalance: true})
	if q["offlineCents"] != float64(0) {
		t.Fatalf("应当余额付清：%v", q)
	}
	before = s.snapshotData()
	full := loyaltyInput{Action: "checkout", TargetID: paidUp, ExpectedVersion: v, QuoteVersion: q["version"].(string), UseBalance: true, Method: "cash", CashReceivedCents: cents(100)}
	if w := loyaltyCall(t, s, clerk.AccessToken, full); w.Code != 400 || decodeMap(t, w)["code"] != "invalid_request" {
		t.Fatalf("不用收线下款却带实收：%d %s", w.Code, w.Body.String())
	}
	if !bytes.Equal(before, s.snapshotData()) {
		t.Fatal("被拒的会员结账改动了数据")
	}
	full.CashReceivedCents = nil
	if done := loyaltyOK(t, s, clerk.AccessToken, full)["order"].(map[string]any); done["status"] != "paid" || len(done["payments"].([]any)) != 1 {
		t.Fatalf("余额付清：%v", done)
	}
}
