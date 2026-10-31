package app

import (
	"bytes"
	"net/http"
	"testing"
	"time"

	"github.com/xuri/excelize/v2"
)

// xlsxRows 用 excelize 读出导出文件（Export 表）的全部单元格文字。每行补齐到表头的列数：
// excelize 读的时候会略掉行尾的空单元格，而导出时每一格都写了。
func xlsxRows(t *testing.T, body []byte) [][]string {
	t.Helper()
	book, err := excelize.OpenReader(bytes.NewReader(body))
	if err != nil {
		t.Fatalf("export is not an xlsx: %v", err)
	}
	defer book.Close()
	rows, err := book.GetRows("Export")
	if err != nil {
		t.Fatalf("export sheet: %v", err)
	}
	for i := 1; i < len(rows); i++ {
		for len(rows[i]) < len(rows[0]) {
			rows[i] = append(rows[i], "")
		}
	}
	return rows
}

var movementExportHeader = []string{"时间", "商品", "类型", "数量变化", "原因", "供应商", "采购备注", "关联单号", "操作人"}

func sameRow(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// 库存流水导出：按门店日期（含当天）筛选，时间用门店时区，从早到晚；类型写中文；
// 采购带供应商、备注和采购单号，盘点带原因，销售和退款带订单号。店长、老板可导出。
func TestMovementExportByStoreDate(t *testing.T) {
	s := newTestServer(t)
	staff := stockStaff(t, s, "movement-export")

	created := call(t, s, http.MethodPost, "/api/v2/catalog-items", staff.owner.AccessToken, id(), map[string]any{"name": "珠光豆 5mm", "unitPriceCents": 1200})
	if created.Code != http.StatusCreated {
		t.Fatalf("catalog item: %d %s", created.Code, created.Body.String())
	}
	beans := decodeMap(t, created)["id"].(string)
	unnamed := "abcdef12-0000-4000-8000-000000000000"

	// 北京时间 10-03 23:30（UTC 15:30）采购，10-04 01:00（UTC 10-03 17:00）起的都算 10-04。
	clock := time.Date(2026, 10, 3, 15, 30, 0, 0, time.UTC)
	s.now = func() time.Time { return clock }
	receipt := call(t, s, http.MethodPost, "/api/v2/stock-receipts", staff.clerk.AccessToken, id(), map[string]any{
		"supplierName": "义乌豆子批发", "note": "发票 0921",
		"items": []map[string]any{{"productId": beans, "quantity": 5, "unitCostCents": 120}, {"productId": unnamed, "quantity": 2, "unitCostCents": 300}},
	})
	if receipt.Code != http.StatusCreated {
		t.Fatalf("purchase: %d %s", receipt.Code, receipt.Body.String())
	}
	receiptID := decodeMap(t, receipt)["id"].(string)
	beansItem := stockByProductOf(t, s, beans).ID

	clock = time.Date(2026, 10, 3, 17, 0, 0, 0, time.UTC)
	if w := call(t, s, http.MethodPost, "/api/v2/stock-adjustments", staff.manager.AccessToken, id(), map[string]any{"stockItemId": beansItem, "quantityDelta": -1, "reason": "盘点少 1 包", "expectedQuantity": 5}); w.Code != http.StatusCreated {
		t.Fatalf("adjust: %d %s", w.Code, w.Body.String())
	}

	clock = time.Date(2026, 10, 4, 2, 0, 0, 0, time.UTC)
	order := decodeMap(t, call(t, s, http.MethodPost, "/api/v2/sales-orders", staff.owner.AccessToken, id(), map[string]any{}))
	orderID := order["id"].(string)
	if w := call(t, s, http.MethodPatch, "/api/v2/sales-orders/"+orderID, staff.owner.AccessToken, id(), map[string]any{
		"expectedVersion": order["version"],
		"lines":           []map[string]any{{"productId": beans, "name": "珠光豆 5mm", "quantity": 2, "unitPriceCents": 1200}},
	}); w.Code != http.StatusOK {
		t.Fatalf("order lines: %d %s", w.Code, w.Body.String())
	}
	if w := call(t, s, http.MethodPost, "/api/v2/sales-orders/"+orderID+"/payments", staff.owner.AccessToken, id(), map[string]any{"expectedVersion": orderOf(t, s, orderID).Version(), "method": "cash", "amountCents": 2400}); w.Code != http.StatusCreated {
		t.Fatalf("payment: %d %s", w.Code, w.Body.String())
	}
	clock = clock.Add(time.Hour)
	if w := call(t, s, http.MethodPost, "/api/v2/sales-orders/"+orderID+"/refunds", staff.owner.AccessToken, id(), map[string]any{"expectedVersion": orderOf(t, s, orderID).Version(), "amountCents": 1200, "reason": "顾客退一包", "returnedProducts": map[string]any{beans: 1}}); w.Code != http.StatusCreated {
		t.Fatalf("refund: %d %s", w.Code, w.Body.String())
	}

	export := func(query string) [][]string {
		t.Helper()
		w := call(t, s, http.MethodGet, "/api/v2/reports/exports/movements"+query, staff.manager.AccessToken, "", nil)
		if w.Code != http.StatusOK {
			t.Fatalf("export %s: %d %s", query, w.Code, w.Body.String())
		}
		if got := w.Header().Get("Content-Disposition"); got != "attachment; filename=movements.xlsx" {
			t.Fatalf("Content-Disposition=%q", got)
		}
		rows := xlsxRows(t, w.Body.Bytes())
		if len(rows) == 0 || !sameRow(rows[0], movementExportHeader) {
			t.Fatalf("header row: %v", rows)
		}
		return rows[1:]
	}

	// 最后一列是办这笔的员工昵称：采购由店员登记，盘点由店长，收款出库与退款回补由老板
	purchaseBeans := []string{"2026-10-03 23:30:00", "珠光豆 5mm", "采购入库", "5", "", "义乌豆子批发", "发票 0921", receiptID, "Clerk"}
	purchaseUnnamed := []string{"2026-10-03 23:30:00", "未命名商品 · abcdef12", "采购入库", "2", "", "义乌豆子批发", "发票 0921", receiptID, "Clerk"}
	adjustment := []string{"2026-10-04 01:00:00", "珠光豆 5mm", "盘点调整", "-1", "盘点少 1 包", "", "", "", "Manager"}
	sale := []string{"2026-10-04 10:00:00", "珠光豆 5mm", "销售出库", "-2", "", "", "", orderID, "Owner"}
	refund := []string{"2026-10-04 11:00:00", "珠光豆 5mm", "退款回补", "1", "", "", "", orderID, "Owner"}

	all := export("")
	if len(all) != 5 {
		t.Fatalf("all movements: %v", all)
	}
	// 同一时刻的两条采购按流水编号排，先后不定；其余按时间从早到晚。
	if !(sameRow(all[0], purchaseBeans) && sameRow(all[1], purchaseUnnamed)) && !(sameRow(all[0], purchaseUnnamed) && sameRow(all[1], purchaseBeans)) {
		t.Fatalf("purchase rows: %v / %v", all[0], all[1])
	}
	for i, want := range [][]string{adjustment, sale, refund} {
		if !sameRow(all[i+2], want) {
			t.Fatalf("row %d = %v, want %v", i+2, all[i+2], want)
		}
	}

	// 门店日期 10-04：凌晨 01:00 的盘点（UTC 还是 10-03）算进来，10-03 23:30 的采购不算。
	if got := export("?from=2026-10-04&to=2026-10-04"); len(got) != 3 || !sameRow(got[0], adjustment) || !sameRow(got[2], refund) {
		t.Fatalf("store date 10-04: %v", got)
	}
	if got := export("?to=2026-10-03"); len(got) != 2 || got[0][2] != "采购入库" || got[1][2] != "采购入库" {
		t.Fatalf("up to store date 10-03: %v", got)
	}
	if got := export("?from=2026-10-05"); len(got) != 0 {
		t.Fatalf("from 10-05 should be empty: %v", got)
	}

	if w := call(t, s, http.MethodGet, "/api/v2/reports/exports/movements?from=2026-10-05&to=2026-10-04", staff.owner.AccessToken, "", nil); w.Code != http.StatusBadRequest || decodeMap(t, w)["code"] != "invalid_date_range" {
		t.Fatalf("reversed date range: %d %s", w.Code, w.Body.String())
	}
	if w := call(t, s, http.MethodGet, "/api/v2/reports/exports/movements?from=2026/10/04", staff.owner.AccessToken, "", nil); w.Code != http.StatusBadRequest {
		t.Fatalf("bad date format: %d", w.Code)
	}
	for name, bearer := range map[string]string{"clerk": staff.clerk.AccessToken, "customer": staff.customer.AccessToken} {
		if w := call(t, s, http.MethodGet, "/api/v2/reports/exports/movements", bearer, "", nil); w.Code != http.StatusForbidden {
			t.Fatalf("%s must not export the ledger: %d", name, w.Code)
		}
	}
	if w := call(t, s, http.MethodGet, "/api/v2/reports/exports/movements", "", "", nil); w.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous export: %d", w.Code)
	}

	// 原来的「库存」导出照旧：当时数量，不按日期。
	inventory := call(t, s, http.MethodGet, "/api/v2/reports/exports/inventory?from=2026-10-05", staff.owner.AccessToken, "", nil)
	if inventory.Code != http.StatusOK {
		t.Fatalf("inventory export: %d", inventory.Code)
	}
	if rows := xlsxRows(t, inventory.Body.Bytes()); len(rows) != 3 {
		t.Fatalf("inventory export should list both stock items regardless of dates: %v", rows)
	}
}

func TestMovementKindLabels(t *testing.T) {
	for _, c := range []struct {
		kind  string
		delta int64
		want  string
	}{
		{"purchase", 3, "采购入库"},
		{"adjustment", -1, "盘点调整"},
		{"adjustment", 2, "盘点调整"},
		{"sale", -2, "销售出库"},
		{"refund", 1, "退款回补"},
		{"loyalty", -1, "会员出库"},
		{"loyalty", 1, "会员退回"},
		{"something-new", 1, "something-new"},
	} {
		if got := movementKindLabel(c.kind, c.delta); got != c.want {
			t.Fatalf("movementKindLabel(%q, %d)=%q, want %q", c.kind, c.delta, got, c.want)
		}
	}
}
