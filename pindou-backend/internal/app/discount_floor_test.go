package app

import (
	"net/http"
	"testing"
	"time"

	member "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/membership/application"
)

// 人工折扣不能把应收减到 0。
//
// 应收为 0 的单结不了账：收款要求至少 1 分，两端前端也拦 0。以前固定减免大于等于应收、
// 或者减免 100% 都照收，草稿从此挂在「待结账」里，收不了也撤不掉。整单不收钱是单独的免单
// （2026-10-06 起：店长、老板写明原因，记一条免单结清记录），人工折扣仍不能把一单减成 0。
func TestManualDiscountCannotTakeTheOrderToZero(t *testing.T) {
	now := time.Date(2026, 9, 20, 10, 0, 0, 0, time.UTC)
	s := newTestServer(t)
	s.now = func() time.Time { return now }
	o := register(t, s, "discount-floor-owner", "老板")
	if err := s.BootstrapOwner(o.User.ID); err != nil {
		t.Fatal(err)
	}
	publishRule(t, s, o.AccessToken, member.Rule{Kind: "package", Name: "1小时", AmountCents: 2990, DurationMinutes: 60, Overtime: "manual"})
	table := seedTable(t, s, "A1", "A", 1, 2, true)
	w := call(t, s, http.MethodPost, "/api/v2/venue-sessions", o.AccessToken, "",
		map[string]any{"serviceTableId": table.ID, "timingMode": "timed", "durationMinutes": 60, "startedAt": now.Format(time.RFC3339)})
	if w.Code != 201 {
		t.Fatalf("开台失败：%d %s", w.Code, w.Body.String())
	}
	w = call(t, s, http.MethodPost, "/api/v2/sales-orders", o.AccessToken, "discount-floor-order", map[string]any{"venueSessionId": decodeMap(t, w)["id"]})
	if w.Code != 201 {
		t.Fatalf("建单失败：%d %s", w.Code, w.Body.String())
	}
	orderID := decodeMap(t, w)["id"].(string)
	before := *orderOf(t, s, orderID)
	if before.ReceivableCents != 2990 {
		t.Fatalf("前置条件：应收 ¥29.90，实际 %d", before.ReceivableCents)
	}

	for name, discount := range map[string]map[string]any{
		"固定减免等于应收": {"kind": "fixed", "amountCents": 2990},
		"固定减免超过应收": {"kind": "fixed", "amountCents": 5000},
		"减免 100%":  {"kind": "percentage", "rateBasisPoints": 10000},
	} {
		discount["reason"] = "老顾客"
		discount["expectedVersion"] = before.Version()
		w := call(t, s, http.MethodPost, "/api/v2/sales-orders/"+orderID+"/discounts", o.AccessToken, "floor-"+name, discount)
		if w.Code != 409 || decodeMap(t, w)["code"] != "zero_receivable" {
			t.Fatalf("%s：应拒绝并说明整单不收钱要用免单，实际 %d %s", name, w.Code, w.Body.String())
		}
	}
	if after := orderOf(t, s, orderID); after.Version() != before.Version() || len(after.Discounts) != 0 {
		t.Fatalf("被拒的折扣不能留下任何改动：%+v", after)
	}

	// 留 1 分照样可以，订单还收得了
	w = call(t, s, http.MethodPost, "/api/v2/sales-orders/"+orderID+"/discounts", o.AccessToken, "floor-ok",
		map[string]any{"kind": "fixed", "amountCents": 2989, "reason": "老顾客", "expectedVersion": before.Version()})
	if w.Code != 201 {
		t.Fatalf("留 1 分的折扣应当成功：%d %s", w.Code, w.Body.String())
	}
	discounted := *orderOf(t, s, orderID)
	if discounted.ReceivableCents != 1 {
		t.Fatalf("应收应剩 1 分，实际 %d", discounted.ReceivableCents)
	}

	// 有折扣时把明细改便宜，折扣同样会把应收减到 0：一样拒绝
	w = call(t, s, http.MethodPatch, "/api/v2/sales-orders/"+orderID, o.AccessToken, "floor-lines",
		map[string]any{"expectedVersion": discounted.Version(), "lines": []map[string]any{{"name": "1小时", "quantity": 1, "unitPriceCents": 2000}}})
	if w.Code != 409 || decodeMap(t, w)["code"] != "zero_receivable" {
		t.Fatalf("改明细让已有折扣减到 0 也要拒绝：%d %s", w.Code, w.Body.String())
	}
	if after := orderOf(t, s, orderID); after.Version() != discounted.Version() {
		t.Fatal("被拒的明细修改不能留下改动")
	}
}
