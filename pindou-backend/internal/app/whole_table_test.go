package app

import (
	"testing"
	"time"

	reserve "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/reservations/domain"
)

// 整桌单位：占掉一个座就等于占掉整张桌。
//
// ★★ 2026-09-19 真机验收发现的洞。顾客端平面图上「一个位置 = 一个可约单位」，
//
//	A 区双人位是一张有 2 个物理座的桌，顾客点图上那个位置就是把整张桌包下来。
//	但后端一直是**按座号**判占用（seatAvailable / Reservation.Blocks），
//	顾客订走 1 号座之后 2 号座在后端仍然是空的 —— 扫码入座页会把它列给下一个
//	进店的人，两拨互不相识的客人被拼到同一张桌上。
//
//	顾客端当时是靠「要求每桌恰好 1 座」绕开这个洞的，代价是店里真按双人桌建了
//	2 座之后整张平面图不可用，而「按平面图同步」只会把座位数改大不会改小，
//	连修复按钮都不显示，门店永久卡死。现在改成后端真的懂「整桌单位」。
func tableFixture(t *testing.T, whole bool) (*Server, *Table, sessionResponse, sessionResponse) {
	s := newTestServer(t)
	table := seedTable(t, s, "A1", "A 区", 1, 2, whole)
	first := register(t, s, "whole-table-first", "顾客甲")
	second := register(t, s, "whole-table-second", "顾客乙")
	return s, table, first, second
}

func TestWholeTableSessionTakesEverySeat(t *testing.T) {
	for _, whole := range []bool{true, false} {
		s, table, first, _ := tableFixture(t, whole)
		edit(t, s, func(q *txn) {
			q.addSession(&TableSession{ID: id(), TableID: table.ID, UserID: first.User.ID, SeatNumber: 1, Status: "active", StartedAt: s.now()})
		})
		available := func(seat int) bool {
			return view(t, s, func(q *txn) bool { return s.seatAvailable(q, table.ID, seat, "") })
		}
		if available(1) {
			t.Fatalf("whole=%v：1 号座正在使用，不该判成空闲", whole)
		}
		got := available(2)
		if whole && got {
			t.Fatal("整桌单位：1 号座被占，2 号座**必须**一起锁住，否则扫码入座会把陌生人拼到同一张桌")
		}
		if !whole && !got {
			t.Fatal("普通桌位：各座各算，1 号座被占不该连累 2 号座")
		}

		// 员工端看到的已占座号：整桌单位要整张桌都标已占，
		// 否则显示「已占 1/2 座」，店员会以为还能再安排一个人。
		var occupied []int
		for _, v := range view(t, s, s.loyaltyTables) {
			if v["id"] == table.ID {
				occupied = v["occupiedSeats"].([]int)
			}
		}
		if whole && len(occupied) != 2 {
			t.Fatalf("整桌单位应显示 2 个已占座号，实际 %v", occupied)
		}
		if !whole && len(occupied) != 1 {
			t.Fatalf("普通桌位应只显示 1 个已占座号，实际 %v", occupied)
		}
	}
}

func TestWholeTableReservationBlocksTheOtherSeat(t *testing.T) {
	for _, whole := range []bool{true, false} {
		s, table, first, second := tableFixture(t, whole)
		now := s.now()
		start := now.Add(2 * time.Hour)
		edit(t, s, func(q *txn) {
			q.addReservation(&reserve.Reservation{
				ID: id(), AccountID: first.User.ID, TableID: table.ID, SeatNumber: 1,
				Status: "confirmed", StartAt: start, DurationMinutes: 60, CreatedAt: now,
			})
		})
		end := start.Add(60 * time.Minute)

		// 别人想订同一张桌的 2 号座
		err := view(t, s, func(q *txn) error { return s.reservationSeatFree(q, table.ID, 2, start, end, "", now) })
		if whole && err == nil {
			t.Fatal("整桌单位：1 号座已被预约，2 号座不该还能订出去")
		}
		if !whole && err != nil {
			t.Fatalf("普通桌位：2 号座与 1 号座互不相干，不该冲突：%v", err)
		}

		hold := func(seat int, account string) *Reservation {
			return view(t, s, func(q *txn) *Reservation { return s.reservationHold(q, table.ID, seat, start, end, account) })
		}
		// 走进来的客人要在 2 号座开台，应被这张桌上的预约挡住
		if h := hold(2, second.User.ID); whole && h == nil {
			t.Fatal("整桌单位：这张桌在该时段有预约，2 号座不该能开台")
		} else if !whole && h != nil {
			t.Fatal("普通桌位：2 号座没有预约，不该被挡")
		}

		// 本人回来入座不该被自己的预约挡住
		if hold(1, first.User.ID) != nil {
			t.Fatal("顾客本人的预约不该挡住他自己入座")
		}
	}
}

// 售卖单位要能读也要能改，否则店里没法把双人桌标成整桌单位。
func TestWholeTableRoundTripsThroughTheTableView(t *testing.T) {
	s, table, _, _ := tableFixture(t, true)
	views := view(t, s, func(q *txn) []map[string]any { return s.tableViews(q, []*Table{q.table(table.ID)}) })
	if views[0]["wholeTable"] != true {
		t.Fatal("tableView 没有把 wholeTable 暴露出去，员工端读不到售卖单位")
	}
	var found bool
	for _, v := range view(t, s, s.loyaltyTables) {
		if v["id"] == table.ID {
			found = true
			if v["wholeTable"] != true {
				t.Fatal("loyaltyTables 没有 wholeTable，顾客端的平面图判不出这张桌是整桌单位")
			}
		}
	}
	if !found {
		t.Fatal("夹具没进 loyaltyTables")
	}
}
