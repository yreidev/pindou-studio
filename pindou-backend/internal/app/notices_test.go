package app

import (
	"context"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	wechatapi "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/identity/infrastructure/wechat"
	member "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/membership/application"
)

// 顾客预约的微信订阅消息（2026-10-20，docs/plan-notify-and-share.md 第 3 节）。测试里没有真微信：登录码就是 openid，
// 发出去的消息记在 recordedNotices 里。

type recordedNotices struct {
	mu   sync.Mutex
	sent []wechatapi.SubscribeMessage
	fail error
}

func (r *recordedNotices) SendSubscribeMessage(_ context.Context, m wechatapi.SubscribeMessage) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.fail != nil {
		return r.fail
	}
	r.sent = append(r.sent, m)
	return nil
}

// take 等提交之后的发送做完，取走这期间发出去的消息。
func (r *recordedNotices) take(s *Server) []wechatapi.SubscribeMessage {
	s.background.Wait()
	r.mu.Lock()
	defer r.mu.Unlock()
	out := r.sent
	r.sent = nil
	return out
}

// noticeFixture 是开了顾客通知的预约夹具。
func noticeFixture(t *testing.T) (*reservationFixture, *recordedNotices) {
	t.Helper()
	f := newReservationFixture(t)
	if err := f.server.ConfigureNoticeKey([]byte("0123456789abcdef0123456789abcdef")); err != nil {
		t.Fatal(err)
	}
	sender := &recordedNotices{}
	f.server.notifier = sender
	keepSignedIn(t, f.server, &f.owner, &f.customer, &f.other)
	return f, sender
}

func subscribe(t *testing.T, s *Server, bearer, reservation, code string, kinds ...string) *httptest.ResponseRecorder {
	t.Helper()
	return call(t, s, "POST", "/api/v2/reservations/"+reservation+"/notices", bearer, "", map[string]any{"wechatLoginCode": code, "kinds": kinds})
}

// noticesIn 是顾客视图里这条预约已经允许过的种类。
func noticesIn(t *testing.T, view map[string]any, reservation string) []string {
	t.Helper()
	for _, entry := range view["reservations"].([]any) {
		e := entry.(map[string]any)
		if e["reservation"].(map[string]any)["id"] == reservation {
			return jsonStrings(t, e["notices"])
		}
	}
	t.Fatalf("预约 %s 不在视图里", reservation)
	return nil
}

// noticeStatuses 是库里这条预约每种通知的状态（失败的带上错误码）。
func noticeStatuses(t *testing.T, s *Server, reservation string) map[string]string {
	t.Helper()
	rows, err := s.postgres.Pool().Query(context.Background(), `SELECT kind, status || coalesce(':' || failure, '') FROM reservation_notices WHERE reservation_id = $1`, reservation)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var kind, status string
		if err := rows.Scan(&kind, &status); err != nil {
			t.Fatal(err)
		}
		out[kind] = status
	}
	return out
}

func sameStatuses(got, want map[string]string) bool {
	if len(got) != len(want) {
		return false
	}
	for k, v := range want {
		if got[k] != v {
			return false
		}
	}
	return true
}

// 允许订阅：登录码换出的微信必须是账户绑定的那个；openid 加密存下（库里没有明文）；视图里带模板和每条预约允许过的种类。
// 店员确认发「预约成功通知」，开始前 2 小时发「预约提醒通知」，各发一次；员工代客登记（已确认）的不用再记「预约成功」。
func TestReservationNoticesConfirmAndRemind(t *testing.T) {
	f, sender := noticeFixture(t)
	s := f.server
	booked := f.book(t, f.customer.AccessToken, 1)

	mine := decodeMap(t, call(t, s, "GET", "/api/v2/reservations/me", f.customer.AccessToken, "", nil))
	templates := mine["noticeTemplates"].([]any)
	if len(templates) != 3 || templates[0].(map[string]any)["kind"] != "confirmed" ||
		templates[0].(map[string]any)["templateId"] != wechatNoticeTemplates[noticeConfirmed].ID || templates[2].(map[string]any)["kind"] != "cancelled" {
		t.Fatalf("订阅用的模板：%v", templates)
	}
	if got := noticesIn(t, mine, booked); len(got) != 0 {
		t.Fatalf("还没允许过：%v", got)
	}

	for label, c := range map[string]struct {
		w      *httptest.ResponseRecorder
		status int
		code   string
	}{
		"别人的预约":    {subscribe(t, s, f.other.AccessToken, booked, "reservation-other", "reminder"), 404, "not_found"},
		"换了个微信":    {subscribe(t, s, f.customer.AccessToken, booked, "reservation-other", "reminder"), 403, "wechat_mismatch"},
		"种类不对":     {subscribe(t, s, f.customer.AccessToken, booked, "reservation-customer", "birthday"), 400, "invalid_request"},
		"种类重复":     {subscribe(t, s, f.customer.AccessToken, booked, "reservation-customer", "reminder", "reminder"), 400, "invalid_request"},
		"一种都没带":    {subscribe(t, s, f.customer.AccessToken, booked, "reservation-customer"), 400, "invalid_request"},
		"没登录":      {subscribe(t, s, "", booked, "reservation-customer", "reminder"), 401, "unauthorized"},
		"预约编号不对":   {subscribe(t, s, f.customer.AccessToken, "not-a-uuid", "reservation-customer", "reminder"), 404, "not_found"},
		"不存在的预约编号": {subscribe(t, s, f.customer.AccessToken, id(), "reservation-customer", "reminder"), 404, "not_found"},
	} {
		if c.w.Code != c.status || errorCodeOf(t, c.w) != c.code {
			t.Errorf("%s：%d %s", label, c.w.Code, c.w.Body.String())
		}
	}

	w := subscribe(t, s, f.customer.AccessToken, booked, "reservation-customer", "confirmed", "reminder", "cancelled")
	if w.Code != 200 {
		t.Fatalf("允许订阅：%d %s", w.Code, w.Body.String())
	}
	if got := noticesIn(t, decodeMap(t, w), booked); !slices.Equal(got, []string{"cancelled", "confirmed", "reminder"}) {
		t.Fatalf("允许过的种类：%v", got)
	}
	var sealed []byte
	if err := s.postgres.Pool().QueryRow(context.Background(), `SELECT openid_sealed FROM account_wechat_identities WHERE account_id = $1`, f.customer.User.ID).Scan(&sealed); err != nil {
		t.Fatal(err)
	}
	if len(sealed) == 0 || strings.Contains(string(sealed), "reservation-customer") {
		t.Fatal("openid 要加密存下，库里不能有明文")
	}
	// 再允许一次不重复记
	if w := subscribe(t, s, f.customer.AccessToken, booked, "reservation-customer", "reminder"); w.Code != 200 {
		t.Fatalf("再允许一次：%d", w.Code)
	}

	// 员工代客登记的是已确认的：「预约成功」那种不用再记
	registered := reservationOK(t, s, f.owner.AccessToken, reservationInput{Action: "register", AccountID: f.customer.User.ID, TableID: f.table, SeatNumber: 2, PackageID: f.pack,
		StartAt: time.Date(2026, 9, 14, 17, 0, 0, 0, cst).Format(time.RFC3339)})["targetId"].(string)
	w = subscribe(t, s, f.customer.AccessToken, registered, "reservation-customer", "confirmed", "reminder", "cancelled")
	if got := noticesIn(t, decodeMap(t, w), registered); !slices.Equal(got, []string{"cancelled", "reminder"}) {
		t.Fatalf("已确认的预约只记提醒和取消：%v", got)
	}

	reservationOK(t, s, f.owner.AccessToken, reservationInput{Action: "confirm", TargetID: booked})
	sent := sender.take(s)
	if len(sent) != 1 {
		t.Fatalf("确认后发一条：%+v", sent)
	}
	confirmed := sent[0]
	if confirmed.TemplateID != wechatNoticeTemplates[noticeConfirmed].ID || confirmed.ToUser != "reservation-customer" || confirmed.Page != "pages/customer/my-reservations/index" ||
		confirmed.State != "trial" || confirmed.Data["time14"] != "2026年09月14日 14:00" || confirmed.Data["thing4"] != "EXAMPLE 示例工坊" ||
		confirmed.Data["thing20"] != "H1 桌 1 号座" || confirmed.Data["thing2"] != "请在开始后30分钟内到店，逾期座位释放" {
		t.Fatalf("预约成功通知：%+v", confirmed)
	}
	if got := noticeStatuses(t, s, booked); !sameStatuses(got, map[string]string{"confirmed": "sent", "reminder": "pending", "cancelled": "pending"}) {
		t.Fatalf("确认之后：%v", got)
	}

	// 开始前 2 小时（默认）：11:59 还不到，12:00 发；发过的不再发
	clock := func(hour, minute int) {
		at := time.Date(2026, 9, 14, hour, minute, 0, 0, cst)
		s.now = func() time.Time { return at }
	}
	clock(11, 59)
	s.sendDueReminders(context.Background())
	if sent := sender.take(s); len(sent) != 0 {
		t.Fatalf("还没到提醒时间：%+v", sent)
	}
	clock(12, 0)
	s.sendDueReminders(context.Background())
	sent = sender.take(s)
	if len(sent) != 1 || sent[0].TemplateID != wechatNoticeTemplates[noticeReminder].ID || sent[0].Data["date7"] != "2026年09月14日 14:00" ||
		sent[0].Data["character_string25"] != "H1-1" || sent[0].Data["thing9"] != "记得准时到店，来不了请提前取消" {
		t.Fatalf("开始前提醒：%+v", sent)
	}
	s.sendDueReminders(context.Background())
	if sent := sender.take(s); len(sent) != 0 {
		t.Fatalf("提醒只发一次：%+v", sent)
	}
	// 代客登记的 17:00 那条到 15:00 才提醒
	clock(15, 0)
	s.sendDueReminders(context.Background())
	if sent := sender.take(s); len(sent) != 1 || sent[0].Data["character_string25"] != "H1-2" {
		t.Fatalf("17:00 那条的提醒：%+v", sent)
	}
	if got := noticeStatuses(t, s, booked); got["reminder"] != "sent" {
		t.Fatalf("提醒发出之后：%v", got)
	}
}

// 店员取消发「预约取消通知」（写了原因的带上原因），其余没发的作废；顾客自己取消什么都不发；
// 离开始不到提前时间才确认的不再提醒；微信不收的记下错误码、不重试；老板设成 0 小时就不提醒。
func TestReservationNoticesCancelLateConfirmAndFailures(t *testing.T) {
	f, sender := noticeFixture(t)
	s := f.server
	all := []string{"confirmed", "reminder", "cancelled"}

	byStaff := f.book(t, f.customer.AccessToken, 1)
	subscribe(t, s, f.customer.AccessToken, byStaff, "reservation-customer", all...)
	reservationOK(t, s, f.owner.AccessToken, reservationInput{Action: "cancel", TargetID: byStaff, Reason: "临时闭店"})
	sent := sender.take(s)
	if len(sent) != 1 || sent[0].TemplateID != wechatNoticeTemplates[noticeCancelled].ID || sent[0].Data["thing14"] != "临时闭店" ||
		sent[0].Data["time2"] != "2026年09月14日 14:00" || sent[0].Data["thing11"] != "H1 桌 1 号座" || sent[0].Data["thing16"] != "EXAMPLE 示例工坊" {
		t.Fatalf("预约取消通知：%+v", sent)
	}
	if got := noticeStatuses(t, s, byStaff); !sameStatuses(got, map[string]string{"confirmed": "void", "reminder": "void", "cancelled": "sent"}) {
		t.Fatalf("店员取消之后：%v", got)
	}
	if w := subscribe(t, s, f.customer.AccessToken, byStaff, "reservation-customer", "reminder"); w.Code != 409 || errorCodeOf(t, w) != "reservation_ended" {
		t.Fatalf("取消了的预约不能再开提醒：%d %s", w.Code, w.Body.String())
	}

	bySelf := f.book(t, f.customer.AccessToken, 2)
	subscribe(t, s, f.customer.AccessToken, bySelf, "reservation-customer", all...)
	reservationOK(t, s, f.customer.AccessToken, reservationInput{Action: "cancel", TargetID: bySelf})
	if sent := sender.take(s); len(sent) != 0 {
		t.Fatalf("顾客自己取消不发：%+v", sent)
	}
	if got := noticeStatuses(t, s, bySelf); !sameStatuses(got, map[string]string{"confirmed": "void", "reminder": "void", "cancelled": "void"}) {
		t.Fatalf("顾客自己取消之后：%v", got)
	}

	// 11:30 开始、10:00 确认：离开始只有一个半小时，不再提醒；微信这次不收（顾客关了通知）
	late := reservationOK(t, s, f.customer.AccessToken, reservationInput{Action: "book", TableID: f.table, SeatNumber: 1, PackageID: f.pack,
		StartAt: time.Date(2026, 9, 14, 11, 30, 0, 0, cst).Format(time.RFC3339)})["targetId"].(string)
	subscribe(t, s, f.customer.AccessToken, late, "reservation-customer", all...)
	sender.fail = &wechatapi.MessageRejected{Code: 43101, Message: "user refuse to accept the msg"}
	reservationOK(t, s, f.owner.AccessToken, reservationInput{Action: "confirm", TargetID: late})
	sender.take(s)
	s.sendDueReminders(context.Background())
	sender.take(s)
	if got := noticeStatuses(t, s, late); !sameStatuses(got, map[string]string{"confirmed": "failed:43101", "reminder": "pending", "cancelled": "pending"}) {
		t.Fatalf("确认晚了、微信不收：%v", got)
	}

	// 老板设成 0 小时：不提醒
	sender.fail = nil
	zero := 0
	settings := reservationSettingsOf(t, s)
	settings.RemindHours = &zero
	saveReservationSettings(t, f, settings)
	if got := reservationSettingsOf(t, s).ReminderHours(); got != 0 {
		t.Fatalf("提醒小时数：%d", got)
	}
	other := reservationOK(t, s, f.owner.AccessToken, reservationInput{Action: "register", AccountID: f.customer.User.ID, TableID: f.table, SeatNumber: 2, PackageID: f.pack,
		StartAt: time.Date(2026, 9, 14, 15, 0, 0, 0, cst).Format(time.RFC3339)})["targetId"].(string)
	subscribe(t, s, f.customer.AccessToken, other, "reservation-customer", all...)
	at := time.Date(2026, 9, 14, 14, 30, 0, 0, cst)
	s.now = func() time.Time { return at }
	s.sendDueReminders(context.Background())
	if sent := sender.take(s); len(sent) != 0 {
		t.Fatalf("设成 0 小时就不提醒：%+v", sent)
	}
	// 到店开台：没发的作废
	reservationOK(t, s, f.owner.AccessToken, reservationInput{Action: "seat", TargetID: other})
	if got := noticeStatuses(t, s, other); !sameStatuses(got, map[string]string{"reminder": "void", "cancelled": "void"}) {
		t.Fatalf("到店开台之后：%v", got)
	}
	bad := 25
	settings = reservationSettingsOf(t, s)
	settings.RemindHours = &bad
	w := reservationCall(t, s, f.owner.AccessToken, reservationInput{Action: "save_settings", Settings: &settings, ExpectedVersion: member.Version(reservationSettingsOf(t, s))})
	if w.Code != 400 {
		t.Fatalf("超过 24 小时拒收：%d %s", w.Code, w.Body.String())
	}
}

// 没配密钥：不给模板、不收订阅，店员确认照常（什么都不发）。
func TestReservationNoticesOffWithoutKey(t *testing.T) {
	f := newReservationFixture(t)
	s := f.server
	keepSignedIn(t, s, &f.owner, &f.customer)
	booked := f.book(t, f.customer.AccessToken, 1)
	mine := decodeMap(t, call(t, s, "GET", "/api/v2/reservations/me", f.customer.AccessToken, "", nil))
	if templates := mine["noticeTemplates"].([]any); len(templates) != 0 {
		t.Fatalf("没开时不给模板：%v", templates)
	}
	if w := subscribe(t, s, f.customer.AccessToken, booked, "reservation-customer", "reminder"); w.Code != 409 || errorCodeOf(t, w) != "notices_unavailable" {
		t.Fatalf("没开时不收订阅：%d %s", w.Code, w.Body.String())
	}
	reservationOK(t, s, f.owner.AccessToken, reservationInput{Action: "confirm", TargetID: booked})
	if got := noticeStatuses(t, s, booked); len(got) != 0 {
		t.Fatalf("没开时不记通知：%v", got)
	}
}

// 关键词按类型截短：事物 20 个字（末尾省略号），字符串只留字母数字符号，时间不截。
func TestFitKeyword(t *testing.T) {
	for _, c := range []struct{ keyword, in, want string }{
		{"thing14", "这次门店临时有事，抱歉取消了你的预约，欢迎改天再来", "这次门店临时有事，抱歉取消了你的预约，…"},
		{"thing2", "两行\n合成  一行", "两行 合成 一行"},
		{"character_string25", "H1 桌-2", "H1-2"},
		{"time14", "2026年09月14日 14:00", "2026年09月14日 14:00"},
		{"phrase3", "已经确认了", "已经确认了"},
	} {
		if got := fitKeyword(c.keyword, c.in); got != c.want {
			t.Errorf("%s %q → %q，应为 %q", c.keyword, c.in, got, c.want)
		}
	}
	if n := len([]rune(fitKeyword("thing1", strings.Repeat("长", 30)))); n != 20 {
		t.Fatalf("截到 20 个字：%d", n)
	}
}

// 换了副本、重启之后照样解得开（密钥一样）；密文挪到别的身份上解不开。
func TestSealedOpenIDIsBoundToItsIdentity(t *testing.T) {
	s := &Server{}
	if err := s.ConfigureNoticeKey([]byte("0123456789abcdef0123456789abcdef")); err != nil {
		t.Fatal(err)
	}
	sealed := s.sealOpenID("openid-1", "hash-a")
	other := &Server{}
	_ = other.ConfigureNoticeKey([]byte("0123456789abcdef0123456789abcdef"))
	if got, err := other.openOpenID(sealed, "hash-a"); err != nil || got != "openid-1" {
		t.Fatalf("同一个密钥：%q %v", got, err)
	}
	if _, err := other.openOpenID(sealed, "hash-b"); err == nil {
		t.Fatal("挪到别的身份上不能解开")
	}
	if err := s.ConfigureNoticeKey([]byte("short")); err == nil {
		t.Fatal("密钥必须 32 字节")
	}
}
