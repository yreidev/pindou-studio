package app

import (
	"encoding/json"
	"net/http"
	"strconv"
	"sync"
	"testing"
	"time"

	member "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/membership/application"
	calls "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/servicecalls/domain"
)

// 呼叫店员（docs/plan-live-board.md 第 2 节）：有进行中计时的顾客才能叫；一个会话同时一条未处理的；
// 店员处理后 1 分钟内不能再叫；没人处理的 30 分钟后显示为过期；处理记审计；新建、处理都推送。

type callFixture struct {
	s        *Server
	now      *time.Time
	owner    sessionResponse
	customer sessionResponse
	session  string
	table    *Table
}

// seatedCustomer 是一位扫码入座、员工确认开台后正在计时的顾客（B3 桌 2 号座）。
func seatedCustomer(t *testing.T) *callFixture {
	t.Helper()
	now := time.Date(2026, 10, 5, 14, 0, 0, 0, time.UTC)
	f := &callFixture{s: newTestServer(t), now: &now}
	f.s.now = func() time.Time { return *f.now }
	f.owner = register(t, f.s, "call-owner", "老板")
	if err := f.s.BootstrapOwner(f.owner.User.ID); err != nil {
		t.Fatal(err)
	}
	enableBilling(t, f.s, f.owner.User.ID) // 有的用例要看确认入座时建的草稿单
	f.customer = register(t, f.s, "call-customer", "小林")
	pack := publishRule(t, f.s, f.owner.AccessToken, member.Rule{Kind: "package", Name: "两小时", AmountCents: 5900, DurationMinutes: 120, PauseLimitMinutes: 30, Overtime: "manual"})
	f.table = seedTable(t, f.s, "B3", "B", 3, 2, false)
	request := loyaltyOK(t, f.s, f.customer.AccessToken, loyaltyInput{Action: "request", TargetID: pack.ID, TableID: f.table.ID, SeatNumber: 2})
	confirmed := loyaltyOK(t, f.s, f.owner.AccessToken, loyaltyInput{Action: "confirm", TargetID: request["id"].(string)})
	f.session = confirmed["venueSessionId"].(string)
	return f
}

func (f *callFixture) later(d time.Duration) { *f.now = f.now.Add(d) }

// ask 是顾客在本次手作页点「呼叫店员」。
func (f *callFixture) ask(t *testing.T, bearer, session string) (int, map[string]any) {
	t.Helper()
	w := call(t, f.s, http.MethodPost, "/api/v2/service-calls", bearer, "", serviceCallInput{SessionID: session})
	if w.Code >= 300 {
		return w.Code, map[string]any{"code": decodeMap(t, w)["code"], "retryAfter": w.Header().Get("Retry-After")}
	}
	return w.Code, decodeMap(t, w)
}

func (f *callFixture) mine(t *testing.T, bearer string) []map[string]any {
	t.Helper()
	return f.list(t, "/api/v2/service-calls/me", bearer)
}

func (f *callFixture) open(t *testing.T, bearer string) []map[string]any {
	t.Helper()
	return f.list(t, "/api/v2/service-calls?scope=open", bearer)
}

func (f *callFixture) list(t *testing.T, path, bearer string) []map[string]any {
	t.Helper()
	w := call(t, f.s, http.MethodGet, path, bearer, "", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("%s：%d %s", path, w.Code, w.Body.String())
	}
	return decodeList(t, w)
}

func (f *callFixture) handle(t *testing.T, bearer, callID string) (int, map[string]any) {
	t.Helper()
	w := call(t, f.s, http.MethodPost, "/api/v2/service-calls/"+callID+"/handle", bearer, "", nil)
	if w.Code != http.StatusOK {
		return w.Code, nil
	}
	return w.Code, decodeMap(t, w)
}

// claim 是店员点「我去处理」；成功、失败都回读到的内容（失败时是 code、message）。
func (f *callFixture) claim(t *testing.T, bearer, callID string) (int, map[string]any) {
	t.Helper()
	w := call(t, f.s, http.MethodPost, "/api/v2/service-calls/"+callID+"/claim", bearer, "", nil)
	return w.Code, decodeMap(t, w)
}

// clerk 是一位新任命的店员。
func (f *callFixture) clerk(t *testing.T, name, nickname string) sessionResponse {
	t.Helper()
	c := register(t, f.s, name, nickname)
	setRoles(t, f.s, c.User.ID, Clerk)
	return c
}

func TestOnlyACustomerWithLiveTimingCanCallStaff(t *testing.T) {
	f := seatedCustomer(t)
	stranger := register(t, f.s, "call-stranger", "路人")

	// 没有计时：不能叫，也什么都没写
	if code, body := f.ask(t, stranger.AccessToken, f.session); code != http.StatusConflict || body["code"] != "no_active_session" {
		t.Fatalf("别人的会话不能叫：%d %v", code, body)
	}
	if code, body := f.ask(t, stranger.AccessToken, id()); code != http.StatusConflict || body["code"] != "no_active_session" {
		t.Fatalf("不存在的会话不能叫：%d %v", code, body)
	}
	if code, _ := f.ask(t, "", f.session); code != http.StatusUnauthorized {
		t.Fatalf("没登录不能叫：%d", code)
	}
	if w := call(t, f.s, http.MethodPost, "/api/v2/service-calls", f.customer.AccessToken, "", map[string]any{}); w.Code != http.StatusBadRequest {
		t.Fatalf("没指明会话应当 400：%d %s", w.Code, w.Body.String())
	}
	if n := count(t, f.s, "service_calls"); n != 0 {
		t.Fatalf("被拒的呼叫写进了 %d 条", n)
	}

	// 暂停中也能叫
	sess := sessionOf(t, f.s, f.session)
	loyaltyOK(t, f.s, f.owner.AccessToken, loyaltyInput{Action: "pause", TargetID: f.session, ExpectedVersion: member.Version(sess)})
	if code, body := f.ask(t, f.customer.AccessToken, f.session); code != http.StatusCreated || body["displayStatus"] != "pending" {
		t.Fatalf("暂停中应当能叫：%d %v", code, body)
	}

	// 结账走了（会话已结束）：不能再叫，员工列表与顾客页也不再列它
	edit(t, f.s, func(q *txn) { q.session(f.session).Status = "settled" })
	if code, body := f.ask(t, f.customer.AccessToken, f.session); code != http.StatusConflict || body["code"] != "no_active_session" {
		t.Fatalf("会话结束后不能叫：%d %v", code, body)
	}
	if got := f.open(t, f.owner.AccessToken); len(got) != 0 {
		t.Fatalf("顾客走了的呼叫不该再催店员：%v", got)
	}
	if got := f.mine(t, f.customer.AccessToken); len(got) != 0 {
		t.Fatalf("顾客页只列进行中的会话：%v", got)
	}
}

func TestOneOpenCallPerSessionAndStaffSeeWhereToGo(t *testing.T) {
	f := seatedCustomer(t)
	code, first := f.ask(t, f.customer.AccessToken, f.session)
	if code != http.StatusCreated {
		t.Fatalf("呼叫：%d %v", code, first)
	}
	if first["tableCode"] != "B3" || first["seatNumber"] != float64(2) || first["status"] != "pending" || first["handledAt"] != nil || first["cooldownSeconds"] != float64(0) {
		t.Fatalf("呼叫要说清在哪张桌、哪个座：%v", first)
	}
	if _, ok := first["customer"]; ok {
		t.Fatal("顾客自己看的不带称呼")
	}

	// 再叫：原样返回那一条，不新建
	f.later(2 * time.Minute)
	if code, again := f.ask(t, f.customer.AccessToken, f.session); code != http.StatusOK || again["id"] != first["id"] {
		t.Fatalf("还没处理时再叫应当返回原来那条：%d %v", code, again)
	}
	if n := count(t, f.s, "service_calls"); n != 1 {
		t.Fatalf("重复呼叫建了 %d 条", n)
	}

	// 员工看到：哪张桌、几号座、谁、什么时候叫的
	list := f.open(t, f.owner.AccessToken)
	if len(list) != 1 || list[0]["id"] != first["id"] || list[0]["tableCode"] != "B3" || list[0]["seatNumber"] != float64(2) {
		t.Fatalf("员工列表：%v", list)
	}
	if customer, _ := list[0]["customer"].(map[string]any); customer["nickname"] != "小林" || customer["phoneMasked"] != "138****8000" {
		t.Fatalf("员工要看到顾客称呼（打码手机号）：%v", list[0]["customer"])
	}
	if list[0]["handledBy"] != nil {
		t.Fatalf("没处理的 handledBy 为 null：%v", list[0]["handledBy"])
	}

	// 顾客换了座：员工按新位置去找
	sess := sessionOf(t, f.s, f.session)
	loyaltyOK(t, f.s, f.owner.AccessToken, loyaltyInput{Action: "move", TargetID: f.session, TableID: f.table.ID, SeatNumber: 1, ExpectedVersion: member.Version(sess)})
	if list := f.open(t, f.owner.AccessToken); len(list) != 1 || list[0]["seatNumber"] != float64(1) {
		t.Fatalf("换座后应当显示新座号：%v", list)
	}
}

func TestConcurrentCallsLeaveOneOpenCall(t *testing.T) {
	f := seatedCustomer(t)
	var wg sync.WaitGroup
	codes := make(chan int, 6)
	for range 6 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			w := call(t, f.s, http.MethodPost, "/api/v2/service-calls", f.customer.AccessToken, "", serviceCallInput{SessionID: f.session})
			codes <- w.Code
		}()
	}
	wg.Wait()
	close(codes)
	created := 0
	for code := range codes {
		switch code {
		case http.StatusCreated:
			created++
		case http.StatusOK:
		default:
			t.Fatalf("同时呼叫回了 %d", code)
		}
	}
	if created != 1 || count(t, f.s, "service_calls") != 1 {
		t.Fatalf("同时叫 6 次应当只建 1 条：建了 %d，库里 %d", created, count(t, f.s, "service_calls"))
	}
}

func TestHandledCallIsAuditedAndCoolsDownForAMinute(t *testing.T) {
	f := seatedCustomer(t)
	clerk := register(t, f.s, "call-clerk", "店员小周")
	setRoles(t, f.s, clerk.User.ID, Clerk)
	_, first := f.ask(t, f.customer.AccessToken, f.session)
	callID := first["id"].(string)

	// 顾客不能替店员点已处理，也看不了全店的呼叫
	if code, _ := f.handle(t, f.customer.AccessToken, callID); code != http.StatusForbidden {
		t.Fatalf("顾客点已处理：%d", code)
	}
	if w := call(t, f.s, http.MethodGet, "/api/v2/service-calls?scope=open", f.customer.AccessToken, "", nil); w.Code != http.StatusForbidden {
		t.Fatalf("顾客读全店呼叫：%d", w.Code)
	}
	if w := call(t, f.s, http.MethodGet, "/api/v2/service-calls", f.owner.AccessToken, "", nil); w.Code != http.StatusBadRequest {
		t.Fatalf("不带 scope 应当 400：%d", w.Code)
	}
	if code, _ := f.handle(t, clerk.AccessToken, id()); code != http.StatusNotFound {
		t.Fatalf("不存在的呼叫：%d", code)
	}

	audits := len(auditsOf(t, f.s))
	f.later(3 * time.Minute)
	code, handled := f.handle(t, clerk.AccessToken, callID)
	if code != http.StatusOK || handled["displayStatus"] != "handled" || handled["handledAt"] == nil {
		t.Fatalf("店员处理：%d %v", code, handled)
	}
	if by, _ := handled["handledBy"].(map[string]any); by["nickname"] != "店员小周" {
		t.Fatalf("要记下谁处理的：%v", handled["handledBy"])
	}
	all := auditsOf(t, f.s)
	if len(all) != audits+1 || all[len(all)-1].Action != "service_call.handled" || all[len(all)-1].ActorID != clerk.User.ID || all[len(all)-1].ObjectID != callID {
		t.Fatalf("处理要记审计（谁、哪条）：%+v", all[len(all)-1])
	}
	// 店长再点一次：原样返回，处理人不变，不重复记审计
	if code, again := f.handle(t, f.owner.AccessToken, callID); code != http.StatusOK || again["handledBy"].(map[string]any)["nickname"] != "店员小周" {
		t.Fatalf("再点已处理：%d %v", code, again)
	}
	if n := len(auditsOf(t, f.s)); n != audits+1 {
		t.Fatalf("再点不该重复记审计：%d 条", n-audits)
	}
	if list := f.open(t, f.owner.AccessToken); len(list) != 0 {
		t.Fatalf("处理过的不在待处理列表里：%v", list)
	}

	// 顾客看到已处理，1 分钟内不能再叫
	f.later(20 * time.Second)
	mine := f.mine(t, f.customer.AccessToken)
	if len(mine) != 1 || mine[0]["displayStatus"] != "handled" || mine[0]["cooldownSeconds"] != float64(40) {
		t.Fatalf("顾客页：%v", mine)
	}
	if _, ok := mine[0]["handledBy"]; ok {
		t.Fatal("顾客看的不带处理人的称呼")
	}
	code, body := f.ask(t, f.customer.AccessToken, f.session)
	if code != http.StatusTooManyRequests || body["code"] != "service_call_cooldown" || body["retryAfter"] != "40" {
		t.Fatalf("冷却中再叫：%d %v", code, body)
	}
	if n := count(t, f.s, "service_calls"); n != 1 {
		t.Fatalf("冷却中被拒的呼叫写进了库：%d", n)
	}
	f.later(40 * time.Second)
	if code, again := f.ask(t, f.customer.AccessToken, f.session); code != http.StatusCreated || again["id"] == callID {
		t.Fatalf("满 1 分钟应当能再叫：%d %v", code, again)
	}
}

func TestUnansweredCallExpiresAfterHalfAnHour(t *testing.T) {
	f := seatedCustomer(t)
	_, first := f.ask(t, f.customer.AccessToken, f.session)
	f.later(calls.Window - time.Second)
	if list := f.open(t, f.owner.AccessToken); len(list) != 1 {
		t.Fatalf("29 分 59 秒时还在等：%v", list)
	}
	f.later(time.Second)
	if list := f.open(t, f.owner.AccessToken); len(list) != 0 {
		t.Fatalf("满 30 分钟没人处理，员工列表不再挂着它：%v", list)
	}
	mine := f.mine(t, f.customer.AccessToken)
	if len(mine) != 1 || mine[0]["displayStatus"] != "expired" || mine[0]["status"] != "pending" {
		t.Fatalf("顾客页显示已过期，已存状态不变：%v", mine)
	}
	// 过期的不挡顾客再叫
	code, again := f.ask(t, f.customer.AccessToken, f.session)
	if code != http.StatusCreated || again["id"] == first["id"] {
		t.Fatalf("过期后应当能再叫：%d %v", code, again)
	}
	if mine := f.mine(t, f.customer.AccessToken); len(mine) != 1 || mine[0]["id"] != again["id"] {
		t.Fatalf("顾客页只看最近的一条：%v", mine)
	}
	// 店员事后补点过期的那条也行
	if code, handled := f.handle(t, f.owner.AccessToken, first["id"].(string)); code != http.StatusOK || handled["displayStatus"] != "handled" {
		t.Fatalf("处理过期的呼叫：%d %v", code, handled)
	}
}

func TestServiceCallsArePushedToStaffAndTheCaller(t *testing.T) {
	f := seatedCustomer(t)
	other := register(t, f.s, "call-other", "另一位顾客")
	staff := f.s.hub.subscribe(streamViewer{accountID: f.owner.User.ID, staff: true})
	defer f.s.hub.unsubscribe(staff)
	caller := f.s.hub.subscribe(streamViewer{accountID: f.customer.User.ID})
	defer f.s.hub.unsubscribe(caller)
	bystander := f.s.hub.subscribe(streamViewer{accountID: other.User.ID})
	defer f.s.hub.unsubscribe(bystander)
	// 只看「呼叫店员」的推送：前面注册顾客、入座等准备步骤也会推账户之类的变动，事件是异步送到的，
	// 机器忙时会在订阅之后才到（2026-10-06 全量检查里员工先收到了 accounts 的变动，误判失败）。
	serviceCall := func(e event) bool {
		var payload map[string]string
		if err := json.Unmarshal(e.payload, &payload); err != nil {
			t.Fatalf("推送内容读不出来：%s", e.payload)
		}
		return payload["resource"] == "service-calls"
	}
	expect := func(who string, ch chan event) {
		t.Helper()
		deadline := time.After(5 * time.Second)
		for {
			select {
			case e := <-ch:
				if serviceCall(e) {
					return
				}
			case <-deadline:
				t.Fatalf("%s 没收到呼叫店员的推送", who)
			}
		}
	}
	quiet := func(ch chan event) {
		t.Helper()
		deadline := time.After(300 * time.Millisecond)
		for {
			select {
			case e := <-ch:
				if serviceCall(e) {
					t.Fatalf("别的顾客收到了 %s", e.payload)
				}
			case <-deadline:
				return
			}
		}
	}

	_, created := f.ask(t, f.customer.AccessToken, f.session)
	expect("员工（新呼叫）", staff)
	expect("叫的顾客（新呼叫）", caller)
	// 有人点了「我去处理」：别的员工那里马上停振停响，顾客页马上显示谁在过来
	if code, body := f.claim(t, f.owner.AccessToken, created["id"].(string)); code != http.StatusOK {
		t.Fatalf("认领：%d %v", code, body)
	}
	expect("员工（我去处理）", staff)
	expect("叫的顾客（我去处理）", caller)
	f.handle(t, f.owner.AccessToken, created["id"].(string))
	expect("员工（已处理）", staff)
	expect("叫的顾客（已处理）", caller)
	quiet(bystander)
}

func TestCallingStaffIsRateLimitedPerAccount(t *testing.T) {
	f := seatedCustomer(t)
	for i := range serviceCallRateLimit {
		if code, body := f.ask(t, f.customer.AccessToken, f.session); code >= 300 {
			t.Fatalf("第 %d 次就被拦了：%d %v", i+1, code, body)
		}
	}
	code, body := f.ask(t, f.customer.AccessToken, f.session)
	if code != http.StatusTooManyRequests || body["code"] != "rate_limited" {
		t.Fatalf("一分钟内第 %d 次应当被限流：%d %v", serviceCallRateLimit+1, code, body)
	}
	if seconds, err := strconv.Atoi(body["retryAfter"].(string)); err != nil || seconds < 1 || seconds > 61 {
		t.Fatalf("Retry-After=%v", body["retryAfter"])
	}
	// 按账户计：别人不受影响（这位没有计时，照常走到规则判断）
	stranger := register(t, f.s, "call-limit-other", "另一位")
	if code, body := f.ask(t, stranger.AccessToken, f.session); code != http.StatusConflict {
		t.Fatalf("别的账户不该被这位的预算拦住：%d %v", code, body)
	}
	if n := count(t, f.s, "service_calls"); n != 1 {
		t.Fatalf("一直只有一条呼叫：%d", n)
	}
}

// 「我去处理」：谁先认领算谁；别人那里显示认领人；同一人重复点无害；顾客页看到谁在过来（只有昵称）。
func TestFirstStaffToClaimACallWinsAndEveryoneSeesWhoIsComing(t *testing.T) {
	f := seatedCustomer(t)
	zhou := f.clerk(t, "claim-zhou", "小周")
	_, created := f.ask(t, f.customer.AccessToken, f.session)
	callID := created["id"].(string)
	if created["claimStatus"] != "none" || created["claimedAt"] != nil {
		t.Fatalf("新呼叫没人认领：%v", created)
	}
	if list := f.open(t, f.owner.AccessToken); list[0]["claimStatus"] != "none" || list[0]["claimedBy"] != nil {
		t.Fatalf("没人认领时员工列表：%v", list[0])
	}

	// 顾客认领不了；不存在的呼叫 404
	if code, _ := f.claim(t, f.customer.AccessToken, callID); code != http.StatusForbidden {
		t.Fatalf("顾客点我去处理：%d", code)
	}
	if code, body := f.claim(t, zhou.AccessToken, id()); code != http.StatusNotFound || body["code"] != "not_found" {
		t.Fatalf("不存在的呼叫：%d %v", code, body)
	}

	audits := len(auditsOf(t, f.s))
	f.later(time.Minute)
	code, claimed := f.claim(t, zhou.AccessToken, callID)
	if code != http.StatusOK || claimed["claimStatus"] != "claimed" || claimed["displayStatus"] != "pending" || claimed["status"] != "pending" {
		t.Fatalf("小周认领：%d %v", code, claimed)
	}
	if by, _ := claimed["claimedBy"].(map[string]any); by["nickname"] != "小周" || by["id"] != zhou.User.ID {
		t.Fatalf("要记下谁认领的：%v", claimed["claimedBy"])
	}
	claimedAt := claimed["claimedAt"]
	if at, err := time.Parse(time.RFC3339Nano, claimedAt.(string)); err != nil || !at.Equal(*f.now) {
		t.Fatalf("要记下何时认领的：%v", claimedAt)
	}
	all := auditsOf(t, f.s)
	if len(all) != audits+1 || all[len(all)-1].Action != "service_call.claimed" || all[len(all)-1].ActorID != zhou.User.ID || all[len(all)-1].ObjectID != callID {
		t.Fatalf("认领要记审计（谁、哪条）：%+v", all[len(all)-1])
	}

	// 别的员工看到「小周 正在处理」：还挂在未处理列表里（等人点已处理），带认领人
	list := f.open(t, f.owner.AccessToken)
	if len(list) != 1 || list[0]["claimStatus"] != "claimed" || list[0]["claimedBy"].(map[string]any)["nickname"] != "小周" {
		t.Fatalf("认领后员工列表：%v", list)
	}
	// 顾客只知道有店员在过来（claimed），不知道是哪位：不带任何员工的称呼（2026-10-06 业主定）
	mine := f.mine(t, f.customer.AccessToken)
	if len(mine) != 1 || mine[0]["claimStatus"] != "claimed" {
		t.Fatalf("顾客页：%v", mine)
	}
	for _, field := range []string{"claimedBy", "claimedByName", "handledBy"} {
		if _, ok := mine[0][field]; ok {
			t.Fatalf("顾客看的不带任何员工的称呼，却有 %s：%v", field, mine[0])
		}
	}

	// 小周再点：原样返回，认领时间不变，不重复记审计
	f.later(2 * time.Minute)
	if code, again := f.claim(t, zhou.AccessToken, callID); code != http.StatusOK || again["claimedAt"] != claimedAt {
		t.Fatalf("同一人重复认领：%d %v", code, again)
	}
	// 老板再点：小周已在处理，什么都不改
	code, body := f.claim(t, f.owner.AccessToken, callID)
	if code != http.StatusConflict || body["code"] != "service_call_claimed" || body["message"] != "小周 已在处理" {
		t.Fatalf("别人认领着再点：%d %v", code, body)
	}
	if list := f.open(t, f.owner.AccessToken); list[0]["claimedBy"].(map[string]any)["nickname"] != "小周" {
		t.Fatalf("先认领的算数：%v", list[0])
	}
	if n := len(auditsOf(t, f.s)); n != audits+1 {
		t.Fatalf("重复认领、被拒的认领不该记审计：%d 条", n-audits)
	}
}

func TestConcurrentClaimsLeaveExactlyOneClaimer(t *testing.T) {
	f := seatedCustomer(t)
	_, created := f.ask(t, f.customer.AccessToken, f.session)
	callID := created["id"].(string)
	staff := make([]sessionResponse, 6)
	for i := range staff {
		staff[i] = f.clerk(t, "claim-race-"+strconv.Itoa(i), "店员"+strconv.Itoa(i))
	}
	audits := len(auditsOf(t, f.s))
	type result struct {
		who  string
		code int
		body map[string]any
	}
	results := make(chan result, len(staff))
	var wg sync.WaitGroup
	for _, s := range staff {
		wg.Add(1)
		go func() {
			defer wg.Done()
			w := call(t, f.s, http.MethodPost, "/api/v2/service-calls/"+callID+"/claim", s.AccessToken, "", nil)
			var body map[string]any
			_ = json.Unmarshal(w.Body.Bytes(), &body)
			results <- result{who: s.User.ID, code: w.Code, body: body}
		}()
	}
	wg.Wait()
	close(results)
	winner := ""
	for r := range results {
		switch {
		case r.code == http.StatusOK:
			if winner != "" {
				t.Fatalf("同时认领应当只有一人成功：%s 和 %s", winner, r.who)
			}
			winner = r.who
		case r.code == http.StatusConflict && r.body["code"] == "service_call_claimed":
		default:
			t.Fatalf("同时认领回了 %d %v", r.code, r.body)
		}
	}
	if winner == "" {
		t.Fatal("同时认领没有一个成功")
	}
	list := f.open(t, f.owner.AccessToken)
	if by := list[0]["claimedBy"].(map[string]any); by["id"] != winner {
		t.Fatalf("库里的认领人应当是成功的那位：%v，成功的是 %s", by, winner)
	}
	if n := len(auditsOf(t, f.s)); n != audits+1 {
		t.Fatalf("同时认领只该记 1 条审计：%d", n-audits)
	}
}

func TestClaimedCallIsStillHandledByAnyoneAndThenClosed(t *testing.T) {
	f := seatedCustomer(t)
	zhou := f.clerk(t, "claim-handle-zhou", "小周")
	_, created := f.ask(t, f.customer.AccessToken, f.session)
	callID := created["id"].(string)
	if code, _ := f.claim(t, zhou.AccessToken, callID); code != http.StatusOK {
		t.Fatalf("认领：%d", code)
	}
	// 小周认领了，老板路过先处理了：处理人记老板，认领人照旧是小周
	f.later(time.Minute)
	code, handled := f.handle(t, f.owner.AccessToken, callID)
	if code != http.StatusOK || handled["displayStatus"] != "handled" || handled["handledBy"].(map[string]any)["nickname"] != "老板" || handled["claimedBy"].(map[string]any)["nickname"] != "小周" {
		t.Fatalf("认领后别人处理：%d %v", code, handled)
	}
	if list := f.open(t, f.owner.AccessToken); len(list) != 0 {
		t.Fatalf("处理了就不再列出：%v", list)
	}
	// 顾客页显示已处理，不再写谁在过来
	if mine := f.mine(t, f.customer.AccessToken); mine[0]["displayStatus"] != "handled" {
		t.Fatalf("处理后的顾客页：%v", mine)
	}
	// 处理过的不用再去：认领被拒，说清谁处理的
	code, body := f.claim(t, zhou.AccessToken, callID)
	if code != http.StatusConflict || body["code"] != "service_call_closed" || body["message"] != "这条呼叫已经由 老板 处理了" {
		t.Fatalf("认领已处理的：%d %v", code, body)
	}
}

func TestClaimLapsesAfterTenMinutesAndAnyoneCanTakeOver(t *testing.T) {
	f := seatedCustomer(t)
	zhou := f.clerk(t, "claim-lapse-zhou", "小周")
	_, created := f.ask(t, f.customer.AccessToken, f.session)
	callID := created["id"].(string)
	f.claim(t, zhou.AccessToken, callID)

	f.later(calls.ClaimHold - time.Second)
	if list := f.open(t, f.owner.AccessToken); list[0]["claimStatus"] != "claimed" {
		t.Fatalf("不到 10 分钟还认领着：%v", list[0])
	}
	// 满 10 分钟还没处理：认领失效，员工端重新提醒；顾客页不再写谁在过来
	f.later(time.Second)
	list := f.open(t, f.owner.AccessToken)
	if len(list) != 1 || list[0]["claimStatus"] != "lapsed" || list[0]["claimedBy"].(map[string]any)["nickname"] != "小周" {
		t.Fatalf("认领满 10 分钟：%v", list)
	}
	if mine := f.mine(t, f.customer.AccessToken); mine[0]["claimStatus"] != "lapsed" || mine[0]["displayStatus"] != "pending" {
		t.Fatalf("认领失效后的顾客页：%v", mine)
	}
	// 老板接手：从现在重新计时，记审计
	audits := len(auditsOf(t, f.s))
	code, taken := f.claim(t, f.owner.AccessToken, callID)
	if code != http.StatusOK || taken["claimStatus"] != "claimed" || taken["claimedBy"].(map[string]any)["nickname"] != "老板" {
		t.Fatalf("认领失效后别人接手：%d %v", code, taken)
	}
	if all := auditsOf(t, f.s); len(all) != audits+1 || all[len(all)-1].Action != "service_call.claimed" || all[len(all)-1].ActorID != f.owner.User.ID {
		t.Fatalf("接手也记审计：%d 条", len(all)-audits)
	}
	if code, body := f.claim(t, zhou.AccessToken, callID); code != http.StatusConflict || body["message"] != "老板 已在处理" {
		t.Fatalf("老板接手后小周再点：%d %v", code, body)
	}
}

func TestExpiredOrLeftCallCannotBeClaimed(t *testing.T) {
	f := seatedCustomer(t)
	_, created := f.ask(t, f.customer.AccessToken, f.session)
	callID := created["id"].(string)
	f.later(calls.Window)
	code, body := f.claim(t, f.owner.AccessToken, callID)
	if code != http.StatusConflict || body["code"] != "service_call_closed" {
		t.Fatalf("过期的呼叫不用再去：%d %v", code, body)
	}
	if stored := view(t, f.s, func(q *txn) bool { return q.serviceCall(callID).ClaimedAt != nil }); stored {
		t.Fatal("被拒的认领不该写进库")
	}

	// 顾客再叫一次，随后结账走了：不用再去
	_, again := f.ask(t, f.customer.AccessToken, f.session)
	edit(t, f.s, func(q *txn) { q.session(f.session).Status = "settled" })
	code, body = f.claim(t, f.owner.AccessToken, again["id"].(string))
	if code != http.StatusConflict || body["code"] != "service_call_closed" || body["message"] != "顾客已经结账离开，不用再去了" {
		t.Fatalf("顾客走了的呼叫不用再去：%d %v", code, body)
	}
}
