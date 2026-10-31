package app

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

// TEST-CHANNEL-001: the retired endpoints must not issue or upgrade credentials.
func TestRetiredAuthenticationRoutes(t *testing.T) {
	s := newTestServer(t)
	owner := register(t, s, "channel-owner", "Owner")
	if err := s.BootstrapOwner(owner.User.ID); err != nil {
		t.Fatal(err)
	}
	for _, endpoint := range []struct{ method, path string }{
		{"POST", "/auth/password-sessions"}, {"GET", "/auth/web-sessions/current"},
		{"DELETE", "/auth/web-sessions/current"}, {"PATCH", "/auth/web-sessions/current/password"},
		{"POST", "/auth/development-sessions"}, {"POST", "/auth/qr-challenges"},
		{"GET", "/auth/qr-challenges/" + id()}, {"POST", "/auth/qr-challenge-approvals"},
	} {
		t.Run(endpoint.method+endpoint.path, func(t *testing.T) {
			before := s.snapshotData()
			for _, bearer := range []string{"", owner.AccessToken} {
				response := call(t, s, endpoint.method, "/api/v2"+endpoint.path, bearer, "retired-route", map[string]any{})
				// 未登录的写请求在路由前就回 401（不占写锁）；登录后访问退役路径一律 404
				anonymousRejected := bearer == "" && response.Code == http.StatusUnauthorized
				if (response.Code != http.StatusNotFound && !anonymousRejected) || response.Header().Get("Set-Cookie") != "" {
					t.Fatalf("retired route responded %d", response.Code)
				}
			}
			if !bytes.Equal(before, s.snapshotData()) {
				t.Fatal("retired route changed state")
			}
		})
	}
	if r := call(t, s, "GET", "/api/v2/staff-role-assignments", owner.AccessToken, "", nil); r.Code != 200 {
		t.Fatal("failed requests lost Bearer session")
	}
}

func TestCookieCannotAuthenticateEvenWithValidBearerValue(t *testing.T) {
	s := newTestServer(t)
	owner := register(t, s, "cookie-owner", "Owner")
	_ = s.BootstrapOwner(owner.User.ID)
	for _, method := range []string{"GET", "POST"} {
		request := httptest.NewRequest(method, "/api/v2/floor-areas", bytes.NewBufferString(`{"name":"area","gridColumns":8,"gridRows":8}`))
		request.AddCookie(&http.Cookie{Name: "__Host-pindou_session", Value: owner.AccessToken})
		request.Header.Set("X-CSRF-Token", "legacy-csrf")
		response := serve(t, s, request)
		if response.Code != 401 {
			t.Fatalf("Cookie authenticated %s: %d", method, response.Code)
		}
	}
	// 换一个仍然存在的写端点：布局固定之后建区域是 405，证明不了 Bearer 还好使。
	table := seedTable(t, s, "H1", "大厅", 1, 1, false)
	if r := call(t, s, "PATCH", "/api/v2/service-tables/"+table.ID, owner.AccessToken, "", map[string]any{"enabled": false}); r.Code != 200 {
		t.Fatalf("Bearer no longer works: %d %s", r.Code, r.Body.String())
	}
}

func TestRetiredAccountFieldsStayPrivateAndCannotBeChanged(t *testing.T) {
	s := newTestServer(t)
	owner := register(t, s, "account-owner", "Owner")
	_ = s.BootstrapOwner(owner.User.ID)
	// 退役的网页密码登录在老账户的 state 里留下的键（凭证列已由迁移 016 删掉）
	edit(t, s, func(q *txn) {
		q.exec(`UPDATE accounts SET state = state || '{"loginName":"legacy-login","passwordChangeRequired":true}' WHERE id=$1`, owner.User.ID)
	})
	before := s.snapshotData()
	for _, field := range []string{"loginName", "initialPassword", "passwordChangeRequired"} {
		response := call(t, s, "PATCH", "/api/v2/accounts/"+owner.User.ID, owner.AccessToken, "", map[string]any{field: "changed", "nickname": "should not change"})
		if response.Code != 400 {
			t.Fatalf("retired field %s accepted: %d", field, response.Code)
		}
		if !bytes.Equal(before, s.snapshotData()) {
			t.Fatal("rejected update changed account")
		}
	}
	for _, path := range []string{"/api/v2/accounts", "/api/v2/accounts/" + owner.User.ID} {
		response := call(t, s, "GET", path, owner.AccessToken, "", nil)
		if response.Code != 200 {
			t.Fatal(response.Code)
		}
		for _, field := range []string{"loginName", "passwordChangeRequired"} {
			if bytes.Contains(response.Body.Bytes(), []byte(field)) {
				t.Fatalf("public DTO exposed %s", field)
			}
		}
	}
	// 老板下载的全部数据不含登录凭证
	export := call(t, s, http.MethodPost, "/api/v2/system/data-exports", owner.AccessToken, "", nil)
	if export.Code != http.StatusOK || bytes.Contains(export.Body.Bytes(), []byte("PasswordHash")) {
		t.Fatalf("export %d exposed a password hash", export.Code)
	}
	// 账户照常改资料：state 里的旧键随这次改写去掉
	if w := call(t, s, http.MethodPatch, "/api/v2/accounts/"+owner.User.ID, owner.AccessToken, "", map[string]any{"nickname": "新昵称"}); w.Code != http.StatusOK {
		t.Fatalf("rename: %d %s", w.Code, w.Body.String())
	}
	var stateKept bool
	if err := s.postgres.Pool().QueryRow(context.Background(), `SELECT state ? 'loginName' FROM accounts WHERE id=$1`, owner.User.ID).Scan(&stateKept); err != nil {
		t.Fatal(err)
	}
	if stateKept {
		t.Fatal("state kept the retired loginName after rename")
	}
}
