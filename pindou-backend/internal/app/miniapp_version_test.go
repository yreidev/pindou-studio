package app

import (
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestMiniappVersionObservationPermissionsAndPersistence(t *testing.T) {
	db := newTestDatabase(t)
	s := serverOn(t, db)
	clerk := register(t, s, "version-clerk", "店员")
	setRoles(t, s, clerk.User.ID, Clerk)
	customer := register(t, s, "version-customer", "顾客")
	path := "/api/v2/system/miniapp-version"
	body := map[string]any{"envVersion": "release", "version": "0.0.39"}
	for _, tc := range []struct {
		name, bearer string
		status       int
	}{
		{"未登录", "", http.StatusUnauthorized},
		{"顾客", customer.AccessToken, http.StatusForbidden},
	} {
		for _, method := range []string{http.MethodGet, http.MethodPost} {
			var data any
			if method == http.MethodPost {
				data = body
			}
			if w := call(t, s, method, path, tc.bearer, "", data); w.Code != tc.status {
				t.Fatalf("%s %s: %d %s", tc.name, method, w.Code, w.Body.String())
			}
		}
	}
	if w := call(t, s, http.MethodGet, path, clerk.AccessToken, "", nil); w.Code != http.StatusOK || decodeMap(t, w)["release"] != nil {
		t.Fatalf("尚未上报应明确为 null：%d %s", w.Code, w.Body.String())
	}
	at := time.Now().UTC().Truncate(time.Second)
	s.now = func() time.Time { return at }
	edit(t, s, func(q *txn) {
		q.putAuthSession(identityKey("version-web-session"), authSession{UserID: clerk.User.ID, Client: clientWeb, ExpiresAt: at.Add(time.Hour)})
	})
	if w := call(t, s, http.MethodPost, path, "version-web-session", "", body); w.Code != http.StatusForbidden {
		t.Fatalf("网页会话不能上报：%d %s", w.Code, w.Body.String())
	}
	for _, invalid := range []map[string]any{
		{"envVersion": "trial", "version": "0.0.99"},
		{"envVersion": "develop", "version": "0.0.99"},
		{"envVersion": "release", "version": ""},
		{"envVersion": "release", "version": "0.0.39<script>"},
		{"envVersion": "release", "version": strings.Repeat("1", 30) + ".0.0"},
	} {
		if w := call(t, s, http.MethodPost, path, clerk.AccessToken, "", invalid); w.Code != http.StatusBadRequest {
			t.Fatalf("无效上报 %v：%d %s", invalid, w.Code, w.Body.String())
		}
	}
	if w := call(t, s, http.MethodGet, path, clerk.AccessToken, "", nil); decodeMap(t, w)["release"] != nil {
		t.Fatalf("被拒的上报不能产生记录：%s", w.Body.String())
	}
	w := call(t, s, http.MethodPost, path, clerk.AccessToken, "", body)
	if w.Code != http.StatusOK {
		t.Fatalf("正式版上报：%d %s", w.Code, w.Body.String())
	}
	release := decodeMap(t, w)["release"].(map[string]any)
	if release["version"] != "0.0.39" || release["reportedAt"] != at.Format(time.RFC3339) {
		t.Fatalf("版本和服务端时间：%v", release)
	}
	// 重启或另一个 API 副本读取同一记录，员工网页会话可读。
	restarted := serverOn(t, db)
	w = call(t, restarted, http.MethodGet, path, "version-web-session", "", nil)
	if w.Code != http.StatusOK || decodeMap(t, w)["release"].(map[string]any)["version"] != "0.0.39" {
		t.Fatalf("另一副本读取：%d %s", w.Code, w.Body.String())
	}
	// 最近使用可能是尚未更新的旧版，按这次实际观察更新，不把版本号较大冒充当前观察。
	at = at.Add(time.Minute)
	body["version"] = "0.0.38"
	w = call(t, s, http.MethodPost, path, clerk.AccessToken, "", body)
	if w.Code != http.StatusOK {
		t.Fatalf("再次上报：%d %s", w.Code, w.Body.String())
	}
	w = call(t, restarted, http.MethodGet, path, clerk.AccessToken, "", nil)
	release = decodeMap(t, w)["release"].(map[string]any)
	reportedAt, err := time.Parse(time.RFC3339, release["reportedAt"].(string))
	if err != nil || release["version"] != "0.0.38" || !reportedAt.Equal(at) {
		t.Fatalf("应显示最近实际使用版本：%v，时间解析：%v", release, err)
	}
}
