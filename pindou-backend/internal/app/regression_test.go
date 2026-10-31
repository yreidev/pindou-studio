package app

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// TEST-CHANNEL-001 / TEST-ROLE-001 / TEST-RECOVERY-001.
func TestPrivateFieldsAndRolesSurviveRestoration(t *testing.T) {
	s := newTestServer(t)
	u := register(t, s, "restart-owner", "Owner")
	if err := s.BootstrapOwner(u.User.ID); err != nil {
		t.Fatal(err)
	}
	original := *userOf(t, s, u.User.ID)
	for _, restore := range []string{"restart"} {
		t.Run(restore, func(t *testing.T) {
			restored := serverOn(t, s.postgres)
			r := call(t, restored, "POST", "/api/v2/auth/wechat-sessions", "", "", map[string]any{"wechatLoginCode": "restart-owner"})
			if r.Code != 201 {
				t.Fatalf("wechat login failed after %s: %d", restore, r.Code)
			}
			user := userOf(t, restored, u.User.ID)
			if user.PrivacyContractVersion != original.PrivacyContractVersion || !user.PrivacyAcceptedAt.Equal(original.PrivacyAcceptedAt) || !user.CreatedAt.Equal(original.CreatedAt) {
				t.Fatal("private account fields lost")
			}
			if len(activeRolesOf(t, restored)) != 1 {
				t.Fatal("role assignments lost")
			}
			if bytes.Contains(r.Body.Bytes(), []byte(original.Phone)) {
				t.Fatal("private fields exposed in API")
			}
		})
	}
}

func regressionSession(t *testing.T) (*Server, sessionResponse, string) {
	s := newTestServer(t)
	u := register(t, s, "timing-owner", "Owner")
	if err := s.BootstrapOwner(u.User.ID); err != nil {
		t.Fatal(err)
	}
	tid, sid := seedTable(t, s, "R1", "测试区", 1, 2, false).ID, id()
	now := time.Date(2026, 9, 6, 4, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return now }
	edit(t, s, func(q *txn) {
		q.addSession(&TableSession{ID: sid, TableID: tid, Status: "active", StartedAt: now, TimingMode: "timed", DurationMinutes: 60})
	})
	return s, u, sid
}

// TEST-SESSION-001: rejection, pause/resume, repeated pause, restart and extension.
func TestSessionAtomicityAndPausedClock(t *testing.T) {
	s, u, sid := regressionSession(t)
	before := s.snapshotData()
	for _, patch := range []map[string]any{{"timingMode": "free", "durationMinutes": 30}, {"timingMode": "free", "startedAt": "bad"}, {"durationMinutes": 90, "status": "bad"}} {
		if r := call(t, s, "PATCH", "/api/v2/venue-sessions/"+sid, u.AccessToken, "", patch); r.Code != 400 {
			t.Fatal(r.Code)
		}
		if !bytes.Equal(before, s.snapshotData()) {
			t.Fatal("rejected request changed state")
		}
		if r := call(t, s, "GET", "/api/v2/accounts/"+u.User.ID, u.AccessToken, "", nil); r.Code != 200 {
			t.Fatal("rollback invalidated bearer")
		}
	}
	now := s.now()
	patch := func(status string) {
		t.Helper()
		if r := call(t, s, "PATCH", "/api/v2/venue-sessions/"+sid, u.AccessToken, "", map[string]any{"status": status}); r.Code != 200 {
			t.Fatal(r.Code)
		}
	}
	patch("paused")
	s.now = func() time.Time { return now.Add(10 * time.Minute) }
	patch("paused")
	table := sessionOf(t, s, sid).TableID
	if tableViewOf(t, s, table)["remainingSeconds"] != int64(3600) {
		t.Fatal("pause consumed time")
	}
	restarted := serverOn(t, s.postgres)
	restarted.now = s.now
	if tableViewOf(t, restarted, table)["remainingSeconds"] != int64(3600) {
		t.Fatal("restart lost pause")
	}
	patch("active")
	s.now = func() time.Time { return now.Add(15 * time.Minute) }
	if tableViewOf(t, s, table)["remainingSeconds"] != int64(3300) {
		t.Fatal("resume counted pause")
	}
}

// TEST-ORDER-001: one order per session, retries, changed payload and closed sessions.
func TestSessionCheckoutUniqueness(t *testing.T) {
	s, u, sid := regressionSession(t)
	body := map[string]any{"venueSessionId": sid}
	if r := call(t, s, "POST", "/api/v2/sales-orders", u.AccessToken, "", body); r.Code != 400 {
		t.Fatal("missing key accepted")
	}
	first := call(t, s, "POST", "/api/v2/sales-orders", u.AccessToken, "create", body)
	if first.Code != 201 {
		t.Fatal(first.Code)
	}
	oid := decodeMap(t, first)["id"].(string)
	for _, key := range []string{"create", "another-key"} {
		r := call(t, s, "POST", "/api/v2/sales-orders", u.AccessToken, key, body)
		if r.Code >= 300 || decodeMap(t, r)["id"] != oid {
			t.Fatal("duplicate draft")
		}
	}
	if r := call(t, s, "POST", "/api/v2/sales-orders", u.AccessToken, "create", map[string]any{}); r.Code != 409 {
		t.Fatal("changed idempotent payload accepted")
	}
	r := call(t, s, "PATCH", "/api/v2/sales-orders/"+oid, u.AccessToken, "edit", map[string]any{"expectedVersion": decodeMap(t, first)["version"], "lines": []OrderLine{{Name: "Service", Quantity: 1, UnitPriceCents: 100}}})
	if r.Code != 200 {
		t.Fatal(r.Code)
	}
	for i := 0; i < 2; i++ {
		if r := call(t, s, "POST", "/api/v2/sales-orders/"+oid+"/payments", u.AccessToken, "pay", map[string]any{"expectedVersion": decodeMap(t, r)["version"], "method": "cash", "amountCents": 100}); r.Code != 201 {
			t.Fatal(r.Code)
		}
	}
	if r := call(t, s, "POST", "/api/v2/sales-orders", u.AccessToken, "new-checkout", body); r.Code != 409 {
		t.Fatal("settled session accepted")
	}
	if len(ordersOf(t, s)) != 1 || len(orderOf(t, s, oid).Payments) != 1 {
		t.Fatal("duplicate financial records")
	}
}

// TEST-REALTIME-001 / TEST-SECURITY-001: actual SSE transport and authorization.
func TestEmployeeSSE(t *testing.T) {
	s := newTestServer(t)
	u := register(t, s, "stream-owner", "Owner")
	// 顾客也能连（只收自己的事件，见 customer_events_test.go）；没登录的游客不能连。
	if r := call(t, s, "GET", "/api/v2/event-streams", "", "", nil); r.Code != 401 {
		t.Fatal("guest stream accepted")
	}
	_ = s.BootstrapOwner(u.User.ID)
	server := httptest.NewServer(s)
	defer server.Close()
	req, _ := http.NewRequest("GET", server.URL+"/api/v2/event-streams", nil)
	req.Header.Set("Authorization", "Bearer "+u.AccessToken)
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "text/event-stream" {
		t.Fatal("not SSE")
	}
	reader := bufio.NewReader(resp.Body)
	if _, err := reader.ReadString('\n'); err != nil {
		t.Fatal(err)
	}
	s.hub.publish(map[string]string{"resource": "sales-orders"}, nil, false)
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatal(err)
		}
		if strings.HasPrefix(line, "data:") {
			if !strings.Contains(line, "sales-orders") {
				t.Fatal(line)
			}
			break
		}
	}
}

// TEST-RECOVERY-001 / TEST-ORDER-001 / TEST-INVENTORY-001: 业务记录落在各自的表里，另一个进程照样读得到。
func TestPostgresBusinessRecordsAndRestart(t *testing.T) {
	ctx := context.Background()
	s := newTestServer(t)
	exerciseCheckout(t, s)
	restarted := serverOn(t, s.postgres)
	if len(ordersOf(t, restarted)) != 1 || len(movementsOf(t, restarted)) != 3 || len(activeRolesOf(t, restarted)) != 1 {
		t.Fatal("business state not restored")
	}
	db := s.postgres.Pool()
	for table, want := range map[string]int{"accounts": 1, "staff_role_assignments": 1, "payment_records": 1, "refund_records": 1, "stock_ledger_entries": 3, "stock_receipts": 1, "sales_order_lines": 1} {
		var got int
		if err := db.QueryRow(ctx, "SELECT count(*) FROM "+pgx.Identifier{table}.Sanitize()).Scan(&got); err != nil {
			t.Fatal(err)
		}
		if got != want {
			t.Fatalf("%s: %d", table, got)
		}
	}
	for _, query := range []string{"DELETE FROM payment_records", "UPDATE refund_records SET amount_cents=amount_cents+1", "DELETE FROM stock_ledger_entries", "DELETE FROM audit_events", "DELETE FROM sales_orders", "UPDATE sales_orders SET paid_cents=paid_cents+1", "DELETE FROM sales_order_lines", "UPDATE sales_order_lines SET quantity=quantity+1"} {
		if _, err := db.Exec(ctx, query); err == nil {
			t.Fatalf("immutable write accepted: %s", query)
		}
	}
	// 提交失败：什么都没改，登录凭证照常可用。
	owner := register(t, restarted, "failure-owner", "Owner")
	_ = restarted.BootstrapOwner(owner.User.ID)
	before := restarted.snapshotData()
	restore := failWrites(t, restarted, "accounts")
	if r := call(t, restarted, "PATCH", "/api/v2/accounts/"+owner.User.ID, owner.AccessToken, "", map[string]any{"nickname": "not committed"}); r.Code != 503 {
		t.Fatal(r.Code)
	}
	restore()
	if !bytes.Equal(before, restarted.snapshotData()) {
		t.Fatal("commit failure changed state")
	}
	if r := call(t, restarted, "GET", "/api/v2/accounts/"+owner.User.ID, owner.AccessToken, "", nil); r.Code != 200 {
		t.Fatal("commit failure lost session")
	}
}

// 数据导出只给老板、留审计、不带重放缓存和登录凭证，导出本身除了这条审计不改任何状态。
func TestDataExportIsOwnerOnlyAuditedAndCarriesNoCredentials(t *testing.T) {
	s, u, _ := regressionSession(t)
	customer := register(t, s, "export-customer", "顾客")
	if r := call(t, s, "POST", "/api/v2/system/data-exports", customer.AccessToken, "", nil); r.Code != 403 {
		t.Fatalf("customer export: %d", r.Code)
	}
	call(t, s, "POST", "/api/v2/sales-orders", u.AccessToken, "export-order", map[string]any{})
	audits := len(auditsOf(t, s))
	r := call(t, s, "POST", "/api/v2/system/data-exports", u.AccessToken, "", nil)
	if r.Code != 200 || !strings.Contains(r.Header().Get("Content-Disposition"), "attachment") {
		t.Fatalf("owner export: %d %v", r.Code, r.Header())
	}
	var content map[string]json.RawMessage
	if err := json.Unmarshal(r.Body.Bytes(), &content); err != nil {
		t.Fatal(err)
	}
	if len(content["Users"]) < 3 || string(content["Idem"]) != "null" {
		t.Fatalf("export content: users %s idem %s", content["Users"], content["Idem"])
	}
	if bytes.Contains(r.Body.Bytes(), []byte(u.AccessToken)) || bytes.Contains(r.Body.Bytes(), []byte(identityKey(u.AccessToken))) {
		t.Fatal("export carries a login credential")
	}
	if all := auditsOf(t, s); len(all) != audits+1 || all[audits].Action != "data.exported" || all[audits].ActorID != u.User.ID {
		t.Fatal("export was not audited")
	}
	for _, retired := range []string{"/api/v2/system/backups", "/api/v2/system/restore-runs"} {
		if r := call(t, s, "POST", retired, u.AccessToken, "", map[string]any{}); r.Code != 404 {
			t.Fatalf("%s still served: %d", retired, r.Code)
		}
	}
}
