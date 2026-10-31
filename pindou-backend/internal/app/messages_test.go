package app

import (
	"encoding/json"
	"reflect"
	"testing"
	"time"

	member "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/membership/application"
	"github.com/yreidev/pindou-studio/pindou-backend/internal/storetime"
)

// 经过 call，同时核对 MessageFeed 的成功响应契约。
func messagesOf(t *testing.T, s *Server, bearer, query string) messageFeed {
	t.Helper()
	w := call(t, s, "GET", "/api/v2/messages/me"+query, bearer, "", nil)
	if w.Code != 200 {
		t.Fatalf("读取消息失败：%d %s", w.Code, w.Body.String())
	}
	var feed messageFeed
	if err := json.Unmarshal(w.Body.Bytes(), &feed); err != nil {
		t.Fatal(err)
	}
	return feed
}

// 不带幂等键，核对 204 成功响应契约与空正文。
func readMessages(t *testing.T, s *Server, bearer string) {
	t.Helper()
	w := call(t, s, "POST", "/api/v2/messages/me/reads", bearer, "", nil)
	if w.Code != 204 || w.Body.Len() != 0 {
		t.Fatalf("记已读失败：%d %s", w.Code, w.Body.String())
	}
}

func TestMessagesLoyaltyPayloadLimitAndIsolation(t *testing.T) {
	s := newTestServer(t)
	now := time.Date(2026, 10, 27, 10, 0, 0, 0, storetime.Location)
	s.now = func() time.Time { return now }
	customer := register(t, s, "消息顾客", "顾客")
	staff := ownerFixture(t, s)
	kinds := []string{"recharge", "tier", "adjust", "recharge_refund", "exchange", "birthday", "fulfill_gift", "checkout", "earned", "refund", "birthday_used", "consume", "consume_reverse"}
	edit(t, s, func(q *txn) {
		m := q.memberAccount(customer.User.ID)
		for i := range 205 {
			e := member.Entry{ID: id(), AccountID: customer.User.ID, Kind: kinds[i%len(kinds)], CreatedAt: now.Add(-time.Duration(i/2) * time.Second), Reason: "消息夹具"}
			if i == 0 {
				e.PrincipalCents, e.BoardUses, e.Method = 10000, 2, "wechat"
				e.BalanceAfter = &member.BalanceAfter{PrincipalCents: 10000, BoardUses: 2}
			}
			if i == 11 {
				e.PrincipalCents, e.BoardUses, e.ServiceDate = -7990, -1, "2026-01-01"
				e.Consumption = &member.Consumption{PackageName: "其他", Headcount: 1, DayType: "workday", AmountCents: 7990}
				e.BalanceAfter = &member.BalanceAfter{PrincipalCents: 2010, BoardUses: 1}
			}
			m.Entries[e.ID] = e
		}
		e := member.Entry{ID: id(), AccountID: staff.User.ID, Kind: "adjust", CreatedAt: now}
		q.memberAccount(staff.User.ID).Entries[e.ID] = e
	})
	w := call(t, s, "GET", "/api/v2/loyalty/me", customer.AccessToken, "", nil)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	var loyalty struct{ Entries []member.Entry }
	if err := json.Unmarshal(w.Body.Bytes(), &loyalty); err != nil {
		t.Fatal(err)
	}
	want := map[string]member.Entry{}
	for _, e := range loyalty.Entries {
		want[e.ID] = e
	}
	feed := messagesOf(t, s, customer.AccessToken, "")
	if len(feed.Items) != 200 || feed.UnreadCount != 205 {
		t.Fatalf("默认限额和未读总数：%d %d", len(feed.Items), feed.UnreadCount)
	}
	seenKinds := map[string]bool{}
	for i, item := range feed.Items {
		if item.Kind != "loyalty" || item.Entry == nil || item.Reservation != nil || !item.Unread || item.ID != "entry:"+item.Entry.ID || !item.At.Equal(item.Entry.CreatedAt) {
			t.Fatalf("会员消息格式不对：%+v", item)
		}
		if !reflect.DeepEqual(*item.Entry, want[item.Entry.ID]) {
			t.Fatalf("流水与 /loyalty/me 不同：%+v / %+v", *item.Entry, want[item.Entry.ID])
		}
		seenKinds[item.Entry.Kind] = true
		if i > 0 {
			previous := feed.Items[i-1]
			if previous.At.Before(item.At) || (previous.At.Equal(item.At) && previous.ID < item.ID) {
				t.Fatal("消息没有按时刻倒序、同刻按编号稳定排序")
			}
		}
	}
	if len(seenKinds) != len(kinds) {
		t.Fatalf("漏了会员流水种类：%v", seenKinds)
	}
	if top := messagesOf(t, s, customer.AccessToken, "?limit=1"); len(top.Items) != 1 || top.UnreadCount != 205 || top.Items[0].ID != feed.Items[0].ID {
		t.Fatalf("limit 不应影响未读总数：%+v", top)
	}
	if got := messagesOf(t, s, customer.AccessToken, "?limit=200"); !reflect.DeepEqual(got, feed) {
		t.Fatal("显式 limit=200 应与默认相同")
	}
	if got := messagesOf(t, s, staff.AccessToken, ""); len(got.Items) != 1 || got.UnreadCount != 1 || got.Items[0].Entry.AccountID != staff.User.ID {
		t.Fatalf("员工身份读到了其他账户的消息：%+v", got)
	}
	if count(t, s, "message_reads") != 0 {
		t.Fatal("GET 不应标已读")
	}
	for _, query := range []string{"?limit=0", "?limit=201", "?limit=-1", "?limit=", "?limit=1.5", "?limit=x", "?limit=1&limit=2"} {
		w := call(t, s, "GET", "/api/v2/messages/me"+query, customer.AccessToken, "", nil)
		if w.Code != 400 || codeOf(t, w) != "invalid_request" {
			t.Errorf("%s 应拒绝：%d %s", query, w.Code, w.Body.String())
		}
	}
}

func TestMessagesWindowReadPersistenceAndRollback(t *testing.T) {
	s := newTestServer(t)
	// 服务器时区用 UTC，窗口仍按门店的日期向前取 90 天。
	clock := time.Date(2026, 10, 27, 2, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return clock }
	a := register(t, s, "已读顾客", "顾客")
	b := register(t, s, "另一个消息顾客", "另一位")
	empty := messagesOf(t, s, a.AccessToken, "")
	if empty.Items == nil || len(empty.Items) != 0 || empty.UnreadCount != 0 {
		t.Fatalf("空消息应返回 [] 和零：%+v", empty)
	}
	since := clock.In(storetime.Location).AddDate(0, 0, -90)
	edit(t, s, func(q *txn) {
		for _, account := range []string{a.User.ID, b.User.ID} {
			for _, at := range []time.Time{since.Add(-time.Microsecond), since, clock.Add(-time.Hour), clock, clock.Add(time.Microsecond)} {
				e := member.Entry{ID: id(), AccountID: account, Kind: "adjust", CreatedAt: at, ServiceDate: "2026-01-01"}
				q.memberAccount(account).Entries[e.ID] = e
			}
		}
	})
	feed := messagesOf(t, s, a.AccessToken, "")
	if len(feed.Items) != 3 || feed.UnreadCount != 3 || !feed.Items[2].At.Equal(since) || !feed.Items[0].At.Equal(clock) {
		t.Fatalf("90 天窗口应按 createdAt，含边界、不含未来：%+v", feed)
	}
	for _, method := range []string{"GET", "POST"} {
		path := "/api/v2/messages/me"
		if method == "POST" {
			path += "/reads"
		}
		w := call(t, s, method, path, "", "", nil)
		if w.Code != 401 || codeOf(t, w) != "unauthorized" {
			t.Fatalf("未登录应拒绝：%d %s", w.Code, w.Body.String())
		}
	}
	if count(t, s, "message_reads") != 0 {
		t.Fatal("未登录不能写已读时间")
	}
	restore := failWrites(t, s, "message_reads")
	w := call(t, s, "POST", "/api/v2/messages/me/reads", a.AccessToken, "", nil)
	restore()
	if w.Code != 503 || count(t, s, "message_reads") != 0 || messagesOf(t, s, a.AccessToken, "").UnreadCount != 3 {
		t.Fatalf("写失败应回滚：%d %s", w.Code, w.Body.String())
	}
	readMessages(t, s, a.AccessToken)
	restarted := serverOn(t, s.postgres)
	restarted.now = func() time.Time { return clock }
	if got := messagesOf(t, restarted, a.AccessToken, ""); got.UnreadCount != 0 {
		t.Fatalf("另一副本应读到已读时间：%+v", got)
	} else {
		for _, item := range got.Items {
			if item.Unread {
				t.Fatal("恰好等于 read_at 的消息不应未读")
			}
		}
	}
	if got := messagesOf(t, s, b.AccessToken, ""); got.UnreadCount != 3 {
		t.Fatal("一人的已读不能影响另一人")
	}
	clock = clock.Add(time.Microsecond)
	if got := messagesOf(t, restarted, a.AccessToken, "?limit=1"); got.UnreadCount != 1 || !got.Items[0].Unread {
		t.Fatalf("晚于 read_at 的才未读：%+v", got)
	}
	readMessages(t, restarted, a.AccessToken)
	// 模拟另一副本稍早发起的请求，不能把已读时间倒退。
	earlier := clock.Add(-time.Hour)
	s.now = func() time.Time { return earlier }
	readMessages(t, s, a.AccessToken)
	if got := messagesOf(t, restarted, a.AccessToken, ""); got.UnreadCount != 0 {
		t.Fatal("重复读、乱序到达的请求不能倒退已读时间")
	}
	if count(t, s, "message_reads") != 1 {
		t.Fatal("重复记已读仍应只有本人一行")
	}
}

func TestMessagesReservationsUseCustomerViewAndAudit(t *testing.T) {
	f := newReservationFixture(t)
	s := f.server
	if err := s.ConfigureNoticeKey([]byte("0123456789abcdef0123456789abcdef")); err != nil {
		t.Fatal(err)
	}
	booked := f.book(t, f.customer.AccessToken, 1)
	if got := messagesOf(t, s, f.customer.AccessToken, ""); len(got.Items) != 0 {
		t.Fatal("待确认预约不算消息")
	}
	reservationOK(t, s, f.owner.AccessToken, reservationInput{Action: "confirm", TargetID: booked})
	if got := messagesOf(t, s, f.customer.AccessToken, ""); len(got.Items) != 1 || got.Items[0].Kind != "reservation_confirmed" {
		t.Fatalf("门店确认应出现消息：%+v", got)
	}
	reservationOK(t, s, f.customer.AccessToken, reservationInput{Action: "cancel", TargetID: booked, Reason: "本人改期"})
	if got := messagesOf(t, s, f.customer.AccessToken, ""); len(got.Items) != 1 || got.Items[0].Kind != "reservation_confirmed" {
		t.Fatal("本人取消不生成取消消息，但此前的门店确认应保留")
	}
	selfCancelled := f.book(t, f.customer.AccessToken, 1)
	reservationOK(t, s, f.customer.AccessToken, reservationInput{Action: "cancel", TargetID: selfCancelled, Reason: "本人改期"})
	storeCancelled := f.book(t, f.customer.AccessToken, 1)
	reservationOK(t, s, f.owner.AccessToken, reservationInput{Action: "cancel", TargetID: storeCancelled, Reason: "门店临时调整"})
	storeConfirmed := f.book(t, f.customer.AccessToken, 1)
	reservationOK(t, s, f.owner.AccessToken, reservationInput{Action: "confirm", TargetID: storeConfirmed})
	// 员工给自己代客登记、取消不生成本人消息；给自己确认的有一条（照样发了微信「预约成功」通知，两边对得上）。
	staffOwn := f.book(t, f.owner.AccessToken, 2)
	reservationOK(t, s, f.owner.AccessToken, reservationInput{Action: "confirm", TargetID: staffOwn})
	reservationOK(t, s, f.owner.AccessToken, reservationInput{Action: "cancel", TargetID: staffOwn, Reason: "本人不来了"})
	staffRegistered := reservationOK(t, s, f.owner.AccessToken, reservationInput{Action: "register", AccountID: f.owner.User.ID,
		TableID: f.table, SeatNumber: 2, PackageID: f.pack, StartAt: f.start.Format(time.RFC3339)})["targetId"].(string)
	if got := messagesOf(t, s, f.owner.AccessToken, ""); len(got.Items) != 1 || got.Items[0].ID != "reservation:"+staffOwn+":confirmed" {
		t.Fatalf("员工给自己确认的应有一条、登记和取消不应生成预约消息：%+v", got)
	}
	reservationOK(t, s, f.owner.AccessToken, reservationInput{Action: "cancel", TargetID: staffRegistered, Reason: "本人不来了"})
	other := f.book(t, f.other.AccessToken, 2)
	reservationOK(t, s, f.owner.AccessToken, reservationInput{Action: "confirm", TargetID: other})
	registered := reservationOK(t, s, f.owner.AccessToken, reservationInput{Action: "register", AccountID: f.customer.User.ID,
		TableID: f.table, SeatNumber: 1, PackageID: f.pack, StartAt: f.start.AddDate(0, 0, 1).Format(time.RFC3339)})["targetId"].(string)
	// 没有审计的旧预约不根据当前状态推断消息。
	edit(t, s, func(q *txn) {
		e := member.Entry{ID: id(), AccountID: f.customer.User.ID, Kind: "adjust", CreatedAt: f.now.Add(-time.Minute)}
		q.memberAccount(f.customer.User.ID).Entries[e.ID] = e
		for _, status := range []string{"confirmed", "cancelled", "pending", "seated", "no_show"} {
			x := *q.reservation(storeCancelled)
			x.ID, x.Status = id(), status
			q.addReservation(&x)
		}
	})
	w := call(t, s, "GET", "/api/v2/reservations/me", f.customer.AccessToken, "", nil)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	reservations := map[string]map[string]any{}
	for _, item := range decodeMap(t, w)["reservations"].([]any) {
		e := item.(map[string]any)
		reservations[e["reservation"].(map[string]any)["id"].(string)] = e
	}
	want := map[string]string{booked: "confirmed", storeCancelled: "cancelled", storeConfirmed: "confirmed", registered: "confirmed"}
	feed := messagesOf(t, s, f.customer.AccessToken, "")
	if len(feed.Items) != 5 || feed.UnreadCount != 5 {
		t.Fatalf("只应有本人的门店取消、确认、代客登记及会员流水：%+v", feed)
	}
	if last := feed.Items[4]; last.Kind != "loyalty" || last.Entry == nil || !last.At.Equal(f.now.Add(-time.Minute)) {
		t.Fatal("会员流水与预约应按发生时刻混排")
	}
	for _, item := range feed.Items[:4] {
		x := item.Reservation["reservation"].(map[string]any)
		reservationID := x["id"].(string)
		if status := want[reservationID]; status == "" || item.ID != "reservation:"+reservationID+":"+status || item.Kind != "reservation_"+status || item.Entry != nil || !item.At.Equal(f.now) {
			t.Fatalf("预约消息不对：%+v", item)
		}
		if !reflect.DeepEqual(item.Reservation, reservations[reservationID]) {
			t.Fatalf("与 /reservations/me 本人视图不同：%+v / %+v", item.Reservation, reservations[reservationID])
		}
		if item.Reservation["tableNumber"] == nil || item.Reservation["endAt"] == nil || item.Reservation["notices"] == nil || item.Reservation["customerName"] != nil || item.Reservation["phoneMasked"] != nil {
			t.Fatal("预约需带桌号、结束时间和本人通知，不带员工视图资料")
		}
		if reservationID == storeCancelled && x["reason"] != "门店临时调整" {
			t.Fatal("门店取消需带原因")
		}
	}
	if got := messagesOf(t, s, f.owner.AccessToken, ""); len(got.Items) != 1 || got.Items[0].ID != "reservation:"+staffOwn+":confirmed" {
		t.Fatalf("员工不能读其他人的预约，自己取消也不算，只有给自己确认的那条：%+v", got)
	}
	// 日后撤销员工角色，历史门店取消的归属仍由当时的审计决定。
	setRoles(t, s, f.owner.User.ID)
	if got := messagesOf(t, s, f.customer.AccessToken, "?limit=1"); len(got.Items) != 1 || got.UnreadCount != 5 {
		t.Fatal("预约未读数不应依赖列表 limit 或操作者当前角色")
	}
	readMessages(t, s, f.customer.AccessToken)
	if got := messagesOf(t, s, f.customer.AccessToken, ""); got.UnreadCount != 0 {
		t.Fatal("记已读应同时覆盖会员流水与预约消息")
	}
}

func TestMessagesReservationHistorySurvivesLaterDecisions(t *testing.T) {
	for _, tc := range []struct{ action, status string }{{"seat", "seated"}, {"no_show", "no_show"}, {"cancel", "cancelled"}} {
		t.Run(tc.action, func(t *testing.T) {
			f := newReservationFixture(t)
			s := f.server
			clock := f.now
			s.now = func() time.Time { return clock }
			booked := f.book(t, f.customer.AccessToken, 1)
			reservationOK(t, s, f.owner.AccessToken, reservationInput{Action: "confirm", TargetID: booked})
			confirmedID := "reservation:" + booked + ":confirmed"
			readMessages(t, s, f.customer.AccessToken)
			clock = f.start.Add(time.Minute)
			reservationOK(t, s, f.owner.AccessToken, reservationInput{Action: tc.action, TargetID: booked, Reason: "门店处理"})
			feed := messagesOf(t, s, f.customer.AccessToken, "")
			wantCount, wantUnread := 1, int64(0)
			if tc.action == "cancel" {
				wantCount, wantUnread = 2, 1
			}
			if len(feed.Items) != wantCount || feed.UnreadCount != wantUnread {
				t.Fatalf("%s 后的确认历史或未读数不对：%+v", tc.action, feed)
			}
			w := call(t, s, "GET", "/api/v2/reservations/me", f.customer.AccessToken, "", nil)
			if w.Code != 200 {
				t.Fatal(w.Body.String())
			}
			current := decodeMap(t, w)["reservations"].([]any)[0].(map[string]any)
			confirmed := false
			for _, item := range feed.Items {
				if !reflect.DeepEqual(item.Reservation, current) || item.Reservation["reservation"].(map[string]any)["status"] != tc.status {
					t.Fatalf("历史消息应使用预约当前的顾客视图：%+v", item.Reservation)
				}
				if item.ID == confirmedID {
					confirmed = true
					if item.Kind != "reservation_confirmed" || !item.At.Equal(f.now) || item.Unread {
						t.Fatalf("确认时刻和已读状态不应随后续决定变化：%+v", item)
					}
				} else if item.ID != "reservation:"+booked+":cancelled" || item.Kind != "reservation_cancelled" || !item.At.Equal(clock) || !item.Unread {
					t.Fatalf("门店取消应另有一条新消息：%+v", item)
				}
			}
			if !confirmed {
				t.Fatal("后续开台、爽约或门店取消不能抹掉确认消息")
			}
			if top := messagesOf(t, s, f.customer.AccessToken, "?limit=1"); top.UnreadCount != wantUnread || (tc.action == "cancel" && top.Items[0].Kind != "reservation_cancelled") {
				t.Fatal("消息应按审计时刻倒序，未读数不受 limit 影响")
			}
		})
	}
}

func TestMessagesReservationWindowUsesAuditTime(t *testing.T) {
	f := newReservationFixture(t)
	s := f.server
	clock := f.now
	s.now = func() time.Time { return clock }
	booked := f.book(t, f.customer.AccessToken, 1)
	since := f.now.In(storetime.Location).AddDate(0, 0, -90)
	type expected struct {
		kind string
		at   time.Time
	}
	want := map[string]expected{}
	edit(t, s, func(q *txn) {
		for _, action := range []string{"reservation.confirm", "reservation.register", "reservation.cancel"} {
			for _, at := range []time.Time{since.Add(-time.Microsecond), since, f.now, f.now.Add(time.Microsecond)} {
				x := *q.reservation(booked)
				// decidedAt 故意设到未来，窗口、排序和未读必须只用审计的 created_at。
				decided := f.now.AddDate(1, 0, 0)
				x.ID, x.Status, x.DecidedAt = id(), "cancelled", &decided
				q.addReservation(&x)
				q.audits = append(q.audits, &auditLog{ID: id(), ActorID: f.owner.User.ID, Action: action, ObjectID: x.ID, CreatedAt: at})
				if !at.Before(since) && !at.After(f.now) {
					suffix := "confirmed"
					if action == "reservation.cancel" {
						suffix = "cancelled"
					}
					want["reservation:"+x.ID+":"+suffix] = expected{"reservation_" + suffix, at}
				}
			}
		}
		for _, action := range []string{"reservation.book", "reservation.seat", "reservation.no_show"} {
			q.audit(f.owner.User.ID, action, booked, "其他预约动作不生成消息", "")
		}
	})
	feed := messagesOf(t, s, f.customer.AccessToken, "")
	if len(feed.Items) != len(want) || feed.UnreadCount != int64(len(want)) {
		t.Fatalf("90 天窗口应使用审计时间，含边界、不含未来：%+v", feed)
	}
	for _, item := range feed.Items {
		e, ok := want[item.ID]
		if !ok || item.Kind != e.kind || !item.At.Equal(e.at) || !item.Unread {
			t.Fatalf("预约消息应来自对应审计：%+v", item)
		}
		delete(want, item.ID)
	}
	if len(want) != 0 {
		t.Fatalf("遗漏了审计消息：%+v", want)
	}
	readMessages(t, s, f.customer.AccessToken)
	if got := messagesOf(t, s, f.customer.AccessToken, ""); got.UnreadCount != 0 {
		t.Fatal("等于 read_at 的审计应已读，不受预约 decidedAt 影响")
	}
	clock = clock.Add(time.Microsecond)
	if got := messagesOf(t, s, f.customer.AccessToken, "?limit=1"); got.UnreadCount != 3 || !got.Items[0].Unread {
		t.Fatal("晚于 read_at 的三种审计均应算未读，不受 limit 影响")
	}
}
