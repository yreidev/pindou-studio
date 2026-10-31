package app

import (
	"testing"
	"time"

	"github.com/yreidev/pindou-studio/pindou-backend/internal/storetime"
)

// 导出日期是门店日期：北京时间 09-19 01:00（UTC 还是 09-18）属于 09-19。
func TestExportDateRangeUsesStoreDay(t *testing.T) {
	paid := time.Date(2026, 9, 18, 17, 0, 0, 0, time.UTC)
	for _, c := range []struct {
		day  string
		want bool
	}{
		{"2026-09-19", true},
		{"2026-09-18", false},
	} {
		from, to, err := exportDateRange(c.day, c.day)
		if err != nil {
			t.Fatal(err)
		}
		if got := exportDateMatch(paid, from, to); got != c.want {
			t.Fatalf("export of %s includes 09-19 01:00 CST = %v, want %v", c.day, got, c.want)
		}
	}
	// 当天最后一刻仍在，次日零点不在。
	from, to, _ := exportDateRange("2026-09-19", "2026-09-19")
	if !exportDateMatch(time.Date(2026, 9, 19, 23, 59, 59, 0, storetime.Location), from, to) || exportDateMatch(time.Date(2026, 9, 20, 0, 0, 0, 0, storetime.Location), from, to) {
		t.Fatal("day boundaries are off")
	}
}
