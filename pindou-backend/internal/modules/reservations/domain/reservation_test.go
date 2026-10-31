package domain

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/yreidev/pindou-studio/pindou-backend/internal/storetime"
)

func at(day, hour, minute int) time.Time {
	return time.Date(2026, 9, day, hour, minute, 0, 0, storetime.Location)
}

func TestWindowRejectsOutsideOpeningHours(t *testing.T) {
	s, now := DefaultSettings(), at(13, 10, 0)
	if err := Window(at(13, 14, 0), 120, s, now); err != nil {
		t.Fatalf("open slot rejected: %v", err)
	}
	for name, start := range map[string]time.Time{
		"before opening": at(14, 8, 30),
		"past closing":   at(14, 21, 30),
		"off the grid":   at(14, 14, 10),
		"too soon":       at(13, 10, 20),
		"too far ahead":  at(30, 14, 0),
	} {
		if err := Window(start, 120, s, now); err == nil {
			t.Fatalf("%s accepted", name)
		}
	}
}

func TestLiveEndsAfterGraceSoTheSeatIsReleased(t *testing.T) {
	r := Reservation{Status: "confirmed", StartAt: at(13, 14, 0), DurationMinutes: 120}
	if !r.Live(at(13, 14, 20), 30) {
		t.Fatal("reservation should still hold the seat inside the grace period")
	}
	if r.Live(at(13, 14, 40), 30) {
		t.Fatal("reservation should release the seat after the grace period")
	}
	if r.Display(at(13, 14, 40), 30) != "expired" {
		t.Fatal("expired state must be derived, not stored")
	}
	if r.Status != "confirmed" {
		t.Fatal("derived state must not rewrite the stored status")
	}
	for _, status := range []string{"cancelled", "no_show", "seated"} {
		settled := Reservation{Status: status, StartAt: at(13, 14, 0), DurationMinutes: 120}
		if settled.Live(at(13, 13, 0), 30) {
			t.Fatalf("%s reservation must not hold a seat", status)
		}
	}
}

func TestBlocksOnlyOverlappingWindowsOfTheSameSeat(t *testing.T) {
	now := at(13, 10, 0)
	r := Reservation{Status: "confirmed", TableID: "t1", SeatNumber: 2, StartAt: at(13, 14, 0), DurationMinutes: 120}
	if !r.Blocks("t1", 2, at(13, 15, 0), at(13, 17, 0), now, 30) {
		t.Fatal("overlapping window on the same seat must conflict")
	}
	if r.Blocks("t1", 2, at(13, 16, 0), at(13, 18, 0), now, 30) {
		t.Fatal("a window starting when the previous one ends must not conflict")
	}
	if r.Blocks("t1", 3, at(13, 15, 0), at(13, 17, 0), now, 30) {
		t.Fatal("another seat must not conflict")
	}
	if r.Blocks("t2", 2, at(13, 15, 0), at(13, 17, 0), now, 30) {
		t.Fatal("another table must not conflict")
	}
}

func TestSettingsValidation(t *testing.T) {
	if err := DefaultSettings().Validate(); err != nil {
		t.Fatalf("defaults rejected: %v", err)
	}
	for name, s := range map[string]Settings{
		"closes before it opens": {OpenMinute: 20 * 60, CloseMinute: 9 * 60, SlotMinutes: 30, AdvanceDays: 7, GraceMinutes: 30},
		"opening off the grid":   {OpenMinute: 9*60 + 10, CloseMinute: 22 * 60, SlotMinutes: 30, AdvanceDays: 7, GraceMinutes: 30},
		"no advance window":      {OpenMinute: 9 * 60, CloseMinute: 22 * 60, SlotMinutes: 30, AdvanceDays: 0, GraceMinutes: 30},
	} {
		if err := s.Validate(); err == nil {
			t.Fatalf("%s accepted", name)
		}
	}
}

// 门店联系方式可选：去掉首尾空白后电话最多 20 个字符、只能是数字空格和 +-()，微信号最多 40 个字符、不含空白。
func TestSettingsContactsAreTrimmedAndChecked(t *testing.T) {
	s := DefaultSettings()
	s.ContactPhone, s.ContactWechat = "  +86 (0571) 8888-6666 ", "\texamplebrand_pindou "
	got, err := s.Normalize(DefaultSettings(), at(13, 10, 0))
	if err != nil {
		t.Fatalf("合法的联系方式被拒：%v", err)
	}
	if got.ContactPhone != "+86 (0571) 8888-6666" || got.ContactWechat != "examplebrand_pindou" {
		t.Fatalf("联系方式没有去掉首尾空白：%q %q", got.ContactPhone, got.ContactWechat)
	}
	if _, err := DefaultSettings().Normalize(DefaultSettings(), at(13, 10, 0)); err != nil {
		t.Fatalf("不填联系方式也要能保存：%v", err)
	}
	long := strings.Repeat("贝", 40)
	withLong := DefaultSettings()
	withLong.ContactWechat = long
	if _, err := withLong.Normalize(DefaultSettings(), at(13, 10, 0)); err != nil {
		t.Fatalf("40 个字的微信号应可保存：%v", err)
	}
	for name, c := range map[string]struct {
		phone, wechat string
		want          error
	}{
		"电话带字母":        {phone: "0571-abc", want: ErrContactPhone},
		"电话带全角括号":      {phone: "（0571）88886666", want: ErrContactPhone},
		"电话超过 20 个字符":  {phone: "0571 8888 6666 (1234)", want: ErrContactPhone},
		"电话 21 位数字":    {phone: strings.Repeat("1", 21), want: ErrContactPhone},
		"微信号中间有空格":     {wechat: "examplebrand pindou", want: ErrContactWechat},
		"微信号超过 40 个字符": {wechat: long + "贝", want: ErrContactWechat},
	} {
		s := DefaultSettings()
		s.ContactPhone, s.ContactWechat = c.phone, c.wechat
		if _, err := s.Normalize(DefaultSettings(), at(13, 10, 0)); !errors.Is(err, c.want) {
			t.Fatalf("%s：应为 %v，实得 %v", name, c.want, err)
		}
	}
}

// 门店地址去掉首尾空白、最多 100 个字；经纬度要么都填要么都不填，且在合法范围内。都没填时 JSON 里没有这几个键，
// 设置的版本和加字段之前一样。
func TestSettingsAddressAndLocation(t *testing.T) {
	lat, lng := 39.1, 117.2
	s := DefaultSettings()
	s.Address, s.Latitude, s.Longitude = "  天津市河西区某某路 1 号 ", &lat, &lng
	got, err := s.Normalize(DefaultSettings(), at(13, 10, 0))
	if err != nil || got.Address != "天津市河西区某某路 1 号" || *got.Latitude != lat || *got.Longitude != lng {
		t.Fatalf("合法的地址被拒或没整理：%+v %v", got, err)
	}
	b, err := json.Marshal(DefaultSettings())
	if err != nil || strings.Contains(string(b), "address") || strings.Contains(string(b), "latitude") {
		t.Fatalf("没填时不该写进 JSON：%s %v", b, err)
	}
	bad, south, east := 91.0, -91.0, 181.0
	for name, c := range map[string]struct {
		address  string
		lat, lng *float64
		want     error
	}{
		"地址超过 100 个字": {address: strings.Repeat("路", 101), want: ErrAddress},
		"地址带换行":       {address: "天津\n河西", want: ErrAddress},
		"只填纬度":        {lat: &lat, want: ErrLocation},
		"只填经度":        {lng: &lng, want: ErrLocation},
		"纬度超过 90":     {lat: &bad, lng: &lng, want: ErrLocation},
		"纬度低于 -90":    {lat: &south, lng: &lng, want: ErrLocation},
		"经度超过 180":    {lat: &lat, lng: &east, want: ErrLocation},
	} {
		s := DefaultSettings()
		s.Address, s.Latitude, s.Longitude = c.address, c.lat, c.lng
		if _, err := s.Normalize(DefaultSettings(), at(13, 10, 0)); !errors.Is(err, c.want) {
			t.Fatalf("%s：应为 %v，实得 %v", name, c.want, err)
		}
	}
}

// 歇业日期按门店时区：去重排序；新加的不能早于今天、最远一年；原来存着、日子已过的悄悄去掉；最多 90 个。
// 每周休息日 1 周一 … 7 周日，去重排序，最多 6 天。
func TestSettingsClosedDatesAreNormalizedInStoreTime(t *testing.T) {
	now := at(13, 10, 0) // 2026-09-13 10:00 门店时间
	s := DefaultSettings()
	s.ClosedDates = []string{"2026-09-20", " 2026-09-13", "2026-09-20", "2026-09-15"}
	s.ClosedWeekdays = []int{7, 1, 7}
	got, err := s.Normalize(DefaultSettings(), now)
	if err != nil {
		t.Fatalf("合法的歇业设置被拒：%v", err)
	}
	if strings.Join(got.ClosedDates, ",") != "2026-09-13,2026-09-15,2026-09-20" {
		t.Fatalf("歇业日期没有去重排序（今天也可以设）：%v", got.ClosedDates)
	}
	if len(got.ClosedWeekdays) != 2 || got.ClosedWeekdays[0] != 1 || got.ClosedWeekdays[1] != 7 {
		t.Fatalf("每周休息日没有去重排序：%v", got.ClosedWeekdays)
	}

	// 门店时区的今天：UTC 9 月 12 日 16:00 已经是门店的 13 日零点，12 日就是过去了
	utcMidnight := time.Date(2026, 9, 12, 16, 0, 0, 0, time.UTC)
	past := DefaultSettings()
	past.ClosedDates = []string{"2026-09-12"}
	if _, err := past.Normalize(DefaultSettings(), utcMidnight); !errors.Is(err, ErrClosedDatePast) {
		t.Fatalf("门店时区已过去的日期应被拒：%v", err)
	}
	if _, err := past.Normalize(DefaultSettings(), utcMidnight.Add(-time.Second)); err != nil {
		t.Fatalf("门店时区还是 12 日时，12 日应能设为歇业：%v", err)
	}
	// 原来就存着、日子已过的：保存时悄悄去掉，不因此失败
	stored := DefaultSettings()
	stored.ClosedDates = []string{"2026-09-10", "2026-09-20"}
	kept, err := stored.Normalize(stored, now)
	if err != nil || strings.Join(kept.ClosedDates, ",") != "2026-09-20" {
		t.Fatalf("已过去的旧歇业日应去掉：%v %v", kept.ClosedDates, err)
	}

	for name, c := range map[string]struct {
		dates    []string
		weekdays []int
		want     error
	}{
		"日期写法不对":  {dates: []string{"2026-9-20"}, want: ErrClosedDate},
		"不存在的日期":  {dates: []string{"2026-02-30"}, want: ErrClosedDate},
		"超过一年以后":  {dates: []string{"2027-09-14"}, want: ErrClosedDate},
		"新加的过去日期": {dates: []string{"2026-09-12"}, want: ErrClosedDatePast},
		"超过 90 个": {dates: days(now, 91), want: ErrClosedDates},
		"星期写成 0":  {weekdays: []int{0}, want: ErrClosedWeekdays},
		"星期写成 8":  {weekdays: []int{8}, want: ErrClosedWeekdays},
		"整周都休":    {weekdays: []int{1, 2, 3, 4, 5, 6, 7}, want: ErrClosedWeekdays},
	} {
		s := DefaultSettings()
		s.ClosedDates, s.ClosedWeekdays = c.dates, c.weekdays
		if _, err := s.Normalize(DefaultSettings(), now); !errors.Is(err, c.want) {
			t.Fatalf("%s：应为 %v，实得 %v", name, c.want, err)
		}
	}
	s = DefaultSettings()
	s.ClosedDates = days(now, 90)
	if _, err := s.Normalize(DefaultSettings(), now); err != nil {
		t.Fatalf("90 个歇业日期应能保存：%v", err)
	}
}

// days 是从 now 那天起连续 n 天的日期。
func days(now time.Time, n int) []string {
	out := make([]string, n)
	for i := range out {
		out[i] = now.AddDate(0, 0, i).Format(time.DateOnly)
	}
	return out
}

// 歇业按门店时区的日期判断：设了的日期和每周休息日都算；ClosedDays 列出今天起若干天里的歇业日，已过去的日期不再给人看。
func TestClosedOnFollowsStoreDate(t *testing.T) {
	s := DefaultSettings()
	s.ClosedDates = []string{"2026-09-10", "2026-09-15"}
	s.ClosedWeekdays = []int{1} // 周一：2026-09-14、09-21
	if !s.ClosedOn(at(15, 14, 0)) || !s.ClosedOn(at(14, 9, 0)) || s.ClosedOn(at(16, 14, 0)) {
		t.Fatal("歇业日期或每周休息日判断不对")
	}
	// UTC 9 月 14 日 16:00 已是门店的 15 日（歇业）；15:59 还是 14 日（周一，也歇业）；UTC 15 日 16:00 是门店 16 日（营业）
	if !s.ClosedOn(time.Date(2026, 9, 14, 16, 0, 0, 0, time.UTC)) || s.ClosedOn(time.Date(2026, 9, 15, 16, 0, 0, 0, time.UTC)) {
		t.Fatal("歇业要按门店时区的日期判断")
	}
	if got := strings.Join(s.ClosedDays(at(13, 23, 30), 8), ","); got != "2026-09-14,2026-09-15,2026-09-21" {
		t.Fatalf("今天起 8 天里的歇业日：%s", got)
	}
	if got := s.Upcoming(at(13, 10, 0)).ClosedDates; strings.Join(got, ",") != "2026-09-15" {
		t.Fatalf("给人看的设置不该再列已过去的歇业日：%v", got)
	}
	if got := DefaultSettings().ClosedDays(at(13, 10, 0), 7); got == nil || len(got) != 0 {
		t.Fatalf("没设歇业时应是空列表：%v", got)
	}
}

// 爽约限制默认不开；窗口是门店时区里含今天在内最近 N 天的第一天零点；次数和天数有范围。
func TestNoShowRule(t *testing.T) {
	s := DefaultSettings()
	if s.NoShowLimit != 0 || s.NoShowWindowDays != 30 || s.Suspended(100) {
		t.Fatalf("爽约限制默认应不限制、统计 30 天：%+v", s)
	}
	s.NoShowLimit, s.NoShowWindowDays = 2, 30
	if s.Suspended(1) || !s.Suspended(2) || !s.Suspended(3) {
		t.Fatal("达到次数才暂停")
	}
	if got := s.NoShowSince(at(13, 23, 59)); !got.Equal(time.Date(2026, 8, 15, 0, 0, 0, 0, storetime.Location)) {
		t.Fatalf("最近 30 天应从 8 月 15 日零点（门店时间）算起：%s", got)
	}
	// UTC 9 月 12 日 16:00 是门店 13 日零点：窗口跟门店的日期走
	if got := s.NoShowSince(time.Date(2026, 9, 12, 16, 0, 0, 0, time.UTC)); !got.Equal(time.Date(2026, 8, 15, 0, 0, 0, 0, storetime.Location)) {
		t.Fatalf("窗口要按门店时区的今天算：%s", got)
	}
	s.NoShowWindowDays = 1
	if got := s.NoShowSince(at(13, 10, 0)); !got.Equal(at(13, 0, 0)) {
		t.Fatalf("最近 1 天就是今天零点起：%s", got)
	}
	for name, c := range map[string][2]int{"次数为负": {-1, 30}, "次数太多": {21, 30}, "天数为 0": {2, 0}, "天数超过一年": {2, 366}} {
		bad := DefaultSettings()
		bad.NoShowLimit, bad.NoShowWindowDays = c[0], c[1]
		if _, err := bad.Normalize(DefaultSettings(), at(13, 10, 0)); !errors.Is(err, ErrNoShowRule) {
			t.Fatalf("%s：应为 ErrNoShowRule，实得 %v", name, err)
		}
	}
}

// 提前几小时发微信提醒：没设置过时按 2 小时、不写进 JSON（设置版本不变）；0 不提醒；0～24 之外拒收。
func TestRemindHours(t *testing.T) {
	s := DefaultSettings()
	if s.ReminderHours() != DefaultRemindHours {
		t.Fatalf("默认 %d 小时", s.ReminderHours())
	}
	if b, _ := json.Marshal(s); strings.Contains(string(b), "remindHours") {
		t.Fatalf("没设置过时不写进 JSON：%s", b)
	}
	for _, hours := range []int{0, 1, 24} {
		s.RemindHours = &hours
		if _, err := s.Normalize(DefaultSettings(), at(13, 10, 0)); err != nil || s.ReminderHours() != hours {
			t.Fatalf("%d 小时：%v", hours, err)
		}
	}
	for _, hours := range []int{-1, 25} {
		s.RemindHours = &hours
		if _, err := s.Normalize(DefaultSettings(), at(13, 10, 0)); !errors.Is(err, ErrRemindHours) {
			t.Fatalf("%d 小时应拒收：%v", hours, err)
		}
	}
}
