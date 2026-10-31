package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"regexp"
	"testing"
	"time"

	identityapp "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/identity/application"
)

// 员工发的临时密码与认领用的密码（password.go、迁移 022）。顾客网页 2026-10-31 下线：网页注册、密码登录、改密码的
// 接口去掉了，库里剩下的顾客网页会话一律当无效。用密码认领的流程在 member_accounts_test.go。

func issueTemporary(t *testing.T, s *Server, bearer, account string) *httptest.ResponseRecorder {
	t.Helper()
	return call(t, s, http.MethodPost, "/api/v2/accounts/"+account+"/password-resets", bearer, "", nil)
}

// webMember 造一个以前在顾客网页注册过的账户：没有微信身份，有自己设的密码（不是临时密码），注册时同意过网页的
// 隐私协议。返回账户编号。
func webMember(t *testing.T, s *Server, staffBearer, phone, password string) string {
	t.Helper()
	account := openMember(t, s, staffBearer, phone)
	hash, err := identityapp.HashPassword(password)
	if err != nil {
		t.Fatal(err)
	}
	normalized, ok := identityapp.NormalizePhone(phone)
	if !ok {
		t.Fatalf("手机号 %q 不合格式", phone)
	}
	edit(t, s, func(q *txn) {
		q.putPasswordLogin(passwordLogin{AccountID: account, Phone: normalized, PasswordHash: hash})
		u := q.user(account)
		u.PrivacyContractVersion, u.PrivacyAcceptedAt = "h5-privacy-v1", q.now()
	})
	return account
}

func codeOf(t *testing.T, w *httptest.ResponseRecorder) string {
	t.Helper()
	code, _ := decodeMap(t, w)["code"].(string)
	return code
}

func sessionFrom(t *testing.T, w *httptest.ResponseRecorder) sessionResponse {
	t.Helper()
	var out sessionResponse
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode %q: %v", w.Body.String(), err)
	}
	return out
}

// 顾客网页的注册、密码登录、改密码三个接口已经没有了。
func TestRetiredCustomerWebEndpointsAreGone(t *testing.T) {
	s := newTestServer(t)
	body := map[string]any{"nickname": "Alice", "phone": "13900001111", "password": "alice-secret", "newPassword": "alice-secret-2", "privacyContractVersion": "h5-privacy-v3"}
	for _, path := range []string{"/api/v2/auth/phone-registrations", "/api/v2/auth/phone-sessions", "/api/v2/auth/password-changes"} {
		if w := call(t, s, http.MethodPost, path, "", "", body); w.Code != http.StatusNotFound {
			t.Fatalf("%s: %d %s", path, w.Code, w.Body.String())
		}
	}
}

// 库里剩下的顾客网页会话（client h5）一律当无效：不能被当成小程序会话、按真实任命给权限（滚动发布时旧版本还会发）。
func TestRetiredCustomerWebSessionsAreRejected(t *testing.T) {
	s := newTestServer(t)
	owner := ownerFixture(t, s)
	web := token()
	edit(t, s, func(q *txn) {
		q.putAuthSession(identityKey(web), authSession{UserID: owner.User.ID, ExpiresAt: q.now().Add(24 * time.Hour), Client: retiredClientH5})
	})
	for _, path := range []string{"/api/v2/accounts/" + owner.User.ID, "/api/v2/accounts", "/api/v2/venue-sessions?status=live"} {
		if got := call(t, s, http.MethodGet, path, web, "", nil).Code; got != http.StatusUnauthorized {
			t.Fatalf("顾客网页会话读 %s：%d", path, got)
		}
	}
	// 小程序会话照旧是老板
	if got := call(t, s, http.MethodGet, "/api/v2/accounts", owner.AccessToken, "", nil).Code; got != http.StatusOK {
		t.Fatalf("小程序会话：%d", got)
	}
}

// 员工发的临时密码：8 位数字、24 小时有效，换掉这个账户原来的密码，只能拿去在小程序里认领；顾客自己不能发。
func TestStaffIssuesATemporaryPasswordForClaiming(t *testing.T) {
	s := newTestServer(t)
	clock := time.Date(2026, 10, 10, 10, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return clock }
	owner := ownerFixture(t, s)
	clerk := register(t, s, "wx-clerk", "店员")
	setRoles(t, s, clerk.User.ID, Clerk)
	customer := register(t, s, "wx-dave", "Dave")
	alice := webMember(t, s, owner.AccessToken, "13900001111", "alice-secret")

	if got := issueTemporary(t, s, customer.AccessToken, alice).Code; got != http.StatusForbidden {
		t.Fatalf("顾客发临时密码：%d", got)
	}
	w := issueTemporary(t, s, clerk.AccessToken, alice)
	if w.Code != http.StatusCreated {
		t.Fatalf("店员发临时密码：%d %s", w.Code, w.Body.String())
	}
	body := decodeMap(t, w)
	temporary := body["temporaryPassword"].(string)
	if !regexp.MustCompile(`^[0-9]{8}$`).MatchString(temporary) || body["phoneMasked"] != "139****1111" {
		t.Fatalf("临时密码结果 = %v", body)
	}
	audits := auditsOf(t, s)
	if last := audits[len(audits)-1]; last.Action != "password.reset" || last.ActorID != clerk.User.ID || last.ObjectID != alice {
		t.Fatalf("审计 = %+v", last)
	}
	// 原来的网页密码换掉了；过了 24 小时临时密码也不能用
	if w := claimMember(t, s, "Alice 的微信", "13900001111", "alice-secret"); w.Code != http.StatusUnauthorized || codeOf(t, w) != "invalid_credentials" {
		t.Fatalf("发了临时密码后旧密码还能认领：%d %s", w.Code, w.Body.String())
	}
	clock = clock.Add(temporaryPasswordTTL + time.Minute)
	if w := claimMember(t, s, "Alice 的微信", "13900001111", temporary); w.Code != http.StatusUnauthorized || codeOf(t, w) != "temporary_password_expired" {
		t.Fatalf("过期的临时密码：%d %s", w.Code, w.Body.String())
	}
	// 再发一个（会话也过了 24 小时，店员重新登录），24 小时内能认领
	relogin := call(t, s, http.MethodPost, "/api/v2/auth/wechat-sessions", "", "", map[string]any{"wechatLoginCode": "wx-clerk"})
	if relogin.Code != http.StatusCreated {
		t.Fatalf("店员重新登录：%d %s", relogin.Code, relogin.Body.String())
	}
	temporary = decodeMap(t, issueTemporary(t, s, sessionFrom(t, relogin).AccessToken, alice))["temporaryPassword"].(string)
	if w := claimMember(t, s, "Alice 的微信", "13900001111", temporary); w.Code != http.StatusCreated || sessionFrom(t, w).User.ID != alice {
		t.Fatalf("用临时密码认领：%d %s", w.Code, w.Body.String())
	}
}

// 员工代开的会员还没有认领密码：按资料里的手机号开一条；资料里没有能用的号、号已被别的账户用来认领时说清楚。
func TestStaffIssueOpensAClaimPasswordByProfilePhone(t *testing.T) {
	s := newTestServer(t)
	clerk := register(t, s, "wx-clerk", "店员")
	setRoles(t, s, clerk.User.ID, Clerk)
	bob := openMember(t, s, clerk.AccessToken, "137 0000 3333")
	w := issueTemporary(t, s, clerk.AccessToken, bob)
	if w.Code != http.StatusCreated {
		t.Fatalf("发临时密码：%d %s", w.Code, w.Body.String())
	}
	temporary := decodeMap(t, w)["temporaryPassword"].(string)

	// 资料里没有能用的号：先填资料
	carol := register(t, s, "wx-carol", "Carol")
	edit(t, s, func(q *txn) { q.user(carol.User.ID).Phone = "" })
	if w := issueTemporary(t, s, clerk.AccessToken, carol.User.ID); w.Code != http.StatusConflict || codeOf(t, w) != "phone_missing" {
		t.Fatalf("没有手机号：%d %s", w.Code, w.Body.String())
	}
	// 资料里的号已被别人用来认领（Bob 的临时密码还没用掉）
	edit(t, s, func(q *txn) { q.user(carol.User.ID).Phone = "13700003333" })
	if w := issueTemporary(t, s, clerk.AccessToken, carol.User.ID); w.Code != http.StatusConflict || codeOf(t, w) != "phone_registered" {
		t.Fatalf("号被占用：%d %s", w.Code, w.Body.String())
	}
	if got := issueTemporary(t, s, clerk.AccessToken, "8d0f3c1e-2b4a-4c6d-9e8f-0a1b2c3d4e5f").Code; got != http.StatusNotFound {
		t.Fatalf("不存在的账户：%d", got)
	}

	if w := claimMember(t, s, "Bob 的微信", "13700003333", temporary); w.Code != http.StatusCreated || sessionFrom(t, w).User.ID != bob {
		t.Fatalf("认领到了别的账户：%d %s", w.Code, w.Body.String())
	}
}

// 给员工发临时密码按任命规则：店员不能给员工发，店长不能给老板发。
func TestStaffIssueFollowsRoleManagementRules(t *testing.T) {
	s := newTestServer(t)
	owner := ownerFixture(t, s)
	manager := register(t, s, "wx-manager", "店长")
	setRoles(t, s, manager.User.ID, Manager)
	clerk := register(t, s, "wx-clerk", "店员")
	setRoles(t, s, clerk.User.ID, Clerk)
	other := register(t, s, "wx-clerk-2", "店员二")
	setRoles(t, s, other.User.ID, Clerk)
	for label, c := range map[string]struct {
		actor, target string
		want          int
	}{
		"店员给店员发": {clerk.AccessToken, other.User.ID, http.StatusForbidden},
		"店员给店长发": {clerk.AccessToken, manager.User.ID, http.StatusForbidden},
		"店长给老板发": {manager.AccessToken, owner.User.ID, http.StatusForbidden},
		"店长给店员发": {manager.AccessToken, other.User.ID, http.StatusCreated},
		"老板给店长发": {owner.AccessToken, manager.User.ID, http.StatusCreated},
	} {
		// 测试账户的手机号都一样：每次换一个，免得「号已被别的账户用来认领」
		phone := map[string]string{other.User.ID: "13600000001", manager.User.ID: "13600000002", owner.User.ID: "13600000003"}[c.target]
		edit(t, s, func(q *txn) { q.user(c.target).Phone = phone })
		if got := issueTemporary(t, s, c.actor, c.target).Code; got != c.want {
			t.Fatalf("%s：%d，应为 %d", label, got, c.want)
		}
	}
}

// 有认领密码的账户改资料换号：认领用的号一起换；换成别人用过的号被拒。
func TestProfilePhoneChangeMovesTheClaimPhone(t *testing.T) {
	s := newTestServer(t)
	owner := ownerFixture(t, s)
	alice := webMember(t, s, owner.AccessToken, "13900001111", "alice-secret")
	webMember(t, s, owner.AccessToken, "13900002222", "bob-secret-1")
	claimed := claimMember(t, s, "Alice 的微信", "13900001111", "alice-secret")
	if claimed.Code != http.StatusCreated {
		t.Fatalf("认领：%d %s", claimed.Code, claimed.Body.String())
	}
	session := sessionFrom(t, claimed).AccessToken
	patch := func(phone string) *httptest.ResponseRecorder {
		return call(t, s, http.MethodPatch, "/api/v2/accounts/"+alice, session, "", map[string]any{"phone": phone})
	}
	if w := patch("139 0000 2222"); w.Code != http.StatusConflict || codeOf(t, w) != "phone_registered" {
		t.Fatalf("换成别人的号：%d %s", w.Code, w.Body.String())
	}
	if w := patch("not-a-phone"); w.Code != http.StatusBadRequest {
		t.Fatalf("格式不对：%d %s", w.Code, w.Body.String())
	}
	if w := patch("139 0000 3333"); w.Code != http.StatusOK || decodeMap(t, w)["phoneMasked"] != "139****3333" {
		t.Fatalf("换号：%d %s", w.Code, w.Body.String())
	}
	// 旧号认不出了；新号认得出（已经认领过，所以是 already_claimed）
	if w := claimMember(t, s, "别的微信", "13900001111", "alice-secret"); w.Code != http.StatusUnauthorized {
		t.Fatalf("旧号还能认领：%d %s", w.Code, w.Body.String())
	}
	if w := claimMember(t, s, "别的微信", "13900003333", "alice-secret"); w.Code != http.StatusConflict || codeOf(t, w) != "already_claimed" {
		t.Fatalf("新号：%d %s", w.Code, w.Body.String())
	}
	// 没有认领密码的小程序账户，换号规则不变（号可以和别人一样）
	carol := register(t, s, "wx-carol", "Carol")
	if w := call(t, s, http.MethodPatch, "/api/v2/accounts/"+carol.User.ID, carol.AccessToken, "", map[string]any{"phone": "13900002222"}); w.Code != http.StatusOK {
		t.Fatalf("小程序账户换号：%d %s", w.Code, w.Body.String())
	}
}
