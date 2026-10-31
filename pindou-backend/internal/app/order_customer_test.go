package app

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	member "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/membership/application"
)

// 草稿订单事后绑定、更换顾客账户或改成散客（PATCH /sales-orders/{id}/customer）：
// 开台时没选顾客的散客单，结账时也能改走会员结账；绑错了能换、能清掉。
// 带订单版本做并发确认；套餐订单的顾客由入座申请决定，不能换；换人记审计，不记手机号。

// putCustomer 发一次换顾客请求；account 为空串表示改成散客（accountId 传 null）。
func putCustomer(t *testing.T, s *Server, bearer, orderID, version, account, key string) *httpResponse {
	t.Helper()
	body := map[string]any{"expectedVersion": version, "accountId": nil}
	if account != "" {
		body["accountId"] = account
	}
	w := call(t, s, http.MethodPatch, "/api/v2/sales-orders/"+orderID+"/customer", bearer, key, body)
	return &httpResponse{code: w.Code, body: w.Body.Bytes(), decoded: func() map[string]any { return decodeMap(t, w) }}
}

type httpResponse struct {
	code    int
	body    []byte
	decoded func() map[string]any
}

// accountHasOrder：这位顾客的订单列表（顾客「我的订单」、员工按顾客查的就是它）里有没有这张单。
// 列表按 sales_orders.account_id 查，换顾客必须连这一列一起改，不能只改 state。
func accountHasOrder(t *testing.T, s *Server, bearer, account, orderID string) bool {
	t.Helper()
	w := call(t, s, http.MethodGet, "/api/v2/accounts/"+account+"/sales-orders", bearer, "", nil)
	if w.Code != 200 {
		t.Fatalf("顾客订单列表：%d %s", w.Code, w.Body.String())
	}
	for _, o := range decodeList(t, w) {
		if o["id"] == orderID {
			return true
		}
	}
	return false
}

func TestDraftOrderCustomerCanBeBoundChangedAndCleared(t *testing.T) {
	s := newTestServer(t)
	owner := register(t, s, "bind-owner", "老板")
	if err := s.BootstrapOwner(owner.User.ID); err != nil {
		t.Fatal(err)
	}
	clerk := register(t, s, "bind-clerk", "店员")
	setRoles(t, s, clerk.User.ID, Clerk)
	li := register(t, s, "bind-li", "小李")
	wang := register(t, s, "bind-wang", "小王")
	// 门店发布了会员规则：带顾客的订单只能走会员结账，散客单才能直接收款
	publishRule(t, s, owner.AccessToken, member.Rule{Kind: "earn", Name: "消费积分", AmountCents: 100, Points: 1, Scope: "all"})

	created := decodeMap(t, call(t, s, http.MethodPost, "/api/v2/sales-orders", clerk.AccessToken, id(), map[string]any{}))
	orderID := created["id"].(string)
	lines := call(t, s, http.MethodPatch, "/api/v2/sales-orders/"+orderID, clerk.AccessToken, id(), map[string]any{
		"expectedVersion": created["version"], "lines": []map[string]any{{"name": "计时服务费", "quantity": 1, "unitPriceCents": 3000}},
	})
	if lines.Code != 200 {
		t.Fatalf("明细：%d %s", lines.Code, lines.Body.String())
	}
	v1 := decodeMap(t, lines)["version"].(string)

	// 店员给散客单绑上小李：订单带出顾客称呼，版本变了
	key := id()
	bound := putCustomer(t, s, clerk.AccessToken, orderID, v1, li.User.ID, key)
	if bound.code != 200 {
		t.Fatalf("绑定顾客：%d %s", bound.code, bound.body)
	}
	view := bound.decoded()
	if view["accountId"] != li.User.ID || view["customer"].(map[string]any)["nickname"] != "小李" || view["version"] == v1 || view["receivableCents"] != float64(3000) {
		t.Fatalf("绑定后：%v", view)
	}
	v2 := view["version"].(string)
	if !accountHasOrder(t, s, clerk.AccessToken, li.User.ID, orderID) || !accountHasOrder(t, s, li.AccessToken, li.User.ID, orderID) {
		t.Fatal("绑定后小李的订单列表里要有这张单")
	}
	audit := lastAudit(t, s)
	if audit.Action != "order.customer.changed" || audit.ObjectID != orderID || audit.ActorID != clerk.User.ID ||
		audit.Reason != "顾客 散客 → 小李（"+li.User.ID+"）" {
		t.Fatalf("审计：%+v", audit)
	}
	if strings.Contains(audit.Reason, "138") {
		t.Fatalf("审计不能记手机号：%q", audit.Reason)
	}
	// 结果不确定时原样重试：重放第一次的结果，不再改一遍、不重复记审计
	if again := putCustomer(t, s, clerk.AccessToken, orderID, v1, li.User.ID, key); again.code != 200 || !bytes.Equal(again.body, bound.body) {
		t.Fatalf("重放：%d %s", again.code, again.body)
	}
	// 同一个键换了内容：409
	if other := putCustomer(t, s, clerk.AccessToken, orderID, v1, wang.User.ID, key); other.code != 409 || other.decoded()["code"] != "idempotency_conflict" {
		t.Fatalf("同键不同内容：%d %s", other.code, other.body)
	}

	// 别人已经改过（版本过期）：409，什么都不改；页面保留输入、重读后由员工再确认
	before := s.snapshotData()
	if stale := putCustomer(t, s, clerk.AccessToken, orderID, v1, wang.User.ID, id()); stale.code != 409 || stale.decoded()["code"] != "order_version_conflict" {
		t.Fatalf("过期版本：%d %s", stale.code, stale.body)
	}
	if !bytes.Equal(before, s.snapshotData()) {
		t.Fatal("过期版本的换顾客改动了数据")
	}

	// 换成同一位：什么都不改，版本照旧，不记审计
	audits := len(auditsOf(t, s))
	if same := putCustomer(t, s, clerk.AccessToken, orderID, v2, li.User.ID, id()); same.code != 200 || same.decoded()["version"] != v2 {
		t.Fatalf("换成同一位：%d %s", same.code, same.body)
	}
	if len(auditsOf(t, s)) != audits {
		t.Fatal("没换人不该记审计")
	}

	// 改成散客：带顾客的订单门店有会员规则时不能普通收款，清掉之后可以
	if w := call(t, s, http.MethodPost, "/api/v2/sales-orders/"+orderID+"/payments", clerk.AccessToken, id(),
		map[string]any{"expectedVersion": v2, "method": "cash", "amountCents": 3000}); w.Code != 409 || decodeMap(t, w)["code"] != "loyalty_conflict" {
		t.Fatalf("会员单普通收款：%d %s", w.Code, w.Body.String())
	}
	cleared := putCustomer(t, s, clerk.AccessToken, orderID, v2, "", id())
	if cleared.code != 200 {
		t.Fatalf("改成散客：%d %s", cleared.code, cleared.body)
	}
	if view := cleared.decoded(); view["accountId"] != nil || view["customer"] != nil {
		t.Fatalf("改成散客后：%v", view)
	}
	if got := lastAudit(t, s).Reason; got != "顾客 小李（"+li.User.ID+"） → 散客" {
		t.Fatalf("改成散客的审计：%q", got)
	}
	if accountHasOrder(t, s, li.AccessToken, li.User.ID, orderID) {
		t.Fatal("改成散客后小李的订单列表里不该再有这张单")
	}
	v3 := cleared.decoded()["version"].(string)
	if w := call(t, s, http.MethodPost, "/api/v2/sales-orders/"+orderID+"/payments", clerk.AccessToken, id(),
		map[string]any{"expectedVersion": v3, "method": "cash", "amountCents": 3000}); w.Code != 201 {
		t.Fatalf("散客单收款：%d %s", w.Code, w.Body.String())
	}

	// 已付款的单不能再换顾客
	paid := orderOf(t, s, orderID)
	if w := putCustomer(t, s, clerk.AccessToken, orderID, paid.Version(), wang.User.ID, id()); w.code != 409 || w.decoded()["code"] != "order_closed" {
		t.Fatalf("已付款换顾客：%d %s", w.code, w.body)
	}
}

// 已经按 A 算过会员报价，换成 B 之后那份报价作废：订单版本变了，拿旧版本结账被拒；
// 按 B 重新报价才能结账，扣的是 B 的余额。
func TestChangingTheCustomerVoidsTheMemberQuote(t *testing.T) {
	s := newTestServer(t)
	owner := register(t, s, "requote-owner", "老板")
	if err := s.BootstrapOwner(owner.User.ID); err != nil {
		t.Fatal(err)
	}
	li := register(t, s, "requote-li", "小李")
	wang := register(t, s, "requote-wang", "小王")
	loyaltyOK(t, s, owner.AccessToken, loyaltyInput{Action: "adjust", AccountID: li.User.ID, PrincipalCents: 5000, Reason: "测试资产"})
	loyaltyOK(t, s, owner.AccessToken, loyaltyInput{Action: "adjust", AccountID: wang.User.ID, PrincipalCents: 1000, Reason: "测试资产"})

	order := &Order{ID: id(), UserID: li.User.ID, Status: "draft", CreatedAt: s.now(), ReceivableCents: 3000, Lines: []OrderLine{{Name: "服务费", Quantity: 1, UnitPriceCents: 3000}}}
	edit(t, s, func(q *txn) { q.addOrder(order) })
	v1 := orderOf(t, s, order.ID).Version()
	quoteLi := loyaltyOK(t, s, owner.AccessToken, loyaltyInput{Action: "quote", TargetID: order.ID, ExpectedVersion: v1, UseBalance: true})
	if quoteLi["principalCents"] != float64(3000) {
		t.Fatalf("小李的报价：%v", quoteLi)
	}

	changed := putCustomer(t, s, owner.AccessToken, order.ID, v1, wang.User.ID, id())
	if changed.code != 200 {
		t.Fatalf("换成小王：%d %s", changed.code, changed.body)
	}
	v2 := changed.decoded()["version"].(string)
	if accountHasOrder(t, s, owner.AccessToken, li.User.ID, order.ID) || !accountHasOrder(t, s, owner.AccessToken, wang.User.ID, order.ID) {
		t.Fatal("换人后这张单应当从小李的订单里挪到小王名下")
	}

	before := s.snapshotData()
	// 拿换人之前的订单版本和报价结账：订单已变，拒收
	stale := loyaltyCall(t, s, owner.AccessToken, loyaltyInput{Action: "checkout", TargetID: order.ID, ExpectedVersion: v1, QuoteVersion: quoteLi["version"].(string), UseBalance: true, Method: "cash"})
	if stale.Code != 409 || decodeMap(t, stale)["code"] != "loyalty_conflict" {
		t.Fatalf("旧版本结账：%d %s", stale.Code, stale.Body.String())
	}
	// 新版本配旧报价（小李的余额）：报价对不上小王的资产，也拒收
	mixed := loyaltyCall(t, s, owner.AccessToken, loyaltyInput{Action: "checkout", TargetID: order.ID, ExpectedVersion: v2, QuoteVersion: quoteLi["version"].(string), UseBalance: true, Method: "cash"})
	if mixed.Code != 409 || decodeMap(t, mixed)["code"] != "loyalty_conflict" {
		t.Fatalf("旧报价结账：%d %s", mixed.Code, mixed.Body.String())
	}
	if !bytes.Equal(before, s.snapshotData()) {
		t.Fatal("被拒的结账改动了数据")
	}

	quoteWang := loyaltyOK(t, s, owner.AccessToken, loyaltyInput{Action: "quote", TargetID: order.ID, ExpectedVersion: v2, UseBalance: true})
	if quoteWang["principalCents"] != float64(1000) || quoteWang["offlineCents"] != float64(2000) {
		t.Fatalf("小王的报价：%v", quoteWang)
	}
	loyaltyOK(t, s, owner.AccessToken, loyaltyInput{Action: "checkout", TargetID: order.ID, ExpectedVersion: v2, QuoteVersion: quoteWang["version"].(string), UseBalance: true, Method: "wechat"})
	if b := memberOf(t, s, wang.User.ID).Balance(wang.User.ID, s.now()); b.PrincipalCents != 0 {
		t.Fatalf("小王的余额：%+v", b)
	}
	if b := memberOf(t, s, li.User.ID).Balance(li.User.ID, s.now()); b.PrincipalCents != 5000 {
		t.Fatalf("小李的余额不该动：%+v", b)
	}
}

// 会员扫码入座的套餐订单：顾客由入座申请决定（计时、呼叫店员都认会话上的人），不能在订单上换。
// 整桌开台的会话不在此列，订单可以换顾客，会话不跟着改。
func TestPackageOrderCustomerIsFixedByTheAdmission(t *testing.T) {
	f := seatedCustomer(t)
	clerk := register(t, f.s, "fixed-clerk", "店员")
	setRoles(t, f.s, clerk.User.ID, Clerk)
	other := register(t, f.s, "fixed-other", "小王")
	order := orderOfSession(t, f.s, f.session)
	before := f.s.snapshotData()
	for _, account := range []string{other.User.ID, ""} {
		w := putCustomer(t, f.s, clerk.AccessToken, order.ID, order.Version(), account, id())
		if w.code != 409 || w.decoded()["code"] != "loyalty_conflict" || !strings.Contains(w.decoded()["message"].(string), "入座申请") {
			t.Fatalf("套餐订单换顾客（%q）：%d %s", account, w.code, w.body)
		}
	}
	if !bytes.Equal(before, f.s.snapshotData()) {
		t.Fatal("被拒的换顾客改动了数据")
	}

	// 整桌开台（没有入座申请）的会话：订单能换顾客，会话照旧
	table := seedTable(t, f.s, "C1", "C", 1, 1, false)
	session := &TableSession{ID: id(), TableID: table.ID, UserID: f.customer.User.ID, Status: "active", StartedAt: f.s.now().Add(-time.Hour), TimingMode: "timed", DurationMinutes: 60}
	edit(t, f.s, func(q *txn) { q.addSession(session) })
	created := decodeMap(t, call(t, f.s, http.MethodPost, "/api/v2/sales-orders", clerk.AccessToken, id(), map[string]any{"venueSessionId": session.ID}))
	if created["accountId"] != f.customer.User.ID {
		t.Fatalf("建单带会话的顾客：%v", created)
	}
	w := putCustomer(t, f.s, clerk.AccessToken, created["id"].(string), created["version"].(string), other.User.ID, id())
	if w.code != 200 || w.decoded()["accountId"] != other.User.ID {
		t.Fatalf("整桌会话的订单换顾客：%d %s", w.code, w.body)
	}
	if got := sessionOf(t, f.s, session.ID).UserID; got != f.customer.User.ID {
		t.Fatalf("会话的顾客不该跟着改：%s", got)
	}
}

func TestOrderCustomerRequestIsChecked(t *testing.T) {
	s := newTestServer(t)
	owner := register(t, s, "check-owner", "老板")
	if err := s.BootstrapOwner(owner.User.ID); err != nil {
		t.Fatal(err)
	}
	customer := register(t, s, "check-customer", "顾客")
	order := &Order{ID: id(), Status: "draft", CreatedAt: s.now()}
	edit(t, s, func(q *txn) { q.addOrder(order) })
	version := orderOf(t, s, order.ID).Version()
	path := "/api/v2/sales-orders/" + order.ID + "/customer"
	before := s.snapshotData()

	// 顾客不能给订单换人
	if w := putCustomer(t, s, customer.AccessToken, order.ID, version, customer.User.ID, id()); w.code != 403 {
		t.Fatalf("顾客换顾客：%d %s", w.code, w.body)
	}
	// 没有这位顾客
	if w := putCustomer(t, s, owner.AccessToken, order.ID, version, id(), id()); w.code != 404 || w.decoded()["code"] != "not_found" {
		t.Fatalf("不存在的顾客：%d %s", w.code, w.body)
	}
	// 没有这张订单
	if w := putCustomer(t, s, owner.AccessToken, id(), version, customer.User.ID, id()); w.code != 404 {
		t.Fatalf("不存在的订单：%d %s", w.code, w.body)
	}
	// 没带幂等键
	if w := call(t, s, http.MethodPatch, path, owner.AccessToken, "", map[string]any{"expectedVersion": version, "accountId": customer.User.ID}); w.Code != 400 || decodeMap(t, w)["code"] != "idempotency_required" {
		t.Fatalf("没带幂等键：%d %s", w.Code, w.Body.String())
	}
	// 请求不全或不对：不带 accountId、编号不是 UUID；别的写请求不能夹带 accountId（被拒的请求不按契约核对）
	for name, c := range map[string]struct{ method, path, body string }{
		"没带 accountId":    {http.MethodPatch, path, `{"expectedVersion":"` + version + `"}`},
		"编号不是 UUID":       {http.MethodPatch, path, `{"expectedVersion":"` + version + `","accountId":"小李"}`},
		"编号是数字":           {http.MethodPatch, path, `{"expectedVersion":"` + version + `","accountId":12}`},
		"改明细夹带 accountId": {http.MethodPatch, "/api/v2/sales-orders/" + order.ID, `{"expectedVersion":"` + version + `","lines":[],"accountId":"` + customer.User.ID + `"}`},
	} {
		r := httptest.NewRequest(c.method, c.path, strings.NewReader(c.body))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Authorization", "Bearer "+owner.AccessToken)
		r.Header.Set("Idempotency-Key", id())
		if w := serve(t, s, r); w.Code != 400 || decodeMap(t, w)["code"] != "invalid_request" {
			t.Fatalf("%s：%d %s", name, w.Code, w.Body.String())
		}
	}
	if !bytes.Equal(before, s.snapshotData()) {
		t.Fatal("被拒的请求改动了数据")
	}
}
