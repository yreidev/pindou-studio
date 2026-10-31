package app

import (
	"bytes"
	"testing"
)

// TEST-INVENTORY-001 / TEST-RECOVERY-001: catalog writes are authorized,
// idempotent and durable without rewriting existing order lines.
func TestCatalogWorkflow(t *testing.T) {
	s := newTestServer(t)
	exerciseCatalog(t, s)
	restored := serverOn(t, s.postgres)
	if len(catalogOf(t, restored)) != 1 {
		t.Fatal("catalog lost on restore")
	}
	for _, item := range catalogOf(t, restored) {
		if item.Name != "Beads updated" || item.UnitPriceCents != 129 {
			t.Fatal(item)
		}
	}
}

func exerciseCatalog(t *testing.T, s *Server) {
	t.Helper()
	owner := register(t, s, "catalog-owner", "Owner")
	if err := s.BootstrapOwner(owner.User.ID); err != nil {
		t.Fatal(err)
	}
	guest := register(t, s, "catalog-guest", "Guest")
	input := map[string]any{"name": "Beads", "unitPriceCents": 29}
	if r := call(t, s, "POST", "/api/v2/catalog-items", guest.AccessToken, "guest", input); r.Code != 403 {
		t.Fatal(r.Code)
	}
	// 缺幂等键：和其他接口一样说清缺的是什么（以前 message 是 "forbidden"）
	if r := call(t, s, "POST", "/api/v2/catalog-items", owner.AccessToken, "", input); r.Code != 400 || decodeMap(t, r)["code"] != "idempotency_required" || decodeMap(t, r)["message"] != "Idempotency-Key is required" {
		t.Fatal(r.Code, r.Body.String())
	}
	created := call(t, s, "POST", "/api/v2/catalog-items", owner.AccessToken, "create", input)
	if created.Code != 201 {
		t.Fatal(created.Code, created.Body.String())
	}
	productID := decodeMap(t, created)["id"].(string)
	replay := call(t, s, "POST", "/api/v2/catalog-items", owner.AccessToken, "create", input)
	if replay.Code != 201 || !bytes.Equal(bytes.TrimSpace(replay.Body.Bytes()), bytes.TrimSpace(created.Body.Bytes())) {
		t.Fatal("create replay changed")
	}
	changed := map[string]any{"name": "Beads updated", "unitPriceCents": 129}
	if r := call(t, s, "POST", "/api/v2/catalog-items", owner.AccessToken, "create", changed); r.Code != 409 {
		t.Fatal(r.Code)
	}
	if r := call(t, s, "PATCH", "/api/v2/catalog-items/"+productID, owner.AccessToken, "edit", changed); r.Code != 200 {
		t.Fatal(r.Code, r.Body.String())
	}
	before := s.snapshotData()
	// PATCH 只改带了的字段（只带名称也行，见 barcode_test.go），什么都没带、带了不合规的值是 400
	for _, bad := range []any{map[string]any{"name": "", "unitPriceCents": 0}, map[string]any{}, map[string]any{"name": " "}, map[string]any{"name": "Beads", "unitPriceCents": -1}, map[string]any{"name": "Beads", "unitPriceCents": 1.1}} {
		if r := call(t, s, "PATCH", "/api/v2/catalog-items/"+productID, owner.AccessToken, "bad", bad); r.Code != 400 {
			t.Fatal(r.Code)
		}
		if !bytes.Equal(before, s.snapshotData()) {
			t.Fatal("invalid catalog write mutated state")
		}
	}
}

func TestPostgresCatalogDurability(t *testing.T) {
	db := newTestDatabase(t)
	s := serverOn(t, db)
	exerciseCatalog(t, s)
	restarted := serverOn(t, db)
	if len(catalogOf(t, restarted)) != 1 {
		t.Fatal("catalog lost after database restart")
	}
	for _, item := range catalogOf(t, restarted) {
		if item.Name != "Beads updated" || item.UnitPriceCents != 129 {
			t.Fatal(item)
		}
	}
	// Failed persistence must roll catalog metadata back with the rest of the transaction.
	login := call(t, restarted, "POST", "/api/v2/auth/wechat-sessions", "", "", map[string]any{"wechatLoginCode": "catalog-owner"})
	if login.Code != 201 {
		t.Fatal(login.Code, login.Body.String())
	}
	token := decodeMap(t, login)["accessToken"].(string)
	before := restarted.snapshotData()
	restore := failWrites(t, restarted, "audit_events")
	if r := call(t, restarted, "POST", "/api/v2/catalog-items", token, "failed", map[string]any{"name": "Not committed", "unitPriceCents": 0}); r.Code != 503 {
		t.Fatal(r.Code)
	}
	restore()
	if !bytes.Equal(before, restarted.snapshotData()) {
		t.Fatal("failed transaction changed catalog")
	}
}
