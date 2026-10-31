package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func openMember(t *testing.T, s *Server, bearer, phone string) string {
	t.Helper()
	w := call(t, s, "POST", "/api/v2/member-accounts", bearer, "", map[string]any{"nickname": "代开顾客", "phone": phone, "consent": true})
	if w.Code != 201 {
		t.Fatalf("代开失败：%d %s", w.Code, w.Body.String())
	}
	out := decodeMap(t, w)
	if out["existing"] != false || out["account"].(map[string]any)["unclaimed"] != true {
		t.Fatalf("代开响应不对：%s", w.Body.String())
	}
	return out["account"].(map[string]any)["id"].(string)
}

func claimMember(t *testing.T, s *Server, code, phone, password string) *httptest.ResponseRecorder {
	t.Helper()
	return call(t, s, "POST", "/api/v2/auth/member-claims", "", "", map[string]any{"wechatLoginCode": code, "phone": phone, "password": password, "privacyContractVersion": "wechat-privacy-v2"})
}

func temporaryFor(t *testing.T, s *Server, bearer, account string) string {
	t.Helper()
	w := issueTemporary(t, s, bearer, account)
	if w.Code != 201 {
		t.Fatalf("发临时密码：%d %s", w.Code, w.Body.String())
	}
	return decodeMap(t, w)["temporaryPassword"].(string)
}

func memberUnclaimed(t *testing.T, s *Server, bearer, account string) bool {
	t.Helper()
	w := call(t, s, "GET", "/api/v2/loyalty/members?q="+account, bearer, "", nil)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	var rows []map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &rows); err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 {
		t.Fatalf("会员列表 = %s", w.Body.String())
	}
	return rows[0]["unclaimed"] == true
}

func TestMemberAccountOpeningAndDuplicatePhones(t *testing.T) {
	s := newTestServer(t)
	owner := ownerFixture(t, s)
	clerk := register(t, s, "代开店员", "店员")
	setRoles(t, s, clerk.User.ID, Clerk)
	account := openMember(t, s, clerk.AccessToken, "139 0000-1111")
	u := userOf(t, s, account)
	if u.Phone != "13900001111" || u.MemberOpening == nil || u.MemberOpening.ActorID != clerk.User.ID || u.MemberOpening.CreatedAt.IsZero() || u.PrivacyContractVersion != "" || !u.PrivacyAcceptedAt.IsZero() {
		t.Fatalf("代开账户状态不对：编号 %s", account)
	}
	view(t, s, func(q *txn) bool {
		if q.accountHasWechat(account) {
			t.Fatal("代开账户不应有微信身份")
		}
		if _, exists := q.passwordLoginOf(account); exists {
			t.Fatal("代开账户不应有网页密码")
		}
		if !scalar[bool](q, `SELECT privacy_accepted_at IS NULL AND privacy_contract_version IS NULL FROM accounts WHERE id = $1`, account) {
			t.Fatal("代开不应替本人同意隐私协议")
		}
		return true
	})
	if !memberUnclaimed(t, s, owner.AccessToken, account) {
		t.Fatal("没标未认领")
	}
	if a := lastAudit(t, s); a.Action != "account.opened_member" || a.ActorID != clerk.User.ID || a.ObjectID != account || strings.Contains(a.Reason, "139") {
		t.Fatal("代开审计不对或泄露了手机号")
	}
	for _, phone := range []string{"13900001111", "139-0000 1111"} {
		w := call(t, s, "POST", "/api/v2/member-accounts", clerk.AccessToken, "", map[string]any{"nickname": "不覆盖旧称呼", "phone": phone, "consent": true})
		if w.Code != 200 || decodeMap(t, w)["existing"] != true || decodeMap(t, w)["account"].(map[string]any)["id"] != account {
			t.Fatalf("重复号未返回原账户：%d %s", w.Code, w.Body.String())
		}
		if userOf(t, s, account).Nickname != "代开顾客" {
			t.Fatal("撞号覆盖了原称呼")
		}
	}
	// 旧小程序资料里的格式化号、认领密码里的号（以前在顾客网页注册的），都应找到原账户。
	existing := webMember(t, s, owner.AccessToken, "13700002222", "member-web-secret")
	edit(t, s, func(q *txn) {
		q.user(existing).Phone = "13700003333"
		q.user(clerk.User.ID).Phone = "136 0000-4444"
	})
	for phone, want := range map[string]string{"13700002222": existing, "137-0000-3333": existing, "13600004444": clerk.User.ID} {
		w := call(t, s, "POST", "/api/v2/member-accounts", owner.AccessToken, "", map[string]any{"nickname": "同号", "phone": phone, "consent": true})
		if w.Code != 200 || decodeMap(t, w)["account"].(map[string]any)["id"] != want {
			t.Fatalf("重复号查找失败：%d", w.Code)
		}
	}
	for _, c := range []struct {
		bearer string
		body   map[string]any
		status int
		code   string
	}{
		{"", map[string]any{}, 401, "unauthorized"},
		{register(t, s, "代开-普通顾客", "顾客").AccessToken, map[string]any{}, 403, "forbidden"},
		{clerk.AccessToken, map[string]any{"nickname": "顾客", "phone": "13500005555", "consent": false}, 400, "invalid_request"},
		{clerk.AccessToken, map[string]any{"nickname": "", "phone": "13500005555", "consent": true}, 400, "invalid_request"},
		{clerk.AccessToken, map[string]any{"nickname": strings.Repeat("名", 51), "phone": "13500005555", "consent": true}, 400, "invalid_request"},
		{clerk.AccessToken, map[string]any{"nickname": "顾客", "phone": "abc", "consent": true}, 400, "invalid_request"},
	} {
		storedWantError(t, s, c.status, c.code, func() *httptest.ResponseRecorder {
			return call(t, s, "POST", "/api/v2/member-accounts", c.bearer, "", c.body)
		})
	}
	// 没认领也能立即记账，代开状态不应影响会员资产操作。
	loyaltyOK(t, s, clerk.AccessToken, loyaltyInput{Action: "adjust", AccountID: account, PrincipalCents: 88800, BoardUses: storedNumber(2), Reason: "补老账"})
	if memberOf(t, s, account).Balance(account, s.now()).BoardUses != 2 {
		t.Fatal("代开账户不能记账")
	}
	encoded, _ := json.Marshal(User{ID: "旧账户", PhoneVerificationStatus: "unverified"})
	if strings.Contains(string(encoded), "memberOpening") {
		t.Fatal("旧账户编码不兼容")
	}
}

func TestMemberAccountConcurrentOpeningIsDeduplicated(t *testing.T) {
	s := newTestServer(t)
	owner := ownerFixture(t, s)
	other := serverOn(t, s.postgres)
	results := make(chan *httptest.ResponseRecorder, 2)
	var wg sync.WaitGroup
	for _, server := range []*Server{s, other} {
		wg.Go(func() {
			results <- call(t, server, "POST", "/api/v2/member-accounts", owner.AccessToken, "", map[string]any{"nickname": "同时代开", "phone": "13900008888", "consent": true})
		})
	}
	wg.Wait()
	close(results)
	counts := map[int]int{}
	ids := map[string]bool{}
	for w := range results {
		counts[w.Code]++
		if w.Code != 200 && w.Code != 201 {
			t.Fatalf("并发代开：%d %s", w.Code, w.Body.String())
		}
		ids[decodeMap(t, w)["account"].(map[string]any)["id"].(string)] = true
	}
	if counts[200] != 1 || counts[201] != 1 || len(ids) != 1 {
		t.Fatalf("并发建了重复账户：%v", counts)
	}
}

func TestMemberClaimTemporaryPasswordPreservesAssets(t *testing.T) {
	s := newTestServer(t)
	owner := ownerFixture(t, s)
	account := openMember(t, s, owner.AccessToken, "13900001111")
	loyaltyOK(t, s, owner.AccessToken, loyaltyInput{Action: "adjust", AccountID: account, PrincipalCents: 88800, GiftCents: 12000, BoardUses: storedNumber(2), Reason: "已有储值"})
	beforeVersion := accountVersionOf(t, s, account)
	temporary := temporaryFor(t, s, owner.AccessToken, account)
	if !memberUnclaimed(t, s, owner.AccessToken, account) {
		t.Fatal("仅发临时密码就标成已认领")
	}
	storedWantError(t, s, 401, "invalid_credentials", func() *httptest.ResponseRecorder {
		return claimMember(t, s, "新的微信", "13900001111", "密码不对")
	})
	storedWantError(t, s, 409, "already_registered", func() *httptest.ResponseRecorder {
		return claimMember(t, s, "web-login-owner", "13900001111", temporary)
	})
	w := claimMember(t, s, "认领微信", "139 0000-1111", temporary)
	if w.Code != 201 {
		t.Fatalf("认领失败：%d %s", w.Code, w.Body.String())
	}
	session := sessionFrom(t, w)
	if session.User.ID != account || session.User.MemberOpening != nil || len(session.User.Roles) != 0 || sessionClient(t, s, session.AccessToken) != clientMiniapp {
		t.Fatal("认领没有发原账户的小程序会话")
	}
	if user := userOf(t, s, account); user.PrivacyContractVersion != "wechat-privacy-v2" || user.PrivacyAcceptedAt.IsZero() || user.MemberOpening == nil {
		t.Fatal("认领没补隐私同意或丢了代开来源")
	}
	if beforeVersion != accountVersionOf(t, s, account) {
		t.Fatal("认领改变了会员资产")
	}
	if memberUnclaimed(t, s, owner.AccessToken, account) {
		t.Fatal("认领后还标未认领")
	}
	if exists := view(t, s, func(q *txn) bool { _, ok := q.passwordLoginOf(account); return ok }); exists {
		t.Fatal("临时密码认领后没作废")
	}
	if a := lastAudit(t, s); a.Action != "account.claimed_member" || a.ActorID != account || a.ObjectID != account {
		t.Fatal("认领没记审计")
	}
	if w := call(t, s, "POST", "/api/v2/auth/wechat-sessions", "", "", map[string]any{"wechatLoginCode": "认领微信"}); w.Code != 201 || sessionFrom(t, w).User.ID != account {
		t.Fatalf("绑定后微信登不了：%d %s", w.Code, w.Body.String())
	}
	storedWantError(t, s, 401, "invalid_credentials", func() *httptest.ResponseRecorder {
		return claimMember(t, s, "另一个微信", "13900001111", temporary)
	})
}

// 以前在顾客网页注册过的账户，用当时设的密码认领：已有的隐私同意不覆盖，密码不作废（不是临时密码）。
func TestMemberClaimWebPasswordAndFailureOrder(t *testing.T) {
	s := newTestServer(t)
	clock := time.Date(2026, 10, 27, 0, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return clock }
	owner := ownerFixture(t, s)
	alice := webMember(t, s, owner.AccessToken, "13900001111", "member-web-secret")
	accepted := userOf(t, s, alice).PrivacyAcceptedAt
	clock = clock.Add(time.Hour)
	w := claimMember(t, s, "网页会员的微信", "13900001111", "member-web-secret")
	if w.Code != 201 || sessionFrom(t, w).User.ID != alice {
		t.Fatalf("网页账号认领：%d %s", w.Code, w.Body.String())
	}
	if u := userOf(t, s, alice); u.PrivacyContractVersion != "h5-privacy-v1" || !u.PrivacyAcceptedAt.Equal(accepted) {
		t.Fatal("已有隐私同意被覆盖")
	}
	storedWantError(t, s, 401, "invalid_credentials", func() *httptest.ResponseRecorder {
		return claimMember(t, s, "另一微信", "13900001111", "错密码")
	})
	storedWantError(t, s, 409, "already_claimed", func() *httptest.ResponseRecorder {
		return claimMember(t, s, "另一微信", "13900001111", "member-web-secret")
	})
	storedWantError(t, s, 401, "invalid_credentials", func() *httptest.ResponseRecorder {
		return claimMember(t, s, "另一微信", "13700009999", "任意密码")
	})
}

func TestMemberClaimExpiryRateLimitAndInput(t *testing.T) {
	s := newTestServer(t)
	clock := time.Date(2026, 10, 27, 0, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return clock }
	owner := ownerFixture(t, s)
	account := openMember(t, s, owner.AccessToken, "13900001111")
	storedWantError(t, s, 401, "invalid_credentials", func() *httptest.ResponseRecorder {
		return claimMember(t, s, "认领微信", "13900001111", "尚未开通密码")
	})
	temporary := temporaryFor(t, s, owner.AccessToken, account)
	clock = clock.Add(temporaryPasswordTTL)
	storedWantError(t, s, 401, "temporary_password_expired", func() *httptest.ResponseRecorder { return claimMember(t, s, "认领微信", "13900001111", temporary) })
	for i := 1; i < passwordPhoneLimit; i++ {
		if w := claimMember(t, s, "认领微信", "13900001111", "错密码"); w.Code != 401 {
			t.Fatalf("第 %d 次失败：%d", i, w.Code)
		}
	}
	w := claimMember(t, s, "认领微信", "139 0000-1111", temporary)
	if w.Code != 429 || w.Header().Get("Retry-After") == "" {
		t.Fatalf("认领没按手机号限流：%d %s", w.Code, w.Body.String())
	}
	clock = clock.Add(passwordPhoneWindow)
	storedWantError(t, s, 401, "invalid_credentials", func() *httptest.ResponseRecorder {
		return claimMember(t, s, "认领微信", "13900001111", "错密码")
	})
	for _, body := range []map[string]any{
		{"wechatLoginCode": "认领微信", "phone": "13900001111", "password": temporary},
		{"wechatLoginCode": "", "phone": "13900001111", "password": temporary, "privacyContractVersion": "v1"},
		{"wechatLoginCode": "认领微信", "phone": "不是手机号", "password": temporary, "privacyContractVersion": "v1"},
	} {
		storedWantError(t, s, 400, "invalid_request", func() *httptest.ResponseRecorder {
			return call(t, s, "POST", "/api/v2/auth/member-claims", "", "", body)
		})
	}
}

func TestMemberRegistrationRequiresClaimOfUnlinkedPhone(t *testing.T) {
	s := newTestServer(t)
	owner := ownerFixture(t, s)
	openMember(t, s, owner.AccessToken, "13900001111")
	web := webMember(t, s, owner.AccessToken, "13700002222", "member-web-secret")
	edit(t, s, func(q *txn) { q.user(web).Phone = "13700003333" })
	for _, phone := range []string{"139 0000-1111", "13700002222", "137-0000-3333"} {
		storedWantError(t, s, 409, "claim_required", func() *httptest.ResponseRecorder {
			return call(t, s, "POST", "/api/v2/accounts", "", "", map[string]any{"wechatLoginCode": "不另建微信", "nickname": "顾客", "phone": phone, "privacyContractVersion": "v1"})
		})
	}
}

// 复用阻塞微信桩，检查等微信时没有占用请求事务；期间密码被改过，认领必须拒绝。
func TestMemberClaimChecksPasswordAgainAfterWechat(t *testing.T) {
	s := newTestServer(t)
	owner := ownerFixture(t, s)
	account := openMember(t, s, owner.AccessToken, "13900001111")
	temporary := temporaryFor(t, s, owner.AccessToken, account)
	baseline := s.postgres.Pool().Stat().AcquiredConns()
	held := newHeldWechat()
	t.Cleanup(held.open)
	s.wechat = held
	result := make(chan *httptest.ResponseRecorder, 1)
	go func() { result <- claimMember(t, s, "阻塞微信", "13900001111", temporary) }()
	select {
	case <-held.entered:
	case <-time.After(3 * time.Second):
		t.Fatal("认领没到微信调用")
	}
	if s.postgres.Pool().Stat().AcquiredConns() != baseline {
		t.Fatalf("等待微信时仍占用数据库连接：%d", s.postgres.Pool().Stat().AcquiredConns())
	}
	temporaryFor(t, s, owner.AccessToken, account)
	held.open()
	select {
	case w := <-result:
		if w.Code != 401 || codeOf(t, w) != "invalid_credentials" {
			t.Fatalf("密码已变仍认领：%d %s", w.Code, w.Body.String())
		}
	case <-time.After(3 * time.Second):
		t.Fatal("微信返回后认领未完成")
	}
	if view(t, s, func(q *txn) bool { return q.accountHasWechat(account) }) {
		t.Fatal("失败认领绑定了微信")
	}
}

type unavailableClaimWechat struct{ *heldWechat }

func (unavailableClaimWechat) ExchangeLogin(context.Context, string) (string, error) {
	return "", errors.New("微信暂不可用")
}

func TestMemberClaimWechatAndPersistenceFailuresRollback(t *testing.T) {
	s := newTestServer(t)
	owner := ownerFixture(t, s)
	account := openMember(t, s, owner.AccessToken, "13900001111")
	temporary := temporaryFor(t, s, owner.AccessToken, account)
	s.wechat = unavailableClaimWechat{}
	storedWantError(t, s, 502, "wechat_unavailable", func() *httptest.ResponseRecorder { return claimMember(t, s, "认领微信", "13900001111", temporary) })
	s.wechat = nil
	restore := failWrites(t, s, "auth_sessions")
	storedWantError(t, s, 503, "persistence_failed", func() *httptest.ResponseRecorder { return claimMember(t, s, "认领微信", "13900001111", temporary) })
	restore()
	if w := claimMember(t, s, "认领微信", "13900001111", temporary); w.Code != 201 {
		t.Fatalf("失败后临时密码或微信被消耗：%d %s", w.Code, w.Body.String())
	}
}
