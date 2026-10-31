package app

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"sync"
	"testing"
)

// TEST-ORDER-002: both transports reach the same versioned application workflow.
func TestOrderVersionedWorkflow(t *testing.T) { exerciseOrderVersions(t, newTestServer(t)) }

func TestPostgresOrderVersionsSurviveRestart(t *testing.T) {
	db := newTestDatabase(t)
	s := serverOn(t, db)
	oid := exerciseOrderVersions(t, s)
	want := orderOf(t, s, oid).Version()
	restarted := serverOn(t, db)
	if orderOf(t, restarted, oid).Version() != want {
		t.Fatal("restart changed order version")
	}
	login := call(t, restarted, "POST", "/api/v2/auth/wechat-sessions", "", "", map[string]any{"wechatLoginCode": "version-owner"})
	if login.Code != 201 {
		t.Fatal(login.Body.String())
	}
	r := call(t, restarted, "GET", "/api/v2/sales-orders/"+oid, decodeMap(t, login)["accessToken"].(string), "", nil)
	if r.Code != 200 || decodeMap(t, r)["version"] != want {
		t.Fatal("persisted version unavailable")
	}
}

func exerciseOrderVersions(t *testing.T, s *Server) string {
	t.Helper()
	u := register(t, s, "version-owner", "Owner")
	if err := s.BootstrapOwner(u.User.ID); err != nil {
		t.Fatal(err)
	}
	other := register(t, s, "version-other", "Other")
	if err := s.BootstrapOwner(other.User.ID); err != nil {
		t.Fatal(err)
	}
	created := call(t, s, "POST", "/api/v2/sales-orders", u.AccessToken, "create", map[string]any{"accountId": u.User.ID})
	if created.Code != 201 {
		t.Fatal(created.Body.String())
	}
	initial := decodeMap(t, created)
	oid := initial["id"].(string)
	path := "/api/v2/sales-orders/" + oid
	version := initial["version"].(string)
	if len(version) != 64 {
		t.Fatal("missing version")
	}
	assertRejected := func(method, suffix, token, key string, body any, status int, code string) {
		t.Helper()
		before := s.snapshotData()
		r := call(t, s, method, path+suffix, token, key, body)
		if r.Code != status || decodeMap(t, r)["code"] != code {
			t.Fatalf("unexpected rejection: %d %s", r.Code, r.Body.String())
		}
		if !bytes.Equal(before, s.snapshotData()) {
			t.Fatal("rejected request changed business state")
		}
	}
	assertRejected("PATCH", "", u.AccessToken, "", map[string]any{"expectedVersion": version, "lines": []OrderLine{}}, 400, "idempotency_required")
	assertRejected("PATCH", "", u.AccessToken, "missing-version", map[string]any{"lines": []OrderLine{}}, 400, "invalid_request")
	edit := map[string]any{"expectedVersion": version, "lines": []OrderLine{{Name: "First service", Quantity: 1, UnitPriceCents: 100}}}
	updated := call(t, s, "PATCH", path, u.AccessToken, "edit", edit)
	if updated.Code != 200 {
		t.Fatal(updated.Body.String())
	}
	retry := call(t, s, "PATCH", path, u.AccessToken, "edit", edit)
	if !bytes.Equal(updated.Body.Bytes(), retry.Body.Bytes()) {
		t.Fatal("edit retry did not replay")
	}
	assertRejected("PATCH", "", u.AccessToken, "edit", map[string]any{"expectedVersion": version, "lines": []OrderLine{}}, 409, "idempotency_conflict")
	assertRejected("PATCH", "", other.AccessToken, "stale-edit", edit, 409, "order_version_conflict")
	oldVersion := decodeMap(t, updated)["version"]
	changed := call(t, s, "PATCH", path, other.AccessToken, "same-total", map[string]any{"expectedVersion": oldVersion, "lines": []OrderLine{{Name: "Different service", Quantity: 1, UnitPriceCents: 100}}})
	if changed.Code != 200 {
		t.Fatal(changed.Body.String())
	}
	assertRejected("POST", "/payments", u.AccessToken, "stale-pay", map[string]any{"expectedVersion": oldVersion, "method": "cash", "amountCents": 100}, 409, "order_version_conflict")
	assertRejected("POST", "/discounts", u.AccessToken, "stale-discount", map[string]any{"expectedVersion": oldVersion, "kind": "fixed", "amountCents": 10, "reason": "reason"}, 409, "order_version_conflict")
	confirmed := decodeMap(t, changed)["version"]
	payment := map[string]any{"expectedVersion": confirmed, "method": "cash", "amountCents": 100}
	var wg sync.WaitGroup
	results := make([]*httptest.ResponseRecorder, 2)
	for i, token := range []string{u.AccessToken, other.AccessToken} {
		wg.Add(1)
		go func(i int, token string) {
			defer wg.Done()
			results[i] = call(t, s, "POST", path+"/payments", token, "pay", payment)
		}(i, token)
	}
	wg.Wait()
	if results[0].Code+results[1].Code != 201+409 {
		t.Fatalf("concurrent payment codes %d/%d", results[0].Code, results[1].Code)
	}
	if len(orderOf(t, s, oid).Payments) != 1 {
		t.Fatal("duplicate payment")
	}
	winner := u.AccessToken
	if results[1].Code == 201 {
		winner = other.AccessToken
	}
	if r := call(t, s, "POST", path+"/payments", winner, "pay", payment); r.Code != 201 {
		t.Fatal("payment retry lost")
	}
	assertRejected("POST", "/payments", winner, "pay", map[string]any{"expectedVersion": confirmed, "method": "wechat", "amountCents": 100}, 409, "idempotency_conflict")
	refund := map[string]any{"expectedVersion": orderOf(t, s, oid).Version(), "amountCents": 25, "reason": "partial"}
	if r := call(t, s, "POST", path+"/refunds", u.AccessToken, "refund", refund); r.Code != 201 {
		t.Fatal(r.Body.String())
	}
	assertRejected("POST", "/refunds", other.AccessToken, "another-refund", refund, 409, "order_version_conflict")
	if r := call(t, s, "POST", path+"/refunds", u.AccessToken, "refund", refund); r.Code != 201 {
		t.Fatal("refund replay lost")
	}
	if len(orderOf(t, s, oid).Refunds) != 1 {
		t.Fatal("duplicate refund")
	}
	assignment := call(t, s, "POST", "/api/v2/staff-role-assignments", other.AccessToken, "", map[string]any{"accountId": u.User.ID, "role": "clerk"})
	if assignment.Code != 201 {
		t.Fatal(assignment.Body.String())
	}
	assertRejected("POST", "/refunds", u.AccessToken, "refund", refund, 403, "forbidden")
	return oid
}

func TestOrderVersionDoesNotRewriteLegacyRecords(t *testing.T) {
	s := newTestServer(t)
	u := register(t, s, "legacy-reader", "Reader")
	o := &Order{ID: id(), UserID: u.User.ID, Status: "paid", ReceivableCents: 100, PaidCents: 100}
	edit(t, s, func(q *txn) { q.addOrder(o) })
	before := s.snapshotData()
	for _, path := range []string{"/api/v2/sales-orders/" + o.ID, "/api/v2/accounts/" + u.User.ID + "/sales-orders"} {
		r := call(t, s, "GET", path, u.AccessToken, "", nil)
		if r.Code != 200 || !bytes.Contains(r.Body.Bytes(), []byte(`"version"`)) {
			t.Fatal("legacy response lacks version")
		}
	}
	if !bytes.Equal(before, s.snapshotData()) {
		t.Fatal("reading version changed legacy storage")
	}
	restored := serverOn(t, s.postgres)
	if orderOf(t, restored, o.ID).Version() != o.Version() {
		t.Fatal("restore changed version")
	}
	data, _ := json.Marshal(o)
	if bytes.Contains(data, []byte(`"version"`)) {
		t.Fatal("version leaked into persisted record")
	}
}
