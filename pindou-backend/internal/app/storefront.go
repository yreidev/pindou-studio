package app

import (
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/yreidev/pindou-studio/pindou-backend/internal/layout"
	reserve "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/reservations/domain"
	"github.com/yreidev/pindou-studio/pindou-backend/internal/storage/queries"
	"github.com/yreidev/pindou-studio/pindou-backend/internal/storetime"
)

// 小程序首页（2026-10-20 业主定，方案见 docs/plan-home-and-patterns.md）：游客也能看，一次读齐公告、门店联系方式与地址、
// 今天的营业状态、今天还能约和本周上新。登录后的状态卡（正在店里、今天有预约）照旧读各自的接口。

// storefrontSlotCount 是「今天还能约」最多列几个整点。
const storefrontSlotCount = 4

// storefrontFeatured 是首页「本周上新」放几张。
const storefrontFeatured = 3

// announcement 是首页公告；ExpiresOn 为空表示不过期。
type announcement struct {
	Body, ExpiresOn string
	UpdatedAt       time.Time
}

func (q *txn) announcement() *announcement {
	rows := must(q.db().StorefrontAnnouncement(q.ctx))
	if len(rows) == 0 {
		return nil
	}
	return &announcement{Body: rows[0].Body, ExpiresOn: rows[0].ExpiresOn, UpdatedAt: rows[0].UpdatedAt}
}

// expired 报告公告是否已过期：到期日（门店日期）那天还显示，过了那天不再显示。
func (a announcement) expired(now time.Time) bool {
	return a.ExpiresOn != "" && a.ExpiresOn < reserve.Today(now)
}

func announcementView(a *announcement, now time.Time) map[string]any {
	if a == nil {
		return nil
	}
	view := map[string]any{"body": a.Body, "expiresOn": nil, "updatedAt": a.UpdatedAt, "expired": a.expired(now)}
	if a.ExpiresOn != "" {
		view["expiresOn"] = a.ExpiresOn
	}
	return view
}

// storeToday 是首页门店一行：营业中（open）、已打烊或还没开门（closed）、今天店休（day_off），和今天的营业时间。
// 营业时间就是「营业与预约」里的每天开始、结束时间（不另设），店休按歇业日期和每周休息日。
func storeToday(set reserve.Settings, now time.Time) map[string]any {
	local := now.In(storetime.Location)
	minute := local.Hour()*60 + local.Minute()
	status := "closed"
	switch {
	case set.ClosedOn(now):
		status = "day_off"
	case minute >= set.OpenMinute && minute < set.CloseMinute:
		status = "open"
	}
	clock := func(m int) string { return time.Date(0, 1, 1, m/60, m%60, 0, 0, time.UTC).Format("15:04") }
	closes := clock(set.CloseMinute % (24 * 60))
	if set.CloseMinute == 24*60 {
		closes = "24:00"
	}
	return map[string]any{"date": reserve.Today(now), "status": status, "opensAt": clock(set.OpenMinute), "closesAt": closes}
}

// storefrontSlots 是「今天还能约」：从此刻往后、今天之内最近的几个整点，每个整点还有几个位置顾客能自助约上。
//
// 口径和顾客自助下单一致（reservationAction 的 book）：这个整点要在可约范围里（开始结束时间、最短提前、时段粒度），
// 时长按最短的已发布套餐（「到打烊」的套餐按到打烊的分钟数）；位置要没被还没过期的预约占着（整桌单位看整张桌），
// 也没被现场的定时会话、等结账的会话挡着。一个可约单位（平面图上的一个位置，双人桌也是一个）算一座。
// 门店关了自助预约、今天歇业时没有；排不下最短套餐的整点跳过（还没开门、离现在太近、离打烊太近）。
func (s *Server) storefrontSlots(q *txn, set reserve.Settings, now time.Time) []map[string]any {
	out := []map[string]any{}
	if !set.Enabled || set.ClosedOn(now) {
		return out
	}
	var packages []int
	untilClose := false
	for _, rule := range offeredRules(q, q.membership().Rules()) {
		if rule.Kind != "package" || packageUsable(q, rule) != nil {
			continue
		}
		if rule.UntilClose {
			untilClose = true
		} else {
			packages = append(packages, rule.DurationMinutes)
		}
	}
	codes := map[string]bool{}
	for _, t := range layout.Get().Tables {
		codes[t.Code] = true
	}
	var units []*Table
	for _, t := range q.allTables() {
		if t.Enabled && codes[t.Code] {
			units = append(units, t)
		}
	}
	reservations := q.openReservations(now)
	local := now.In(storetime.Location)
	midnight := time.Date(local.Year(), local.Month(), local.Day()+1, 0, 0, 0, 0, storetime.Location)
	for start := local.Truncate(time.Hour).Add(time.Hour); start.Before(midnight) && len(out) < storefrontSlotCount; start = start.Add(time.Hour) {
		// 最短的、在这个整点排得下的套餐
		shortest := 0
		candidates := packages
		if untilClose {
			candidates = append(append([]int{}, packages...), set.MinutesUntilClose(start))
		}
		for _, d := range candidates {
			if d >= 1 && reserve.Window(start, d, set, now) == nil && (shortest == 0 || d < shortest) {
				shortest = d
			}
		}
		if shortest == 0 {
			continue
		}
		end := start.Add(time.Duration(shortest) * time.Minute)
		free := 0
		for _, t := range units {
			if storefrontUnitFree(q, t, reservations, start, end, now, set.GraceMinutes) {
				free++
			}
		}
		out = append(out, map[string]any{"startAt": start.UTC(), "remaining": free})
	}
	return out
}

// storefrontUnitFree 报告这个可约单位（顾客订的永远是 1 号座）在 [start, end) 能不能自助约上。
func storefrontUnitFree(q *txn, t *Table, reservations []*Reservation, start, end, now time.Time, grace int) bool {
	for _, x := range reservations {
		for _, n := range unitSeats(t, 1) {
			if x.Blocks(t.ID, n, start, end, now, grace) {
				return false
			}
		}
	}
	_, _, held := sessionHold(q, t.ID, 1, start, now)
	return !held
}

// getStorefront 是小程序首页要的东西，游客也能读。联系方式和地址取自预约设置（老板在「营业与预约」填）。
func (s *Server) getStorefront(w http.ResponseWriter, r *http.Request) {
	q := s.tx(r)
	now := q.now()
	set := *q.reservationSettings()
	var notice map[string]any
	if a := q.announcement(); a != nil && !a.expired(now) {
		notice = map[string]any{"body": a.Body}
	}
	contact := map[string]any{"phone": set.ContactPhone, "wechat": set.ContactWechat, "address": set.Address, "latitude": set.Latitude, "longitude": set.Longitude}
	writeJSON(w, 200, map[string]any{
		"announcement": notice, "contact": contact, "today": storeToday(set, now),
		"selfService": set.Enabled, "slots": s.storefrontSlots(q, set, now), "featured": q.featuredPatterns(storefrontFeatured),
	})
}

// getAnnouncement 是员工编辑公告时读的：含已过期的，标出是否过期。
func (s *Server) getAnnouncement(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.staffMember(w, r); !ok {
		return
	}
	q := s.tx(r)
	writeJSON(w, 200, map[string]any{"announcement": announcementView(q.announcement(), q.now())})
}

// saveAnnouncement 是员工保存首页公告：文字 200 字以内（去掉首尾空白，空的表示清除），到期日可不填，填了不能早于今天。记审计。
func (s *Server) saveAnnouncement(w http.ResponseWriter, r *http.Request) {
	u, ok := s.staffMember(w, r)
	if !ok {
		return
	}
	var in struct {
		Body      string  `json:"body"`
		ExpiresOn *string `json:"expiresOn"`
	}
	if err := decode(r, &in); err != nil {
		s.writeError(w, r, 400, "invalid_request", err)
		return
	}
	q := s.tx(r)
	now := q.now()
	body := strings.TrimSpace(in.Body)
	expires := ""
	if in.ExpiresOn != nil {
		expires = strings.TrimSpace(*in.ExpiresOn)
	}
	switch {
	case utf8.RuneCountInString(body) > 200 || strings.IndexFunc(body, func(r rune) bool { return unicode.IsControl(r) && r != '\n' }) >= 0:
		s.writeError(w, r, 400, "invalid_announcement", errors.New("公告最多 200 个字"))
		return
	case expires != "" && !validStoreDay(expires):
		s.writeError(w, r, 400, "invalid_announcement", errors.New("到期日要写成 2026-10-08 这样的日期"))
		return
	case expires != "" && expires < reserve.Today(now):
		s.writeError(w, r, 400, "invalid_announcement", errors.New("到期日不能早于今天"))
		return
	}
	if body == "" {
		if q.announcement() != nil {
			q.fail(q.dbWrite().ClearStorefrontAnnouncement(q.ctx))
			q.audit(u.ID, "announcement.cleared", "", "", requestID(r))
		}
	} else {
		q.fail(q.dbWrite().SaveStorefrontAnnouncement(q.ctx, queries.SaveStorefrontAnnouncementParams{Body: body, ExpiresOn: expires, UpdatedBy: u.ID, UpdatedAt: now}))
		reason := body
		if expires != "" {
			reason += "（显示到 " + expires + "）"
		}
		q.audit(u.ID, "announcement.saved", "", reason, requestID(r))
	}
	writeJSON(w, 200, map[string]any{"announcement": announcementView(q.announcement(), now)})
}

// validStoreDay 是写成 YYYY-MM-DD 的一个真实日期。
func validStoreDay(d string) bool {
	t, err := time.ParseInLocation(time.DateOnly, d, storetime.Location)
	return err == nil && t.Format(time.DateOnly) == d
}
