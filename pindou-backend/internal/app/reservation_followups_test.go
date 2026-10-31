package app

import (
	"net/http"
	"strings"
	"testing"
	"time"

	member "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/membership/application"
)

// 到店开台、按座续时、整桌改时长，都要核对同一座位后面的预约。
//
// 顾客申请入座、员工确认、换座、整桌开台早就会核对预约，唯独这三条路不核对：
// 迟到的顾客到店开台后坐满套餐时长，会压到下一位顾客已确认的时段；续时、改时长也一样。
// 下一位顾客到店时座位还有人，而他的预约在系统里是好好的。

// laterBooking 让另一位顾客（员工代客登记，直接生效）约下 start 起这个座位。
func (f *reservationFixture) laterBooking(t *testing.T, seat int, start time.Time) string {
	t.Helper()
	out := reservationOK(t, f.server, f.owner.AccessToken, reservationInput{Action: "register", AccountID: f.other.User.ID,
		TableID: f.table, SeatNumber: seat, PackageID: f.pack, StartAt: start.Format(time.RFC3339)})
	return out["targetId"].(string)
}

func TestLateArrivalSeatingRespectsTheNextReservation(t *testing.T) {
	f := newReservationFixture(t)
	s := f.server
	mine := f.book(t, f.customer.AccessToken, 1)
	reservationOK(t, s, f.owner.AccessToken, reservationInput{Action: "confirm", TargetID: mine})
	// 下一位 17:00 起约了同一个座位：本单 14:00–17:00 正好接上
	f.laterBooking(t, 1, time.Date(2026, 9, 14, 17, 0, 0, 0, cst))

	// 迟到 20 分钟（还在宽限期里）到店：按套餐 180 分钟坐到 17:20，压到下一位
	s.now = func() time.Time { return f.start.Add(20 * time.Minute) }
	w := reservationCall(t, s, f.owner.AccessToken, reservationInput{Action: "seat", TargetID: mine})
	if w.Code != 409 {
		t.Fatalf("迟到开台会压到下一位的预约，应当拒绝：%d %s", w.Code, w.Body.String())
	}
	if msg := decodeMap(t, w)["message"].(string); !strings.Contains(msg, "17:00") || !strings.Contains(msg, "另一位") {
		t.Fatalf("要说明压到的是哪个预约（时间、称呼）：%s", msg)
	}
	if f.at(t, mine).Status != "confirmed" || len(sessionsOf(t, s)) != 0 || len(ordersOf(t, s)) != 0 {
		t.Fatal("被拒的开台不能留下会话、订单或改动预约")
	}

	// 准时到店：14:00–17:00，不冲突
	s.now = func() time.Time { return f.start }
	reservationOK(t, s, f.owner.AccessToken, reservationInput{Action: "seat", TargetID: mine})
	if f.at(t, mine).Status != "seated" {
		t.Fatal("准时到店应能开台")
	}
}

func TestSeatRenewalRespectsTheNextReservation(t *testing.T) {
	f := newReservationFixture(t)
	s := f.server
	mine := f.book(t, f.customer.AccessToken, 1)
	reservationOK(t, s, f.owner.AccessToken, reservationInput{Action: "confirm", TargetID: mine})
	f.laterBooking(t, 1, time.Date(2026, 9, 14, 17, 0, 0, 0, cst))
	s.now = func() time.Time { return f.start }
	reservationOK(t, s, f.owner.AccessToken, reservationInput{Action: "seat", TargetID: mine})
	session := sessionOf(t, s, f.at(t, mine).SessionID)
	order := *orderOfSession(t, s, session.ID)

	// 续时 60 分钟会坐到 18:00，压到 17:00 的预约
	w := loyaltyCall(t, s, f.owner.AccessToken, loyaltyInput{Action: "renew", TargetID: session.ID, ExpectedVersion: member.Version(session)})
	if w.Code != 409 {
		t.Fatalf("续时压到下一位的预约，应当拒绝：%d %s", w.Code, w.Body.String())
	}
	if msg := decodeMap(t, w)["message"].(string); !strings.Contains(msg, "17:00") {
		t.Fatalf("要说明压到的是哪个预约：%s", msg)
	}
	if got := sessionOf(t, s, session.ID); got.DurationMinutes != f.duration {
		t.Fatalf("被拒的续时不能改时长：%d", got.DurationMinutes)
	}
	if got := orderOfSession(t, s, session.ID); got.Version() != order.Version() {
		t.Fatal("被拒的续时不能给订单加续时费")
	}
}

func TestWholeTableDurationChangeRespectsLaterReservations(t *testing.T) {
	f := newReservationFixture(t)
	s := f.server
	// 2 号座 12:00 起有人约了；10:00 整桌开 90 分钟到 11:30，不冲突
	f.laterBooking(t, 2, time.Date(2026, 9, 14, 12, 0, 0, 0, cst))
	w := call(t, s, http.MethodPost, "/api/v2/venue-sessions", f.owner.AccessToken, "",
		map[string]any{"serviceTableId": f.table, "timingMode": "timed", "durationMinutes": 90, "startedAt": f.now.Format(time.RFC3339)})
	if w.Code != 201 {
		t.Fatalf("开台失败：%d %s", w.Code, w.Body.String())
	}
	sessionID := decodeMap(t, w)["id"].(string)

	// 改成 150 分钟要坐到 12:30：压到 12:00 的预约
	w = call(t, s, http.MethodPatch, "/api/v2/venue-sessions/"+sessionID, f.owner.AccessToken, "whole-extend", map[string]any{"durationMinutes": 150})
	if w.Code != 409 || decodeMap(t, w)["code"] != "seat_reserved" {
		t.Fatalf("改时长压到别人的预约，应当拒绝：%d %s", w.Code, w.Body.String())
	}
	if msg := decodeMap(t, w)["message"].(string); !strings.Contains(msg, "12:00") {
		t.Fatalf("要说明压到的是哪个预约：%s", msg)
	}
	if got := sessionOf(t, s, sessionID); got.DurationMinutes != 90 {
		t.Fatalf("被拒的改时长不能生效：%d", got.DurationMinutes)
	}
	// 续时（追加分钟数）同样核对：追加 60 分钟也要坐到 12:30
	w = call(t, s, http.MethodPatch, "/api/v2/venue-sessions/"+sessionID, f.owner.AccessToken, "whole-append",
		map[string]any{"extendMinutes": 60, "expectedDurationMinutes": 90})
	if w.Code != 409 || decodeMap(t, w)["code"] != "seat_reserved" {
		t.Fatalf("续时压到别人的预约，应当拒绝：%d %s", w.Code, w.Body.String())
	}
	if got := sessionOf(t, s, sessionID); got.DurationMinutes != 90 {
		t.Fatalf("被拒的续时不能生效：%d", got.DurationMinutes)
	}
	// 只延到 12:00 为止不冲突
	w = call(t, s, http.MethodPatch, "/api/v2/venue-sessions/"+sessionID, f.owner.AccessToken, "whole-extend-ok", map[string]any{"durationMinutes": 120})
	if w.Code != 200 {
		t.Fatalf("延到 12:00 不冲突，应当成功：%d %s", w.Code, w.Body.String())
	}
}
