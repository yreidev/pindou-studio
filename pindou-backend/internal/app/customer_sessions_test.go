package app

import (
	"encoding/json"
	"net/http"
	"sort"
	"testing"
	"time"

	member "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/membership/application"
)

// 顾客自己的整桌计时（GET /venue-sessions/me）：员工从桌位开台、绑定了顾客账户的整桌会话，
// 顾客在「本次手作」页要看得到、叫得了店员（2026-10-06 业主用自己的账号开 A1 台时发现看不到）。

type wholeTableFixture struct {
	s     *Server
	now   *time.Time
	owner sessionResponse
	alice sessionResponse
	bob   sessionResponse
	a1    *Table
	a2    *Table
}

func newWholeTableFixture(t *testing.T) *wholeTableFixture {
	t.Helper()
	now := time.Date(2026, 10, 6, 14, 0, 0, 0, time.UTC)
	f := &wholeTableFixture{s: newTestServer(t), now: &now}
	f.s.now = func() time.Time { return *f.now }
	f.owner = register(t, f.s, "whole-owner", "老板")
	if err := f.s.BootstrapOwner(f.owner.User.ID); err != nil {
		t.Fatal(err)
	}
	enableBilling(t, f.s, f.owner.User.ID)
	f.alice = register(t, f.s, "whole-alice", "小林")
	f.bob = register(t, f.s, "whole-bob", "小周")
	f.a1 = seedTable(t, f.s, "A1", "A 区", 1, 1, false)
	f.a2 = seedTable(t, f.s, "A2", "A 区", 2, 1, false)
	return f
}

func (f *wholeTableFixture) later(d time.Duration) { *f.now = f.now.Add(d) }

// open 是员工在桌位开台；account 为空是散客。minutes 为 0 是自由计时。
func (f *wholeTableFixture) open(t *testing.T, table *Table, account string, minutes int) string {
	t.Helper()
	body := map[string]any{"serviceTableId": table.ID, "startedAt": f.now.Format(time.RFC3339), "timingMode": "free"}
	if minutes > 0 {
		body["timingMode"], body["durationMinutes"] = "timed", minutes
	}
	if account != "" {
		body["accountId"] = account
	}
	w := call(t, f.s, http.MethodPost, "/api/v2/venue-sessions", f.owner.AccessToken, "", body)
	if w.Code != http.StatusCreated {
		t.Fatalf("开台：%d %s", w.Code, w.Body.String())
	}
	return decodeMap(t, w)["id"].(string)
}

func (f *wholeTableFixture) patch(t *testing.T, session string, body map[string]any) {
	t.Helper()
	if w := call(t, f.s, http.MethodPatch, "/api/v2/venue-sessions/"+session, f.owner.AccessToken, "", body); w.Code != http.StatusOK {
		t.Fatalf("改会话 %v：%d %s", body, w.Code, w.Body.String())
	}
}

// mine 是顾客读自己的整桌计时。
func (f *wholeTableFixture) mine(t *testing.T, bearer string) []map[string]any {
	t.Helper()
	w := call(t, f.s, http.MethodGet, "/api/v2/venue-sessions/me", bearer, "", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("读本人整桌计时：%d %s", w.Code, w.Body.String())
	}
	return decodeList(t, w)
}

// tableView 是员工桌位接口（GET /service-tables）里这张桌的样子。
func (f *wholeTableFixture) tableView(t *testing.T, table *Table) map[string]any {
	t.Helper()
	w := call(t, f.s, http.MethodGet, "/api/v2/service-tables", f.owner.AccessToken, "", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("桌位接口：%d %s", w.Code, w.Body.String())
	}
	for _, v := range decodeList(t, w) {
		if v["id"] == table.ID {
			return v
		}
	}
	t.Fatalf("桌位接口里没有 %s", table.Code)
	return nil
}

// sameClock 核对顾客看到的结束时间、剩余与提醒档和桌位接口一致。
func sameClock(t *testing.T, mine, table map[string]any) {
	t.Helper()
	for _, key := range []string{"endsAt", "remainingSeconds", "timingStatus", "startedAt"} {
		if mine[key] != table[key] {
			t.Errorf("%s：顾客看到 %v，桌位接口 %v", key, mine[key], table[key])
		}
	}
}

func keysOf(v map[string]any) []string {
	out := make([]string, 0, len(v))
	for key := range v {
		out = append(out, key)
	}
	sort.Strings(out)
	return out
}

func TestCustomerReadsOnlyHerOwnWholeTableSessions(t *testing.T) {
	f := newWholeTableFixture(t)
	mine := f.open(t, f.a1, f.alice.User.ID, 60)
	f.open(t, f.a2, f.bob.User.ID, 0)
	f.open(t, seedTable(t, f.s, "A3", "A 区", 3, 1, false), "", 90) // 散客，谁的都不是

	// 扫码入座的顾客：按座会话在 /loyalty/me 的 admissions 里，这里不重复列
	carol := register(t, f.s, "whole-carol", "小陈")
	pack := publishRule(t, f.s, f.owner.AccessToken, member.Rule{Kind: "package", Name: "两小时", AmountCents: 5900, DurationMinutes: 120, PauseLimitMinutes: 30, Overtime: "manual"})
	b3 := seedTable(t, f.s, "B3", "B 区", 3, 2, false)
	request := loyaltyOK(t, f.s, carol.AccessToken, loyaltyInput{Action: "request", TargetID: pack.ID, TableID: b3.ID, SeatNumber: 2})
	loyaltyOK(t, f.s, f.owner.AccessToken, loyaltyInput{Action: "confirm", TargetID: request["id"].(string)})
	if got := f.mine(t, carol.AccessToken); len(got) != 0 {
		t.Fatalf("按座会话不该出现在整桌计时里：%v", got)
	}
	if w := call(t, f.s, http.MethodGet, "/api/v2/loyalty/me", carol.AccessToken, "", nil); w.Code != http.StatusOK || len(decodeMap(t, w)["admissions"].([]any)) != 1 {
		t.Fatalf("按座会话照旧在 admissions 里：%d %s", w.Code, w.Body.String())
	}

	f.later(10 * time.Minute)
	got := f.mine(t, f.alice.AccessToken)
	if len(got) != 1 || got[0]["id"] != mine {
		t.Fatalf("Alice 只看到自己的那一台：%v", got)
	}
	v := got[0]
	if v["serviceTableId"] != f.a1.ID || v["tableCode"] != "A1" || v["timingMode"] != "timed" || v["durationMinutes"] != float64(60) ||
		v["displayStatus"] != "running" || v["canCallStaff"] != true {
		t.Fatalf("桌、计时方式与状态：%v", v)
	}
	if v["elapsedSeconds"] != float64(600) || v["remainingSeconds"] != float64(3000) || v["overdueSeconds"] != float64(0) || v["timingStatus"] != "running" {
		t.Fatalf("开台 10 分钟：%v", v)
	}
	if v["startedAt"] != "2026-10-06T14:00:00Z" || v["endsAt"] != "2026-10-06T15:00:00Z" {
		t.Fatalf("开始与结束时间：%v", v)
	}
	sameClock(t, v, f.tableView(t, f.a1))
	// 不带金额估算、账户、员工这些：只有契约里写的这几项
	want := []string{"canCallStaff", "displayStatus", "durationMinutes", "elapsedSeconds", "endsAt", "id", "overdueSeconds", "remainingSeconds", "serviceTableId", "startedAt", "tableCode", "timingMode", "timingStatus"}
	if keys := keysOf(v); len(keys) != len(want) {
		t.Fatalf("字段：%v", keys)
	}

	// 自由计时没有结束时间：只给已用
	free := f.mine(t, f.bob.AccessToken)
	if len(free) != 1 || free[0]["tableCode"] != "A2" || free[0]["timingMode"] != "free" || free[0]["elapsedSeconds"] != float64(600) {
		t.Fatalf("Bob 的自由计时：%v", free)
	}
	for _, key := range []string{"durationMinutes", "endsAt", "remainingSeconds", "overdueSeconds", "timingStatus"} {
		if _, ok := free[0][key]; ok {
			t.Fatalf("自由计时不该有 %s：%v", key, free[0])
		}
	}

	// 没开台的人是空数组；没登录 401
	if got := f.mine(t, f.owner.AccessToken); len(got) != 0 {
		t.Fatalf("老板自己名下没有计时：%v", got)
	}
	if w := call(t, f.s, http.MethodGet, "/api/v2/venue-sessions/me", "", "", nil); w.Code != http.StatusUnauthorized {
		t.Fatalf("没登录：%d", w.Code)
	}
	// 字面路径不被 {id} 吃掉：员工照旧按编号读会话
	if w := call(t, f.s, http.MethodGet, "/api/v2/venue-sessions/"+mine, f.owner.AccessToken, "", nil); w.Code != http.StatusOK {
		t.Fatalf("员工按编号读会话：%d %s", w.Code, w.Body.String())
	}
}

func TestWholeTableClockMatchesTheTableView(t *testing.T) {
	f := newWholeTableFixture(t)
	session := f.open(t, f.a1, f.alice.User.ID, 60)
	now := func() map[string]any {
		t.Helper()
		got := f.mine(t, f.alice.AccessToken)
		if len(got) != 1 {
			t.Fatalf("应当有一台：%v", got)
		}
		sameClock(t, got[0], f.tableView(t, f.a1))
		return got[0]
	}

	// 剩余 5 分钟：快到点
	f.later(55 * time.Minute)
	if v := now(); v["timingStatus"] != "expiring" || v["remainingSeconds"] != float64(300) || v["elapsedSeconds"] != float64(3300) {
		t.Fatalf("快到点：%v", v)
	}

	// 暂停 10 分钟：时间不走，结束时间顺延；暂停中照样能叫店员
	f.patch(t, session, map[string]any{"status": "paused"})
	f.later(10 * time.Minute)
	v := now()
	if v["displayStatus"] != "paused" || v["remainingSeconds"] != float64(300) || v["elapsedSeconds"] != float64(3300) ||
		v["endsAt"] != "2026-10-06T15:10:00Z" || v["canCallStaff"] != true {
		t.Fatalf("暂停中：%v", v)
	}

	// 继续后再过 20 分钟：超时 15 分钟
	f.patch(t, session, map[string]any{"status": "active"})
	f.later(20 * time.Minute)
	if v := now(); v["displayStatus"] != "running" || v["timingStatus"] != "overdue" || v["remainingSeconds"] != float64(0) ||
		v["overdueSeconds"] != float64(900) || v["elapsedSeconds"] != float64(4500) {
		t.Fatalf("超时：%v", v)
	}

	// 员工续到 90 分钟：又回到计时中
	f.patch(t, session, map[string]any{"durationMinutes": 90})
	if v := now(); v["timingStatus"] != "running" || v["remainingSeconds"] != float64(900) || v["overdueSeconds"] != float64(0) || v["durationMinutes"] != float64(90) {
		t.Fatalf("续时后：%v", v)
	}

	// 改成陪客：照样列出，但不能叫店员（和 POST /service-calls 同一条规则）
	f.patch(t, session, map[string]any{"status": "companion"})
	if v := now(); v["displayStatus"] != "companion" || v["canCallStaff"] != false {
		t.Fatalf("陪客：%v", v)
	}
	w := call(t, f.s, http.MethodPost, "/api/v2/service-calls", f.alice.AccessToken, "", serviceCallInput{SessionID: session})
	if w.Code != http.StatusConflict || decodeMap(t, w)["code"] != "no_active_session" {
		t.Fatalf("陪客叫店员：%d %s", w.Code, w.Body.String())
	}
}

func TestCustomerCallsStaffForHerWholeTableSession(t *testing.T) {
	f := newWholeTableFixture(t)
	session := f.open(t, f.a1, f.alice.User.ID, 60)
	f.later(5 * time.Minute)

	// 别人不能替她叫
	if w := call(t, f.s, http.MethodPost, "/api/v2/service-calls", f.bob.AccessToken, "", serviceCallInput{SessionID: session}); w.Code != http.StatusConflict {
		t.Fatalf("别人的整桌会话：%d %s", w.Code, w.Body.String())
	}
	w := call(t, f.s, http.MethodPost, "/api/v2/service-calls", f.alice.AccessToken, "", serviceCallInput{SessionID: session})
	if w.Code != http.StatusCreated {
		t.Fatalf("整桌会话叫店员：%d %s", w.Code, w.Body.String())
	}
	created := decodeMap(t, w)
	if created["tableCode"] != "A1" || created["seatNumber"] != float64(0) || created["venueSessionId"] != session {
		t.Fatalf("整桌会话的呼叫：%v", created)
	}
	// 顾客页读到这条，员工列表里有，按整桌（座号 0）去找
	if mine := decodeList(t, call(t, f.s, http.MethodGet, "/api/v2/service-calls/me", f.alice.AccessToken, "", nil)); len(mine) != 1 || mine[0]["id"] != created["id"] {
		t.Fatalf("顾客读自己的呼叫：%v", mine)
	}
	open := decodeList(t, call(t, f.s, http.MethodGet, "/api/v2/service-calls?scope=open", f.owner.AccessToken, "", nil))
	if len(open) != 1 || open[0]["tableCode"] != "A1" || open[0]["seatNumber"] != float64(0) {
		t.Fatalf("员工看到的呼叫：%v", open)
	}
}

func TestWholeTableSessionLeavesTheListWhenItEnds(t *testing.T) {
	f := newWholeTableFixture(t)
	cancelled := f.open(t, f.a1, f.alice.User.ID, 60)
	f.later(time.Minute)
	settled := f.open(t, f.a2, f.alice.User.ID, 0)
	f.later(time.Minute)
	got := f.mine(t, f.alice.AccessToken)
	if len(got) != 2 || got[0]["id"] != cancelled || got[1]["id"] != settled {
		t.Fatalf("两台都在，先开的在前：%v", got)
	}

	// 员工撤销误开的台
	if w := call(t, f.s, http.MethodDelete, "/api/v2/venue-sessions/"+cancelled, f.owner.AccessToken, "", nil); w.Code != http.StatusNoContent {
		t.Fatalf("撤销：%d %s", w.Code, w.Body.String())
	}
	if got := f.mine(t, f.alice.AccessToken); len(got) != 1 || got[0]["id"] != settled {
		t.Fatalf("撤销的台不再列出：%v", got)
	}

	// 结账：建单、填价、收款后会话结算，不再列出
	w := call(t, f.s, http.MethodPost, "/api/v2/sales-orders", f.owner.AccessToken, id(), map[string]any{"venueSessionId": settled})
	if w.Code != http.StatusCreated {
		t.Fatalf("建单：%d %s", w.Code, w.Body.String())
	}
	order := decodeMap(t, w)
	w = call(t, f.s, http.MethodPatch, "/api/v2/sales-orders/"+order["id"].(string), f.owner.AccessToken, id(),
		map[string]any{"expectedVersion": order["version"], "lines": []map[string]any{{"name": "自由计时", "quantity": 1, "unitPriceCents": 1500}}})
	if w.Code != http.StatusOK {
		t.Fatalf("填价：%d %s", w.Code, w.Body.String())
	}
	order = decodeMap(t, w)
	w = call(t, f.s, http.MethodPost, "/api/v2/sales-orders/"+order["id"].(string)+"/payments", f.owner.AccessToken, id(),
		map[string]any{"expectedVersion": order["version"], "method": "cash", "amountCents": 1500})
	if w.Code != http.StatusOK && w.Code != http.StatusCreated {
		t.Fatalf("收款：%d %s", w.Code, w.Body.String())
	}
	if status := sessionOf(t, f.s, settled).Status; status != "settled" {
		t.Fatalf("收款后会话应已结算：%s", status)
	}
	if got := f.mine(t, f.alice.AccessToken); len(got) != 0 {
		t.Fatalf("结完账不再列出：%v", got)
	}
}

// 整桌会话的增改推给会话绑定的顾客本人，别的顾客收不到（归属按 venue_sessions.account_id 自动收集）。
func TestWholeTableSessionChangesArePushedToItsCustomer(t *testing.T) {
	f := newWholeTableFixture(t)
	alice := f.s.hub.subscribe(streamViewer{accountID: f.alice.User.ID})
	defer f.s.hub.unsubscribe(alice)
	bob := f.s.hub.subscribe(streamViewer{accountID: f.bob.User.ID})
	defer f.s.hub.unsubscribe(bob)
	// 只看计时会话的推送：准备步骤里注册顾客等也会推账户之类的变动，事件经 LISTEN/NOTIFY 异步送到，
	// 机器忙时会在订阅之后才到，不能当成这一步的推送（同 TestServiceCallsArePushedToStaffAndTheCaller）。
	sessionEvent := func(e event) bool {
		var payload map[string]string
		if err := json.Unmarshal(e.payload, &payload); err != nil {
			t.Fatalf("推送内容读不出来：%s", e.payload)
		}
		return payload["resource"] == "venue-sessions"
	}
	expect := func(step string) {
		t.Helper()
		deadline := time.After(5 * time.Second)
		for {
			select {
			case e := <-alice:
				if sessionEvent(e) {
					return
				}
			case <-deadline:
				t.Fatalf("%s：顾客没收到计时会话的推送", step)
			}
		}
	}

	session := f.open(t, f.a1, f.alice.User.ID, 60)
	expect("开台")
	f.patch(t, session, map[string]any{"status": "paused"})
	expect("暂停")
	f.patch(t, session, map[string]any{"serviceTableId": f.a2.ID})
	expect("换桌")
	if w := call(t, f.s, http.MethodDelete, "/api/v2/venue-sessions/"+session, f.owner.AccessToken, "", nil); w.Code != http.StatusNoContent {
		t.Fatalf("撤销：%d %s", w.Code, w.Body.String())
	}
	expect("撤销")
	quiet := time.After(300 * time.Millisecond)
	for {
		select {
		case e := <-bob:
			if sessionEvent(e) {
				t.Fatalf("别的顾客收到了 %s", e.payload)
			}
		case <-quiet:
			return
		}
	}
}
