package app

import (
	"testing"
	"time"
)

// 2026-10-27 按代码逐个流程查出来的几处预约漏洞（docs/product.md「预约」）：顾客坐到别的座位时自己的预约要结掉；
// 待确认的预约到店可以直接开台；顾客自己取消今天的预约要提醒员工，点「知道了」消掉。

// 顾客约了 H1 1 号座，到店坐了另一张桌（扫码入座被确认，或员工给他整桌开台）：那条预约记为已到店，约的座位放出来，
// 不会挂到过期、再被当成没来标爽约。时间不重叠的（上午先来坐一会儿，预约在下午）不动。
func TestSeatingElsewhereSettlesTheCustomersReservation(t *testing.T) {
	for _, via := range []string{"scan", "whole_table"} {
		f := newReservationFixture(t)
		s := f.server
		booked := f.book(t, f.customer.AccessToken, 1)
		reservationOK(t, s, f.owner.AccessToken, reservationInput{Action: "confirm", TargetID: booked})
		elsewhere := seedTable(t, s, "H2", "大厅", 2, 1, false).ID
		s.now = func() time.Time { return f.start.Add(-5 * time.Minute) }
		var session string
		switch via {
		case "scan":
			admission := loyaltyOK(t, s, f.customer.AccessToken, loyaltyInput{Action: "request", TargetID: f.pack, TableID: elsewhere, SeatNumber: 1})["id"].(string)
			session = loyaltyOK(t, s, f.owner.AccessToken, loyaltyInput{Action: "confirm", TargetID: admission})["venueSessionId"].(string)
		case "whole_table":
			w := call(t, s, "POST", "/api/v2/venue-sessions", f.owner.AccessToken, id(), map[string]any{"serviceTableId": elsewhere, "accountId": f.customer.User.ID, "timingMode": "timed", "durationMinutes": 60})
			if w.Code != 201 {
				t.Fatalf("整桌开台：%d %s", w.Code, w.Body.String())
			}
			session = decodeMap(t, w)["id"].(string)
		}
		if x := f.at(t, booked); x.Status != "seated" || x.SessionID != session {
			t.Fatalf("%s：坐到别的桌，自己这个时段的预约应记为已到店：%+v", via, x)
		}
		// 约的座位放出来了：别人现在就能扫码坐 H1 1 号座
		if w := loyaltyCall(t, s, f.other.AccessToken, loyaltyInput{Action: "request", TargetID: f.pack, TableID: f.table, SeatNumber: 1}); w.Code != 200 {
			t.Fatalf("%s：预约结掉后约的座位应放出来：%d %s", via, w.Code, w.Body.String())
		}
	}

	f := newReservationFixture(t)
	s := f.server
	booked := f.book(t, f.customer.AccessToken, 1)
	elsewhere := seedTable(t, s, "H2", "大厅", 2, 1, false).ID
	w := call(t, s, "POST", "/api/v2/venue-sessions", f.owner.AccessToken, id(), map[string]any{"serviceTableId": elsewhere, "accountId": f.customer.User.ID, "timingMode": "timed", "durationMinutes": 60})
	if w.Code != 201 {
		t.Fatalf("整桌开台：%d %s", w.Code, w.Body.String())
	}
	if x := f.at(t, booked); x.Status != "pending" || x.SessionID != "" {
		t.Fatalf("上午坐一小时和下午的预约不重叠，预约不该动：%+v", x)
	}
}

// 待确认的预约，顾客人已经到了：店员直接开台，不用先确认；不发「预约成功」通知，没发的都作废。处理完的不能再开台。
func TestPendingReservationSeatsWithoutConfirmation(t *testing.T) {
	f, sender := noticeFixture(t)
	s := f.server
	booked := f.book(t, f.customer.AccessToken, 1)
	if w := subscribe(t, s, f.customer.AccessToken, booked, "reservation-customer", "confirmed", "reminder", "cancelled"); w.Code != 200 {
		t.Fatalf("允许订阅：%d %s", w.Code, w.Body.String())
	}
	s.now = func() time.Time { return f.start.Add(5 * time.Minute) }
	reservationOK(t, s, f.owner.AccessToken, reservationInput{Action: "seat", TargetID: booked})
	x := f.at(t, booked)
	if x.Status != "seated" || x.SessionID == "" || sessionOf(t, s, x.SessionID) == nil {
		t.Fatalf("待确认的预约应能直接开台：%+v", x)
	}
	if sent := sender.take(s); len(sent) != 0 {
		t.Fatalf("到店开台不发预约成功通知：%+v", sent)
	}
	if got := noticeStatuses(t, s, booked); !sameStatuses(got, map[string]string{"confirmed": "void", "reminder": "void", "cancelled": "void"}) {
		t.Fatalf("没发的通知应作废：%v", got)
	}
	if w := reservationCall(t, s, f.owner.AccessToken, reservationInput{Action: "seat", TargetID: booked}); w.Code != 409 {
		t.Fatalf("已到店的预约又开了一次台：%d %s", w.Code, w.Body.String())
	}
}

// 顾客自己取消今天的预约：员工的预约视图带 customerCancellations（称呼、原因），现场页据此提醒；员工替顾客取消的、
// 别的日子的不提醒，顾客自己的视图里没有这一项。员工点「知道了」（acknowledge）后，这次的响应和之后重读都不再列；
// 预约的时段过去了也不再列。只有员工能点，只能点已取消的。
func TestCustomerCancellationAlertsStaffUntilAcknowledged(t *testing.T) {
	f := newReservationFixture(t)
	s := f.server
	alerts := func() []string {
		t.Helper()
		w := call(t, s, "GET", "/api/v2/reservations/staff?scope=open", f.owner.AccessToken, "", nil)
		if w.Code != 200 {
			t.Fatalf("员工读预约：%d %s", w.Code, w.Body.String())
		}
		return cancellationIDs(t, decodeMap(t, w))
	}
	cancelled := f.book(t, f.customer.AccessToken, 1)
	reservationOK(t, s, f.customer.AccessToken, reservationInput{Action: "cancel", TargetID: cancelled, Reason: "临时有事来不了"})
	byStaff := f.book(t, f.other.AccessToken, 2)
	reservationOK(t, s, f.owner.AccessToken, reservationInput{Action: "cancel", TargetID: byStaff, Reason: "顾客打电话说不来了"})
	tomorrow := reservationOK(t, s, f.other.AccessToken, reservationInput{Action: "book", TableID: f.table, SeatNumber: 2, PackageID: f.pack, StartAt: f.start.AddDate(0, 0, 1).Format(time.RFC3339)})["targetId"].(string)
	reservationOK(t, s, f.other.AccessToken, reservationInput{Action: "cancel", TargetID: tomorrow})

	w := call(t, s, "GET", "/api/v2/reservations/staff?scope=open", f.owner.AccessToken, "", nil)
	list, _ := decodeMap(t, w)["customerCancellations"].([]any)
	if len(list) != 1 {
		t.Fatalf("只该提醒顾客自己取消的今天这一条：%v", list)
	}
	entry := list[0].(map[string]any)
	if x := entry["reservation"].(map[string]any); x["id"] != cancelled || x["reason"] != "临时有事来不了" || entry["customerName"] != "顾客" || entry["displayStatus"] != "cancelled" {
		t.Fatalf("提醒要带称呼和原因：%v", entry)
	}
	if _, ok := decodeMap(t, call(t, s, "GET", "/api/v2/reservations/me", f.customer.AccessToken, "", nil))["customerCancellations"]; ok {
		t.Fatal("顾客自己的视图不带员工的提醒")
	}

	if w := reservationCall(t, s, f.customer.AccessToken, reservationInput{Action: "acknowledge", TargetID: cancelled}); w.Code != 403 {
		t.Fatalf("顾客点了「知道了」：%d %s", w.Code, w.Body.String())
	}
	live := f.book(t, f.customer.AccessToken, 1)
	if w := reservationCall(t, s, f.owner.AccessToken, reservationInput{Action: "acknowledge", TargetID: live}); w.Code != 409 {
		t.Fatalf("没取消的预约点了「知道了」：%d %s", w.Code, w.Body.String())
	}
	done := reservationOK(t, s, f.owner.AccessToken, reservationInput{Action: "acknowledge", TargetID: cancelled})
	if got := cancellationIDs(t, done); len(got) != 0 || done["targetId"] != cancelled {
		t.Fatalf("点了「知道了」的响应里不该还有这条：%v", got)
	}
	if got := alerts(); len(got) != 0 {
		t.Fatalf("点了「知道了」之后不再提醒：%v", got)
	}

	reservationOK(t, s, f.customer.AccessToken, reservationInput{Action: "cancel", TargetID: live, Reason: "想换个时间"})
	if got := alerts(); len(got) != 1 || got[0] != live {
		t.Fatalf("又一条顾客取消：%v", got)
	}
	s.now = func() time.Time { return f.start.Add(time.Duration(f.duration) * time.Minute) }
	if got := alerts(); len(got) != 0 {
		t.Fatalf("预约的时段过了不再提醒：%v", got)
	}
}

// cancellationIDs 是员工视图里「顾客取消」提醒的预约编号，按顺序。
func cancellationIDs(t *testing.T, view map[string]any) []string {
	t.Helper()
	list, ok := view["customerCancellations"].([]any)
	if !ok {
		t.Fatalf("员工视图没带 customerCancellations：%v", view)
	}
	out := []string{}
	for _, item := range list {
		out = append(out, item.(map[string]any)["reservation"].(map[string]any)["id"].(string))
	}
	return out
}
