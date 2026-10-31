package app

import "testing"

// 测试用的桌位夹具。
//
// ★ 布局固定之后，POST /floor-areas 与 POST /service-tables 都返回 405 —— 它们原本
//
//	被不少用例当成「随手造一张桌」的快捷方式。造夹具直接写进库即可：
//	走 API 本来也不是这些用例要验的东西。
func seedTable(t *testing.T, s *Server, code, areaName string, number, seatCount int, whole bool) *Table {
	t.Helper()
	var table *Table
	edit(t, s, func(q *txn) {
		var area *FloorArea
		for _, a := range q.allAreas() {
			if a.Name == areaName {
				area = a
				break
			}
		}
		if area == nil {
			area = &FloorArea{ID: id(), Name: areaName}
			q.addArea(area)
		}
		table = &Table{ID: id(), Code: code, AreaID: area.ID, Number: number, SeatCount: seatCount, WholeTable: whole, Enabled: true}
		q.addTable(table)
	})
	return table
}
