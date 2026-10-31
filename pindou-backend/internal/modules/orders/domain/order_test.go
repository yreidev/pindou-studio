package domain

import (
	"encoding/json"
	"regexp"
	"testing"
	"time"
)

func versionFixture() Order {
	now := time.Date(2026, 9, 8, 8, 0, 0, 0, time.UTC)
	return Order{ID: "order", UserID: "customer", TableSessionID: "session", Status: "paid", ReceivableCents: 900, PaidCents: 900,
		Lines:     []Line{{ProductID: "beads", Name: "材料", Quantity: 1, UnitPriceCents: 1000}},
		Discounts: []Discount{{ID: "discount", Kind: "fixed", Reason: "活动", AmountCents: 100, CreatedAt: now}},
		Payments:  []Payment{{ID: "payment", Method: "cash", AmountCents: 900, CreatedAt: now}},
		Refunds:   []Refund{{ID: "refund", Reason: "退货", AmountCents: 100, CreatedAt: now}}, CreatedAt: now}
}

func TestVersionIsStableAcrossReadsAndSerialization(t *testing.T) {
	order := versionFixture()
	before, _ := json.Marshal(order)
	version := order.Version()
	if !regexp.MustCompile(`^[0-9a-f]{64}$`).MatchString(version) {
		t.Fatal("version is not an opaque SHA-256 token")
	}
	var restored Order
	if err := json.Unmarshal(before, &restored); err != nil {
		t.Fatal(err)
	}
	if restored.Version() != version || order.Version() != version {
		t.Fatal("same content produced different confirmation version")
	}
	after, _ := json.Marshal(order)
	if string(before) != string(after) {
		t.Fatal("reading version mutated persisted order")
	}
	restored.RefundedCents = 123 // Derived private cache is absent from the public aggregate.
	if restored.Version() != version {
		t.Fatal("private cache changed the public confirmation version")
	}
}

func TestVersionCoversContentEvenWhenTotalDoesNotChange(t *testing.T) {
	for name, change := range map[string]func(*Order){
		"same price different product":       func(o *Order) { o.Lines[0].ProductID = "other" },
		"line name":                          func(o *Order) { o.Lines[0].Name = "其他材料" },
		"same line total different quantity": func(o *Order) { o.Lines[0].Quantity = 2; o.Lines[0].UnitPriceCents = 500 },
		"discount reason":                    func(o *Order) { o.Discounts[0].Reason = "授权改价" },
		"payment method":                     func(o *Order) { o.Payments[0].Method = "wechat" },
		"refund reason":                      func(o *Order) { o.Refunds[0].Reason = "服务退款" },
		"customer":                           func(o *Order) { o.UserID = "other" },
		"session":                            func(o *Order) { o.TableSessionID = "other" },
		"status":                             func(o *Order) { o.Status = "refunded" },
		"paid amount":                        func(o *Order) { o.PaidCents = 800 },
		"receivable":                         func(o *Order) { o.ReceivableCents = 800 },
		"payment timestamp":                  func(o *Order) { o.Payments[0].CreatedAt = o.Payments[0].CreatedAt.Add(time.Second) },
		"appended refund":                    func(o *Order) { o.Refunds = append(o.Refunds, Refund{ID: "refund2", AmountCents: 1}) },
	} {
		t.Run(name, func(t *testing.T) {
			o := versionFixture()
			before := o.Version()
			change(&o)
			if o.Version() == before {
				t.Fatal("changed public content accepted old confirmation version")
			}
		})
	}
}
