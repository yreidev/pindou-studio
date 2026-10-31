package app

import (
	"net/http"
	"testing"
	"time"

	member "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/membership/application"
)

// 陪客会话不能暂停、继续。
//
// 会话只有一个 status 字段，陪客就记在它上面（companion）。以前陪客会话照样能暂停、
// 再继续：companion → paused → active，陪客标记就这么丢了，建单按套餐价收了陪客的钱。
// 陪客不计费，暂停也没有意义；收费政策待定之前，后端直接拒绝，两端也不给按钮。
func TestCompanionSessionCannotBePausedOrResumed(t *testing.T) {
	now := time.Date(2026, 9, 20, 10, 0, 0, 0, time.UTC)
	s := newTestServer(t)
	s.now = func() time.Time { return now }
	o := register(t, s, "companion-owner", "老板")
	if err := s.BootstrapOwner(o.User.ID); err != nil {
		t.Fatal(err)
	}
	publishRule(t, s, o.AccessToken, member.Rule{Kind: "package", Name: "1小时", AmountCents: 2990, DurationMinutes: 60, Overtime: "manual"})
	table := seedTable(t, s, "A1", "A", 1, 2, true)
	w := call(t, s, http.MethodPost, "/api/v2/venue-sessions", o.AccessToken, "",
		map[string]any{"serviceTableId": table.ID, "timingMode": "timed", "durationMinutes": 60, "startedAt": now.Format(time.RFC3339)})
	if w.Code != 201 {
		t.Fatalf("开台失败：%d %s", w.Code, w.Body.String())
	}
	sessionID := decodeMap(t, w)["id"].(string)
	patch := func(key string, body map[string]any) map[string]any {
		t.Helper()
		w := call(t, s, http.MethodPatch, "/api/v2/venue-sessions/"+sessionID, o.AccessToken, key, body)
		out := decodeMap(t, w)
		out["_status"] = w.Code
		return out
	}
	if got := patch("companion-mark", map[string]any{"status": "companion"}); got["_status"] != 200 {
		t.Fatalf("标记陪客失败：%v", got)
	}
	for _, status := range []string{"paused", "active"} {
		got := patch("companion-"+status, map[string]any{"status": status})
		if got["_status"] != 409 || got["code"] != "invalid_session_state" {
			t.Fatalf("陪客会话改成 %s 应被拒绝：%v", status, got)
		}
	}
	if got := sessionOf(t, s, sessionID); got.Status != "companion" || got.PausedAt != nil {
		t.Fatalf("陪客标记不能丢：%+v", got)
	}
	w = call(t, s, http.MethodPost, "/api/v2/sales-orders", o.AccessToken, "companion-order", map[string]any{"venueSessionId": sessionID})
	lines := decodeMap(t, w)["lines"].([]any)
	if len(lines) != 1 || lines[0].(map[string]any)["name"] != "陪客" || lines[0].(map[string]any)["unitPriceCents"].(float64) != 0 {
		t.Fatalf("陪客会话建单应是一行 0 元的陪客，实际 %v", lines)
	}
}
