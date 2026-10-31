package app

import (
	"encoding/json"
	"sort"
	"strings"
	"testing"

	"github.com/yreidev/pindou-studio/pindou-backend/internal/modules/orders/domain"
)

// 已付款订单只能追加退款（immutable_paid_order 触发器：state 去掉 refunds、status 之后必须和库里一样）。
// 订单整条存在 sales_orders.state 里，所以给 Order 或它里面的明细、折扣、付款、退款加一个总会出现的键，
// 库里的旧订单就没有这个键：之后给这些旧订单退款，触发器会拒绝整次保存。
//
// 新字段要么加 omitempty（零值不出现），要么写迁移把旧订单补齐，再更新这里的清单。
func TestPaidOrderShapeIsFrozen(t *testing.T) {
	order := domain.Order{
		Lines:     []domain.Line{{}},
		Discounts: []domain.Discount{{}},
		Payments:  []domain.Payment{{}},
		Refunds:   []domain.Refund{{}},
	}
	data, err := json.Marshal(order)
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(data, &doc); err != nil {
		t.Fatal(err)
	}
	keys := func(v any) string {
		var out []string
		for k := range v.(map[string]any) {
			out = append(out, k)
		}
		sort.Strings(out)
		return strings.Join(out, ",")
	}
	first := func(name string) any { return doc[name].([]any)[0] }
	got := map[string]string{
		"order":    keys(doc),
		"line":     keys(first("lines")),
		"discount": keys(first("discounts")),
		"payment":  keys(first("payments")),
		"refund":   keys(first("refunds")),
	}
	want := map[string]string{
		"order":    "createdAt,discounts,id,lines,paidCents,payments,receivableCents,refunds,status",
		"line":     "quantity,unitPriceCents",
		"discount": "createdAt,id,kind,reason",
		"payment":  "amountCents,createdAt,id,method",
		"refund":   "amountCents,createdAt,id,reason",
	}
	for name := range want {
		if got[name] != want[name] {
			t.Errorf("%s 的 JSON 键变了：%s，原来是 %s。旧的已付订单没有新键，给它们退款会被触发器拒绝；加 omitempty 或写迁移补齐旧订单",
				name, got[name], want[name])
		}
	}
}
