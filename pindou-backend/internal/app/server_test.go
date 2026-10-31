package app

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type sessionResponse struct {
	AccessToken string `json:"accessToken"`
	User        User   `json:"user"`
}

// call 发一个接口请求（body 不为 nil 时编成 JSON），请求与响应按契约核对（见 contract_test.go）。
func call(t *testing.T, h http.Handler, method, path, bearer, idem string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var data []byte
	if body != nil {
		var err error
		data, err = json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
	}
	r := httptest.NewRequest(method, path, bytes.NewReader(data))
	if body != nil {
		r.Header.Set("Content-Type", "application/json") // 网页后台和小程序发的都带
	}
	if bearer != "" {
		r.Header.Set("Authorization", "Bearer "+bearer)
	}
	if idem != "" {
		r.Header.Set("Idempotency-Key", idem)
	}
	return serve(t, h, r)
}

func register(t *testing.T, s *Server, code, nickname string) sessionResponse {
	t.Helper()
	w := call(t, s, http.MethodPost, "/api/v2/accounts", "", "", map[string]any{"wechatLoginCode": code, "nickname": nickname, "phone": "13800138000", "privacyContractVersion": "v1"})
	if w.Code != 201 {
		t.Fatalf("register: status=%d body=%s", w.Code, w.Body.String())
	}
	var out sessionResponse
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func decodeMap(t *testing.T, w *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode %q: %v", w.Body.String(), err)
	}
	return out
}

func TestIdentityIsolationAndExpiry(t *testing.T) {
	s := newTestServer(t)
	a := register(t, s, "wx-a", "Alice")
	b := register(t, s, "wx-b", "Bob")
	verified := call(t, s, http.MethodPost, "/api/v2/accounts", "", "", map[string]any{"wechatLoginCode": "wx-verified", "nickname": "Verified", "phoneCode": "phone-code", "privacyContractVersion": "v1"})
	if verified.Code != 201 || decodeMap(t, verified)["user"].(map[string]any)["phoneVerificationStatus"] != "verified" {
		t.Fatalf("verified registration: %d %s", verified.Code, verified.Body.String())
	}
	if a.User.PhoneMasked != "138****8000" || a.User.PhoneVerificationStatus != "unverified" {
		t.Fatalf("unexpected user: %+v", a.User)
	}
	if got := call(t, s, http.MethodGet, "/api/v2/accounts/"+b.User.ID, a.AccessToken, "", nil).Code; got != 403 {
		t.Fatalf("customer isolation status=%d", got)
	}
	edit(t, s, func(q *txn) {
		q.addOrder(&Order{ID: "11111111-1111-4111-8111-111111111111", UserID: a.User.ID, Status: "paid", ReceivableCents: 100, PaidCents: 100})
	})
	if got := call(t, s, http.MethodGet, "/api/v2/sales-orders/11111111-1111-4111-8111-111111111111", a.AccessToken, "", nil).Code; got != 200 {
		t.Fatalf("customer own order status=%d", got)
	}
	if got := call(t, s, http.MethodPost, "/api/v2/accounts", "", "", map[string]any{"wechatLoginCode": "wx-a", "nickname": "Again", "phone": "1", "privacyContractVersion": "v1"}).Code; got != 409 {
		t.Fatalf("duplicate registration status=%d", got)
	}
	now := time.Now()
	s.now = func() time.Time { return now.Add(25 * time.Hour) }
	if got := call(t, s, http.MethodGet, "/api/v2/accounts/"+a.User.ID, a.AccessToken, "", nil).Code; got != 401 {
		t.Fatalf("expired bearer status=%d", got)
	}
	// 过期的会话在下一次有人登录时清掉，表不会一直长
	loginWith(t, s, "wx-b")
	if left := view(t, s, func(q *txn) int {
		return scalar[int](q, `SELECT count(*) FROM auth_sessions WHERE token_hash=$1`, identityKey(a.AccessToken))
	}); left != 0 {
		t.Fatal("expired bearer was retained in the session store")
	}
}

func TestSecurityHeaders(t *testing.T) {
	w := call(t, newTestServer(t), http.MethodGet, "/healthz", "", "", nil)
	for name, want := range map[string]string{
		"X-Content-Type-Options":    "nosniff",
		"X-Frame-Options":           "DENY",
		"Referrer-Policy":           "no-referrer",
		"Strict-Transport-Security": "max-age=31536000",
	} {
		if got := w.Header().Get(name); got != want {
			t.Fatalf("%s=%q, want %q", name, got, want)
		}
	}
}

// 发布后靠 /healthz 核对线上跑的是哪个 commit；注入的值优先于 Go 自动记录的 git 信息。
func TestHealthReportsTheRunningCommit(t *testing.T) {
	if got := decodeMap(t, call(t, newTestServer(t), http.MethodGet, "/healthz", "", "", nil))["commit"]; got != runningCommit || got == "" {
		t.Fatalf("healthz commit=%v, want %q", got, runningCommit)
	}
	injected := Commit
	t.Cleanup(func() { Commit = injected })
	Commit = "0123abc"
	if got := buildCommit(); got != "0123abc" {
		t.Fatalf("injected commit ignored: %q", got)
	}
}

// 版本号：发布构建按标签注入（0.0.13），本地构建报告 dev；/healthz 与 /statusz 都带上，网页后台首页显示它。
func TestHealthReportsTheReleaseVersion(t *testing.T) {
	s := newTestServer(t)
	if got := decodeMap(t, call(t, s, http.MethodGet, "/healthz", "", "", nil))["version"]; got != runningVersion || got == "" {
		t.Fatalf("healthz version=%v, want %q", got, runningVersion)
	}
	injected := Version
	t.Cleanup(func() { Version = injected })
	Version = ""
	if got := buildVersion(); got != "dev" {
		t.Fatalf("local build version %q, want dev", got)
	}
	Version = "0.0.13"
	if got := buildVersion(); got != "0.0.13" {
		t.Fatalf("injected version ignored: %q", got)
	}
}

// 迁移 012：备份任务在 backup_runs 里记一笔，/statusz 报告各类最近的一次，外部监控据此发现备份停了。
func TestStatusReportsTheLatestBackups(t *testing.T) {
	s := newTestServer(t)
	backups := func() map[string]any {
		t.Helper()
		w := call(t, s, http.MethodGet, "/statusz", "", "", nil)
		if w.Code != http.StatusOK {
			t.Fatalf("statusz: %d %s", w.Code, w.Body.String())
		}
		body := decodeMap(t, w)
		if body["commit"] != runningCommit {
			t.Fatalf("statusz commit=%v", body["commit"])
		}
		return body["backups"].(map[string]any)
	}
	if got := backups(); got["local"] != nil || got["offsite"] != nil {
		t.Fatalf("backups before any run: %v", got)
	}
	edit(t, s, func(q *txn) {
		q.exec(`INSERT INTO backup_runs(kind,name,size_bytes,finished_at) VALUES ('local','pindou_20261004T031500+0800.dump',100,'2026-10-04T03:15:30+08:00')`)
		q.exec(`INSERT INTO backup_runs(kind,name,size_bytes) VALUES ('local','pindou_20261005T031500+0800.dump',120)`)
	})
	local, ok := backups()["local"].(map[string]any)
	if !ok || local["name"] != "pindou_20261005T031500+0800.dump" || local["sizeBytes"] != float64(120) {
		t.Fatalf("latest local backup: %v", local)
	}
	if backups()["offsite"] != nil {
		t.Fatal("offsite backup reported without one")
	}
	for _, bad := range []string{`('remote','pindou_1.dump',1)`, `('local','../etc/passwd',1)`, `('local','pindou_1.dump',0)`} {
		if _, err := s.postgres.Pool().Exec(context.Background(), `INSERT INTO backup_runs(kind,name,size_bytes) VALUES `+bad); err == nil || !strings.Contains(err.Error(), "check constraint") {
			t.Fatalf("backup_runs %s: %v", bad, err)
		}
	}
	// 测试库没开 WAL 归档：报 null。开了归档的情形由 archiveFailing 的单元测试和切换手册里的实测覆盖。
	var archiveMode string
	if err := s.postgres.Pool().QueryRow(context.Background(), `SHOW archive_mode`).Scan(&archiveMode); err != nil {
		t.Fatal(err)
	}
	w := call(t, s, http.MethodGet, "/statusz", "", "", nil)
	if wal := decodeMap(t, w)["walArchive"]; (archiveMode == "off") != (wal == nil) {
		t.Fatalf("archive_mode=%s walArchive=%v", archiveMode, wal)
	}
	// 只读的一页，限流之外；不需要登录
	for i := 0; i < 30; i++ {
		if w := call(t, s, http.MethodGet, "/api/v2/statusz", "", "", nil); w.Code != http.StatusOK {
			t.Fatalf("statusz %d: %d", i, w.Code)
		}
	}
}

func TestArchiveFailingWhenTheLatestAttemptFailed(t *testing.T) {
	at := func(minute int) *time.Time {
		v := time.Date(2026, 10, 5, 12, minute, 0, 0, time.UTC)
		return &v
	}
	for _, c := range []struct {
		name             string
		archived, failed *time.Time
		want             bool
	}{
		{"刚开归档，还没有 WAL 要归档", nil, nil, false},
		{"一直成功", at(5), nil, false},
		{"失败过，之后又成功了", at(10), at(5), false},
		{"成功之后又失败", at(5), at(10), true},
		{"从没成功过", nil, at(5), true},
	} {
		if got := archiveFailing(c.archived, c.failed); got != c.want {
			t.Errorf("%s：failing=%v，应为 %v", c.name, got, c.want)
		}
	}
}

func TestRoleBoundariesAndLastOwner(t *testing.T) {
	s := newTestServer(t)
	owner := register(t, s, "owner", "Owner")
	manager := register(t, s, "manager", "Manager")
	secondOwner := register(t, s, "owner-2", "Owner 2")
	if err := s.BootstrapOwner(owner.User.ID); err != nil {
		t.Fatal(err)
	}
	assignManager := call(t, s, http.MethodPost, "/api/v2/staff-role-assignments", owner.AccessToken, "", map[string]any{"accountId": manager.User.ID, "role": "manager"})
	if assignManager.Code != 201 {
		t.Fatalf("assign manager: %d %s", assignManager.Code, assignManager.Body.String())
	}
	assignOwner := call(t, s, http.MethodPost, "/api/v2/staff-role-assignments", owner.AccessToken, "", map[string]any{"accountId": secondOwner.User.ID, "role": "owner"})
	if assignOwner.Code != 201 {
		t.Fatalf("assign owner: %d %s", assignOwner.Code, assignOwner.Body.String())
	}
	secondAssignmentID := decodeMap(t, assignOwner)["id"].(string)
	if got := call(t, s, http.MethodDelete, "/api/v2/staff-role-assignments/"+secondAssignmentID, manager.AccessToken, "", nil).Code; got != 403 {
		t.Fatalf("manager revoked owner: status=%d", got)
	}
	if got := call(t, s, http.MethodDelete, "/api/v2/staff-role-assignments/"+secondAssignmentID, owner.AccessToken, "", nil).Code; got != 204 {
		t.Fatalf("owner revoke: status=%d", got)
	}
	var firstAssignmentID string
	for _, assignment := range activeRolesOf(t, s) {
		if assignment.UserID == owner.User.ID {
			firstAssignmentID = assignment.ID
		}
	}
	if got := call(t, s, http.MethodDelete, "/api/v2/staff-role-assignments/"+firstAssignmentID, owner.AccessToken, "", nil).Code; got != 409 {
		t.Fatalf("last owner status=%d", got)
	}
}

func TestCheckoutInventoryRefundAndIdempotency(t *testing.T) {
	exerciseCheckout(t, newTestServer(t))
}

func exerciseCheckout(t *testing.T, s *Server) {
	t.Helper()
	owner := register(t, s, "owner", "Owner")
	if err := s.BootstrapOwner(owner.User.ID); err != nil {
		t.Fatal(err)
	}
	h := s.Handler()
	// 布局固定之后没有建区域/建桌接口了，夹具直接进 store（见 fixtures_test.go）。
	tableID := seedTable(t, s, "M1", "Main", 1, 4, false).ID
	started := time.Now().Format(time.RFC3339)
	session := call(t, h, http.MethodPost, "/api/v2/venue-sessions", owner.AccessToken, "", map[string]any{"serviceTableId": tableID, "startedAt": started, "timingMode": "timed", "durationMinutes": 60})
	if session.Code != 201 {
		t.Fatalf("session: %d %s", session.Code, session.Body.String())
	}
	sessionID := decodeMap(t, session)["id"].(string)
	tableView := call(t, h, http.MethodGet, "/api/v2/service-tables", owner.AccessToken, "", nil)
	var tableViews []map[string]any
	if err := json.Unmarshal(tableView.Body.Bytes(), &tableViews); err != nil || len(tableViews) != 1 || tableViews[0]["timingStatus"] == nil || tableViews[0]["remainingSeconds"] == nil {
		t.Fatalf("timer view: %d %s", tableView.Code, tableView.Body.String())
	}
	productID := id()
	purchase := map[string]any{"supplierName": "Supplier", "items": []map[string]any{{"productId": productID, "quantity": 2, "unitCostCents": 50}}}
	for i := 0; i < 2; i++ {
		if w := call(t, h, http.MethodPost, "/api/v2/stock-receipts", owner.AccessToken, "purchase-1", purchase); w.Code != 201 {
			t.Fatalf("purchase retry %d: %d %s", i, w.Code, w.Body.String())
		}
	}
	order := call(t, h, http.MethodPost, "/api/v2/sales-orders", owner.AccessToken, "create-order", map[string]any{"venueSessionId": sessionID, "accountId": owner.User.ID})
	orderID := decodeMap(t, order)["id"].(string)
	setLines := func(quantity int) {
		w := call(t, h, http.MethodPatch, "/api/v2/sales-orders/"+orderID, owner.AccessToken, id(), map[string]any{"expectedVersion": orderOf(t, s, orderID).Version(), "lines": []map[string]any{{"productId": productID, "quantity": quantity, "unitPriceCents": 100}}})
		if w.Code != 200 {
			t.Fatalf("lines: %d %s", w.Code, w.Body.String())
		}
	}
	setLines(3)
	failedPayment := call(t, h, http.MethodPost, "/api/v2/sales-orders/"+orderID+"/payments", owner.AccessToken, "pay-too-many", map[string]any{"expectedVersion": orderOf(t, s, orderID).Version(), "method": "cash", "amountCents": 300})
	if failedPayment.Code != 409 || decodeMap(t, failedPayment)["code"] != "insufficient_stock" {
		t.Fatalf("stock failure: %d %s", failedPayment.Code, failedPayment.Body.String())
	}
	if o := orderOf(t, s, orderID); o.Status != "draft" || o.PaidCents != 0 {
		t.Fatalf("failed payment mutated order: %+v", o)
	}
	setLines(2)
	discount := call(t, h, http.MethodPost, "/api/v2/sales-orders/"+orderID+"/discounts", owner.AccessToken, "discount-1", map[string]any{"expectedVersion": orderOf(t, s, orderID).Version(), "kind": "fixed", "amountCents": 50, "reason": "promotion"})
	if discount.Code != 201 || int64(decodeMap(t, discount)["receivableCents"].(float64)) != 150 {
		t.Fatalf("discount: %d %s", discount.Code, discount.Body.String())
	}
	confirmedVersion := orderOf(t, s, orderID).Version()
	for i := 0; i < 2; i++ {
		if w := call(t, h, http.MethodPost, "/api/v2/sales-orders/"+orderID+"/payments", owner.AccessToken, "payment-1", map[string]any{"expectedVersion": confirmedVersion, "method": "wechat", "amountCents": 150}); w.Code != 201 {
			t.Fatalf("payment retry %d: %d %s", i, w.Code, w.Body.String())
		}
	}
	refund := call(t, h, http.MethodPost, "/api/v2/sales-orders/"+orderID+"/refunds", owner.AccessToken, "refund-1", map[string]any{"expectedVersion": orderOf(t, s, orderID).Version(), "amountCents": 150, "reason": "customer request", "returnedProducts": map[string]any{productID: 2}})
	if refund.Code != 201 || decodeMap(t, refund)["status"] != "refunded" {
		t.Fatalf("refund: %d %s", refund.Code, refund.Body.String())
	}
	item := stockByProductOf(t, s, productID)
	quantity := item.Quantity
	movements := len(movementsOf(t, s))
	if quantity != 2 {
		t.Fatalf("stock after refund=%d", quantity)
	}
	if movements != 3 {
		t.Fatalf("movements=%d, want purchase/sale/refund", movements)
	}
	if got := call(t, h, http.MethodGet, "/api/v2/system/audit-events", owner.AccessToken, "", nil).Code; got != 200 {
		t.Fatalf("audit status=%d", got)
	}
	if got := call(t, h, http.MethodPost, "/api/v2/system/data-exports", owner.AccessToken, "", nil).Code; got != 200 {
		t.Fatalf("data export status=%d", got)
	}
	export := call(t, h, http.MethodGet, "/api/v2/reports/exports/orders", owner.AccessToken, "", nil)
	if export.Code != 200 || !bytes.HasPrefix(export.Body.Bytes(), []byte("PK")) {
		t.Fatalf("xlsx export: %d %q", export.Code, export.Body.Bytes())
	}
	archive, err := zip.NewReader(bytes.NewReader(export.Body.Bytes()), int64(export.Body.Len()))
	if err != nil || len(archive.File) < 5 {
		t.Fatalf("invalid xlsx archive: %v", err)
	}
	inventoryExport := call(t, h, http.MethodGet, "/api/v2/reports/exports/inventory", owner.AccessToken, "", nil)
	if inventoryExport.Code != 200 || !bytes.HasPrefix(inventoryExport.Body.Bytes(), []byte("PK")) {
		t.Fatalf("inventory xlsx export: %d %q", inventoryExport.Code, inventoryExport.Body.Bytes())
	}
}

// 写请求提交后推送的资源名在登记接口时写明（routes.go）：入库改的是库存，推 stock-items；订单的子资源
// （收款、退款、折扣）推 sales-orders；登录只发凭证，不推送。推送按提交顺序到达，所以逐条对得上。
func TestWritesPublishTheResourceTheyInvalidate(t *testing.T) {
	s := newTestServer(t)
	events := s.hub.subscribe(streamViewer{staff: true})
	defer s.hub.unsubscribe(events)
	next := func() string {
		t.Helper()
		select {
		case e := <-events:
			var payload map[string]string
			if err := json.Unmarshal(e.payload, &payload); err != nil || payload["type"] != "resource.updated" {
				t.Fatalf("event payload %s", e.payload)
			}
			return payload["resource"]
		case <-time.After(5 * time.Second):
			t.Fatal("no event published")
			return ""
		}
	}

	owner := register(t, s, "publish-owner", "老板")
	if err := s.BootstrapOwner(owner.User.ID); err != nil {
		t.Fatal(err)
	}
	if got := next(); got != "accounts" {
		t.Fatalf("register published %q", got)
	}
	if w := call(t, s, http.MethodPost, "/api/v2/auth/wechat-sessions", "", "", map[string]any{"wechatLoginCode": "publish-owner"}); w.Code != http.StatusCreated {
		t.Fatalf("login: %d %s", w.Code, w.Body.String())
	}
	product := id()
	receiveStock(t, s, owner.AccessToken, product, 2)
	if got := next(); got != "stock-items" {
		t.Fatalf("login or stock receipt published %q", got)
	}
	order := decodeMap(t, call(t, s, http.MethodPost, "/api/v2/sales-orders", owner.AccessToken, id(), map[string]any{}))
	if got := next(); got != "sales-orders" {
		t.Fatalf("new order published %q", got)
	}
	orderID := order["id"].(string)
	if w := call(t, s, http.MethodPatch, "/api/v2/sales-orders/"+orderID, owner.AccessToken, id(), map[string]any{
		"expectedVersion": order["version"], "lines": []map[string]any{{"productId": product, "name": "豆", "quantity": 1, "unitPriceCents": 100}},
	}); w.Code != http.StatusOK {
		t.Fatalf("order lines: %d %s", w.Code, w.Body.String())
	}
	if got := next(); got != "sales-orders" {
		t.Fatalf("order lines published %q", got)
	}
	if w := call(t, s, http.MethodPost, "/api/v2/sales-orders/"+orderID+"/payments", owner.AccessToken, id(), map[string]any{"expectedVersion": orderOf(t, s, orderID).Version(), "method": "cash", "amountCents": 100}); w.Code != http.StatusCreated {
		t.Fatalf("payment: %d %s", w.Code, w.Body.String())
	}
	if got := next(); got != "sales-orders" {
		t.Fatalf("payment published %q", got)
	}
}

// 接口路径按方法与路径模式分派；没有的路径回 404、路径对但方法不对回 405（带 Allow），都是统一的 JSON 错误。
// 不规整的路径（结尾斜杠、`..`）不跳转，直接 404。
func TestUnknownRoutesAnswerWithJSONErrors(t *testing.T) {
	s := newTestServer(t)
	owner := register(t, s, "routes-owner", "老板")
	if err := s.BootstrapOwner(owner.User.ID); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		method, path string
		status       int
		code, allow  string
	}{
		{http.MethodGet, "/api/v2/nothing-here", 404, "not_found", ""},
		{http.MethodGet, "/api/v2/sales-orders/" + id() + "/nothing", 404, "not_found", ""},
		{http.MethodGet, "/api/v2/sales-orders/", 404, "not_found", ""},
		{http.MethodGet, "/api/v2/sales-orders/../accounts", 404, "not_found", ""},
		{http.MethodGet, "/api/v1/sales-orders", 404, "not_found", ""},
		{http.MethodDelete, "/api/v2/sales-orders", 405, "method_not_allowed", "GET, HEAD, POST"},
		{http.MethodGet, "/api/v2/sales-orders/" + id() + "/payments", 405, "method_not_allowed", "POST"},
		{http.MethodPut, "/api/v2/sales-orders", 405, "method_not_allowed", "GET, POST, PATCH, DELETE"},
	} {
		w := call(t, s, c.method, c.path, owner.AccessToken, "", nil)
		if w.Code != c.status || w.Header().Get("Content-Type") != "application/json" || decodeMap(t, w)["code"] != c.code {
			t.Errorf("%s %s: %d %q %s", c.method, c.path, w.Code, w.Header().Get("Content-Type"), w.Body.String())
		}
		if w.Header().Get("Allow") != c.allow {
			t.Errorf("%s %s: Allow %q, want %q", c.method, c.path, w.Header().Get("Allow"), c.allow)
		}
		if rid := w.Header().Get("X-Request-ID"); rid == "" || decodeMap(t, w)["requestId"] != rid {
			t.Errorf("%s %s: request id header %q body %v", c.method, c.path, rid, decodeMap(t, w)["requestId"])
		}
	}
	// 网页后台的路径不归接口管：照旧交给页面（单页应用自己处理路由）
	if w := call(t, s, http.MethodGet, "/sales-orders/abc", "", "", nil); w.Code == http.StatusNotFound && w.Header().Get("Content-Type") == "application/json" {
		t.Fatalf("admin page path answered like the API: %d %s", w.Code, w.Body.String())
	}
}

// 退款回补库存必须由员工点清件数，不能按退款金额在订单里的占比推算。
// 混合订单只退服务费时，比例推算会让商品库存凭空上涨——货还在顾客手里。
func TestRefundRestocksOnlyWhatStaffCountedBack(t *testing.T) {
	s := newTestServer(t)
	h := s.Handler()
	owner := register(t, s, "owner", "Owner")
	if err := s.BootstrapOwner(owner.User.ID); err != nil {
		t.Fatal(err)
	}
	productID := id()
	if w := call(t, h, http.MethodPost, "/api/v2/stock-receipts", owner.AccessToken, id(),
		map[string]any{"supplierName": "Supplier", "items": []map[string]any{{"productId": productID, "quantity": 3, "unitCostCents": 50}}}); w.Code != 201 {
		t.Fatalf("purchase: %d %s", w.Code, w.Body.String())
	}
	orderID := decodeMap(t, call(t, h, http.MethodPost, "/api/v2/sales-orders", owner.AccessToken, id(), map[string]any{}))["id"].(string)
	version := func() string {
		return orderOf(t, s, orderID).Version()
	}
	stock := func() int64 {
		return stockByProductOf(t, s, productID).Quantity
	}
	// 3 包材料 ¥150 加一笔不关联商品的服务费 ¥150，合计 ¥300。
	lines := []map[string]any{
		{"productId": productID, "quantity": 3, "unitPriceCents": 5000},
		{"name": "计时服务费", "quantity": 1, "unitPriceCents": 15000},
	}
	if w := call(t, h, http.MethodPatch, "/api/v2/sales-orders/"+orderID, owner.AccessToken, id(),
		map[string]any{"expectedVersion": version(), "lines": lines}); w.Code != 200 {
		t.Fatalf("lines: %d %s", w.Code, w.Body.String())
	}
	if w := call(t, h, http.MethodPost, "/api/v2/sales-orders/"+orderID+"/payments", owner.AccessToken, id(),
		map[string]any{"expectedVersion": version(), "method": "cash", "amountCents": 30000}); w.Code != 201 {
		t.Fatalf("payment: %d %s", w.Code, w.Body.String())
	}
	if got := stock(); got != 0 {
		t.Fatalf("卖出后库存应为 0，实际 %d", got)
	}

	// 只退服务费，材料没退回来。按比例推算会算出 3×15000/30000＝1 包回到货架。
	refund := call(t, h, http.MethodPost, "/api/v2/sales-orders/"+orderID+"/refunds", owner.AccessToken, id(),
		map[string]any{"expectedVersion": version(), "amountCents": 15000, "reason": "服务未提供"})
	if refund.Code != 201 {
		t.Fatalf("refund: %d %s", refund.Code, refund.Body.String())
	}
	if got := stock(); got != 0 {
		t.Fatalf("只退服务费不应回补库存，实际库存 %d", got)
	}

	// 顾客退回 2 包未拆封的，剩下 1 包已拆封不入库：只认员工点的这 2 包。
	second := call(t, h, http.MethodPost, "/api/v2/sales-orders/"+orderID+"/refunds", owner.AccessToken, id(),
		map[string]any{"expectedVersion": version(), "amountCents": 10000, "reason": "未拆封退货",
			"returnedProducts": map[string]any{productID: 2}})
	if second.Code != 201 {
		t.Fatalf("second refund: %d %s", second.Code, second.Body.String())
	}
	if got := stock(); got != 2 {
		t.Fatalf("应只回补员工点的 2 包，实际库存 %d", got)
	}

	// 累计退回数不能超过卖出数，否则分几笔退就能凭空造货。
	excess := call(t, h, http.MethodPost, "/api/v2/sales-orders/"+orderID+"/refunds", owner.AccessToken, id(),
		map[string]any{"expectedVersion": version(), "amountCents": 5000, "reason": "再退",
			"returnedProducts": map[string]any{productID: 2}})
	if excess.Code != 400 {
		t.Fatalf("累计退回超出已售数量应被拒绝，实际 %d %s", excess.Code, excess.Body.String())
	}
	if got := stock(); got != 2 {
		t.Fatalf("被拒绝的退款不应改动库存，实际 %d", got)
	}

	// 不在本单里的商品同样不能借退款入库。
	other := call(t, h, http.MethodPost, "/api/v2/sales-orders/"+orderID+"/refunds", owner.AccessToken, id(),
		map[string]any{"expectedVersion": version(), "amountCents": 5000, "reason": "退别的货",
			"returnedProducts": map[string]any{id(): 1}})
	if other.Code != 400 {
		t.Fatalf("本单没卖过的商品应被拒绝，实际 %d %s", other.Code, other.Body.String())
	}

	// 退回件数留在退款记录上，事后能查出这笔退款到底退了什么。
	recorded := map[string]int64{}
	for _, r := range orderOf(t, s, orderID).Refunds {
		for product, n := range r.ReturnedProducts {
			recorded[product] += n
		}
	}
	if recorded[productID] != 2 {
		t.Fatalf("退款记录里的退回件数应为 2，实际 %v", recorded)
	}
}

// 写事务占着锁时，存活、就绪检查照常立即回答：它们不开事务、不碰业务表；
// 否则探针超时，Kubernetes 会把正常的服务摘下甚至重启。
func TestProbesDoNotWaitForBusinessLocks(t *testing.T) {
	s := newTestServer(t)
	ctx := context.Background()
	blocker, err := s.postgres.Pool().Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback(ctx)
	if _, err := blocker.Exec(ctx, `LOCK TABLE accounts, sales_orders IN ACCESS EXCLUSIVE MODE`); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/healthz", "/readyz"} {
		done := make(chan int, 1)
		go func() {
			rec := httptest.NewRecorder()
			s.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
			done <- rec.Code
		}()
		select {
		case code := <-done:
			if code != http.StatusOK {
				t.Fatalf("%s: %d", path, code)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("%s 在业务表的锁后面等着", path)
		}
	}
}

// 未登录（或令牌无效）的写请求回 401，什么都不改；接口不用的方法（HEAD、OPTIONS、PUT）直接 405。
func TestAnonymousWritesAndUnusedMethodsAreRejected(t *testing.T) {
	s := newTestServer(t)
	owner := register(t, s, "method-owner", "老板")
	before := s.snapshotData()
	for _, bearer := range []string{"", "not-a-real-token"} {
		req := httptest.NewRequest(http.MethodPost, "/api/v2/catalog-items", strings.NewReader(`{"name":"x","unitPriceCents":1}`))
		req.Header.Set("Idempotency-Key", id())
		if bearer != "" {
			req.Header.Set("Authorization", "Bearer "+bearer)
		}
		rec := serve(t, s, req)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("bearer %q: %d", bearer, rec.Code)
		}
	}
	if !bytes.Equal(before, s.snapshotData()) {
		t.Fatal("an anonymous write changed data")
	}
	for _, method := range []string{http.MethodHead, http.MethodOptions, http.MethodPut} {
		req := httptest.NewRequest(method, "/api/v2/sales-orders", nil)
		req.Header.Set("Authorization", "Bearer "+owner.AccessToken)
		rec := serve(t, s, req)
		if rec.Code != http.StatusMethodNotAllowed {
			t.Fatalf("%s: %d", method, rec.Code)
		}
	}
}

// 服务端错误要留日志，并能按 requestId 和客户端看到的报错对上；路径不带查询参数（可能有手机尾号）。
func TestServerErrorsAreLoggedWithTheResponseRequestID(t *testing.T) {
	var logs bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&logs, nil)))
	defer slog.SetDefault(previous)

	s := newTestServer(t)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v2/sales-orders?q=7788", nil)
	req.Header.Set("X-Request-ID", "req-test-1")
	s.writeError(rec, req, 503, "persistence_failed", errors.New("boom"))
	var entry map[string]any
	if err := json.Unmarshal(logs.Bytes(), &entry); err != nil {
		t.Fatalf("log line: %q", logs.String())
	}
	if entry["requestId"] != "req-test-1" || entry["path"] != "/api/v2/sales-orders" || entry["error"] != "boom" || entry["status"] != float64(503) {
		t.Fatalf("log entry: %v", entry)
	}
	if bytes.Contains(logs.Bytes(), []byte("7788")) {
		t.Fatal("log leaked the query string")
	}

	// 4xx 不记；每个响应都带回同一个请求编号
	logs.Reset()
	w := call(t, s, http.MethodGet, "/api/v2/sales-orders", "", "", nil)
	if logs.Len() != 0 {
		t.Fatalf("4xx should not be logged: %s", logs.String())
	}
	if rid := w.Header().Get("X-Request-ID"); rid == "" || decodeMap(t, w)["requestId"] != rid {
		t.Fatalf("response request id: header %q body %v", rid, decodeMap(t, w)["requestId"])
	}
}
