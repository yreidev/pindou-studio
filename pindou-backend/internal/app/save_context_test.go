package app

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// 客户端在落库途中断开，已经处理完的写请求仍要保存下来，不能回滚成 503。
func TestPostgresSaveIgnoresClientDisconnect(t *testing.T) {
	db := newTestDatabase(t)
	s := serverOn(t, db)
	owner := register(t, s, "disconnect-owner", "Owner")
	if err := s.BootstrapOwner(owner.User.ID); err != nil {
		t.Fatal(err)
	}
	gone, cancel := context.WithCancel(context.Background())
	cancel()
	r := httptest.NewRequest(http.MethodPost, "/api/v2/sales-orders", strings.NewReader(`{}`)).WithContext(gone)
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Authorization", "Bearer "+owner.AccessToken)
	r.Header.Set("Idempotency-Key", id())
	w := serve(t, s, r)
	if w.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	restarted := serverOn(t, db)
	if len(ordersOf(t, restarted)) != 1 {
		t.Fatalf("order was not persisted: %d orders after restart", len(ordersOf(t, restarted)))
	}
	// 之后的写请求也不能因版本错位而失败。
	if next := call(t, s, http.MethodPost, "/api/v2/sales-orders", owner.AccessToken, id(), map[string]any{}); next.Code != http.StatusCreated {
		t.Fatalf("next write status=%d body=%s", next.Code, next.Body.String())
	}
}
