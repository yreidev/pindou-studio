package app

import (
	"bytes"
	"testing"
)

func TestPaymentStockFailuresAndServices(t *testing.T) {
	exercisePaymentStock(t, newTestServer(t))
}

func TestPostgresPaymentStockFailuresAndServices(t *testing.T) {
	db := newTestDatabase(t)
	s := serverOn(t, db)
	exercisePaymentStock(t, s)
	restarted := serverOn(t, db)
	if len(ordersOf(t, restarted)) != 3 || len(movementsOf(t, restarted)) != len(movementsOf(t, s)) {
		t.Fatal("payment and stock records did not survive restart")
	}
	for _, order := range ordersOf(t, restarted) {
		if order.Status != "paid" || len(order.Payments) != 1 {
			t.Fatal("payment was lost or duplicated after restart")
		}
	}
}

func exercisePaymentStock(t *testing.T, s *Server) {
	t.Helper()
	owner := register(t, s, "payment-stock-owner", "Owner")
	if err := s.BootstrapOwner(owner.User.ID); err != nil {
		t.Fatal(err)
	}
	for _, scenario := range []string{"service", "catalog-without-stock", "duplicate-product-lines"} {
		t.Run(scenario, func(t *testing.T) {
			created := call(t, s, "POST", "/api/v2/sales-orders", owner.AccessToken, id(), map[string]any{})
			if created.Code != 201 {
				t.Fatalf("create order: %d", created.Code)
			}
			oid := decodeMap(t, created)["id"].(string)
			path := "/api/v2/sales-orders/" + oid
			lines := []OrderLine{{Name: "计时服务", Quantity: 1, UnitPriceCents: 2990}}
			productID := ""
			purchase := func(quantity int) {
				t.Helper()
				r := call(t, s, "POST", "/api/v2/stock-receipts", owner.AccessToken, id(), map[string]any{"supplierName": "Supplier", "items": []map[string]any{{"productId": productID, "quantity": quantity, "unitCostCents": 100}}})
				if r.Code != 201 {
					t.Fatalf("purchase: %d", r.Code)
				}
			}
			if scenario != "service" {
				catalog := call(t, s, "POST", "/api/v2/catalog-items", owner.AccessToken, id(), map[string]any{"name": "测试商品", "unitPriceCents": 2990})
				if catalog.Code != 201 {
					t.Fatalf("catalog: %d", catalog.Code)
				}
				productID = decodeMap(t, catalog)["id"].(string)
				lines[0].ProductID, lines[0].Name = productID, "测试商品"
				if scenario == "duplicate-product-lines" {
					lines = append(lines, lines[0])
					purchase(1)
				}
			}
			edited := call(t, s, "PATCH", path, owner.AccessToken, id(), map[string]any{"expectedVersion": orderOf(t, s, oid).Version(), "lines": lines})
			if edited.Code != 200 {
				t.Fatalf("edit order: %d", edited.Code)
			}
			payment := map[string]any{"expectedVersion": orderOf(t, s, oid).Version(), "method": "wechat", "amountCents": orderOf(t, s, oid).ReceivableCents}
			key := id()
			if scenario != "service" {
				before := s.snapshotData()
				failed := call(t, s, "POST", path+"/payments", owner.AccessToken, key, payment)
				if failed.Code != 409 || decodeMap(t, failed)["code"] != "insufficient_stock" {
					t.Fatalf("stock error: %d %s", failed.Code, failed.Body.String())
				}
				if !bytes.Equal(before, s.snapshotData()) {
					t.Fatal("rejected payment changed order, stock, audit or idempotency state")
				}
				purchase(1)
			}
			movements := len(movementsOf(t, s))
			for attempt := 0; attempt < 2; attempt++ {
				paid := call(t, s, "POST", path+"/payments", owner.AccessToken, key, payment)
				if paid.Code != 201 || decodeMap(t, paid)["status"] != "paid" {
					t.Fatalf("pay attempt %d: %d %s", attempt, paid.Code, paid.Body.String())
				}
			}
			if len(orderOf(t, s, oid).Payments) != 1 {
				t.Fatal("replayed payment was recorded twice")
			}
			if productID == "" {
				if len(movementsOf(t, s)) != movements {
					t.Fatal("service payment changed stock")
				}
			} else if stockByProductOf(t, s, productID).Quantity != 0 || len(movementsOf(t, s)) != movements+1 {
				t.Fatal("product payment did not deduct aggregate quantity exactly once")
			}
		})
	}
}
