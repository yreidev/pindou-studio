package app

import (
	"net/http"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

// 商品条码（2026-10-06 业主改定：手机上收货入库并扫码）：店长、老板登记条码，同一条码只属于一件商品，
// 被占用时说清是哪件；员工（含店员）按条码精确查，查不到是空列表；手机绑条码只带 barcode，不动名称和售价。
func TestCatalogBarcodes(t *testing.T) {
	s := newTestServer(t)
	owner := register(t, s, "barcode-owner", "老板")
	if err := s.BootstrapOwner(owner.User.ID); err != nil {
		t.Fatal(err)
	}
	manager := register(t, s, "barcode-manager", "店长")
	setRoles(t, s, manager.User.ID, Manager)
	clerk := register(t, s, "barcode-clerk", "店员")
	setRoles(t, s, clerk.User.ID, Clerk)
	customer := register(t, s, "barcode-customer", "顾客")

	lookup := func(token, code string) *httpResult {
		t.Helper()
		w := call(t, s, http.MethodGet, "/api/v2/catalog-items?barcode="+url.QueryEscape(code), token, "", nil)
		return &httpResult{code: w.Code, body: w.Body.String()}
	}

	// 老板建商品时登记条码：扫码枪带回车、前后空白都去掉
	w := call(t, s, http.MethodPost, "/api/v2/catalog-items", owner.AccessToken, id(), map[string]any{"name": "拼豆 5mm 白", "unitPriceCents": 1200, "barcode": " 6901234567892\r\n"})
	if w.Code != 201 || decodeMap(t, w)["barcode"] != "6901234567892" {
		t.Fatalf("建商品带条码：%d %s", w.Code, w.Body.String())
	}
	white := decodeMap(t, w)["id"].(string)
	// 没登记条码的商品，响应里不带 barcode
	w = call(t, s, http.MethodPost, "/api/v2/catalog-items", owner.AccessToken, id(), map[string]any{"name": "拼豆 5mm 黑", "unitPriceCents": 1200})
	if w.Code != 201 {
		t.Fatalf("建商品：%d %s", w.Code, w.Body.String())
	}
	if _, has := decodeMap(t, w)["barcode"]; has {
		t.Fatalf("没有条码的商品不该带 barcode：%s", w.Body.String())
	}
	black := decodeMap(t, w)["id"].(string)

	// 店员能按条码查到；查不到是空列表；格式不对是 400；顾客不能查
	if r := lookup(clerk.AccessToken, "6901234567892"); r.code != 200 || !strings.Contains(r.body, white) || strings.Contains(r.body, black) {
		t.Fatalf("店员按条码查：%d %s", r.code, r.body)
	}
	if r := lookup(clerk.AccessToken, " 6901234567892 "); r.code != 200 || !strings.Contains(r.body, white) {
		t.Fatalf("查询时也去掉首尾空白：%d %s", r.code, r.body)
	}
	if r := lookup(clerk.AccessToken, "0000000000000"); r.code != 200 || strings.TrimSpace(r.body) != "[]" {
		t.Fatalf("没登记的条码应当是空列表：%d %s", r.code, r.body)
	}
	for _, bad := range []string{"", "  ", "690 123", "条码", strings.Repeat("1", 65)} {
		if r := lookup(clerk.AccessToken, bad); r.code != 400 || !strings.Contains(r.body, "invalid_barcode") {
			t.Fatalf("条码 %q 格式不对应当 400：%d %s", bad, r.code, r.body)
		}
	}
	if r := lookup(customer.AccessToken, "6901234567892"); r.code != 403 {
		t.Fatalf("顾客不能按条码查商品：%d", r.code)
	}

	// 店员不能改条码
	if w := call(t, s, http.MethodPatch, "/api/v2/catalog-items/"+black, clerk.AccessToken, id(), map[string]any{"barcode": "6901234567809"}); w.Code != 403 {
		t.Fatalf("店员不能绑条码：%d %s", w.Code, w.Body.String())
	}
	// 条码已被别的商品占用：409，说清是哪件商品；什么都不改
	before := s.snapshotData()
	w = call(t, s, http.MethodPatch, "/api/v2/catalog-items/"+black, manager.AccessToken, id(), map[string]any{"barcode": "6901234567892"})
	if w.Code != 409 || decodeMap(t, w)["code"] != "barcode_taken" || !strings.Contains(decodeMap(t, w)["message"].(string), "拼豆 5mm 白") {
		t.Fatalf("条码被占用：%d %s", w.Code, w.Body.String())
	}
	if w := call(t, s, http.MethodPost, "/api/v2/catalog-items", owner.AccessToken, id(), map[string]any{"name": "重复条码", "unitPriceCents": 1, "barcode": "6901234567892"}); w.Code != 409 || decodeMap(t, w)["code"] != "barcode_taken" {
		t.Fatalf("新建时条码被占用：%d %s", w.Code, w.Body.String())
	}
	if string(before) != string(s.snapshotData()) {
		t.Fatal("被拒的条码改动改了数据")
	}
	// 格式不对：400 invalid_barcode
	if w := call(t, s, http.MethodPatch, "/api/v2/catalog-items/"+black, manager.AccessToken, id(), map[string]any{"barcode": "690 1234"}); w.Code != 400 || decodeMap(t, w)["code"] != "invalid_barcode" {
		t.Fatalf("条码带空格：%d %s", w.Code, w.Body.String())
	}
	// 什么都没带：400；新建时名称、售价仍然必填（只有条码不行）
	if w := call(t, s, http.MethodPatch, "/api/v2/catalog-items/"+black, manager.AccessToken, id(), map[string]any{}); w.Code != 400 {
		t.Fatalf("空的修改：%d %s", w.Code, w.Body.String())
	}
	for _, partial := range []map[string]any{{"name": "只有名称"}, {"unitPriceCents": 100}, {"barcode": "123"}} {
		if w := call(t, s, http.MethodPost, "/api/v2/catalog-items", owner.AccessToken, id(), partial); w.Code != 400 || decodeMap(t, w)["code"] != "invalid_catalog_item" {
			t.Fatalf("新建缺字段 %v：%d %s", partial, w.Code, w.Body.String())
		}
	}
	// 不存在的商品：404
	if w := call(t, s, http.MethodPatch, "/api/v2/catalog-items/"+id(), manager.AccessToken, id(), map[string]any{"barcode": "123"}); w.Code != 404 {
		t.Fatalf("不存在的商品：%d %s", w.Code, w.Body.String())
	}

	// 店长在手机上只带 barcode 绑定：名称、售价不动；审计记下条码变化
	w = call(t, s, http.MethodPatch, "/api/v2/catalog-items/"+black, manager.AccessToken, id(), map[string]any{"barcode": "6901234567809"})
	if w.Code != 200 {
		t.Fatalf("只绑条码：%d %s", w.Code, w.Body.String())
	}
	if got := decodeMap(t, w); got["name"] != "拼豆 5mm 黑" || got["unitPriceCents"] != float64(1200) || got["barcode"] != "6901234567809" {
		t.Fatalf("只绑条码动了别的字段：%v", got)
	}
	if a := lastAudit(t, s); a.Action != "catalog.updated" || a.ActorID != manager.User.ID || a.ObjectID != black || a.Reason != "条码 无 → 6901234567809" {
		t.Fatalf("绑条码的审计：%+v", a)
	}
	// 老客户端（只带名称和售价）改资料：条码保留
	w = call(t, s, http.MethodPatch, "/api/v2/catalog-items/"+black, owner.AccessToken, id(), map[string]any{"name": "拼豆 5mm 黑（大包）", "unitPriceCents": 1500})
	if w.Code != 200 || decodeMap(t, w)["barcode"] != "6901234567809" {
		t.Fatalf("只改名称售价应当保留条码：%d %s", w.Code, w.Body.String())
	}
	if a := lastAudit(t, s); a.Reason != "" {
		t.Fatalf("条码没变时审计不写条码：%+v", a)
	}
	// 把同一条码再登记给同一件商品：不算占用
	if w := call(t, s, http.MethodPatch, "/api/v2/catalog-items/"+black, owner.AccessToken, id(), map[string]any{"barcode": "6901234567809"}); w.Code != 200 {
		t.Fatalf("同一件商品重登同一条码：%d %s", w.Code, w.Body.String())
	}

	// 清除白色的条码后，黑色的可以换成这个条码
	w = call(t, s, http.MethodPatch, "/api/v2/catalog-items/"+white, owner.AccessToken, id(), map[string]any{"barcode": ""})
	if w.Code != 200 {
		t.Fatalf("清除条码：%d %s", w.Code, w.Body.String())
	}
	if _, has := decodeMap(t, w)["barcode"]; has {
		t.Fatalf("清除后不该再带 barcode：%s", w.Body.String())
	}
	if a := lastAudit(t, s); a.Reason != "条码 6901234567892 → 无" {
		t.Fatalf("清除条码的审计：%+v", a)
	}
	if r := lookup(clerk.AccessToken, "6901234567892"); r.code != 200 || strings.TrimSpace(r.body) != "[]" {
		t.Fatalf("清除后查不到：%d %s", r.code, r.body)
	}
	if w := call(t, s, http.MethodPatch, "/api/v2/catalog-items/"+black, owner.AccessToken, id(), map[string]any{"barcode": "6901234567892"}); w.Code != 200 {
		t.Fatalf("换条码：%d %s", w.Code, w.Body.String())
	}
	if a := lastAudit(t, s); a.Reason != "条码 6901234567809 → 6901234567892" {
		t.Fatalf("换条码的审计：%+v", a)
	}

	// 重启后条码还在，按条码查得到
	restarted := serverOn(t, s.postgres)
	w = call(t, restarted, http.MethodGet, "/api/v2/catalog-items?barcode=6901234567892", clerk.AccessToken, "", nil)
	if w.Code != 200 || !strings.Contains(w.Body.String(), black) || !strings.Contains(w.Body.String(), "拼豆 5mm 黑（大包）") {
		t.Fatalf("重启后按条码查：%d %s", w.Code, w.Body.String())
	}
	// 全部目录里也带条码
	w = call(t, restarted, http.MethodGet, "/api/v2/catalog-items", clerk.AccessToken, "", nil)
	if w.Code != 200 || strings.Count(w.Body.String(), `"barcode"`) != 1 {
		t.Fatalf("目录里的条码：%d %s", w.Code, w.Body.String())
	}
}

// 两个人同时把同一条码登记给两件商品：后提交的撞唯一索引、整个请求重来，重来时看到已被占用回 409，
// 不会两件都登记上，也不会回 5xx。
func TestConcurrentBarcodeBindingKeepsOneOwner(t *testing.T) {
	s := newTestServer(t)
	owner := register(t, s, "barcode-race-owner", "老板")
	if err := s.BootstrapOwner(owner.User.ID); err != nil {
		t.Fatal(err)
	}
	products := make([]string, 4)
	for i := range products {
		w := call(t, s, http.MethodPost, "/api/v2/catalog-items", owner.AccessToken, id(), map[string]any{"name": "商品" + string(rune('A'+i)), "unitPriceCents": 100})
		products[i] = decodeMap(t, w)["id"].(string)
	}
	codes := make([]int, len(products))
	var wg sync.WaitGroup
	for i, product := range products {
		wg.Add(1)
		go func() {
			defer wg.Done()
			codes[i] = call(t, s, http.MethodPatch, "/api/v2/catalog-items/"+product, owner.AccessToken, id(), map[string]any{"barcode": "RACE-1"}).Code
		}()
	}
	wg.Wait()
	ok, taken := 0, 0
	for _, code := range codes {
		switch code {
		case 200:
			ok++
		case 409:
			taken++
		default:
			t.Fatalf("同时绑定同一条码：%v", codes)
		}
	}
	if ok != 1 || taken != len(products)-1 {
		t.Fatalf("只能有一件登记上：%v", codes)
	}
	withCode := 0
	for _, item := range catalogOf(t, s) {
		if item.Barcode == "RACE-1" {
			withCode++
		}
	}
	if withCode != 1 {
		t.Fatalf("库里登记了 %d 件", withCode)
	}
}

// 收货入库的预填：最近一次入库的供应商、每件商品最近一次入库的进价，由后端从采购单现算；所有员工可读。
func TestPurchasePrefill(t *testing.T) {
	s := newTestServer(t)
	base := time.Date(2026, 10, 6, 10, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return base }
	owner := register(t, s, "prefill-owner", "老板")
	if err := s.BootstrapOwner(owner.User.ID); err != nil {
		t.Fatal(err)
	}
	clerk := register(t, s, "prefill-clerk", "店员")
	setRoles(t, s, clerk.User.ID, Clerk)
	customer := register(t, s, "prefill-customer", "顾客")
	prefill := func(token string) (int, map[string]any) {
		t.Helper()
		w := call(t, s, http.MethodGet, "/api/v2/stock-receipts/prefill", token, "", nil)
		if w.Code != 200 {
			return w.Code, nil
		}
		return w.Code, decodeMap(t, w)
	}
	costs := func(body map[string]any) map[string]float64 {
		out := map[string]float64{}
		for _, raw := range body["lastUnitCosts"].([]any) {
			c := raw.(map[string]any)
			out[c["productId"].(string)] = c["unitCostCents"].(float64)
		}
		return out
	}

	// 还没入过库：没有供应商，进价列表为空
	if code, body := prefill(clerk.AccessToken); code != 200 || body["supplierName"] != nil || len(body["lastUnitCosts"].([]any)) != 0 {
		t.Fatalf("没入过库：%d %v", code, body)
	}
	if code, _ := prefill(customer.AccessToken); code != 403 {
		t.Fatalf("顾客不能读预填：%d", code)
	}

	x, y := id(), id()
	receive := func(token, supplier string, items ...map[string]any) {
		t.Helper()
		if w := call(t, s, http.MethodPost, "/api/v2/stock-receipts", token, id(), map[string]any{"supplierName": supplier, "items": items}); w.Code != 201 {
			t.Fatalf("入库：%d %s", w.Code, w.Body.String())
		}
	}
	receive(owner.AccessToken, "义乌拼豆批发", map[string]any{"productId": x, "quantity": 10, "unitCostCents": 100}, map[string]any{"productId": y, "quantity": 5, "unitCostCents": 200})
	s.now = func() time.Time { return base.Add(time.Hour) }
	// 店员后来又进了一次 x（大写编号也算同一件商品），换了供应商和进价；同一单里 x 出现两行取靠后的
	receive(clerk.AccessToken, "本地文具店", map[string]any{"productId": strings.ToUpper(x), "quantity": 1, "unitCostCents": 140}, map[string]any{"productId": x, "quantity": 2, "unitCostCents": 150})

	code, body := prefill(clerk.AccessToken)
	if code != 200 || body["supplierName"] != "本地文具店" {
		t.Fatalf("最近一次的供应商：%d %v", code, body)
	}
	if got := costs(body); len(got) != 2 || got[x] != 150 || got[y] != 200 {
		t.Fatalf("每件商品最近一次的进价：%v", got)
	}
}
