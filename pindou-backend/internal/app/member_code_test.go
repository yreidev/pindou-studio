package app

import (
	"net/http"
	"strings"
	"testing"
	"time"
)

// 会员码（membercode.go）：顾客给自己签发 90 秒有效的随机码，只有员工能凭码查人，查到的记审计。

// issueCode 让 bearer 给自己签发一个会员码，返回码和整个响应。
func issueCode(t *testing.T, s *Server, bearer string) (string, map[string]any) {
	t.Helper()
	w := call(t, s, http.MethodPost, "/api/v2/member-codes", bearer, "", nil)
	if w.Code != http.StatusCreated {
		t.Fatalf("issue member code: %d %s", w.Code, w.Body.String())
	}
	body := decodeMap(t, w)
	return body["code"].(string), body
}

func lookupCode(t *testing.T, s *Server, bearer, code string) (int, map[string]any) {
	t.Helper()
	w := call(t, s, http.MethodPost, "/api/v2/member-codes/lookups", bearer, "", map[string]any{"code": code})
	return w.Code, decodeMap(t, w)
}

func TestMemberCodeIdentifiesTheCustomerOnlyToStaff(t *testing.T) {
	s := newTestServer(t)
	owner := ownerFixture(t, s)
	alice := register(t, s, "member-code-alice", "Alice")
	bob := register(t, s, "member-code-bob", "Bob")

	code, issued := issueCode(t, s, alice.AccessToken)
	if !memberCodePattern.MatchString(code) || issued["validSeconds"] != float64(90) {
		t.Fatalf("issued %v", issued)
	}
	// 码里、响应里都没有账户编号和手机号；库里只有码的哈希
	raw := call(t, s, http.MethodPost, "/api/v2/member-codes", alice.AccessToken, "", nil).Body.String()
	if strings.Contains(raw, alice.User.ID) || strings.Contains(raw, "13800138000") {
		t.Fatalf("member code response leaks the account: %s", raw)
	}
	if n := view(t, s, func(q *txn) int {
		return scalar[int](q, `SELECT count(*) FROM member_codes WHERE token_hash = $1 AND account_id = $2`, identityKey(code), alice.User.ID)
	}); n != 1 {
		t.Fatalf("stored hash rows=%d", n)
	}
	if n := view(t, s, func(q *txn) int {
		return scalar[int](q, `SELECT count(*) FROM member_codes WHERE token_hash = $1`, code)
	}); n != 0 {
		t.Fatal("the plain code must not be stored")
	}

	audits := len(auditsOf(t, s))
	// 顾客查谁的码都不行，自己的也不行；什么都不记
	for name, bearer := range map[string]string{"bob": bob.AccessToken, "alice": alice.AccessToken} {
		if status, body := lookupCode(t, s, bearer, code); status != http.StatusForbidden {
			t.Fatalf("%s looked up a member code: %d %v", name, status, body)
		}
	}
	if len(auditsOf(t, s)) != audits {
		t.Fatal("a refused lookup wrote an audit")
	}

	// 员工查到 Alice：称呼、打码手机号、会员资产摘要；记审计
	status, found := lookupCode(t, s, owner.AccessToken, " "+code+"\n")
	if status != http.StatusOK || found["id"] != alice.User.ID || found["nickname"] != "Alice" || found["phoneMasked"] != "138****8000" {
		t.Fatalf("lookup: %d %v", status, found)
	}
	if balance := found["balance"].(map[string]any); balance["tierName"] != "普通会员" || balance["points"] != float64(0) {
		t.Fatalf("balance %v", balance)
	}
	if strings.Contains(call(t, s, http.MethodPost, "/api/v2/member-codes/lookups", owner.AccessToken, "", map[string]any{"code": code}).Body.String(), "13800138000") {
		t.Fatal("lookup leaks the full phone number")
	}
	last := lastAudit(t, s)
	if last.Action != "member_code.scanned" || last.ActorID != owner.User.ID || last.ObjectID != alice.User.ID {
		t.Fatalf("audit %+v", last)
	}

	// 有效期内可以反复查；再签发一个，旧码到期前照样能用
	second, _ := issueCode(t, s, alice.AccessToken)
	if second == code {
		t.Fatal("two member codes in a row are the same")
	}
	for _, c := range []string{code, second} {
		if status, body := lookupCode(t, s, owner.AccessToken, c); status != http.StatusOK || body["id"] != alice.User.ID {
			t.Fatalf("lookup %s: %d %v", c, status, body)
		}
	}
	// 没登录不能签发
	if w := call(t, s, http.MethodPost, "/api/v2/member-codes", "", "", nil); w.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous issue: %d", w.Code)
	}
}

func TestMemberCodeExpiresAndForgedCodesAreRejected(t *testing.T) {
	s := newTestServer(t)
	owner := ownerFixture(t, s)
	alice := register(t, s, "member-code-expiry", "Alice")
	start := time.Date(2026, 10, 6, 15, 0, 0, 0, time.UTC)
	clock := start
	s.now = func() time.Time { return clock }

	code, issued := issueCode(t, s, alice.AccessToken)
	if expires, _ := time.Parse(time.RFC3339, issued["expiresAt"].(string)); !expires.Equal(start.Add(90 * time.Second)) {
		t.Fatalf("expiresAt %v", issued["expiresAt"])
	}
	audits := len(auditsOf(t, s))

	clock = start.Add(89 * time.Second)
	if status, body := lookupCode(t, s, owner.AccessToken, code); status != http.StatusOK {
		t.Fatalf("just before expiry: %d %v", status, body)
	}
	audits++
	clock = start.Add(90 * time.Second)
	if status, body := lookupCode(t, s, owner.AccessToken, code); status != http.StatusGone || body["code"] != "member_code_expired" {
		t.Fatalf("expired: %d %v", status, body)
	}

	// 伪造、别的码、格式不对：一律「不是本店的会员码」
	for _, forged := range []string{
		"9" + strings.Repeat("1", 19), // 格式对，但没签发过
		"6901234567892",               // 商品条码
		"13800138000",                 // 手机号
		"8" + code[1:],                // 首位不对
		code + "0",                    // 多一位
		alice.User.ID,                 // 账户编号
		"pindou-web-login:" + id(),    // 别的二维码
	} {
		if status, body := lookupCode(t, s, owner.AccessToken, forged); status != http.StatusNotFound || body["code"] != "member_code_not_found" {
			t.Fatalf("forged %q: %d %v", forged, status, body)
		}
	}
	if status, body := lookupCode(t, s, owner.AccessToken, "  "); status != http.StatusBadRequest {
		t.Fatalf("blank code: %d %v", status, body)
	}
	if len(auditsOf(t, s)) != audits {
		t.Fatal("failed lookups must not be audited")
	}

	// 过期一小时以上的码在下次签发时清掉，之后只说「不是本店的会员码」
	clock = start.Add(90*time.Second + time.Hour + time.Second)
	issueCode(t, s, alice.AccessToken)
	if status, body := lookupCode(t, s, owner.AccessToken, code); status != http.StatusNotFound {
		t.Fatalf("purged code: %d %v", status, body)
	}
	if n := count(t, s, "member_codes"); n != 1 {
		t.Fatalf("member_codes rows after purge=%d", n)
	}
}

func TestIssuingMemberCodesIsRateLimitedPerAccount(t *testing.T) {
	s := newTestServer(t)
	alice := register(t, s, "member-code-limit-alice", "Alice")
	bob := register(t, s, "member-code-limit-bob", "Bob")
	for i := range memberCodeRateLimit {
		if w := call(t, s, http.MethodPost, "/api/v2/member-codes", alice.AccessToken, "", nil); w.Code != http.StatusCreated {
			t.Fatalf("issue %d: %d %s", i+1, w.Code, w.Body.String())
		}
	}
	w := call(t, s, http.MethodPost, "/api/v2/member-codes", alice.AccessToken, "", nil)
	if w.Code != http.StatusTooManyRequests || w.Header().Get("Retry-After") == "" {
		t.Fatalf("one more within the minute: %d %s", w.Code, w.Body.String())
	}
	// 按账户计：Bob 不受 Alice 的影响
	issueCode(t, s, bob.AccessToken)
}
