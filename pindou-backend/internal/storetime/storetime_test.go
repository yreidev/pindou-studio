package storetime

import (
	"testing"
	"time"
)

// 门店时区是固定的东八区：不读系统时区库（精简镜像里可能没有 tzdata），没有夏令时，冬夏都差 8 小时。
func TestLocationIsFixedUTCPlus8(t *testing.T) {
	for _, at := range []time.Time{
		time.Date(2026, 1, 15, 12, 0, 0, 0, time.UTC),
		time.Date(2026, 7, 15, 12, 0, 0, 0, time.UTC),
	} {
		if _, offset := at.In(Location).Zone(); offset != 8*60*60 {
			t.Errorf("%s：偏移 %d 秒，应为 8 小时", at.Format(time.DateOnly), offset)
		}
	}
}

// 按日期判断的口径（今天、生日年度）以门店日期为准：UTC 16:00 已经是门店的第二天零点。
func TestStoreDateTurnsOverAtUTC1600(t *testing.T) {
	before := time.Date(2026, 12, 31, 15, 59, 59, 0, time.UTC).In(Location)
	after := time.Date(2026, 12, 31, 16, 0, 0, 0, time.UTC).In(Location)
	if got := before.Format(time.DateTime); got != "2026-12-31 23:59:59" {
		t.Errorf("跨日前：%s", got)
	}
	if got := after.Format(time.DateTime); got != "2027-01-01 00:00:00" || after.Year() != 2027 {
		t.Errorf("跨日后：%s（生日年度要按门店的年份算）", got)
	}
}
