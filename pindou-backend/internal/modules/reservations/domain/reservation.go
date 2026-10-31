// Package domain holds seat reservation rules, independent of HTTP and SQL.
package domain

import (
	"errors"
	"fmt"
	"math"
	"slices"
	"strings"
	"time"
	"unicode"

	"github.com/yreidev/pindou-studio/pindou-backend/internal/storetime"
)

// SelfServiceLimit 是一个账号同时能有几个还没到店的预约（待确认、已确认都算），只管顾客自助预约；
// 员工代客登记不受它限制，顾客要约更多就找门店。
const SelfServiceLimit = 2

const (
	// MaxClosedDates 是最多能设几个歇业日期（已经过去的不算）。
	MaxClosedDates = 90
	// MaxNoShowLimit、MaxNoShowWindowDays 是爽约限制两项设置的上限。
	MaxNoShowLimit      = 20
	MaxNoShowWindowDays = 365
	// DefaultNoShowWindowDays 是没设置过时统计爽约的天数；默认不限制（NoShowLimit 为 0），这一项只是填表时的起点。
	DefaultNoShowWindowDays = 30
	// DefaultRemindHours 是没设置过时开始前几小时发微信提醒，MaxRemindHours 是最多提前几小时。
	DefaultRemindHours = 2
	MaxRemindHours     = 24
)

var (
	ErrInvalid  = errors.New("请检查预约的座位、套餐和时间")
	ErrClosed   = errors.New("该时间不在可预约范围内")
	ErrConflict = errors.New("该座位在这个时间段已被预约")
	// ErrLimitReached 是顾客自助预约超过 SelfServiceLimit。
	ErrLimitReached  = fmt.Errorf("每个账号最多同时预约 %d 个座位，更多座位请联系门店", SelfServiceLimit)
	ErrContactPhone  = errors.New("门店电话只能填数字、空格、+、-、括号，最多 20 个字符")
	ErrContactWechat = errors.New("门店微信号最多 40 个字符，不能有空格")
	ErrAddress       = errors.New("门店地址最多 100 个字，不能换行")
	ErrLocation      = errors.New("经纬度要一起填：纬度在 -90～90 之间、经度在 -180～180 之间，都不填表示不提供导航")
	// 歇业与爽约限制的设置填得不对。
	ErrClosedDate     = errors.New("歇业日期要写成 2026-10-08 这样的日期，最远设到一年以后")
	ErrClosedDatePast = errors.New("歇业日期不能早于今天")
	ErrClosedDates    = fmt.Errorf("歇业日期最多设 %d 个", MaxClosedDates)
	ErrClosedWeekdays = errors.New("每周休息日只能选周一到周日，最多 6 天；整周都不接待请关闭自助预约")
	ErrNoShowRule     = fmt.Errorf("爽约次数要在 0–%d 之间（0 表示不限制），统计天数要在 1–%d 之间", MaxNoShowLimit, MaxNoShowWindowDays)
	ErrRemindHours    = fmt.Errorf("提前几小时提醒要在 0–%d 之间（0 表示不提醒）", MaxRemindHours)
	// ErrStoreClosed 是顾客自助预约落在歇业日；员工代客登记不受它限制。
	ErrStoreClosed = errors.New("门店这天歇业，请换一天预约")
	// ErrSuspended 是顾客最近爽约次数达到老板设的上限，暂停自助预约；员工代客登记不受它限制。
	ErrSuspended = errors.New("最近爽约次数较多，暂时不能自助预约，请联系门店")
)

// Settings bounds when customers may book. One store keeps one record; the
// defaults let reservations work before the owner fills in real opening hours.
//
// ContactPhone、ContactWechat 是门店联系方式，顾客约满上限、想包间时找门店用；空串表示没填。
// 没填时不写进 JSON：设置的版本按 JSON 算，这样没填联系方式的设置版本和加字段之前一样。
// Address、Latitude、Longitude 是门店地址和经纬度（迁移 025 一起加，2026-10-20 业主定）：首页门店一行显示地址，
// 「导航」按经纬度打开地图（腾讯地图坐标拾取得到的 GCJ-02）。同样没填时不写进 JSON；经纬度要么都有要么都没有。
//
// 歇业：ClosedDates 是门店时区的日期（YYYY-MM-DD，去重排序），ClosedWeekdays 是每周固定休息日
// （1 周一 … 7 周日）。这些天顾客不能自助预约；员工代客登记不受限，已经约在这些天的预约不自动取消、不改状态。
// 爽约限制：门店时区里含今天在内最近 NoShowWindowDays 天，被员工标记爽约达到 NoShowLimit 次的账号暂停自助预约；
// NoShowLimit 为 0 表示不限制（默认）。员工代客登记不受限。
// 这四项总写进 JSON（空的是 []、0），老库里没有这几个键时读出来是 DefaultSettings 的值。
// RemindHours 是开始前几小时给允许了微信提醒的顾客发一条提醒，0 不提醒（迁移 026，2026-10-20 业主定）：没设置过时为 nil、
// 不写进 JSON（设置的版本和加字段之前一样），按 DefaultRemindHours 算，用 ReminderHours 读。
type Settings struct {
	Enabled          bool     `json:"enabled"`
	OpenMinute       int      `json:"openMinute"`
	CloseMinute      int      `json:"closeMinute"`
	SlotMinutes      int      `json:"slotMinutes"`
	AdvanceDays      int      `json:"advanceDays"`
	LeadMinutes      int      `json:"leadMinutes"`
	GraceMinutes     int      `json:"graceMinutes"`
	ContactPhone     string   `json:"contactPhone,omitempty"`
	ContactWechat    string   `json:"contactWechat,omitempty"`
	Address          string   `json:"address,omitempty"`
	Latitude         *float64 `json:"latitude,omitempty"`
	Longitude        *float64 `json:"longitude,omitempty"`
	ClosedDates      []string `json:"closedDates"`
	ClosedWeekdays   []int    `json:"closedWeekdays"`
	NoShowLimit      int      `json:"noShowLimit"`
	NoShowWindowDays int      `json:"noShowWindowDays"`
	RemindHours      *int     `json:"remindHours,omitempty"`
}

// ReminderHours 是开始前几小时发提醒（0 不提醒）。
func (s Settings) ReminderHours() int {
	if s.RemindHours == nil {
		return DefaultRemindHours
	}
	return *s.RemindHours
}

func DefaultSettings() Settings {
	return Settings{Enabled: true, OpenMinute: 9 * 60, CloseMinute: 22 * 60, SlotMinutes: 30, AdvanceDays: 7, LeadMinutes: 30, GraceMinutes: 30,
		ClosedDates: []string{}, ClosedWeekdays: []int{}, NoShowWindowDays: DefaultNoShowWindowDays}
}

// Normalize 整理老板提交的设置再整体校验，返回要保存的设置：联系方式去掉首尾空白；歇业日期、每周休息日去重排序。
// 歇业日期只能是今天（门店时区）及以后：已经过去的日子里，原来就存着的（previous）悄悄去掉——日子过了自然作废，
// 跨过零点保存也不该因此失败；新加的拒收。
func (s Settings) Normalize(previous Settings, now time.Time) (Settings, error) {
	s.ContactPhone = strings.TrimSpace(s.ContactPhone)
	s.ContactWechat = strings.TrimSpace(s.ContactWechat)
	s.Address = strings.TrimSpace(s.Address)
	today, last := Today(now), now.In(storetime.Location).AddDate(1, 0, 0).Format(time.DateOnly)
	dates := make([]string, 0, len(s.ClosedDates))
	for _, d := range s.ClosedDates {
		d = strings.TrimSpace(d)
		if !validDay(d) || d > last {
			return s, ErrClosedDate
		}
		if d < today {
			if slices.Contains(previous.ClosedDates, d) {
				continue
			}
			return s, ErrClosedDatePast
		}
		dates = append(dates, d)
	}
	slices.Sort(dates)
	s.ClosedDates = slices.Compact(dates)
	weekdays := append([]int{}, s.ClosedWeekdays...)
	slices.Sort(weekdays)
	s.ClosedWeekdays = slices.Compact(weekdays)
	return s, s.Validate()
}

func (s Settings) Validate() error {
	if s.OpenMinute < 0 || s.CloseMinute > 24*60 || s.CloseMinute-s.OpenMinute < 60 {
		return ErrInvalid
	}
	if s.SlotMinutes < 5 || s.SlotMinutes > 240 || s.OpenMinute%s.SlotMinutes != 0 {
		return ErrInvalid
	}
	if s.AdvanceDays < 1 || s.AdvanceDays > 90 || s.LeadMinutes < 0 || s.LeadMinutes > 1440 || s.GraceMinutes < 5 || s.GraceMinutes > 240 {
		return ErrInvalid
	}
	if len(s.ContactPhone) > 20 || strings.TrimFunc(s.ContactPhone, phoneRune) != "" {
		return ErrContactPhone
	}
	if len([]rune(s.ContactWechat)) > 40 || strings.IndexFunc(s.ContactWechat, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) }) >= 0 {
		return ErrContactWechat
	}
	if len([]rune(s.Address)) > 100 || strings.IndexFunc(s.Address, unicode.IsControl) >= 0 {
		return ErrAddress
	}
	if (s.Latitude == nil) != (s.Longitude == nil) ||
		(s.Latitude != nil && (math.IsNaN(*s.Latitude) || *s.Latitude < -90 || *s.Latitude > 90 || math.IsNaN(*s.Longitude) || *s.Longitude < -180 || *s.Longitude > 180)) {
		return ErrLocation
	}
	if len(s.ClosedDates) > MaxClosedDates {
		return ErrClosedDates
	}
	for _, d := range s.ClosedDates {
		if !validDay(d) {
			return ErrClosedDate
		}
	}
	if len(s.ClosedWeekdays) > 6 {
		return ErrClosedWeekdays
	}
	for i, w := range s.ClosedWeekdays {
		if w < 1 || w > 7 || slices.Contains(s.ClosedWeekdays[:i], w) {
			return ErrClosedWeekdays
		}
	}
	if s.NoShowLimit < 0 || s.NoShowLimit > MaxNoShowLimit || s.NoShowWindowDays < 1 || s.NoShowWindowDays > MaxNoShowWindowDays {
		return ErrNoShowRule
	}
	if s.RemindHours != nil && (*s.RemindHours < 0 || *s.RemindHours > MaxRemindHours) {
		return ErrRemindHours
	}
	return nil
}

// Today 是门店时区的今天（YYYY-MM-DD）。
func Today(now time.Time) string {
	return now.In(storetime.Location).Format(time.DateOnly)
}

// validDay 是写成 YYYY-MM-DD 的一个真实日期（不收 2026-2-30、2026-1-5 这类写法）。
func validDay(d string) bool {
	t, err := time.ParseInLocation(time.DateOnly, d, storetime.Location)
	return err == nil && t.Format(time.DateOnly) == d
}

// isoWeekday 把 time.Weekday（0 周日）换成 1 周一 … 7 周日。
func isoWeekday(w time.Weekday) int {
	if w == time.Sunday {
		return 7
	}
	return int(w)
}

// ClosedOn 报告 at 所在的那一天（门店时区）是不是歇业日：设了的歇业日期，或每周固定休息日。
func (s Settings) ClosedOn(at time.Time) bool {
	local := at.In(storetime.Location)
	return slices.Contains(s.ClosedDates, local.Format(time.DateOnly)) || slices.Contains(s.ClosedWeekdays, isoWeekday(local.Weekday()))
}

// ClosedDays 列出门店时区里从今天起到 days 天之后（含两头）的歇业日，顾客的日期条、员工代客登记据此标出店休，
// 不用各自去算每周休息日落在哪天。
func (s Settings) ClosedDays(now time.Time, days int) []string {
	local := now.In(storetime.Location)
	// 取当天正午往后数整天：门店时区没有夏令时，正午加减整天总落在目标那一天
	noon := time.Date(local.Year(), local.Month(), local.Day(), 12, 0, 0, 0, storetime.Location)
	out := []string{}
	for i := 0; i <= days; i++ {
		if day := noon.AddDate(0, 0, i); s.ClosedOn(day) {
			out = append(out, day.Format(time.DateOnly))
		}
	}
	return out
}

// Upcoming 是给人看的设置：已经过去的歇业日期不再列出（存着的那份在下次保存时去掉）。
func (s Settings) Upcoming(now time.Time) Settings {
	today := Today(now)
	dates := make([]string, 0, len(s.ClosedDates))
	for _, d := range s.ClosedDates {
		if d >= today {
			dates = append(dates, d)
		}
	}
	s.ClosedDates = dates
	if s.ClosedWeekdays == nil {
		s.ClosedWeekdays = []int{}
	}
	return s
}

// NoShowSince 是统计爽约的起点：门店时区里含今天在内最近 NoShowWindowDays 天的第一天零点。
// 按预约的开始时间算（爽约只能在开始之后标记，所以都不晚于此刻）。
func (s Settings) NoShowSince(now time.Time) time.Time {
	local := now.In(storetime.Location)
	return time.Date(local.Year(), local.Month(), local.Day()-(s.NoShowWindowDays-1), 0, 0, 0, 0, storetime.Location)
}

// Suspended 报告统计窗口里爽约 noShows 次的账号是否暂停自助预约；NoShowLimit 为 0 时不限制。
func (s Settings) Suspended(noShows int) bool {
	return s.NoShowLimit > 0 && noShows >= s.NoShowLimit
}

// CloseAt 是 at 所在那一天（门店时区）的打烊时刻：当天零点加每天结束时间（CloseMinute，最晚 24:00 即次日零点）。
func (s Settings) CloseAt(at time.Time) time.Time {
	local := at.In(storetime.Location)
	return time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, storetime.Location).Add(time.Duration(s.CloseMinute) * time.Minute)
}

// MinutesUntilClose 是「到打烊」的套餐从 start 起用多少分钟：到当天打烊为止，不足一分钟按一分钟（结束时间不早于打烊）。
// 已到或过了打烊返回 0，调用方据此拒绝。
func (s Settings) MinutesUntilClose(start time.Time) int {
	left := s.CloseAt(start).Sub(start)
	if left <= 0 {
		return 0
	}
	return int((left + time.Minute - 1) / time.Minute)
}

// phoneRune 是门店电话里允许的字符：数字、空格、+、-、括号（区号、分机常这么写）。
func phoneRune(r rune) bool {
	return (r >= '0' && r <= '9') || strings.ContainsRune(" +-()", r)
}

// Reservation holds one seat for one window. It carries no money: the package
// order is created when staff seat the customer through the existing flow.
type Reservation struct {
	ID              string     `json:"id"`
	AccountID       string     `json:"accountId,omitempty"`
	GuestName       string     `json:"guestName,omitempty"`
	TableID         string     `json:"serviceTableId"`
	SeatNumber      int        `json:"seatNumber"`
	PackageID       string     `json:"packageId"`
	PackageName     string     `json:"packageName"`
	DurationMinutes int        `json:"durationMinutes"`
	AmountCents     int64      `json:"amountCents"`
	StartAt         time.Time  `json:"startAt"`
	Status          string     `json:"status"`
	SessionID       string     `json:"venueSessionId,omitempty"`
	Note            string     `json:"note,omitempty"`
	Reason          string     `json:"reason,omitempty"`
	CreatedBy       string     `json:"createdBy"`
	CreatedAt       time.Time  `json:"createdAt"`
	DecidedAt       *time.Time `json:"decidedAt,omitempty"`
	// Coupon 是顾客在美团、大众点评买的团购（或到店再买），选填；没填时不写进 JSON，旧预约的版本不变。
	Coupon *Coupon `json:"coupon,omitempty"`
}

// 团购记录（2026-10-10 业主决定）：门店的钱都在美团、大众点评收，单店接不了美团的验券接口，由店员在美团开店宝
// 扫顾客手机上的券码核销，系统只记平台和券码，店员确认入座、到店开台时看到。预约和扫码入座都能填，都选填。
const (
	CouponMeituan  = "meituan"
	CouponDianping = "dianping"
	// CouponInStore 是还没买，到店再买：不用填券码。
	CouponInStore = "in_store"
	// MaxCouponCode 是券码最长几位（美团券码多是 12 位数字，其余格式未确认，放宽到 32 位）。
	MaxCouponCode = 32
)

// ErrCoupon 是团购记录填得不对。
var ErrCoupon = fmt.Errorf("团购平台只能选美团、大众点评或到店再买；券码只能是字母和数字，最长 %d 位，到店再买不用填券码", MaxCouponCode)

// Coupon 是一条团购记录：平台和券码（券码选填）。
type Coupon struct {
	Platform string `json:"platform"`
	Code     string `json:"code,omitempty"`
}

// NormalizeCoupon 整理请求里的团购记录：券码去掉空白（顾客常照着手机上「1234 5678 9012」的样子分段抄），
// 平台和券码都空表示不记（返回 nil）。
func NormalizeCoupon(c *Coupon) (*Coupon, error) {
	if c == nil {
		return nil, nil
	}
	code := strings.Join(strings.Fields(c.Code), "")
	if c.Platform == "" && code == "" {
		return nil, nil
	}
	switch c.Platform {
	case CouponMeituan, CouponDianping:
	case CouponInStore:
		if code != "" {
			return nil, ErrCoupon
		}
	default:
		return nil, ErrCoupon
	}
	if len(code) > MaxCouponCode || strings.IndexFunc(code, func(r rune) bool {
		return (r < '0' || r > '9') && (r < 'a' || r > 'z') && (r < 'A' || r > 'Z')
	}) >= 0 {
		return nil, ErrCoupon
	}
	return &Coupon{Platform: c.Platform, Code: code}, nil
}

func (r Reservation) EndAt() time.Time {
	return r.StartAt.Add(time.Duration(r.DurationMinutes) * time.Minute)
}

// Live reports whether the customer may still turn up, which is exactly when
// the reservation keeps holding its seat. Nothing rewrites the stored status in
// the background: a reservation left unattended stops blocking the seat once
// the grace period runs out, and staff still settle it as seated or no-show.
func (r Reservation) Live(now time.Time, grace int) bool {
	if r.Status != "pending" && r.Status != "confirmed" {
		return false
	}
	return now.Before(r.StartAt.Add(time.Duration(grace) * time.Minute))
}

// Display adds the derived expired state that staff and customers see; the
// stored status only changes through an explicit action.
func (r Reservation) Display(now time.Time, grace int) string {
	if (r.Status == "pending" || r.Status == "confirmed") && !r.Live(now, grace) {
		return "expired"
	}
	return r.Status
}

// Blocks reports whether an existing reservation stands in the way of the
// window a new booking or a walk-in asks for on the same seat.
func (r Reservation) Blocks(table string, seat int, start, end time.Time, now time.Time, grace int) bool {
	if r.TableID != table || r.SeatNumber != seat || !r.Live(now, grace) {
		return false
	}
	return start.Before(r.EndAt()) && r.StartAt.Before(end)
}

// Window checks the requested start against the opening hours, the slot grid
// and how far ahead bookings are accepted.
func Window(start time.Time, duration int, s Settings, now time.Time) error {
	if duration < 1 || duration > 1440 {
		return ErrInvalid
	}
	if !start.After(now.Add(time.Duration(s.LeadMinutes) * time.Minute)) {
		return ErrClosed
	}
	local := start.In(storetime.Location)
	if local.After(now.In(storetime.Location).AddDate(0, 0, s.AdvanceDays)) {
		return ErrClosed
	}
	if local.Second() != 0 || local.Nanosecond() != 0 {
		return ErrInvalid
	}
	minute := local.Hour()*60 + local.Minute()
	if minute%s.SlotMinutes != 0 || minute < s.OpenMinute || minute+duration > s.CloseMinute {
		return ErrClosed
	}
	return nil
}

// Name limits what staff may store for a customer who has no account. Only a
// form of address is kept; phone numbers stay out of reservations.
func Name(v string) (string, error) {
	v = strings.TrimSpace(v)
	if len([]rune(v)) > 20 {
		return "", ErrInvalid
	}
	return v, nil
}

func Note(v string) (string, error) {
	v = strings.TrimSpace(v)
	if len([]rune(v)) > 200 {
		return "", ErrInvalid
	}
	return v, nil
}
