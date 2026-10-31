package app

import (
	"net/http"
	"testing"
	"time"
)

// 「现在」开台不受设备时钟快慢影响。
//
// 2026-10-06 生产服务器没开对时、比标准时间慢 2.2 秒：网页、小程序选「现在」开台时带的是设备的当前时间，
// 设备时钟是准的，到了服务器反倒「晚于当前时间」，全部被拒。现在不传开始时间就按服务器时间开；
// 旧客户端照旧带设备时间，比服务器快 2 分钟以内的也按服务器的「现在」算；再往后仍是未来时间，照旧拒。
func TestSessionStartToleratesSmallClockSkew(t *testing.T) {
	now := time.Date(2026, 10, 6, 9, 20, 0, 0, time.UTC)
	clerk := &User{Roles: []Role{Clerk}}
	for _, ahead := range []time.Duration{time.Second, 2200 * time.Millisecond, startClockSkew} {
		got, err := sessionStart(now, now.Add(ahead), clerk)
		if err != nil || !got.Equal(now) {
			t.Fatalf("设备快 %s：应按服务器时间 %s 开台，得到 %s，错误 %v", ahead, now, got, err)
		}
	}
	if _, err := sessionStart(now, now.Add(startClockSkew+time.Second), clerk); err == nil {
		t.Fatal("比服务器时间晚 2 分钟以上的开始时间仍应被拒")
	}
	backfilled := now.Add(-30 * time.Minute)
	if got, err := sessionStart(now, backfilled, clerk); err != nil || !got.Equal(backfilled) {
		t.Fatalf("回填 30 分钟前不该被改：得到 %s，错误 %v", got, err)
	}
}

func TestOpenSessionUsesServerClockWhenStartOmittedOrSlightlyAhead(t *testing.T) {
	now := time.Date(2026, 10, 6, 9, 20, 0, 0, time.UTC)
	s := newTestServer(t)
	s.now = func() time.Time { return now }
	o := register(t, s, "skew-owner", "老板")
	if err := s.BootstrapOwner(o.User.ID); err != nil {
		t.Fatal(err)
	}
	open := func(code string, startedAt string) (int, map[string]any) {
		t.Helper()
		table := seedTable(t, s, code, "A", int(code[1]-'0'), 2, true)
		body := map[string]any{"serviceTableId": table.ID, "timingMode": "timed", "durationMinutes": 60}
		if startedAt != "" {
			body["startedAt"] = startedAt
		}
		w := call(t, s, http.MethodPost, "/api/v2/venue-sessions", o.AccessToken, "", body)
		return w.Code, decodeMap(t, w)
	}
	startedOf := func(out map[string]any) time.Time {
		t.Helper()
		at, err := time.Parse(time.RFC3339Nano, out["startedAt"].(string))
		if err != nil {
			t.Fatalf("开始时间读不出来：%v", out)
		}
		return at
	}

	// 不传开始时间：按服务器时间开
	if code, out := open("A1", ""); code != 201 || !startedOf(out).Equal(now) {
		t.Fatalf("不传开始时间应按服务器时间开台：%d %v", code, out)
	}
	// 旧客户端带了快 2.2 秒的设备时间：按服务器时间开，不拒
	if code, out := open("A2", now.Add(2200*time.Millisecond).Format(time.RFC3339Nano)); code != 201 || !startedOf(out).Equal(now) {
		t.Fatalf("设备快 2.2 秒应按服务器时间开台：%d %v", code, out)
	}
	// 快 10 分钟：是真的填了未来时间，照旧拒
	if code, out := open("A3", now.Add(10*time.Minute).Format(time.RFC3339)); code != 400 || out["code"] != "invalid_session" {
		t.Fatalf("未来 10 分钟的开始时间应被拒：%d %v", code, out)
	}
}
