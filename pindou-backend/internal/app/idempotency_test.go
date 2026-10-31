package app

import (
	"bytes"
	"net/http"
	"testing"
	"time"

	catalogapp "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/catalog/application"
)

// Idempotency keys used to accumulate forever: every financial retry guard ever
// issued stayed in memory and in every persisted snapshot. They now age out,
// while a key inside the retention window still replays its recorded response.
func TestIdempotencyKeysExpireButStillReplayWithinRetention(t *testing.T) {
	s := newTestServer(t)
	base := time.Now()
	s.now = func() time.Time { return base }
	owner := register(t, s, "idem-owner", "Owner")
	if err := s.BootstrapOwner(owner.User.ID); err != nil {
		t.Fatal(err)
	}
	// Bearer sessions last a day; keep this one valid across the whole
	// retention window so the assertions below are about key expiry only.
	edit(t, s, func(q *txn) {
		q.exec(`UPDATE auth_sessions SET expires_at=$2 WHERE token_hash=$1`, identityKey(owner.AccessToken), base.Add(2*idempotencyRetention))
	})

	first := call(t, s, http.MethodPost, "/api/v2/catalog-items", owner.AccessToken, "old-key",
		map[string]any{"name": "Beads", "unitPriceCents": 29})
	if first.Code != 201 {
		t.Fatalf("first write: %d %s", first.Code, first.Body.String())
	}
	if got := len(idemOf(t, s)); got != 1 {
		t.Fatalf("expected 1 recorded key, got %d", got)
	}

	// Still inside the window: the key must replay rather than execute again.
	s.now = func() time.Time { return base.Add(idempotencyRetention - time.Hour) }
	replay := call(t, s, http.MethodPost, "/api/v2/catalog-items", owner.AccessToken, "old-key",
		map[string]any{"name": "Beads", "unitPriceCents": 29})
	// The cached body is written verbatim; the original went through writeJSON,
	// which appends a newline.
	if replay.Code != 201 || !bytes.Equal(bytes.TrimSpace(replay.Body.Bytes()), bytes.TrimSpace(first.Body.Bytes())) {
		t.Fatalf("replay within retention changed: %d %s", replay.Code, replay.Body.String())
	}
	if n := len(view(t, s, func(q *txn) []*catalogapp.Item { return q.allCatalog() })); n != 1 {
		t.Fatalf("replay created a second catalog item: %d", n)
	}

	// Past the window, the next write prunes the aged key and keeps its own.
	s.now = func() time.Time { return base.Add(idempotencyRetention + 2*time.Hour) }
	later := call(t, s, http.MethodPost, "/api/v2/catalog-items", owner.AccessToken, "new-key",
		map[string]any{"name": "More beads", "unitPriceCents": 31})
	if later.Code != 201 {
		t.Fatalf("later write: %d %s", later.Code, later.Body.String())
	}
	_, aged := idemOf(t, s)["catalog:"+owner.User.ID+":POST::old-key"]
	total := len(idemOf(t, s))
	if aged {
		t.Fatal("expired idempotency key was retained")
	}
	if total != 1 {
		t.Fatalf("expected only the fresh key to remain, got %d", total)
	}
}
