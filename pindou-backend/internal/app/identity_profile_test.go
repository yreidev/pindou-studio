package app

import (
	"context"
	"net/http"
	"testing"
)

// 改手机号原先是条死胡同：编辑资料只能手输，写进去一律 unverified，
// 「未验证」这个标签永远摘不掉。微信授权换号补上之后，这几条边界不能塌。
func TestProfilePhoneUpdateVerificationAndBoundaries(t *testing.T) {
	s := newTestServer(t)
	me := register(t, s, "wx-me", "本人")
	other := register(t, s, "wx-other", "别人")
	path := "/api/v2/accounts/" + me.User.ID

	// 手动填号：能改，但没人核过，仍是 unverified
	w := call(t, s, http.MethodPatch, path, me.AccessToken, "", map[string]any{"phone": "13900139000"})
	got := decodeMap(t, w)
	if w.Code != 200 || got["phoneVerificationStatus"] != "unverified" {
		t.Fatalf("manual phone: %d %s", w.Code, w.Body.String())
	}
	if got["phoneMasked"] != "139****9000" {
		t.Fatalf("manual phone not saved: %v", got["phoneMasked"])
	}

	// 微信授权换号：状态转为 verified
	w = call(t, s, http.MethodPatch, path, me.AccessToken, "", map[string]any{"phoneCode": "wx-phone-code"})
	if got = decodeMap(t, w); w.Code != 200 || got["phoneVerificationStatus"] != "verified" {
		t.Fatalf("wechat phone: %d %s", w.Code, w.Body.String())
	}

	// 两个都给：说不清该信哪个，拒绝（和注册的 validRegistration 同规则）
	if code := call(t, s, http.MethodPatch, path, me.AccessToken, "", map[string]any{"phone": "13700137000", "phoneCode": "c"}).Code; code != 400 {
		t.Fatalf("phone and phoneCode together status=%d", code)
	}

	// 代改他人不能走微信授权：那张 code 是本人微信给的，换出来的号会写到别人账上
	owner := register(t, s, "wx-owner", "老板")
	setRoles(t, s, owner.User.ID, Owner)
	if code := call(t, s, http.MethodPatch, "/api/v2/accounts/"+other.User.ID, owner.AccessToken, "", map[string]any{"phoneCode": "c"}).Code; code != 403 {
		t.Fatalf("owner using someone else's phone code status=%d", code)
	}
	// 但代改昵称仍然可以
	if code := call(t, s, http.MethodPatch, "/api/v2/accounts/"+other.User.ID, owner.AccessToken, "", map[string]any{"nickname": "改过的"}).Code; code != 200 {
		t.Fatalf("owner renaming status=%d", code)
	}

	// 已验证的号再手输一个：退回 unverified，不能靠改号把验证状态带过去
	if got := decodeMap(t, call(t, s, http.MethodPatch, path, me.AccessToken, "", map[string]any{"phone": "13600136000"})); got["phoneVerificationStatus"] != "unverified" {
		t.Fatalf("manual phone after verification kept the badge: %v", got)
	}
}

// 店长不能管理老板：可以代改顾客、店员的资料，不能改老板的；老板可以改店长的。
func TestManagerCannotEditAnOwnersProfile(t *testing.T) {
	s := newTestServer(t)
	owner := register(t, s, "profile-owner", "老板")
	if err := s.BootstrapOwner(owner.User.ID); err != nil {
		t.Fatal(err)
	}
	manager := register(t, s, "profile-manager", "店长")
	setRoles(t, s, manager.User.ID, Manager)
	customer := register(t, s, "profile-customer", "顾客")

	if w := call(t, s, "PATCH", "/api/v2/accounts/"+owner.User.ID, manager.AccessToken, "", map[string]any{"nickname": "被改了"}); w.Code != 403 {
		t.Fatalf("店长改了老板的资料: %d %s", w.Code, w.Body.String())
	}
	if userOf(t, s, owner.User.ID).Nickname != "老板" {
		t.Fatal("owner nickname changed")
	}
	if w := call(t, s, "PATCH", "/api/v2/accounts/"+customer.User.ID, manager.AccessToken, "", map[string]any{"nickname": "顾客甲"}); w.Code != 200 {
		t.Fatalf("店长代改顾客资料: %d %s", w.Code, w.Body.String())
	}
	if w := call(t, s, "PATCH", "/api/v2/accounts/"+manager.User.ID, owner.AccessToken, "", map[string]any{"nickname": "店长乙"}); w.Code != 200 {
		t.Fatalf("老板改店长资料: %d %s", w.Code, w.Body.String())
	}
}

// 首位老板的受控初始化：只在还没有老板时生效；已有老板时不动；账号已有别的任命时报错，不悄悄跳过。
func TestBootstrapFirstOwnerOnlyWhenThereIsNone(t *testing.T) {
	s := newTestServer(t)
	first := register(t, s, "bootstrap-first", "首位老板")
	second := register(t, s, "bootstrap-second", "第二人")
	done, err := s.BootstrapFirstOwner(context.Background(), first.User.ID)
	if err != nil || !done || !hasRole(userOf(t, s, first.User.ID), Owner) {
		t.Fatalf("first owner: done=%v err=%v", done, err)
	}
	if done, err := s.BootstrapFirstOwner(context.Background(), second.User.ID); err != nil || done || hasRole(userOf(t, s, second.User.ID), Owner) {
		t.Fatalf("an owner exists, bootstrap must be a no-op: done=%v err=%v", done, err)
	}

	other := newTestServer(t)
	clerk := register(t, other, "bootstrap-clerk", "店员")
	edit(t, other, func(q *txn) {
		q.addRole(&roleAssignment{ID: id(), UserID: clerk.User.ID, Role: Clerk, AssignedAt: other.now()})
		q.user(clerk.User.ID).Roles = []Role{Clerk}
	})
	if done, err := other.BootstrapFirstOwner(context.Background(), clerk.User.ID); err == nil || done {
		t.Fatalf("an account with another assignment must not be silently skipped: done=%v err=%v", done, err)
	}
}
