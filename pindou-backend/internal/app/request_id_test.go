package app

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// 客户端给的请求号会原样进入永久保存的审计，超长或带控制字符的值必须换成服务端生成的。
func TestAuditRequestIDRejectsUntrustedValues(t *testing.T) {
	s := newTestServer(t)
	owner := register(t, s, "request-id-owner", "Owner")
	if err := s.BootstrapOwner(owner.User.ID); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		name, header string
		kept         bool
	}{
		{"short", "client-42.retry:1", true},
		{"too long", strings.Repeat("x", 65), false},
		{"control characters", "abc\tdef", false},
		{"non-ascii", "请求号", false},
	} {
		t.Run(c.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodPost, "/api/v2/system/data-exports", nil)
			r.Header.Set("Authorization", "Bearer "+owner.AccessToken)
			r.Header.Set("Idempotency-Key", id())
			r.Header.Set("X-Request-ID", c.header)
			w := serve(t, s, r)
			if w.Code != http.StatusOK {
				t.Fatalf("export: %d %s", w.Code, w.Body.String())
			}
			got := lastAudit(t, s).RequestID
			if c.kept && got != c.header {
				t.Fatalf("valid request id replaced: %q", got)
			}
			if !c.kept && (got == c.header || !validID(got)) {
				t.Fatalf("untrusted request id reached the audit: %q", got)
			}
		})
	}
}
