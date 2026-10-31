package app

import (
	"net/http"
	"testing"
	"time"

	member "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/membership/application"
)

// 申请过期是**时间到了自然发生**的，没有人去点它，所以 Status 会一直停在 pending。
//
// 2026-09-20 业主看到的就是这个：顾客端写着「等待员工确认，尚未开始计时」还给「取消申请」，
// 员工端还摆着「确认开台」，点下去才报「申请已过期」。更糟的是工作台那个「待确认开台 N」
// 会永远挂着一个下不去的数字 —— 一个永远在催、催的还是件做不了的事的提示。
//
// 所以过期必须在**读的时候**算出来并下发（displayStatus），和预约的 Display 同一套做法。
func TestExpiredAdmissionReadsAsExpiredEverywhere(t *testing.T) {
	now := time.Date(2026, 9, 20, 10, 0, 0, 0, time.UTC)
	s := newTestServer(t)
	s.now = func() time.Time { return now }
	owner := register(t, s, "adm-owner", "老板")
	if err := s.BootstrapOwner(owner.User.ID); err != nil {
		t.Fatal(err)
	}
	guest := register(t, s, "adm-guest", "顾客")
	pack := publishRule(t, s, owner.AccessToken, member.Rule{
		Kind: "package", Name: "1小时", AmountCents: 2990, DurationMinutes: 60, Overtime: "manual",
	})
	table := seedTable(t, s, "A1", "A", 1, 2, true)

	loyaltyOK(t, s, guest.AccessToken, loyaltyInput{
		Action: "request", TargetID: pack.ID, TableID: table.ID, SeatNumber: 1,
	})
	view := func(bearer, path string) map[string]any {
		t.Helper()
		return decodeMap(t, call(t, s, http.MethodGet, path, bearer, "", nil))
	}
	first := func(v map[string]any) map[string]any {
		t.Helper()
		list := v["admissions"].([]any)
		if len(list) != 1 {
			t.Fatalf("应当正好一条申请：%v", list)
		}
		return list[0].(map[string]any)
	}

	// 刚申请：员工端和顾客端都该看到「待确认」
	if got := first(view(owner.AccessToken, "/api/v2/loyalty/shift"))["displayStatus"]; got != "pending" {
		t.Fatalf("刚申请应当是 pending：%v", got)
	}
	if got := first(view(guest.AccessToken, "/api/v2/loyalty/me"))["displayStatus"]; got != "pending" {
		t.Fatalf("顾客端刚申请应当是 pending：%v", got)
	}

	// 过了 30 分钟窗口
	s.now = func() time.Time { return now.Add(member.AdmissionWindow + time.Minute) }

	staffEntry := first(view(owner.AccessToken, "/api/v2/loyalty/shift"))
	if staffEntry["displayStatus"] != "expired" {
		t.Fatalf("超时之后员工端必须看到 expired，否则「确认开台」是个点了就报错的按钮：%v", staffEntry["displayStatus"])
	}
	// ★ 底层 Status 仍是 pending —— 这正是为什么不能让前端去看它
	if staffEntry["admission"].(map[string]any)["status"] != "pending" {
		t.Fatal("前置条件变了：这条用例的意义就在于 Status 不会自己变")
	}
	if got := first(view(guest.AccessToken, "/api/v2/loyalty/me"))["displayStatus"]; got != "expired" {
		t.Fatalf("顾客端也必须看到 expired，不能还写着「等待员工确认」：%v", got)
	}

	// 确认仍然被拒（规则没变，只是现在提前就看得见了）
	r := loyaltyCall(t, s, owner.AccessToken, loyaltyInput{
		Action: "confirm", TargetID: staffEntry["admission"].(map[string]any)["id"].(string),
	})
	if r.Code == 200 {
		t.Fatal("过期的申请不该还能确认开台")
	}

	// 过期的申请也不能挡住顾客重新申请：以前按 Status 判断，报「你已有待确认或进行中的体验」。
	again := loyaltyCall(t, s, guest.AccessToken, loyaltyInput{
		Action: "request", TargetID: pack.ID, TableID: table.ID, SeatNumber: 1,
	})
	if again.Code != 200 {
		t.Fatalf("申请过期后顾客应当能重新申请：%d %s", again.Code, again.Body.String())
	}
}
