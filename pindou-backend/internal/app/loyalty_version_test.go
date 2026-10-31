package app

import (
	"net/http"
	"testing"

	member "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/membership/application"
)

// 一位顾客的操作不能让店员对另一位顾客的确认失效。以前版本覆盖整个会员状态，
// 任何人提交申请或领取福利，正在给别人充值的店员就收到「规则或资产已变化」。
func TestLoyaltyVersionIsScopedToTheAccount(t *testing.T) {
	s := newTestServer(t)
	owner := register(t, s, "loyalty-version-owner", "Owner")
	if err := s.BootstrapOwner(owner.User.ID); err != nil {
		t.Fatal(err)
	}
	alice := register(t, s, "loyalty-version-alice", "Alice")
	bob := register(t, s, "loyalty-version-bob", "Bob")
	recharge := publishRule(t, s, owner.AccessToken, member.Rule{Kind: "recharge", Name: "充值", AmountCents: 100})
	pack := publishRule(t, s, owner.AccessToken, member.Rule{Kind: "package", Name: "1小时", AmountCents: 2990, DurationMinutes: 60, Overtime: "manual"})
	table := seedTable(t, s, "B1", "B", 1, 1, false)

	// 店员打开了 Bob 的会员页和规则页。
	bobView := decodeMap(t, call(t, s, http.MethodGet, "/api/v2/loyalty/account?accountId="+bob.User.ID, owner.AccessToken, "", nil))
	rulesView := decodeMap(t, call(t, s, http.MethodGet, "/api/v2/loyalty/settings", owner.AccessToken, "", nil))

	// 这时 Alice 扫码提交了入座申请。
	loyaltyOK(t, s, alice.AccessToken, loyaltyInput{Action: "request", TargetID: pack.ID, TableID: table.ID, SeatNumber: 1})

	// 给 Bob 充值、保存规则草稿，仍按刚才读到的版本成功。
	loyaltyOK(t, s, owner.AccessToken, loyaltyInput{Action: "recharge", TargetID: recharge.ID, AccountID: bob.User.ID, Method: "cash", ExpectedVersion: bobView["version"].(string)})
	loyaltyOK(t, s, owner.AccessToken, loyaltyInput{Action: "save_rule", Rule: member.Rule{Kind: "recharge", Name: "新充值", AmountCents: 200}, ExpectedVersion: rulesView["version"].(string)})

	// Bob 自己的资产已经变了：再拿旧版本确认必须被拒。
	if r := loyaltyCall(t, s, owner.AccessToken, loyaltyInput{Action: "adjust", AccountID: bob.User.ID, Points: 1, Reason: "补录", ExpectedVersion: bobView["version"].(string)}); r.Code != http.StatusConflict {
		t.Fatalf("stale version for Bob's own assets accepted: %d %s", r.Code, r.Body.String())
	}
	// 草稿已经变了：旧的规则版本同样被拒。
	if r := loyaltyCall(t, s, owner.AccessToken, loyaltyInput{Action: "publish", TargetID: recharge.ID, Reason: "旧版本", ExpectedVersion: rulesView["version"].(string)}); r.Code != http.StatusConflict {
		t.Fatalf("stale rules version accepted: %d %s", r.Code, r.Body.String())
	}
}
