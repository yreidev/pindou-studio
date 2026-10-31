package app

import (
	"encoding/json"
	"testing"
)

func switchMode(t *testing.T, s *Server, previous sessionResponse, mode string) sessionResponse {
	t.Helper()
	w := call(t, s, "POST", "/api/v2/auth/developer-sessions", previous.AccessToken, "", map[string]string{"mode": mode})
	if w.Code != 201 {
		t.Fatalf("switch %s: status=%d", mode, w.Code)
	}
	var next sessionResponse
	if err := json.Unmarshal(w.Body.Bytes(), &next); err != nil {
		t.Fatal(err)
	}
	if next.User.ID != previous.User.ID || next.User.DeveloperMode != mode || next.AccessToken == previous.AccessToken {
		t.Fatal("invalid switched session")
	}
	if got := call(t, s, "GET", "/api/v2/accounts/"+previous.User.ID, previous.AccessToken, "", nil).Code; got != 401 {
		t.Fatalf("old session remains valid: %d", got)
	}
	return next
}

// 开发者白名单本身不给权限：体验身份只能降不能升（不高于真实任命），没选（developer）时按真实任命；
// 撤销任命、移出白名单都立即生效。每次切换留一条审计，不改任命，也不影响同一账号的其他设备。
func TestDeveloperModesEnforceEffectivePermissions(t *testing.T) {
	s := newTestServer(t)
	dev := register(t, s, "developer", "Developer")
	owner := register(t, s, "shop-owner", "Owner")
	if err := s.BootstrapOwner(owner.User.ID); err != nil {
		t.Fatal(err)
	}
	for _, user := range []sessionResponse{dev, owner} {
		if got := call(t, s, "POST", "/api/v2/auth/developer-sessions", user.AccessToken, "", map[string]string{"mode": "owner"}).Code; got != 403 {
			t.Fatalf("unprovisioned switch: %d", got)
		}
	}
	if err := s.ConfigureDeveloperAccounts(dev.User.ID); err != nil {
		t.Fatal(err)
	}
	otherLogin := call(t, s, "POST", "/api/v2/auth/wechat-sessions", "", "", map[string]string{"wechatLoginCode": "developer"})
	var otherDevice sessionResponse
	if err := json.Unmarshal(otherLogin.Body.Bytes(), &otherDevice); err != nil {
		t.Fatal(err)
	}
	if otherLogin.Code != 201 || otherDevice.User.DeveloperMode != "developer" || len(otherDevice.User.Roles) != 0 {
		t.Fatal("developer login without an assignment should have no employee privileges")
	}
	// 没有任命：员工身份一个都切不过去
	for _, mode := range []string{"clerk", "manager", "owner"} {
		if got := call(t, s, "POST", "/api/v2/auth/developer-sessions", dev.AccessToken, "", map[string]string{"mode": mode}).Code; got != 403 {
			t.Fatalf("没有任命却能切到 %s: %d", mode, got)
		}
	}
	// 老板任命开发者为店长：能降成店员，不能升成老板
	if w := call(t, s, "POST", "/api/v2/staff-role-assignments", owner.AccessToken, id(), map[string]string{"accountId": dev.User.ID, "role": "manager"}); w.Code != 201 {
		t.Fatalf("assign manager: %d %s", w.Code, w.Body.String())
	}
	if got := call(t, s, "POST", "/api/v2/auth/developer-sessions", dev.AccessToken, "", map[string]string{"mode": "owner"}).Code; got != 403 {
		t.Fatalf("店长体验成了老板: %d", got)
	}
	for _, c := range []struct {
		mode          string
		role          Role
		audit, export int
	}{
		{"clerk", Clerk, 403, 403},
		{"manager", Manager, 200, 403},
		{"customer", "", 403, 403},
		{"guest", "", 401, 401},
		{"developer", Manager, 200, 403},
	} {
		dev = switchMode(t, s, dev, c.mode)
		if c.role == "" && len(dev.User.Roles) != 0 || c.role != "" && (len(dev.User.Roles) != 1 || dev.User.Roles[0] != c.role) {
			t.Fatalf("%s 的有效角色 %v", c.mode, dev.User.Roles)
		}
		if c.mode != "guest" {
			if self := call(t, s, "GET", "/api/v2/accounts/"+dev.User.ID, dev.AccessToken, "", nil); self.Code != 200 || decodeMap(t, self)["developerMode"] != c.mode {
				t.Fatal("self refresh lost selected mode")
			}
		}
		if got := call(t, s, "GET", "/api/v2/system/audit-events", dev.AccessToken, "", nil).Code; got != c.audit {
			t.Fatalf("%s audit access: %d want %d", c.mode, got, c.audit)
		}
		if got := call(t, s, "POST", "/api/v2/system/data-exports", dev.AccessToken, "", nil).Code; got != c.export {
			t.Fatalf("%s export access: %d want %d", c.mode, got, c.export)
		}
	}
	switched := 0
	for _, a := range auditsOf(t, s) {
		if a.Action == "developer.mode_switched" {
			switched++
		}
	}
	if switched != 5 || len(userOf(t, s, dev.User.ID).Roles) != 1 || userOf(t, s, dev.User.ID).Roles[0] != Manager {
		t.Fatalf("每次切换一条审计、不改任命：审计 %d 条，任命 %v", switched, userOf(t, s, dev.User.ID).Roles)
	}
	// 只影响这台设备：另一台还是真实任命（店长）
	dev = switchMode(t, s, dev, "clerk")
	if got := call(t, s, "GET", "/api/v2/system/audit-events", otherDevice.AccessToken, "", nil).Code; got != 200 {
		t.Fatalf("switch affected another device: %d", got)
	}
	if got := call(t, s, "POST", "/api/v2/auth/developer-sessions", dev.AccessToken, "", map[string]string{"mode": "invalid"}).Code; got != 400 {
		t.Fatalf("invalid mode accepted: %d", got)
	}
	if got := call(t, s, "GET", "/api/v2/accounts/"+dev.User.ID, dev.AccessToken, "", nil).Code; got != 200 {
		t.Fatal("failed switch invalidated old session")
	}
	// 撤销任命立即生效：体验身份（店员）高于真实任命（无）时按顾客看
	setRoles(t, s, dev.User.ID)
	if got := call(t, s, "GET", "/api/v2/sales-orders", dev.AccessToken, "", nil).Code; got != 403 {
		t.Fatalf("撤销任命后体验身份仍有员工权限: %d", got)
	}
	// 移出白名单：按真实任命
	setRoles(t, s, dev.User.ID, Manager)
	if err := s.ConfigureDeveloperAccounts(""); err != nil {
		t.Fatal(err)
	}
	if got := call(t, s, "POST", "/api/v2/system/data-exports", dev.AccessToken, "", nil).Code; got != 403 {
		t.Fatal("developer removal retained elevated access")
	}
	if got := call(t, s, "GET", "/api/v2/system/audit-events", dev.AccessToken, "", nil).Code; got != 200 {
		t.Fatal("移出白名单后应按真实任命（店长）")
	}
}

func TestDeveloperWritesAndAuditPersistWithoutChangingAssignments(t *testing.T) {
	db := newTestDatabase(t)
	s := serverOn(t, db)
	dev := register(t, s, "developer-persistent", "Developer")
	// 体验身份不能高于真实任命：先让开发者成为老板，再降成店员体验
	if err := s.BootstrapOwner(dev.User.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.ConfigureDeveloperAccounts(dev.User.ID); err != nil {
		t.Fatal(err)
	}
	dev = switchMode(t, s, dev, "clerk")
	w := call(t, s, "POST", "/api/v2/sales-orders", dev.AccessToken, "developer-order", map[string]any{})
	if w.Code != 201 {
		t.Fatalf("real clerk write: %d", w.Code)
	}
	orderID := decodeMap(t, w)["id"].(string)
	restarted := serverOn(t, db)
	if roles := userOf(t, restarted, dev.User.ID).Roles; orderOf(t, restarted, orderID) == nil || len(roles) != 1 || roles[0] != Owner {
		t.Fatal("real write or role isolation was not preserved")
	}
	switchAudit := false
	for _, a := range auditsOf(t, restarted) {
		switchAudit = switchAudit || a.Action == "developer.mode_switched" && a.ActorID == dev.User.ID
	}
	if !switchAudit {
		t.Fatal("missing durable developer audit")
	}
	// 会话落库：重启后切换出来的令牌仍然有效，体验身份也跟着保留。
	if err := restarted.ConfigureDeveloperAccounts(dev.User.ID); err != nil {
		t.Fatal(err)
	}
	if self := call(t, restarted, "GET", "/api/v2/accounts/"+dev.User.ID, dev.AccessToken, "", nil); self.Code != 200 || decodeMap(t, self)["developerMode"] != "clerk" {
		t.Fatalf("switched developer session after restart: %d %s", self.Code, self.Body.String())
	}
	auditCount := len(auditsOf(t, s))
	restore := failWrites(t, s, "auth_sessions")
	if got := call(t, s, "POST", "/api/v2/auth/developer-sessions", dev.AccessToken, "", map[string]string{"mode": "owner"}).Code; got != 503 {
		t.Fatalf("expected persistence failure: %d", got)
	}
	restore()
	self := call(t, s, "GET", "/api/v2/accounts/"+dev.User.ID, dev.AccessToken, "", nil)
	if self.Code != 200 || decodeMap(t, self)["developerMode"] != "clerk" || len(auditsOf(t, s)) != auditCount {
		t.Fatal("failed save lost old session or retained switched audit")
	}
}
