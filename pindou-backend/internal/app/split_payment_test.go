package app

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	catalogapp "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/catalog/application"
	member "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/membership/application"
)

// 分笔付款（多人合付，2026-10-06 业主定）：一单可以分几笔收，每笔自选方式，收齐（已收 + 免单 = 应收）才算付清；
// 没收齐是部分付款（partially_paid），可以接着收下一笔或对剩余免单。收第一笔时计价与明细冻结、计时停在这一刻；
// 退款按员工选的那一笔退，会员结账那一笔按原付款比例退，免单那一笔不能退。

// splitShop 是分笔付款测试的门店：时钟停着（policyShop），另有店员、店长。
type splitShop struct {
	*policyShop
	clerk, manager sessionResponse
}

func newSplitShop(t *testing.T) *splitShop {
	t.Helper()
	p := newPolicyShop(t)
	clerk := register(t, p.s, "split-clerk", "店员")
	setRoles(t, p.s, clerk.User.ID, Clerk)
	manager := register(t, p.s, "split-manager", "店长")
	setRoles(t, p.s, manager.User.ID, Manager)
	return &splitShop{policyShop: p, clerk: clerk, manager: manager}
}

// draft 建一张散客单，一行自定义服务 price 分，返回订单（响应）。
func (x *splitShop) draft(t *testing.T, price int64) map[string]any {
	t.Helper()
	orderID, _ := draftWithLine(t, x.s, x.clerk.AccessToken, "", price)
	return x.order(t, orderID)
}

// pay 收一笔，返回状态码与响应。
func (x *splitShop) pay(t *testing.T, bearer, key string, order map[string]any, method string, amount int64, extra map[string]any) (int, map[string]any) {
	t.Helper()
	body := map[string]any{"expectedVersion": order["version"], "method": method, "amountCents": amount}
	for k, v := range extra {
		body[k] = v
	}
	w := call(t, x.s, http.MethodPost, "/api/v2/sales-orders/"+order["id"].(string)+"/payments", bearer, key, body)
	return w.Code, decodeMap(t, w)
}

func (x *splitShop) refund(t *testing.T, order map[string]any, body map[string]any) (int, map[string]any) {
	t.Helper()
	body["expectedVersion"] = order["version"]
	w := call(t, x.s, http.MethodPost, "/api/v2/sales-orders/"+order["id"].(string)+"/refunds", x.manager.AccessToken, id(), body)
	return w.Code, decodeMap(t, w)
}

func cents64(v any) int64 { return int64(v.(float64)) }

func paymentsOf(order map[string]any) []map[string]any {
	out := []map[string]any{}
	list, _ := order["payments"].([]any)
	for _, p := range list {
		out = append(out, p.(map[string]any))
	}
	return out
}

// 收第一笔时计时停在这一刻、计价与明细冻结：之后时间再走金额不变，不能改明细、打折、换顾客，也不能撤销开台；
// 去结账回到这张单；「待结账」列表里有它。第二笔收齐，订单结清、会话结清。
func TestSplitPaymentFreezesTimingAndSettlesOnSecond(t *testing.T) {
	x := newSplitShop(t)
	x.renewalPackage(t)
	session := x.open(t, "A1", map[string]any{"timingMode": "timed", "durationMinutes": 60})
	x.at(65 * time.Minute) // 超时 5 分钟，在宽限内
	draft := x.checkout(t, session)
	if receivable(draft) != 2990 || cents64(draft["outstandingCents"]) != 2990 {
		t.Fatalf("草稿还差的就是应收：%v %v", receivable(draft), draft["outstandingCents"])
	}

	code, first := x.pay(t, x.clerk.AccessToken, "first", draft, "wechat", 1000, nil)
	if code != 201 || first["status"] != "partially_paid" || cents64(first["paidCents"]) != 1000 || cents64(first["outstandingCents"]) != 1990 || len(paymentsOf(first)) != 1 {
		t.Fatalf("收第一笔 ¥10：部分付款、还差 ¥19.90：%d %v", code, first)
	}
	if _, present := first["timing"]; present {
		t.Fatal("部分付款的单不再带计时说明（计价已冻结）")
	}
	if p := paymentsOf(first)[0]; p["refundableCents"] != nil || p["member"] != nil {
		t.Fatalf("部分付款的单还不能退，付款上不带可退：%v", p)
	}
	x0 := sessionOf(t, x.s, session)
	if x0.StoppedAt == nil || !x0.StoppedAt.Equal(x.t0.Add(65*time.Minute)) || x0.Status != "active" {
		t.Fatalf("收第一笔时计时停在这一刻：%+v", x0)
	}
	if table := tableViewOf(t, x.s, tableByCode(t, x.s, "A1").ID); table["stopped"] != true || table["estimatedCents"] != nil || table["charge"] == nil {
		t.Fatalf("桌位写待结账；收了一部分就不再报整单估价（还差多少看订单）：%v", table)
	}

	// 时间再走：已经超时 35 分钟，部分付款的单不再加收
	x.at(95 * time.Minute)
	frozen := x.order(t, first["id"].(string))
	if receivable(frozen) != 2990 || frozen["version"] != first["version"] || cents64(frozen["outstandingCents"]) != 1990 {
		t.Fatalf("收第一笔后明细冻结，不再随时间变：%v %v", receivable(frozen), frozen["outstandingCents"])
	}
	stored := view(t, x.s, func(q *txn) string {
		return scalar[string](q, `SELECT status || '/' || receivable_cents || '/' || paid_cents FROM sales_orders WHERE id = $1`, first["id"])
	})
	if stored != "partially_paid/2990/1000" {
		t.Fatalf("库里记的是部分付款（旧版本只认 draft 才收款，不会再整单收一次）：%s", stored)
	}

	orderID := first["id"].(string)
	closed := map[string]*struct {
		method, path string
		body         map[string]any
	}{
		"改明细": {http.MethodPatch, "/api/v2/sales-orders/" + orderID, map[string]any{"expectedVersion": first["version"], "lines": []map[string]any{{"name": "1小时", "quantity": 1, "unitPriceCents": 1}}}},
		"换顾客": {http.MethodPatch, "/api/v2/sales-orders/" + orderID + "/customer", map[string]any{"expectedVersion": first["version"], "accountId": x.clerk.User.ID}},
	}
	for name, c := range closed {
		if w := call(t, x.s, c.method, c.path, x.owner.AccessToken, id(), c.body); w.Code != 409 || decodeMap(t, w)["code"] != "order_closed" {
			t.Fatalf("%s：部分付款的单不能改：%d %s", name, w.Code, w.Body.String())
		}
	}
	if w := call(t, x.s, http.MethodPost, "/api/v2/sales-orders/"+orderID+"/discounts", x.owner.AccessToken, id(),
		map[string]any{"expectedVersion": first["version"], "kind": "fixed", "amountCents": 100, "reason": "熟客"}); w.Code != 400 {
		t.Fatalf("部分付款的单不能打折：%d %s", w.Code, w.Body.String())
	}
	if code, out := x.refund(t, first, map[string]any{"amountCents": 100, "reason": "退一点"}); code != 400 || !strings.Contains(out["message"].(string), "还没收齐") {
		t.Fatalf("部分付款的单不能退款：%d %v", code, out)
	}
	if w := call(t, x.s, http.MethodDelete, "/api/v2/venue-sessions/"+session, x.owner.AccessToken, "", nil); w.Code != 409 || decodeMap(t, w)["code"] != "partially_paid" {
		t.Fatalf("收了一部分的台不能撤销：%d %s", w.Code, w.Body.String())
	}
	if again := x.checkout(t, session); again["id"] != orderID || again["status"] != "partially_paid" {
		t.Fatalf("去结账回到这张部分付款的单：%v", again)
	}
	for status, want := range map[string]bool{"open": true, "partially_paid": true, "draft": false} {
		rows := decodeList(t, call(t, x.s, http.MethodGet, "/api/v2/sales-orders?status="+status, x.clerk.AccessToken, "", nil))
		found := false
		for _, row := range rows {
			found = found || row["id"] == orderID
		}
		if found != want {
			t.Fatalf("status=%s 里有没有部分付款的单：%v，期望 %v", status, found, want)
		}
	}

	// 第二笔现金收齐：找零按这一笔算
	code, settled := x.pay(t, x.clerk.AccessToken, "second", frozen, "cash", 1990, map[string]any{"cashReceivedCents": 2000})
	if code != 201 || settled["status"] != "paid" || cents64(settled["paidCents"]) != 2990 || cents64(settled["outstandingCents"]) != 0 {
		t.Fatalf("第二笔收齐：%d %v", code, settled)
	}
	payments := paymentsOf(settled)
	if len(payments) != 2 || payments[0]["method"] != "wechat" || payments[1]["method"] != "cash" || cents64(payments[1]["changeCents"]) != 10 || cents64(payments[1]["refundableCents"]) != 1990 || cents64(payments[0]["refundableCents"]) != 1000 {
		t.Fatalf("两笔各记方式与金额，找零记在第二笔：%v", payments)
	}
	if got := sessionOf(t, x.s, session); got.Status != "settled" {
		t.Fatalf("收齐后会话结清：%s", got.Status)
	}
	if code, out := x.pay(t, x.clerk.AccessToken, "third", settled, "cash", 1, nil); code != 409 || out["code"] != "order_closed" {
		t.Fatalf("收齐后不能再收：%d %v", code, out)
	}
	actions := []string{}
	for _, a := range auditsOf(t, x.s) {
		if a.ObjectID == orderID || a.ObjectID == session {
			actions = append(actions, a.Action)
		}
	}
	if !strings.Contains(strings.Join(actions, ","), "order.payment.partial") || !strings.Contains(strings.Join(actions, ","), "venue_session.stopped") || !strings.Contains(strings.Join(actions, ","), "order.paid") {
		t.Fatalf("审计：分笔收款、计时停止、收齐：%v", actions)
	}
}

// 三笔收齐；每笔不超过还差的数，超了什么都不登记；收第一笔时商品出库一次，之后分笔收不再动库存。
// 退款按笔：分几笔收的单要选哪一笔，每笔最多退「这笔金额 − 已退」；收到的钱都退完订单才是已退款。
func TestSplitPaymentThreeWaysOverpayAndRefundByPayment(t *testing.T) {
	x := newSplitShop(t)
	var productID string
	edit(t, x.s, func(q *txn) {
		item := &catalogapp.Item{ID: id(), Name: "拼豆材料包", UnitPriceCents: 2000}
		q.addCatalogItem(item)
		productID = item.ID
		q.addStockItem(&inventoryItem{ID: id(), ProductID: item.ID, Quantity: 5})
	})
	created := decodeMap(t, call(t, x.s, http.MethodPost, "/api/v2/sales-orders", x.clerk.AccessToken, id(), map[string]any{}))
	w := call(t, x.s, http.MethodPatch, "/api/v2/sales-orders/"+created["id"].(string), x.clerk.AccessToken, id(), map[string]any{
		"expectedVersion": created["version"], "lines": []map[string]any{{"productId": productID, "name": "拼豆材料包", "quantity": 2, "unitPriceCents": 2000}, {"name": "计时服务费", "quantity": 1, "unitPriceCents": 6000}},
	})
	order := decodeMap(t, w)

	before := x.s.snapshotData()
	if code, out := x.pay(t, x.clerk.AccessToken, "too-much", order, "cash", 10001, nil); code != 400 || !strings.Contains(out["message"].(string), "超过了还差的 ¥100.00") {
		t.Fatalf("超收拒绝：%d %v", code, out)
	}
	if string(before) != string(x.s.snapshotData()) {
		t.Fatal("被拒的超收改了数据")
	}
	stock := func() int64 { return stockByProductOf(t, x.s, productID).Quantity }

	code, one := x.pay(t, x.clerk.AccessToken, "one", order, "wechat", 3333, nil)
	if code != 201 || one["status"] != "partially_paid" || stock() != 3 {
		t.Fatalf("第一笔：%d %v，库存 %d", code, one, stock())
	}
	if code, out := x.pay(t, x.clerk.AccessToken, "two-too-much", one, "alipay", 6668, nil); code != 400 || !strings.Contains(out["message"].(string), "¥66.67") {
		t.Fatalf("第二笔超收：%d %v", code, out)
	}
	code, two := x.pay(t, x.clerk.AccessToken, "two", one, "alipay", 3333, nil)
	if code != 201 || two["status"] != "partially_paid" || cents64(two["outstandingCents"]) != 3334 || stock() != 3 {
		t.Fatalf("第二笔：%d %v，库存 %d", code, two, stock())
	}
	code, three := x.pay(t, x.clerk.AccessToken, "three", two, "cash", 3334, nil)
	if code != 201 || three["status"] != "paid" || cents64(three["paidCents"]) != 10000 || stock() != 3 || len(paymentsOf(three)) != 3 {
		t.Fatalf("第三笔收齐，库存只出一次：%d %v，库存 %d", code, three, stock())
	}
	sales := 0
	for _, m := range movementsOf(t, x.s) {
		if m.Kind == "sale" {
			sales++
		}
	}
	if sales != 1 {
		t.Fatalf("出库流水只记一次：%d", sales)
	}

	payments := paymentsOf(three)
	p1, p2 := payments[0]["id"].(string), payments[1]["id"].(string)
	if code, out := x.refund(t, three, map[string]any{"amountCents": 100, "reason": "少给了"}); code != 400 || !strings.Contains(out["message"].(string), "请选择退哪一笔") {
		t.Fatalf("分几笔收的单要选哪一笔：%d %v", code, out)
	}
	if code, out := x.refund(t, three, map[string]any{"paymentId": p1, "amountCents": 3334, "reason": "多退"}); code != 400 {
		t.Fatalf("超过这一笔能退的：%d %v", code, out)
	}
	if code, out := x.refund(t, three, map[string]any{"paymentId": id(), "amountCents": 1, "reason": "不是这单的"}); code != 400 {
		t.Fatalf("不是这一单的付款：%d %v", code, out)
	}
	code, r1 := x.refund(t, three, map[string]any{"paymentId": p1, "amountCents": 3333, "reason": "朋友先走了", "returnedProducts": map[string]any{productID: 1}})
	if code != 201 || r1["status"] != "paid" || cents64(r1["refundableCents"]) != 6667 || stock() != 4 {
		t.Fatalf("退第一笔：%d %v，库存 %d", code, r1, stock())
	}
	after := paymentsOf(r1)
	if cents64(after[0]["refundableCents"]) != 0 || cents64(after[0]["refundedCents"]) != 3333 || cents64(after[1]["refundableCents"]) != 3333 {
		t.Fatalf("各笔已退、可退：%v", after)
	}
	if refunds := r1["refunds"].([]any); refunds[0].(map[string]any)["paymentId"] != p1 {
		t.Fatalf("退款记下是哪一笔：%v", refunds)
	}
	if code, out := x.refund(t, r1, map[string]any{"paymentId": p1, "amountCents": 1, "reason": "再退"}); code != 400 {
		t.Fatalf("退完的那一笔不能再退：%d %v", code, out)
	}
	code, r2 := x.refund(t, r1, map[string]any{"paymentId": p2, "amountCents": 3333, "reason": "第二位"})
	if code != 201 || r2["status"] != "paid" {
		t.Fatalf("退第二笔：%d %v", code, r2)
	}
	code, r3 := x.refund(t, r2, map[string]any{"paymentId": paymentsOf(r2)[2]["id"], "amountCents": 3334, "reason": "第三位"})
	if code != 201 || r3["status"] != "refunded" || cents64(r3["refundableCents"]) != 0 {
		t.Fatalf("收到的钱都退完才是已退款：%d %v", code, r3)
	}
}

// 收了一部分、剩下免单：免单记成一条结清记录（金额是还差的数），实收只算收到的钱；店员不能免单。
// 收到的那笔照常能退，免单那一笔不能退。
func TestSplitPaymentCompRemainder(t *testing.T) {
	x := newSplitShop(t)
	order := x.draft(t, 10000)
	code, partial := x.pay(t, x.clerk.AccessToken, "part", order, "cash", 4000, nil)
	if code != 201 {
		t.Fatalf("收 ¥40：%d %v", code, partial)
	}
	comp := func(bearer, key string, o map[string]any, reason string) (int, map[string]any) {
		w := call(t, x.s, http.MethodPost, "/api/v2/sales-orders/"+o["id"].(string)+"/comps", bearer, key, map[string]any{"expectedVersion": o["version"], "reason": reason})
		return w.Code, decodeMap(t, w)
	}
	if code, out := comp(x.clerk.AccessToken, "clerk", partial, "老顾客"); code != 403 {
		t.Fatalf("店员不能免单：%d %v", code, out)
	}
	if code, out := comp(x.manager.AccessToken, "stale", order, "老顾客"); code != 409 || out["code"] != "order_version_conflict" {
		t.Fatalf("拿收款前的版本免单：%d %v", code, out)
	}
	code, done := comp(x.manager.AccessToken, "comp", partial, "朋友没带钱，店长同意免单")
	if code != 201 || done["status"] != "paid" || cents64(done["paidCents"]) != 4000 || cents64(done["compCents"]) != 6000 || cents64(done["outstandingCents"]) != 0 || done["settlement"] != "standard" {
		t.Fatalf("对剩余免单：实收 ¥40、免掉 ¥60，不算整单免单：%d %v", code, done)
	}
	payments := paymentsOf(done)
	if len(payments) != 2 || payments[1]["method"] != "comp" || cents64(payments[1]["amountCents"]) != 6000 || payments[1]["refundableCents"] != nil {
		t.Fatalf("免单是第二条结清记录、没有可退：%v", payments)
	}
	if !strings.Contains(lastAudit(t, x.s).Reason, "已收 ¥40.00，剩余 ¥60.00 免单") {
		t.Fatalf("审计写明已收多少、免了多少：%s", lastAudit(t, x.s).Reason)
	}
	if code, out := x.refund(t, done, map[string]any{"paymentId": payments[1]["id"], "amountCents": 100, "reason": "退免单"}); code != 409 || out["code"] != "comp_not_refundable" {
		t.Fatalf("免单那一笔不能退：%d %v", code, out)
	}
	code, refunded := x.refund(t, done, map[string]any{"amountCents": 4000, "reason": "退收到的钱"})
	if code != 201 || refunded["status"] != "refunded" {
		t.Fatalf("只有一笔收到的钱，可以不选；退完是已退款：%d %v", code, refunded)
	}
}

// 两个店员拿同一版订单同时收款：只有一个成功，另一个版本已过期（409），不会超收。
func TestSplitPaymentConcurrentCollectorsCannotOverpay(t *testing.T) {
	x := newSplitShop(t)
	order := x.draft(t, 10000)
	other := register(t, x.s, "split-clerk-2", "店员二")
	setRoles(t, x.s, other.User.ID, Clerk)
	var wg sync.WaitGroup
	codes := make([]int, 2)
	for i, bearer := range []string{x.clerk.AccessToken, other.AccessToken} {
		wg.Add(1)
		go func(i int, bearer string) {
			defer wg.Done()
			body, _ := json.Marshal(map[string]any{"expectedVersion": order["version"], "method": "cash", "amountCents": 6000})
			r, _ := http.NewRequest(http.MethodPost, "/api/v2/sales-orders/"+order["id"].(string)+"/payments", strings.NewReader(string(body)))
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("Authorization", "Bearer "+bearer)
			r.Header.Set("Idempotency-Key", id())
			codes[i] = serve(t, x.s, r).Code
		}(i, bearer)
	}
	wg.Wait()
	if !((codes[0] == 201 && codes[1] == 409) || (codes[0] == 409 && codes[1] == 201)) {
		t.Fatalf("只能有一个收成：%v", codes)
	}
	got := orderOf(t, x.s, order["id"].(string))
	if got.PaidCents != 6000 || len(got.Payments) != 1 || got.Status != "partially_paid" {
		t.Fatalf("只收了一笔 ¥60：%+v", got)
	}
}

// 每笔一个幂等键：同键同内容重放上次的结果、不重复收；同键不同内容 409。
func TestSplitPaymentIdempotency(t *testing.T) {
	x := newSplitShop(t)
	order := x.draft(t, 10000)
	code, first := x.pay(t, x.clerk.AccessToken, "same-key", order, "wechat", 3000, nil)
	if code != 201 {
		t.Fatalf("第一笔：%d %v", code, first)
	}
	code, replay := x.pay(t, x.clerk.AccessToken, "same-key", order, "wechat", 3000, nil)
	if code != 201 || replay["version"] != first["version"] || len(paymentsOf(replay)) != 1 {
		t.Fatalf("同键重放：%d %v", code, replay)
	}
	if code, out := x.pay(t, x.clerk.AccessToken, "same-key", order, "wechat", 4000, nil); code != 409 || out["code"] != "idempotency_conflict" {
		t.Fatalf("同键不同内容：%d %v", code, out)
	}
	if got := orderOf(t, x.s, order["id"].(string)); got.PaidCents != 3000 || len(got.Payments) != 1 {
		t.Fatalf("重放不重复收：%+v", got)
	}
}

// 读出草稿时计时明细按此刻重算（只读不落库）；之前写库时存下的计时明细（超时 1 块）到收款时变成 2 块，
// 收款要连明细一起存下。明细的触发器只认库里订单的状态：先改订单再写明细会被当成改已付订单的明细拒收（0.0.20 的问题）。
func TestPayingAfterTimingLinesChangedSavesTheLines(t *testing.T) {
	x := newSplitShop(t)
	x.renewalPackage(t)
	session := x.open(t, "A1", map[string]any{"timingMode": "timed", "durationMinutes": 60})
	x.at(71 * time.Minute)
	orderID := x.checkout(t, session)["id"].(string) // 建单时存下：套餐 + 超时加收 1 块
	x.at(95 * time.Minute)
	current := x.order(t, orderID)
	if receivable(current) != 5990 {
		t.Fatalf("超时 2 块：%v", receivable(current))
	}
	code, partial := x.pay(t, x.owner.AccessToken, "part", current, "wechat", 2000, nil)
	if code != 201 || receivable(partial) != 5990 {
		t.Fatalf("收第一笔（明细跟着存下）：%d %v", code, partial)
	}
	stored := view(t, x.s, func(q *txn) int64 {
		return scalar[int64](q, `SELECT quantity FROM sales_order_lines WHERE sales_order_id = $1 AND line_index = 2`, orderID)
	})
	if stored != 2 {
		t.Fatalf("明细行存的是收款时的 2 块：%d", stored)
	}
	code, paid := x.pay(t, x.owner.AccessToken, "rest", partial, "cash", 3990, nil)
	if code != 201 || paid["status"] != "paid" {
		t.Fatalf("收齐：%d %v", code, paid)
	}
}

// 会员结账与分笔：会员结账只能是第一笔（草稿），会员价按整单定；可以只收一部分线下补付（offlineCents），余下别人分笔付。
// 会员这一笔（储值 + 随会员结账收的线下款）标 member，积分只按这一笔送；退款时会员这一笔按原付款比例拆到储值、积分与线下，
// 别人付的走普通退款。
func TestSplitPaymentWithMemberCheckout(t *testing.T) {
	shop := newMemberRefundShop(t)
	s := shop.s
	customer := shop.customer(t, "split-member", true) // 本金 ¥50、赠送 ¥10、30 积分
	shop.later()
	o := &Order{ID: id(), UserID: customer, Status: "draft", CreatedAt: s.now(), ReceivableCents: 10000, Lines: shop.standardBasket()}
	edit(t, s, func(q *txn) { q.addOrder(o) })
	version := shop.version(t, o.ID)
	quote := loyaltyOK(t, s, shop.manager.AccessToken, loyaltyInput{Action: "quote", TargetID: o.ID, ExpectedVersion: version, Points: 30, UseBalance: true})
	if cents64(quote["offlineCents"]) != 3700 || cents64(quote["earnedPoints"]) != 97 {
		t.Fatalf("报价：线下补付 ¥37、送 97 分：%v", quote)
	}
	checkout := loyaltyInput{Action: "checkout", TargetID: o.ID, ExpectedVersion: version, Points: 30, UseBalance: true, QuoteVersion: quote["version"].(string), Method: "cash"}

	for name, in := range map[string]loyaltyInput{
		"线下款超过报价": func() loyaltyInput { c := checkout; c.OfflineCents = amount(3701); return c }(),
		"线下款为负":   func() loyaltyInput { c := checkout; c.OfflineCents = amount(-1); return c }(),
		"报价不能带":   {Action: "quote", TargetID: o.ID, ExpectedVersion: version, OfflineCents: amount(100)},
	} {
		if w := loyaltyCall(t, s, shop.manager.AccessToken, in); w.Code != 400 {
			t.Fatalf("%s：%d %s", name, w.Code, w.Body.String())
		}
	}
	// 会员这一笔一分钱没收（不用储值、这次不收线下款）：分不出哪笔是会员的，拒绝
	noMoneyQuote := loyaltyOK(t, s, shop.manager.AccessToken, loyaltyInput{Action: "quote", TargetID: o.ID, ExpectedVersion: version, Points: 30})
	if w := loyaltyCall(t, s, shop.manager.AccessToken, loyaltyInput{Action: "checkout", TargetID: o.ID, ExpectedVersion: version, Points: 30, QuoteVersion: noMoneyQuote["version"].(string), OfflineCents: amount(0)}); w.Code != 400 || !strings.Contains(decodeMap(t, w)["message"].(string), "要收到钱") {
		t.Fatalf("会员这一笔要收到钱：%d %s", w.Code, w.Body.String())
	}

	// 会员用储值 ¥60，线下补付只收 ¥17（现金给 ¥20），余下 ¥20 朋友付
	c := checkout
	c.OfflineCents = amount(1700)
	c.CashReceivedCents = amount(2000)
	out := loyaltyOK(t, s, shop.manager.AccessToken, c)
	order := out["order"].(map[string]any)
	if order["status"] != "partially_paid" || receivable(order) != 9700 || cents64(order["paidCents"]) != 7700 || cents64(order["outstandingCents"]) != 2000 {
		t.Fatalf("会员结账收一部分：应收 ¥97、已收 ¥77、还差 ¥20：%v", order)
	}
	payments := paymentsOf(order)
	if len(payments) != 2 || payments[0]["method"] != "balance" || payments[0]["member"] != true || payments[1]["member"] != true || cents64(payments[1]["changeCents"]) != 300 {
		t.Fatalf("储值与这次收的线下款都是会员这一笔：%v", payments)
	}
	if b := memberOf(t, s, customer).Balance(customer, s.now()); b.Points != 77 {
		t.Fatalf("积分只按会员这一笔收到的 ¥77 送：%+v", b)
	}
	if cents64(out["quote"].(map[string]any)["earnedPoints"]) != 77 {
		t.Fatalf("响应里的报价写实际送的积分：%v", out["quote"])
	}
	if stock := stockByProductOf(t, s, shop.product).Quantity; stock != 8 {
		t.Fatalf("会员结账（第一笔）时出库：%d", stock)
	}
	// 会员结账只能是第一笔
	if w := loyaltyCall(t, s, shop.manager.AccessToken, loyaltyInput{Action: "quote", TargetID: o.ID, ExpectedVersion: order["version"].(string)}); w.Code != 409 {
		t.Fatalf("部分付款的单不能再会员结账：%d %s", w.Code, w.Body.String())
	}

	// 朋友用支付宝付剩下的 ¥20：门店有会员规则，部分付款的单余下的照常在普通收款里收
	w := call(t, s, http.MethodPost, "/api/v2/sales-orders/"+o.ID+"/payments", shop.clerk.AccessToken, id(), map[string]any{"expectedVersion": order["version"], "method": "alipay", "amountCents": 2000})
	if w.Code != 201 {
		t.Fatalf("朋友付剩下的：%d %s", w.Code, w.Body.String())
	}
	paid := decodeMap(t, w)
	mc := paid["memberCheckout"].(map[string]any)
	if paid["status"] != "paid" || paid["settlement"] != "member" || cents64(mc["offlineCents"]) != 1700 || cents64(mc["refundableCents"]) != 7700 || cents64(mc["pointsEarned"]) != 77 {
		t.Fatalf("会员这一笔只算储值和随会员结账收的 ¥17：%v", mc)
	}
	friend := paymentsOf(paid)[2]
	if friend["member"] != nil || cents64(friend["refundableCents"]) != 2000 {
		t.Fatalf("朋友那一笔单独可退：%v", friend)
	}

	// 旧版本（0.0.21 及更早）不认识 member，读出来再整条写回会丢掉它：触发器当作改写已付订单拒收，不会按整单比例乱退
	if _, err := s.postgres.Pool().Exec(context.Background(), `UPDATE sales_orders SET state = jsonb_set(state, '{payments}', (SELECT jsonb_agg(p - 'member') FROM jsonb_array_elements(state->'payments') p)) WHERE id = $1`, o.ID); err == nil || !strings.Contains(err.Error(), "paid order can only receive refund records") {
		t.Fatalf("丢掉 member 的整条改写应被触发器拒收：%v", err)
	}

	// 普通退款选会员那一笔：要走会员退款
	refundBody := func(o map[string]any, extra map[string]any) map[string]any {
		body := map[string]any{"expectedVersion": o["version"], "reason": "朋友先走了"}
		for k, v := range extra {
			body[k] = v
		}
		return body
	}
	if w := call(t, s, http.MethodPost, "/api/v2/sales-orders/"+o.ID+"/refunds", shop.manager.AccessToken, id(), refundBody(paid, map[string]any{"paymentId": payments[0]["id"], "amountCents": 100})); w.Code != 409 || decodeMap(t, w)["code"] != "loyalty_conflict" {
		t.Fatalf("会员那一笔走会员退款：%d %s", w.Code, w.Body.String())
	}
	// 朋友那一笔照常普通退款
	w = call(t, s, http.MethodPost, "/api/v2/sales-orders/"+o.ID+"/refunds", shop.manager.AccessToken, id(), refundBody(paid, map[string]any{"paymentId": friend["id"], "amountCents": 2000}))
	if w.Code != 201 || decodeMap(t, w)["status"] != "paid" {
		t.Fatalf("退朋友那一笔：%d %s", w.Code, w.Body.String())
	}
	afterFriend := decodeMap(t, w)

	// 会员这一笔按原付款比例退：实付 ¥77 = 线下 ¥17 + 本金 ¥50 + 赠送 ¥10，抵扣 30 积分、送出 77 积分；退一半 ¥38.50
	preview := loyaltyOK(t, s, shop.manager.AccessToken, loyaltyInput{Action: "refund_quote", TargetID: o.ID, ExpectedVersion: afterFriend["version"].(string), AmountCents: amount(3850)})
	if got := part(t, preview); got != (member.RefundPart{OfflineCents: 850, PrincipalCents: 2500, GiftCents: 500, PointsRestored: 15, PointsClawedBack: 38}) || cents64(preview["refundableCents"]) != 7700 {
		t.Fatalf("会员这一笔退一半：%+v %v", got, preview)
	}
	half := loyaltyOK(t, s, shop.manager.AccessToken, loyaltyInput{Action: "refund", AccountID: customer, TargetID: o.ID, ExpectedVersion: afterFriend["version"].(string), AmountCents: amount(3850), Reason: "会员也走了"})
	if half["status"] != "paid" || cents64(half["memberCheckout"].(map[string]any)["refundableCents"]) != 3850 {
		t.Fatalf("会员这一笔还能退 ¥38.50：%v", half)
	}
	rest := loyaltyOK(t, s, shop.manager.AccessToken, loyaltyInput{Action: "refund", AccountID: customer, TargetID: o.ID, ExpectedVersion: half["version"].(string), Reason: "退完"})
	if rest["status"] != "refunded" || cents64(rest["refundableCents"]) != 0 {
		t.Fatalf("会员这一笔和朋友那一笔都退完：%v", rest)
	}
	if b := memberOf(t, s, customer).Balance(customer, s.now()); b.PrincipalCents != 5000 || b.GiftCents != 1000 || b.Points != 30 {
		t.Fatalf("储值、积分都回到结账前：%+v", b)
	}
	for _, r := range rest["refunds"].([]any) {
		if r.(map[string]any)["paymentId"] == nil {
			t.Fatalf("分笔付款的单每次退款都记下是哪一笔：%v", r)
		}
	}
}

// 会员只用储值付自己那份（2026-10-06 业主改定）：店员填这次用多少储值（balanceCents），不超过可用储值和这一笔应付；
// 先扣本金、后扣赠送，余下进线下补付，由别人分笔付。储值也算会员这一笔收到的钱，这次可以一分线下款都不收；
// 积分只按会员这一笔送；退款照旧按这一笔实际的构成退。
func TestSplitPaymentMemberUsesPartOfBalance(t *testing.T) {
	shop := newMemberRefundShop(t)
	s := shop.s
	customer := shop.customer(t, "balance-cap", true) // 本金 ¥50、赠送 ¥10、30 积分
	shop.later()
	o := &Order{ID: id(), UserID: customer, Status: "draft", CreatedAt: s.now(), ReceivableCents: 10000, Lines: shop.standardBasket()}
	small := &Order{ID: id(), UserID: customer, Status: "draft", CreatedAt: s.now(), ReceivableCents: 2000, Lines: []OrderLine{{Name: "计时服务费", Quantity: 1, UnitPriceCents: 2000}}}
	edit(t, s, func(q *txn) { q.addOrder(o); q.addOrder(small) })
	version := shop.version(t, o.ID)

	for name, in := range map[string]loyaltyInput{
		"超过可用储值 ¥60":  {Action: "quote", TargetID: o.ID, ExpectedVersion: version, UseBalance: true, BalanceCents: amount(6001)},
		"超过这一笔应付 ¥20": {Action: "quote", TargetID: small.ID, ExpectedVersion: shop.version(t, small.ID), UseBalance: true, BalanceCents: amount(2001)},
		"没勾用储值":       {Action: "quote", TargetID: o.ID, ExpectedVersion: version, BalanceCents: amount(1000)},
		"别的动作不能带":     {Action: "refund_quote", TargetID: o.ID, ExpectedVersion: version, BalanceCents: amount(1000)},
	} {
		w := loyaltyCall(t, s, shop.manager.AccessToken, in)
		if w.Code != 400 || decodeMap(t, w)["code"] != "invalid_request" {
			t.Fatalf("%s：%d %s", name, w.Code, w.Body.String())
		}
	}
	if w := loyaltyCall(t, s, shop.manager.AccessToken, loyaltyInput{Action: "quote", TargetID: o.ID, ExpectedVersion: version, UseBalance: true, BalanceCents: amount(6001)}); !strings.Contains(decodeMap(t, w)["message"].(string), "可用储值 ¥60.00") {
		t.Fatalf("说明超了哪个：%s", w.Body.String())
	}

	quote := loyaltyOK(t, s, shop.manager.AccessToken, loyaltyInput{Action: "quote", TargetID: o.ID, ExpectedVersion: version, UseBalance: true, BalanceCents: amount(3000)})
	if cents64(quote["principalCents"]) != 3000 || cents64(quote["giftCents"]) != 0 || cents64(quote["offlineCents"]) != 7000 {
		t.Fatalf("只用 ¥30 储值，全从本金扣，余下 ¥70 线下：%v", quote)
	}
	checkout := loyaltyInput{Action: "checkout", TargetID: o.ID, ExpectedVersion: version, UseBalance: true, BalanceCents: amount(3000), QuoteVersion: quote["version"].(string), OfflineCents: amount(0)}
	changed := checkout
	changed.BalanceCents = amount(4000)
	if w := loyaltyCall(t, s, shop.manager.AccessToken, changed); w.Code != 409 || decodeMap(t, w)["code"] != "loyalty_conflict" {
		t.Fatalf("确认时用的储值和报价不一样：%d %s", w.Code, w.Body.String())
	}
	out := loyaltyOK(t, s, shop.manager.AccessToken, checkout)
	order := out["order"].(map[string]any)
	payments := paymentsOf(order)
	if order["status"] != "partially_paid" || cents64(order["paidCents"]) != 3000 || cents64(order["outstandingCents"]) != 7000 || len(payments) != 1 || payments[0]["method"] != "balance" || payments[0]["member"] != true {
		t.Fatalf("会员只用 ¥30 储值，这次不收线下款，余下 ¥70：%v", order)
	}
	if b := memberOf(t, s, customer).Balance(customer, s.now()); b.PrincipalCents != 2000 || b.GiftCents != 1000 || b.Points != 60 {
		t.Fatalf("扣本金 ¥30、赠送不动，积分只按这 ¥30 送 30 分：%+v", b)
	}

	w := call(t, s, http.MethodPost, "/api/v2/sales-orders/"+o.ID+"/payments", shop.clerk.AccessToken, id(), map[string]any{"expectedVersion": order["version"], "method": "wechat", "amountCents": 7000})
	if w.Code != 201 || decodeMap(t, w)["status"] != "paid" {
		t.Fatalf("朋友付剩下的 ¥70：%d %s", w.Code, w.Body.String())
	}
	paid := decodeMap(t, w)
	preview := loyaltyOK(t, s, shop.manager.AccessToken, loyaltyInput{Action: "refund_quote", TargetID: o.ID, ExpectedVersion: paid["version"].(string)})
	if got := part(t, preview); got != (member.RefundPart{PrincipalCents: 3000, PointsClawedBack: 30}) || cents64(preview["amountCents"]) != 3000 {
		t.Fatalf("会员这一笔全是本金：退 ¥30 回本金、收回 30 分：%+v %v", got, preview)
	}
	done := loyaltyOK(t, s, shop.manager.AccessToken, loyaltyInput{Action: "refund", AccountID: customer, TargetID: o.ID, ExpectedVersion: paid["version"].(string), Reason: "会员先走了"})
	if done["status"] != "paid" || cents64(done["refundableCents"]) != 7000 {
		t.Fatalf("会员这一笔退完，朋友那一笔还能退 ¥70：%v", done)
	}
	if b := memberOf(t, s, customer).Balance(customer, s.now()); b.PrincipalCents != 5000 || b.GiftCents != 1000 || b.Points != 30 {
		t.Fatalf("储值、积分回到结账前：%+v", b)
	}
}

// 门店后来才发布会员规则：关联顾客的单收第一笔时还没有规则（普通收款），之后余下的照常普通收款，不要求会员结账。
// 一笔收齐的单和以前一样：付款、退款记录不多出新的键（旧订单的形状，TestPaidOrderShapeIsFrozen）。
func TestSplitPaymentLegacyShapes(t *testing.T) {
	x := newSplitShop(t)
	customer := register(t, x.s, "split-customer", "小林")
	orderID, _ := draftWithLine(t, x.s, x.clerk.AccessToken, customer.User.ID, 5000)
	order := x.order(t, orderID)
	code, partial := x.pay(t, x.clerk.AccessToken, "first", order, "cash", 2000, nil)
	if code != 201 {
		t.Fatalf("没有会员规则时普通收款：%d %v", code, partial)
	}
	x.renewalPackage(t) // 门店有了规则
	if code, out := x.pay(t, x.clerk.AccessToken, "rest", partial, "wechat", 3000, nil); code != 201 || out["status"] != "paid" {
		t.Fatalf("部分付款的单余下的照常收：%d %v", code, out)
	}

	single := x.draft(t, 1200)
	code, paid := x.pay(t, x.clerk.AccessToken, "single", single, "cash", 1200, nil)
	if code != 201 || paid["status"] != "paid" {
		t.Fatalf("一笔收齐：%d %v", code, paid)
	}
	code, refunded := x.refund(t, paid, map[string]any{"amountCents": 1200, "reason": "不要了"})
	if code != 201 || refunded["status"] != "refunded" {
		t.Fatalf("一笔收齐的单不用选哪一笔：%d %v", code, refunded)
	}
	state := view(t, x.s, func(q *txn) string {
		return scalar[string](q, `SELECT state::text FROM sales_orders WHERE id = $1`, paid["id"])
	})
	for _, key := range []string{`"member"`, `"paymentId"`, `"outstandingCents"`, `"refundableCents"`} {
		if strings.Contains(state, key) {
			t.Fatalf("一笔收齐的单存的形状和以前一样，不该有 %s：%s", key, state)
		}
	}
}

// 没收到钱的单退款怎么走：草稿不能退；全用积分抵扣的会员结账单（没有付款记录）走会员退款退回积分，退完是已退款。
func TestRefundRoutesWithoutMoney(t *testing.T) {
	x := newSplitShop(t)
	draft := x.draft(t, 500)
	if code, out := x.refund(t, draft, map[string]any{"amountCents": 100, "reason": "还没收"}); code != 400 {
		t.Fatalf("草稿不能退款：%d %v", code, out)
	}
	publishRule(t, x.s, x.owner.AccessToken, member.Rule{Kind: "redeem", Name: "抵扣", AmountCents: 100, Points: 10, MaxBasisPoints: 10000, Stack: true})
	customer := register(t, x.s, "points-only", "小周")
	loyaltyOK(t, x.s, x.owner.AccessToken, loyaltyInput{Action: "adjust", AccountID: customer.User.ID, Points: 100, Reason: "测试积分"})
	x.at(time.Minute) // 结账晚于加积分：「本单结账后余额」按流水先后推出，同一时刻的分不出先后
	orderID, version := draftWithLine(t, x.s, x.clerk.AccessToken, customer.User.ID, 500)
	quote := loyaltyOK(t, x.s, x.manager.AccessToken, loyaltyInput{Action: "quote", TargetID: orderID, ExpectedVersion: version, Points: 50})
	out := loyaltyOK(t, x.s, x.manager.AccessToken, loyaltyInput{Action: "checkout", TargetID: orderID, ExpectedVersion: version, Points: 50, QuoteVersion: quote["version"].(string)})
	paid := out["order"].(map[string]any)
	if paid["status"] != "paid" || cents64(paid["paidCents"]) != 0 || len(paymentsOf(paid)) != 0 {
		t.Fatalf("全用积分抵扣，一次结清、没有付款记录：%v", paid)
	}
	if code, res := x.refund(t, paid, map[string]any{"amountCents": 1, "reason": "退积分"}); code != 409 || res["code"] != "loyalty_conflict" {
		t.Fatalf("全用积分抵扣的单走会员退款：%d %v", code, res)
	}
	done := loyaltyOK(t, x.s, x.manager.AccessToken, loyaltyInput{Action: "refund", AccountID: customer.User.ID, TargetID: orderID, ExpectedVersion: paid["version"].(string), Reason: "退积分"})
	if done["status"] != "refunded" {
		t.Fatalf("积分退回、订单已退款：%v", done)
	}
	if b := memberOf(t, x.s, customer.User.ID).Balance(customer.User.ID, x.s.now()); b.Points != 100 {
		t.Fatalf("积分回到 100：%+v", b)
	}
}
