package layout

import (
	"strings"
	"testing"
)

// 嵌入的布局本身要过校验（包初始化时就会校验，这里把它写成看得见的断言）。
func TestStoreLayoutIsConsistent(t *testing.T) {
	if err := Get().validate(); err != nil {
		t.Fatal(err)
	}
}

// 布局写错要在启动期被拦下：每条规则各给一份写错的布局，报告要说清楚错在哪。
func TestValidateRejectsBrokenLayouts(t *testing.T) {
	zones := []Zone{{Key: "A", Name: "A 区", SeatsPerUnit: 2}, {Key: "B", Name: "B 区", SeatsPerUnit: 1}}
	pair := Table{Code: "A1", Zone: "A", Number: 1, SeatCount: 2, WholeTable: true}
	single := Table{Code: "B1", Zone: "B", Number: 1, SeatCount: 1}
	for _, c := range []struct {
		name   string
		layout Layout
		want   string
	}{
		{"没有分区", Layout{Tables: []Table{single}}, "没有分区"},
		{"没有桌位", Layout{Zones: zones}, "没有桌位"},
		{"编码重复", Layout{Zones: zones, Tables: []Table{single, single}}, "桌位编码重复: B1"},
		{"分区不存在", Layout{Zones: zones, Tables: []Table{{Code: "C1", Zone: "C", Number: 1, SeatCount: 1}}}, `所属分区 "C" 不存在`},
		{"编码与桌号对不上", Layout{Zones: zones, Tables: []Table{{Code: "B1", Zone: "B", Number: 2, SeatCount: 1}}}, "与分区加桌号 B2 对不上"},
		{"座数与分区不符", Layout{Zones: zones, Tables: []Table{{Code: "A1", Zone: "A", Number: 1, SeatCount: 1}}}, "A1 有 1 座，但 A 区的每单位座数是 2"},
		{"多座不是整桌单位", Layout{Zones: zones, Tables: []Table{{Code: "A1", Zone: "A", Number: 1, SeatCount: 2}}}, "多于一座必须是整桌单位"},
		{"单座标成整桌", Layout{Zones: zones, Tables: []Table{{Code: "B1", Zone: "B", Number: 1, SeatCount: 1, WholeTable: true}}}, "多于一座必须是整桌单位"},
	} {
		err := c.layout.validate()
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s：应报 %q，实得 %v", c.name, c.want, err)
		}
	}
	if err := (Layout{Zones: zones, Tables: []Table{pair, single}}).validate(); err != nil {
		t.Errorf("正确的布局不该被拒：%v", err)
	}
}

func TestZoneOf(t *testing.T) {
	l := Get()
	if z, ok := l.ZoneOf("D"); !ok || z.SeatsPerUnit != 2 {
		t.Errorf("D 区（包间双人桌）：%+v %v", z, ok)
	}
	if _, ok := l.ZoneOf("Z"); ok {
		t.Error("不存在的分区不该找到")
	}
}
