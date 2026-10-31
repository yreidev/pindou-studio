package app

import (
	"testing"

	member "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/membership/application"
)

// 审计要记下动作作用在谁、哪条记录上，而不是一律记成操作者本人。
func TestLoyaltyAuditRecordsTheAffectedObject(t *testing.T) {
	s := newTestServer(t)
	owner := register(t, s, "loyalty-audit-owner", "Owner")
	if err := s.BootstrapOwner(owner.User.ID); err != nil {
		t.Fatal(err)
	}
	customer := register(t, s, "loyalty-audit-customer", "Customer")
	last := func() auditLog {
		t.Helper()
		return *lastAudit(t, s)
	}

	loyaltyOK(t, s, owner.AccessToken, loyaltyInput{Action: "adjust", AccountID: customer.User.ID, Reason: "补录积分", Points: 5})
	if a := last(); a.Action != "loyalty.adjust" || a.ActorID != owner.User.ID || a.ObjectID != customer.User.ID {
		t.Fatalf("staff adjustment should be recorded against the customer: %+v", a)
	}

	pack := publishRule(t, s, owner.AccessToken, member.Rule{Kind: "package", Name: "1小时", AmountCents: 2990, DurationMinutes: 60, Overtime: "manual"})
	if a := last(); a.Action != "loyalty.publish" || a.ObjectID != pack.ID {
		t.Fatalf("publishing should be recorded against the rule: %+v", a)
	}

	table := seedTable(t, s, "B1", "B", 1, 1, false)
	admission := loyaltyOK(t, s, customer.AccessToken, loyaltyInput{Action: "request", TargetID: pack.ID, TableID: table.ID, SeatNumber: 1})
	if a := last(); a.ActorID != customer.User.ID || a.ObjectID != admission["id"] {
		t.Fatalf("a seat request should be recorded against the admission it created: %+v", a)
	}
}

// 小程序「会员与计时」页以前把「会员」标签里选中的会员（accountId 和他的资产版本）合进所有动作：
// 先选了张三，再到「计时」标签确认李四的入座、给李四续时，审计记成「张三 loyalty.confirm / renew」。
// 计时类动作的对象是那次申请、那段计时的顾客，由后端按记录认定，不信请求里多带的 accountId。
func TestTimingActionsAuditTheSeatedCustomerNotTheSelectedMember(t *testing.T) {
	s := newTestServer(t)
	owner := register(t, s, "timing-audit-owner", "老板")
	if err := s.BootstrapOwner(owner.User.ID); err != nil {
		t.Fatal(err)
	}
	selected := register(t, s, "timing-audit-zhang", "张三")
	seated := register(t, s, "timing-audit-li", "李四")
	pack := publishRule(t, s, owner.AccessToken, member.Rule{Kind: "package", Name: "1小时", AmountCents: 2990, DurationMinutes: 60,
		RenewalMinutes: 30, RenewalCents: 1500, PauseLimitMinutes: 10, Overtime: "manual"})
	table := seedTable(t, s, "B1", "B", 1, 1, false)
	admission := loyaltyOK(t, s, seated.AccessToken, loyaltyInput{Action: "request", TargetID: pack.ID, TableID: table.ID, SeatNumber: 1})
	stray := accountVersionOf(t, s, selected.User.ID)
	check := func(action string) {
		t.Helper()
		if a := lastAudit(t, s); a.Action != "loyalty."+action || a.ObjectID != seated.User.ID {
			t.Fatalf("%s 应记在入座的顾客（李四）名下，而不是页面上选中的会员：%+v", action, a)
		}
	}
	loyaltyOK(t, s, owner.AccessToken, loyaltyInput{Action: "confirm", TargetID: admission["id"].(string), AccountID: selected.User.ID, ExpectedVersion: stray})
	check("confirm")
	sessionID := admissionOf(t, s, admission["id"].(string)).SessionID
	for _, action := range []string{"pause", "resume", "renew", "stop"} {
		version := member.Version(sessionOf(t, s, sessionID))
		loyaltyOK(t, s, owner.AccessToken, loyaltyInput{Action: action, TargetID: sessionID, AccountID: selected.User.ID, ExpectedVersion: version})
		check(action)
	}
}
