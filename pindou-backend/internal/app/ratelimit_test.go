package app

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"
)

func identityCall(t *testing.T, s *Server, ip string, code string) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(map[string]any{
		"wechatLoginCode": code, "nickname": "Flood", "phone": "13800138000", "privacyContractVersion": "v1",
	})
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodPost, "/api/v2/accounts", bytes.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-Real-IP", ip)
	return serve(t, s, r)
}

// The unauthenticated identity endpoints spend a WeChat API call per request,
// so a scripted flood from one client must be rejected without reaching a
// handler — and without consuming the WeChat quota or creating accounts.
func TestIdentityEndpointsRateLimitPerClient(t *testing.T) {
	s := newTestServer(t)
	base := time.Now()
	s.now = func() time.Time { return base }

	for i := 0; i < identityRateLimit; i++ {
		if got := identityCall(t, s, "203.0.113.7", "flood-"+strconv.Itoa(i)).Code; got != 201 {
			t.Fatalf("request %d within the limit was rejected: %d", i, got)
		}
	}
	accounts := count(t, s, "accounts")

	blocked := identityCall(t, s, "203.0.113.7", "flood-over")
	if blocked.Code != http.StatusTooManyRequests {
		t.Fatalf("over-limit status=%d, want 429", blocked.Code)
	}
	if decodeMap(t, blocked)["code"] != "rate_limited" {
		t.Fatalf("unexpected error body: %s", blocked.Body.String())
	}
	if blocked.Header().Get("Retry-After") == "" {
		t.Fatal("429 response did not say when to retry")
	}
	if count(t, s, "accounts") != accounts {
		t.Fatal("throttled request still created an account")
	}

	// The budget is per client, so an unrelated device is unaffected.
	if got := identityCall(t, s, "203.0.113.8", "other-device").Code; got != 201 {
		t.Fatalf("second client was throttled by the first: %d", got)
	}

	// The window rolls over.
	s.now = func() time.Time { return base.Add(identityRateWindow + time.Second) }
	if got := identityCall(t, s, "203.0.113.7", "after-window").Code; got != 201 {
		t.Fatalf("client still throttled after the window: %d", got)
	}
}

// Authenticated business traffic must never be throttled by the identity
// budget: a busy till issues far more writes than a login flood would.
func TestRateLimitLeavesAuthenticatedTrafficAlone(t *testing.T) {
	s := newTestServer(t)
	owner := register(t, s, "rate-owner", "Owner")
	if err := s.BootstrapOwner(owner.User.ID); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < identityRateLimit*3; i++ {
		key := "catalog-" + strconv.Itoa(i)
		w := call(t, s, http.MethodPost, "/api/v2/catalog-items", owner.AccessToken, key,
			map[string]any{"name": "Beads " + key, "unitPriceCents": 29})
		if w.Code != 201 {
			t.Fatalf("authenticated write %d rejected: %d %s", i, w.Code, w.Body.String())
		}
	}
}

// 限流计数在库里：同一个访客打到哪个副本，用的都是同一个窗口。
func TestRateLimitIsSharedAcrossReplicas(t *testing.T) {
	s := newTestServer(t)
	other := serverOn(t, s.postgres)
	base := time.Now()
	s.now = func() time.Time { return base }
	other.now = s.now
	for i := 0; i < identityRateLimit; i++ {
		replica := s
		if i%2 == 1 {
			replica = other
		}
		if got := identityCall(t, replica, "203.0.113.9", "shared-"+strconv.Itoa(i)).Code; got != 201 {
			t.Fatalf("request %d within the limit was rejected: %d", i, got)
		}
	}
	for _, replica := range []*Server{s, other} {
		if got := identityCall(t, replica, "203.0.113.9", "shared-over").Code; got != http.StatusTooManyRequests {
			t.Fatalf("over-limit request reached a replica: %d", got)
		}
	}
}

// 过期的限流窗口会被清掉，表不会一直长。
func TestExpiredRateWindowsArePurged(t *testing.T) {
	s := newTestServer(t)
	base := time.Now()
	s.now = func() time.Time { return base }
	for i := 0; i < 5; i++ {
		identityCall(t, s, "203.0.113."+strconv.Itoa(20+i), "purge-"+strconv.Itoa(i))
	}
	if count(t, s, "rate_limit_windows") != 5 {
		t.Fatalf("expected 5 windows, got %d", count(t, s, "rate_limit_windows"))
	}
	s.purgeRateWindows(context.Background(), base.Add(identityRateWindow+2*time.Hour))
	if n := count(t, s, "rate_limit_windows"); n != 0 {
		t.Fatalf("expired windows were retained: %d", n)
	}
}
