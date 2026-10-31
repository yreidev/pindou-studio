package app

import (
	"bytes"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	member "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/membership/application"
	ordersapp "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/orders/application"
)

// memberRefundShop 是会员部分退款测试的门店：消费积分每 ¥1 送 1 分（30 天到期），每 10 分抵 ¥1；
// 充值 ¥50 送 ¥10 和 30 积分（60 天到期）；一种材料包 ¥20，库存 10。
//
// 时钟平时停着，两位顾客的到期时间可以直接比；结账前用 later 往后拨：「本单结账后余额」按流水的时间先后推出
// （BalanceAfterCheckout），和本单结账同一时刻的别的流水分不出先后、不算在内，所以结账要晚于之前的充值和结账。
type memberRefundShop struct {
	s                     *Server
	owner, manager, clerk sessionResponse
	product, recharge     string
	clock                 atomic.Int64      // 现在的时刻（UnixNano）；结账、退款的处理函数会并发读
	rechargeLots          map[string]string // 顾客 → 充值送的积分批次
	rechargeExpiry        time.Time
}

// later 把时钟往后拨一分钟。
func (shop *memberRefundShop) later() { shop.clock.Add(int64(time.Minute)) }

func newMemberRefundShop(t *testing.T) *memberRefundShop {
	t.Helper()
	s := newTestServer(t)
	at := time.Date(2026, 10, 6, 6, 0, 0, 0, time.UTC)
	shop := &memberRefundShop{s: s, rechargeLots: map[string]string{}, rechargeExpiry: at.AddDate(0, 0, 60)}
	shop.clock.Store(at.UnixNano())
	s.now = func() time.Time { return time.Unix(0, shop.clock.Load()).UTC() }
	shop.owner = register(t, s, "partial-owner", "老板")
	if err := s.BootstrapOwner(shop.owner.User.ID); err != nil {
		t.Fatal(err)
	}
	enableBilling(t, s, shop.owner.User.ID)
	shop.manager = register(t, s, "partial-manager", "店长")
	setRoles(t, s, shop.manager.User.ID, Manager)
	shop.clerk = register(t, s, "partial-clerk", "店员")
	setRoles(t, s, shop.clerk.User.ID, Clerk)
	publishRule(t, s, shop.owner.AccessToken, member.Rule{Kind: "earn", Name: "消费积分", AmountCents: 100, Points: 1, Scope: "all", ValidDays: 30})
	publishRule(t, s, shop.owner.AccessToken, member.Rule{Kind: "redeem", Name: "抵扣", AmountCents: 100, Points: 10, MaxBasisPoints: 5000, Stack: true})
	shop.recharge = publishRule(t, s, shop.owner.AccessToken, member.Rule{Kind: "recharge", Name: "充 50 送 10", AmountCents: 5000, GiftCents: 1000, Points: 30, ValidDays: 60}).ID
	shop.product = decodeMap(t, call(t, s, "POST", "/api/v2/catalog-items", shop.owner.AccessToken, id(), map[string]any{"name": "拼豆材料包", "unitPriceCents": 2000}))["id"].(string)
	edit(t, s, func(q *txn) { q.addStockItem(&inventoryItem{ID: id(), ProductID: shop.product, Quantity: 10}) })
	return shop
}

// customer 注册一位顾客；charged 时到店充值一次（本金 ¥50、赠送 ¥10、30 积分）。
func (shop *memberRefundShop) customer(t *testing.T, code string, charged bool) string {
	t.Helper()
	c := register(t, shop.s, code, "顾客"+code)
	if charged {
		loyaltyOK(t, shop.s, shop.manager.AccessToken, loyaltyInput{Action: "recharge", AccountID: c.User.ID, TargetID: shop.recharge, Method: "cash"})
		for _, e := range memberOf(t, shop.s, c.User.ID).History(c.User.ID) {
			if e.Kind == "recharge" {
				shop.rechargeLots[c.User.ID] = e.ID
			}
		}
	}
	return c.User.ID
}

// checkout 给顾客建一张单并会员结账：points 抵扣的积分，balance 是否用储值，其余现金补付。
func (shop *memberRefundShop) checkout(t *testing.T, customer string, lines []OrderLine, points int64, balance bool) string {
	t.Helper()
	total := int64(0)
	for _, l := range lines {
		total += l.UnitPriceCents * int64(l.Quantity)
	}
	o := &Order{ID: id(), UserID: customer, Status: "draft", CreatedAt: shop.s.now(), ReceivableCents: total, Lines: lines}
	edit(t, shop.s, func(q *txn) { q.addOrder(o) })
	version := orderOf(t, shop.s, o.ID).Version()
	quote := loyaltyOK(t, shop.s, shop.manager.AccessToken, loyaltyInput{Action: "quote", TargetID: o.ID, ExpectedVersion: version, Points: points, UseBalance: balance})
	loyaltyOK(t, shop.s, shop.manager.AccessToken, loyaltyInput{Action: "checkout", TargetID: o.ID, ExpectedVersion: version, Points: points, UseBalance: balance, QuoteVersion: quote["version"].(string), Method: "cash"})
	return o.ID
}

// standardBasket 是 2 包材料（¥40）加计时服务费 ¥60：抵扣 30 积分（¥3）、本金 ¥50、赠送 ¥10、现金补付 ¥37，送 97 积分。
func (shop *memberRefundShop) standardBasket() []OrderLine {
	return []OrderLine{{ProductID: shop.product, Name: "拼豆材料包", Quantity: 2, UnitPriceCents: 2000}, {Name: "计时服务费", Quantity: 1, UnitPriceCents: 6000}}
}

func (shop *memberRefundShop) version(t *testing.T, order string) string {
	t.Helper()
	return orderOf(t, shop.s, order).Version()
}

func amount(cents int64) *int64 { return &cents }

// part 取预览或订单 memberCheckout.refunded 里的五个数。
func part(t *testing.T, v map[string]any) member.RefundPart {
	t.Helper()
	n := func(key string) int64 {
		f, ok := v[key].(float64)
		if !ok {
			t.Fatalf("缺少 %s：%v", key, v)
		}
		return int64(f)
	}
	return member.RefundPart{OfflineCents: n("offlineCents"), PrincipalCents: n("principalCents"), GiftCents: n("giftCents"), PointsRestored: n("pointsRestored"), PointsClawedBack: n("pointsClawedBack")}
}

func refundedOf(t *testing.T, order map[string]any) member.RefundPart {
	t.Helper()
	refunded, ok := order["memberCheckout"].(map[string]any)["refunded"].(map[string]any)
	if !ok {
		t.Fatalf("订单没有 memberCheckout.refunded：%v", order["memberCheckout"])
	}
	return part(t, refunded)
}

// 按原付款比例分多次退：预览与实际一致、提交带的是预览依据的版本；钱回原来源、积分回原批次（保留到期时间）；
// 库存只按逐件填写的件数、累计不超过售出数；最后不带金额退剩余全部，零头在这次结清，订单变为已退款。
func TestMemberPartialRefundSplitsByOriginalShares(t *testing.T) {
	shop := newMemberRefundShop(t)
	s := shop.s
	customer := shop.customer(t, "partial-a", true)
	shop.later()
	order := shop.checkout(t, customer, shop.standardBasket(), 30, true)
	if b := memberOf(t, s, customer).Balance(customer, s.now()); b.PrincipalCents != 0 || b.GiftCents != 0 || b.Points != 97 {
		t.Fatalf("结账后：%+v", b)
	}
	stock := func() int64 { return stockByProductOf(t, s, shop.product).Quantity }
	if stock() != 8 {
		t.Fatalf("卖出 2 包后库存应为 8：%d", stock())
	}

	// 预览：退 ¥19.40（实付 ¥97 的 20%）→ 线下 ¥7.40、本金 ¥10、赠送 ¥2，恢复 6 积分，收回 19 积分（19.4 向下取整）
	before := s.snapshotData()
	v1 := shop.version(t, order)
	quote := loyaltyOK(t, s, shop.manager.AccessToken, loyaltyInput{Action: "refund_quote", AccountID: customer, TargetID: order, ExpectedVersion: v1, AmountCents: amount(1940)})
	want := member.RefundPart{OfflineCents: 740, PrincipalCents: 1000, GiftCents: 200, PointsRestored: 6, PointsClawedBack: 19}
	if part(t, quote) != want || quote["settlesOrder"] != false || quote["orderVersion"] != v1 || quote["amountCents"] != float64(1940) || quote["refundableCents"] != float64(9700) || quote["blocked"] != nil {
		t.Fatalf("预览：%v", quote)
	}
	if !bytes.Equal(before, s.snapshotData()) {
		t.Fatal("预览不该改动数据")
	}

	// 照预览提交（带预览依据的版本），退回 1 包材料
	done := loyaltyOK(t, s, shop.manager.AccessToken, loyaltyInput{Action: "refund", AccountID: customer, TargetID: order, ExpectedVersion: quote["orderVersion"].(string), AmountCents: amount(1940), Reason: "少做了一件", ReturnedProducts: map[string]int64{shop.product: 1}})
	if done["status"] != "paid" || done["refundedCents"] != float64(1940) || done["refundableCents"] != float64(7760) || refundedOf(t, done) != want {
		t.Fatalf("第一次退款后：%v", done)
	}
	if b := memberOf(t, s, customer).Balance(customer, s.now()); b.PrincipalCents != 1000 || b.GiftCents != 200 || b.Points != 97-19+6 {
		t.Fatalf("第一次退款后的资产：%+v", b)
	}
	if stock() != 9 {
		t.Fatalf("点回 1 包后库存应为 9：%d", stock())
	}
	// 恢复的积分回到充值送的那一批，保留原到期时间
	lots := memberOf(t, s, customer).Lots(customer)
	if lot := lots[shop.rechargeLots[customer]]; lot.Delta != 6 || lot.ExpiresAt == nil || !lot.ExpiresAt.Equal(shop.rechargeExpiry) {
		t.Fatalf("恢复的积分应回原批次：%+v", lot)
	}

	// 详情：累计已退回、还可退；没有积分缺口
	detail := decodeMap(t, call(t, s, "GET", "/api/v2/sales-orders/"+order, shop.manager.AccessToken, "", nil))
	if refundedOf(t, detail) != want || detail["memberCheckout"].(map[string]any)["refundBlocked"] != nil {
		t.Fatalf("详情：%v", detail["memberCheckout"])
	}
	// 小票上的「本单结账后余额」是结账那一刻的数，退款不改变它
	if after := detail["memberCheckout"].(map[string]any)["balanceAfter"]; !equalJSON(after, map[string]any{"principalCents": 0, "giftCents": 0, "points": 97}) {
		t.Fatalf("部分退款后结账后余额应不变：%v", after)
	}

	// 退回件数累计不超过售出：已退回 1 包，再退回 2 包超了，拒绝且不改数据
	before = s.snapshotData()
	over := loyaltyCall(t, s, shop.manager.AccessToken, loyaltyInput{Action: "refund", AccountID: customer, TargetID: order, ExpectedVersion: shop.version(t, order), AmountCents: amount(100), Reason: "再退", ReturnedProducts: map[string]int64{shop.product: 2}})
	if body := decodeMap(t, over); over.Code != 400 || body["code"] != "invalid_request" {
		t.Fatalf("退回件数超出售出数应被拒：%d %v", over.Code, body)
	}
	// 金额超过还可退
	tooMuch := loyaltyCall(t, s, shop.manager.AccessToken, loyaltyInput{Action: "refund", AccountID: customer, TargetID: order, ExpectedVersion: shop.version(t, order), AmountCents: amount(7761), Reason: "超额"})
	if body := decodeMap(t, tooMuch); tooMuch.Code != 400 || !strings.Contains(body["message"].(string), "¥77.60") {
		t.Fatalf("超过还可退应被拒：%d %v", tooMuch.Code, body)
	}
	if !bytes.Equal(before, s.snapshotData()) {
		t.Fatal("被拒的退款改动了数据")
	}

	// 第二次退 ¥33.33：预览与实际一致
	v2 := shop.version(t, order)
	quote = loyaltyOK(t, s, shop.manager.AccessToken, loyaltyInput{Action: "refund_quote", TargetID: order, ExpectedVersion: v2, AmountCents: amount(3333)})
	second := part(t, quote)
	if second.OfflineCents+second.PrincipalCents+second.GiftCents != 3333 {
		t.Fatalf("钱的三项合计应等于退款金额：%+v", second)
	}
	done = loyaltyOK(t, s, shop.owner.AccessToken, loyaltyInput{Action: "refund", TargetID: order, ExpectedVersion: v2, AmountCents: amount(3333), Reason: "作品返工"})
	if got := refundedOf(t, done); got != (member.RefundPart{
		OfflineCents: want.OfflineCents + second.OfflineCents, PrincipalCents: want.PrincipalCents + second.PrincipalCents, GiftCents: want.GiftCents + second.GiftCents,
		PointsRestored: want.PointsRestored + second.PointsRestored, PointsClawedBack: want.PointsClawedBack + second.PointsClawedBack,
	}) {
		t.Fatalf("第二次退款与预览不一致：预览 %+v，累计 %+v", second, got)
	}

	// 最后不带金额：退剩余全部，零头结清，各来源退满
	quote = loyaltyOK(t, s, shop.manager.AccessToken, loyaltyInput{Action: "refund_quote", TargetID: order, ExpectedVersion: shop.version(t, order)})
	if quote["settlesOrder"] != true || quote["amountCents"] != float64(9700-1940-3333) {
		t.Fatalf("退剩余全部的预览：%v", quote)
	}
	done = loyaltyOK(t, s, shop.manager.AccessToken, loyaltyInput{Action: "refund", AccountID: customer, TargetID: order, ExpectedVersion: shop.version(t, order), Reason: "顾客全部不要了", ReturnedProducts: map[string]int64{shop.product: 1}})
	if done["status"] != "refunded" || done["refundedCents"] != float64(9700) || done["refundableCents"] != float64(0) {
		t.Fatalf("退满后：%v", done)
	}
	if got := refundedOf(t, done); got != (member.RefundPart{OfflineCents: 3700, PrincipalCents: 5000, GiftCents: 1000, PointsRestored: 30, PointsClawedBack: 97}) {
		t.Fatalf("退满后各来源应等于原结账：%+v", got)
	}
	if refunds, _ := done["refunds"].([]any); len(refunds) != 3 {
		t.Fatalf("应有 3 笔退款记录：%v", done["refunds"])
	}
	b := memberOf(t, s, customer).Balance(customer, s.now())
	if b.PrincipalCents != 5000 || b.GiftCents != 1000 || b.Points != 30 {
		t.Fatalf("退满后资产应回到结账前：%+v", b)
	}
	if lot := memberOf(t, s, customer).Lots(customer)[shop.rechargeLots[customer]]; lot.Delta != 30 || !lot.ExpiresAt.Equal(shop.rechargeExpiry) {
		t.Fatalf("抵扣的 30 分应全部回到原批次：%+v", lot)
	}
	if stock() != 10 {
		t.Fatalf("两包都点回后库存应为 10：%d", stock())
	}
	// 每次退款都追加冲正流水，原结账流水不变
	kinds := map[string]int{}
	for _, e := range memberOf(t, s, customer).History(customer) {
		kinds[e.Kind]++
	}
	if kinds["checkout"] != 1 || kinds["earned"] != 1 || kinds["refund"] != 6 {
		t.Fatalf("流水：%v", kinds)
	}
	// 退满了不能再退，也不能再预览
	again := loyaltyCall(t, s, shop.manager.AccessToken, loyaltyInput{Action: "refund", TargetID: order, ExpectedVersion: shop.version(t, order), Reason: "再退"})
	if body := decodeMap(t, again); again.Code != 409 || body["code"] != "loyalty_conflict" {
		t.Fatalf("退满后再退：%d %v", again.Code, body)
	}
	// 审计：每次退款一条，记在顾客名下
	refunds := 0
	for _, a := range auditsOf(t, s) {
		if a.Action == "loyalty.refund" {
			refunds++
		}
	}
	if refunds != 3 {
		t.Fatalf("应有 3 条退款审计：%d", refunds)
	}
}

// lotSnapshot 是顾客各积分批次的余量和到期时间（不看批次编号），用来比两位顾客的账。
func lotSnapshot(t *testing.T, s *Server, customer string) []string {
	t.Helper()
	var out []string
	for _, lot := range memberOf(t, s, customer).Lots(customer) {
		expiry := "永久"
		if lot.ExpiresAt != nil {
			expiry = lot.ExpiresAt.UTC().Format(time.RFC3339)
		}
		out = append(out, fmt.Sprintf("%d@%s", lot.Delta, expiry))
	}
	sort.Strings(out)
	return out
}

// 两位顾客资产、订单一模一样：一位分三次退满，一位一次退完，退完后两人的本金、赠送、各积分批次（含到期时间）
// 完全相同，订单都是已退款、已退金额等于实付。
func TestMemberRefundInPartsEqualsWholeRefund(t *testing.T) {
	shop := newMemberRefundShop(t)
	s := shop.s
	inParts := shop.customer(t, "parts", true)
	whole := shop.customer(t, "whole", true)
	shop.later()
	partsOrder := shop.checkout(t, inParts, shop.standardBasket(), 30, true)
	wholeOrder := shop.checkout(t, whole, shop.standardBasket(), 30, true)

	for _, cents := range []int64{1, 1234, 4321} {
		loyaltyOK(t, s, shop.manager.AccessToken, loyaltyInput{Action: "refund", TargetID: partsOrder, ExpectedVersion: shop.version(t, partsOrder), AmountCents: amount(cents), Reason: "分次退"})
	}
	loyaltyOK(t, s, shop.manager.AccessToken, loyaltyInput{Action: "refund", TargetID: partsOrder, ExpectedVersion: shop.version(t, partsOrder), AmountCents: amount(9700 - 1 - 1234 - 4321), Reason: "退满"})
	loyaltyOK(t, s, shop.manager.AccessToken, loyaltyInput{Action: "refund", TargetID: wholeOrder, ExpectedVersion: shop.version(t, wholeOrder), Reason: "一次退完"})

	a, b := memberOf(t, s, inParts).Balance(inParts, s.now()), memberOf(t, s, whole).Balance(whole, s.now())
	if a != b {
		t.Fatalf("分次退满 %+v ≠ 一次退完 %+v", a, b)
	}
	if got, want := lotSnapshot(t, s, inParts), lotSnapshot(t, s, whole); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("积分批次：分次 %v ≠ 一次 %v", got, want)
	}
	for _, order := range []string{partsOrder, wholeOrder} {
		view := decodeMap(t, call(t, s, "GET", "/api/v2/sales-orders/"+order, shop.manager.AccessToken, "", nil))
		if view["status"] != "refunded" || view["refundedCents"] != float64(9700) || refundedOf(t, view) != (member.RefundPart{OfflineCents: 3700, PrincipalCents: 5000, GiftCents: 1000, PointsRestored: 30, PointsClawedBack: 97}) {
			t.Fatalf("%s：%v", order, view)
		}
	}
}

// 本单送出的积分被别的结账用掉：按比例收得回的部分可以退；要收回的超过剩下的就拒绝，说明缺多少、被哪张单用掉、
// 现在最多能退多少（预览、订单详情、提交被拒是同一句话），不允许负积分、不记欠额；先退掉用分的那张单就能退满。
func TestMemberPartialRefundRejectsWhenEarnedPointsSpent(t *testing.T) {
	shop := newMemberRefundShop(t)
	s := shop.s
	customer := shop.customer(t, "spent", false)
	// A 单现金 ¥100，送 100 分；B 单 ¥20 用其中 50 分抵 ¥5
	shop.later()
	first := shop.checkout(t, customer, []OrderLine{{Name: "计时服务费", Quantity: 1, UnitPriceCents: 10000}}, 0, false)
	shop.later()
	second := shop.checkout(t, customer, []OrderLine{{Name: "加时", Quantity: 1, UnitPriceCents: 2000}}, 50, false)
	if b := memberOf(t, s, customer).Balance(customer, s.now()); b.Points != 100-50+15 {
		t.Fatalf("两单结账后积分：%+v", b)
	}

	// 先退 A 单 ¥40：按比例收回 40 分，剩下的 50 分够
	loyaltyOK(t, s, shop.manager.AccessToken, loyaltyInput{Action: "refund", TargetID: first, ExpectedVersion: shop.version(t, first), AmountCents: amount(4000), Reason: "退一部分"})

	// 再退剩余全部 ¥60 要收回 60 分，A 单的批次只剩 10 分：缺 50 分。最多能退 ¥10.99（收回 10 分）
	reason := memberRefundBlockedReason(60, 50, 1099)
	quote := loyaltyOK(t, s, shop.manager.AccessToken, loyaltyInput{Action: "refund_quote", TargetID: first, ExpectedVersion: shop.version(t, first)})
	blocked, _ := quote["blocked"].(map[string]any)
	if blocked == nil || blocked["reason"] != reason || blocked["pointsShort"] != float64(50) || blocked["maxRefundableCents"] != float64(1099) || quote["pointsClawedBack"] != float64(60) {
		t.Fatalf("预览应说明缺口：%v", quote)
	}
	spent, _ := blocked["spentBy"].([]any)
	if len(spent) != 1 || spent[0].(map[string]any)["sourceId"] != second || spent[0].(map[string]any)["points"] != float64(50) {
		t.Fatalf("spentBy 应指向 B 单：%v", blocked["spentBy"])
	}
	detail := decodeMap(t, call(t, s, "GET", "/api/v2/sales-orders/"+first, shop.manager.AccessToken, "", nil))
	if got, _ := detail["memberCheckout"].(map[string]any)["refundBlocked"].(map[string]any); got == nil || got["reason"] != reason || got["maxRefundableCents"] != float64(1099) {
		t.Fatalf("订单详情应提前说明：%v", detail["memberCheckout"])
	}

	before := s.snapshotData()
	w := loyaltyCall(t, s, shop.manager.AccessToken, loyaltyInput{Action: "refund", TargetID: first, ExpectedVersion: shop.version(t, first), Reason: "全退"})
	if body := decodeMap(t, w); w.Code != 409 || body["code"] != "loyalty_conflict" || body["message"] != reason {
		t.Fatalf("收不回积分应拒绝：%d %v", w.Code, body)
	}
	over := loyaltyCall(t, s, shop.manager.AccessToken, loyaltyInput{Action: "refund", TargetID: first, ExpectedVersion: shop.version(t, first), AmountCents: amount(1100), Reason: "多退一分"})
	if body := decodeMap(t, over); over.Code != 409 || body["message"] != memberRefundBlockedReason(11, 1, 1099) {
		t.Fatalf("¥11.00 要收回 11 分，缺 1 分：%d %v", over.Code, body)
	}
	if !bytes.Equal(before, s.snapshotData()) {
		t.Fatal("被拒的退款改动了数据")
	}
	// 最多能退的那一笔可以退，积分正好收完、不为负
	loyaltyOK(t, s, shop.manager.AccessToken, loyaltyInput{Action: "refund", TargetID: first, ExpectedVersion: shop.version(t, first), AmountCents: amount(1099), Reason: "先退能退的"})
	for _, lot := range memberOf(t, s, customer).Lots(customer) {
		if lot.Delta < 0 {
			t.Fatalf("积分批次出现负数：%+v", lot)
		}
	}

	// 先把 B 单退掉：抵扣的 50 分回到 A 单的批次，A 单剩下的就能退满
	loyaltyOK(t, s, shop.manager.AccessToken, loyaltyInput{Action: "refund", TargetID: second, ExpectedVersion: shop.version(t, second), Reason: "先退用分的单"})
	done := loyaltyOK(t, s, shop.manager.AccessToken, loyaltyInput{Action: "refund", TargetID: first, ExpectedVersion: shop.version(t, first), Reason: "退满"})
	if done["status"] != "refunded" || refundedOf(t, done).PointsClawedBack != 100 {
		t.Fatalf("A 单应能退满：%v", done)
	}
	if b := memberOf(t, s, customer).Balance(customer, s.now()); b.Points != 0 {
		t.Fatalf("两单都退满后积分应归零：%+v", b)
	}
}

// 权限、幂等与并发：只有店长、老板能预览和办理；同键同内容重放第一次的结果、不重复退，同键不同金额 409；
// 版本过期回 order_version_conflict；两人拿同一版本同时退，只成一笔。
func TestMemberPartialRefundPermissionIdempotencyAndConcurrency(t *testing.T) {
	shop := newMemberRefundShop(t)
	s := shop.s
	customer := shop.customer(t, "guarded", true)
	shop.later()
	order := shop.checkout(t, customer, shop.standardBasket(), 30, true)
	customerToken := register(t, s, "guarded-other", "别的顾客").AccessToken

	refund := loyaltyInput{Action: "refund", AccountID: customer, TargetID: order, ExpectedVersion: shop.version(t, order), AmountCents: amount(1000), Reason: "部分退款"}
	quote := refund
	quote.Action, quote.Reason = "refund_quote", ""
	for _, token := range []string{shop.clerk.AccessToken, customerToken} {
		for _, in := range []loyaltyInput{refund, quote} {
			if w := loyaltyCall(t, s, token, in); w.Code != 403 {
				t.Fatalf("%s 应无权：%d %s", in.Action, w.Code, w.Body.String())
			}
		}
	}
	// 顾客写错
	wrong := refund
	wrong.AccountID = shop.clerk.User.ID
	if w := loyaltyCall(t, s, shop.manager.AccessToken, wrong); w.Code != 400 {
		t.Fatalf("顾客与订单不符应拒绝：%d %s", w.Code, w.Body.String())
	}
	// 金额不能是 0 或负数（不带才是退剩余全部）
	for _, cents := range []int64{0, -1} {
		zero := refund
		zero.AmountCents = amount(cents)
		if w := loyaltyCall(t, s, shop.manager.AccessToken, zero); w.Code != 400 {
			t.Fatalf("金额 %d 应拒绝：%d %s", cents, w.Code, w.Body.String())
		}
	}

	// 幂等：同键同内容重放第一次的结果，只退一次
	first := call(t, s, http.MethodPost, "/api/v2/loyalty/actions", shop.manager.AccessToken, "partial-key", refund)
	if first.Code != 200 {
		t.Fatalf("退款：%d %s", first.Code, first.Body.String())
	}
	replay := call(t, s, http.MethodPost, "/api/v2/loyalty/actions", shop.manager.AccessToken, "partial-key", refund)
	if replay.Code != 200 || !bytes.Equal(bytes.TrimSpace(first.Body.Bytes()), bytes.TrimSpace(replay.Body.Bytes())) {
		t.Fatalf("重放：%d %s", replay.Code, replay.Body.String())
	}
	if got := orderOf(t, s, order); len(got.Refunds) != 1 || got.Refunds[0].AmountCents != 1000 {
		t.Fatalf("重放不该再退一次：%+v", got.Refunds)
	}
	changed := refund
	changed.AmountCents = amount(2000)
	if w := call(t, s, http.MethodPost, "/api/v2/loyalty/actions", shop.manager.AccessToken, "partial-key", changed); w.Code != 409 || decodeMap(t, w)["code"] != "idempotency_conflict" {
		t.Fatalf("同键不同金额：%d %s", w.Code, w.Body.String())
	}

	// 版本过期（别人刚退过）：order_version_conflict，什么都不改
	before := s.snapshotData()
	stale := refund
	stale.AmountCents = amount(500)
	if w := loyaltyCall(t, s, shop.manager.AccessToken, stale); w.Code != 409 || decodeMap(t, w)["code"] != "order_version_conflict" {
		t.Fatalf("过期版本：%d %s", w.Code, w.Body.String())
	}
	staleQuote := quote
	if w := loyaltyCall(t, s, shop.manager.AccessToken, staleQuote); w.Code != 409 || decodeMap(t, w)["code"] != "order_version_conflict" {
		t.Fatalf("过期版本的预览：%d %s", w.Code, w.Body.String())
	}
	if !bytes.Equal(before, s.snapshotData()) {
		t.Fatal("过期版本改动了数据")
	}

	// 两人拿同一版本同时各退 ¥10：只成一笔，另一笔回 order_version_conflict
	current := shop.version(t, order)
	codes := make([]int, 2)
	var wg sync.WaitGroup
	for i, token := range []string{shop.manager.AccessToken, shop.owner.AccessToken} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			in := loyaltyInput{Action: "refund", TargetID: order, ExpectedVersion: current, AmountCents: amount(1000), Reason: fmt.Sprintf("同时退 %d", i)}
			codes[i] = call(t, s, http.MethodPost, "/api/v2/loyalty/actions", token, id(), in).Code
		}()
	}
	wg.Wait()
	sort.Ints(codes)
	if codes[0] != 200 || codes[1] != 409 {
		t.Fatalf("同时退款应只成一笔：%v", codes)
	}
	if got := orderOf(t, s, order); len(got.Refunds) != 2 || ordersapp.RefundedCents(*got) != 2000 {
		t.Fatalf("同时退款后：%+v", got.Refunds)
	}
}
