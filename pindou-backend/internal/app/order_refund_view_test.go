package app

import (
	"encoding/json"
	"net/http"
	"testing"
)

// 订单接口带上服务端算好的已退金额与还可退上限，网页后台只展示、不自行加减；
// 这两个值不进入订单版本，登记退款也按同一个上限校验。
func TestOrderViewCarriesRefundTotals(t *testing.T) {
	s := newTestServer(t)
	h := s.Handler()
	owner := register(t, s, "owner", "Owner")
	if err := s.BootstrapOwner(owner.User.ID); err != nil {
		t.Fatal(err)
	}
	orderID := decodeMap(t, call(t, h, http.MethodPost, "/api/v2/sales-orders", owner.AccessToken, id(), map[string]any{}))["id"].(string)
	version := func() string {
		return orderOf(t, s, orderID).Version()
	}
	read := func() map[string]any {
		t.Helper()
		w := call(t, h, http.MethodGet, "/api/v2/sales-orders/"+orderID, owner.AccessToken, "", nil)
		if w.Code != 200 {
			t.Fatalf("read: %d %s", w.Code, w.Body.String())
		}
		return decodeMap(t, w)
	}
	totals := func(view map[string]any) (int64, int64) {
		return int64(view["refundedCents"].(float64)), int64(view["refundableCents"].(float64))
	}

	if refunded, refundable := totals(read()); refunded != 0 || refundable != 0 {
		t.Fatalf("草稿订单：已退 %d 可退 %d", refunded, refundable)
	}
	if w := call(t, h, http.MethodPatch, "/api/v2/sales-orders/"+orderID, owner.AccessToken, id(),
		map[string]any{"expectedVersion": version(), "lines": []map[string]any{{"name": "计时服务费", "quantity": 1, "unitPriceCents": 30000}}}); w.Code != 200 {
		t.Fatalf("lines: %d %s", w.Code, w.Body.String())
	}
	if w := call(t, h, http.MethodPost, "/api/v2/sales-orders/"+orderID+"/payments", owner.AccessToken, id(),
		map[string]any{"expectedVersion": version(), "method": "cash", "amountCents": 30000}); w.Code != 201 {
		t.Fatalf("payment: %d %s", w.Code, w.Body.String())
	}
	refund := call(t, h, http.MethodPost, "/api/v2/sales-orders/"+orderID+"/refunds", owner.AccessToken, id(),
		map[string]any{"expectedVersion": version(), "amountCents": 12000, "reason": "部分退款"})
	if refund.Code != 201 {
		t.Fatalf("refund: %d %s", refund.Code, refund.Body.String())
	}
	if refunded, refundable := totals(decodeMap(t, refund)); refunded != 12000 || refundable != 18000 {
		t.Fatalf("退款响应：已退 %d 可退 %d", refunded, refundable)
	}
	view := read()
	if refunded, refundable := totals(view); refunded != 12000 || refundable != 18000 || view["status"] != "paid" {
		t.Fatalf("部分退款后：%v", view)
	}
	if view["version"] != version() {
		t.Fatal("附加的已退、可退字段不应改变订单版本")
	}

	// 列表与详情同样带这两个值
	list := call(t, h, http.MethodGet, "/api/v2/sales-orders", owner.AccessToken, "", nil)
	var rows []map[string]any
	if err := json.Unmarshal(list.Body.Bytes(), &rows); err != nil || len(rows) != 1 {
		t.Fatalf("list: %d %s", list.Code, list.Body.String())
	}
	if refunded, refundable := totals(rows[0]); refunded != 12000 || refundable != 18000 {
		t.Fatalf("列表：已退 %d 可退 %d", refunded, refundable)
	}

	// 超过可退上限被拒，且不留下记录
	over := call(t, h, http.MethodPost, "/api/v2/sales-orders/"+orderID+"/refunds", owner.AccessToken, id(),
		map[string]any{"expectedVersion": version(), "amountCents": 18001, "reason": "超额"})
	if over.Code != 400 {
		t.Fatalf("超过可退上限应被拒绝：%d %s", over.Code, over.Body.String())
	}
	if refunded, _ := totals(read()); refunded != 12000 {
		t.Fatalf("被拒的退款不应留下记录，已退 %d", refunded)
	}
	rest := call(t, h, http.MethodPost, "/api/v2/sales-orders/"+orderID+"/refunds", owner.AccessToken, id(),
		map[string]any{"expectedVersion": version(), "amountCents": 18000, "reason": "退完"})
	if rest.Code != 201 {
		t.Fatalf("退完余额：%d %s", rest.Code, rest.Body.String())
	}
	done := decodeMap(t, rest)
	if refunded, refundable := totals(done); refunded != 30000 || refundable != 0 || done["status"] != "refunded" {
		t.Fatalf("全部退完：%v", done)
	}
}
