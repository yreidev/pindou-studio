package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	member "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/membership/application"
	reserve "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/reservations/domain"
)

type storefrontView struct {
	Announcement *struct{ Body string }
	Contact      struct {
		Phone, Wechat, Address string
		Latitude, Longitude    *float64
	}
	Today struct {
		Date, Status, OpensAt, ClosesAt string
	}
	SelfService bool
	Slots       []struct {
		StartAt   time.Time
		Remaining int
	}
	Featured []libraryPattern
}

func storefrontOf(t *testing.T, s *Server, bearer string) storefrontView {
	t.Helper()
	w := call(t, s, http.MethodGet, "/api/v2/storefront", bearer, "", nil)
	if w.Code != 200 {
		t.Fatalf("storefront: %d %s", w.Code, w.Body.String())
	}
	var out storefrontView
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode %q: %v", w.Body.String(), err)
	}
	return out
}

// storefrontShop 是按门店布局建好全部桌位（21 个可约单位，D 区双人桌各算一个）、发布了两小时和三小时套餐的店，
// 此刻门店时间 2026-10-20（周二）10:20，预约设置是默认的（9:00～22:00、时段 30 分钟、提前 30 分钟）。
type storefrontShop struct {
	*patternShop
	twoHours, threeHours string
}

func newStorefrontShop(t *testing.T) *storefrontShop {
	t.Helper()
	p := newPatternShop(t)
	if err := p.s.ReconcileLayout(context.Background()); err != nil {
		t.Fatal(err)
	}
	pack := func(name string, minutes int) string {
		return publishRule(t, p.s, p.owner.AccessToken, member.Rule{Kind: "package", Name: name, AmountCents: 6000, DurationMinutes: minutes, RenewalMinutes: 60, RenewalCents: 2000, PauseLimitMinutes: 10, Overtime: "manual"}).ID
	}
	return &storefrontShop{patternShop: p, threeHours: pack("三小时", 180), twoHours: pack("两小时", 120)}
}

func (f *storefrontShop) settings(t *testing.T, change func(*reserve.Settings)) *httptest.ResponseRecorder {
	t.Helper()
	settings := reservationSettingsOf(t, f.s)
	change(&settings)
	return reservationCall(t, f.s, f.owner.AccessToken, reservationInput{Action: "save_settings", Settings: &settings, ExpectedVersion: member.Version(reservationSettingsOf(t, f.s))})
}

func slotTimes(v storefrontView) []string {
	var out []string
	for _, s := range v.Slots {
		out = append(out, s.StartAt.In(cst).Format("15:04"))
	}
	return out
}

func remaining(v storefrontView) []int {
	var out []int
	for _, s := range v.Slots {
		out = append(out, s.Remaining)
	}
	return out
}

// 「今天还能约」：游客也能看，从下一个整点起列最多 4 个，每个按最短的套餐（两小时）算还能自助约上几个位置，
// 口径同顾客自助下单——被预约占着的位置不算，双人桌整张算一个；离打烊排不下最短套餐的整点不列。
// 关了自助预约或今天店休时不列。
func TestStorefrontListsTodaysOpenHours(t *testing.T) {
	f := newStorefrontShop(t)
	s := f.s
	got := storefrontOf(t, s, "")
	if got.Today.Date != "2026-10-20" || got.Today.Status != "open" || got.Today.OpensAt != "09:00" || got.Today.ClosesAt != "22:00" || !got.SelfService {
		t.Fatalf("今天：%+v %v", got.Today, got.SelfService)
	}
	if times := strings.Join(slotTimes(got), ","); times != "11:00,12:00,13:00,14:00" {
		t.Fatalf("最近 4 个整点：%s", times)
	}
	if left := remaining(got); left[0] != 21 || left[3] != 21 {
		t.Fatalf("没有预约时 21 个位置都空着：%v", left)
	}
	if got.Announcement != nil || len(got.Featured) != 0 || got.Contact.Latitude != nil {
		t.Fatalf("还没有公告、图纸和地址：%+v", got)
	}

	// 12:00 约走 B1 两小时（12～14 点），14:00 约走 D1 双人桌整张
	book := func(bearer, table, pack string, at time.Time) {
		t.Helper()
		reservationOK(t, s, bearer, reservationInput{Action: "book", TableID: tableByCode(t, s, table).ID, SeatNumber: 1, PackageID: pack, StartAt: at.Format(time.RFC3339)})
	}
	day := func(h int) time.Time { return time.Date(2026, 10, 20, h, 0, 0, 0, cst) }
	other := register(t, s, "storefront-other", "另一位")
	book(f.customer.AccessToken, "B1", f.twoHours, day(12))
	book(other.AccessToken, "D1", f.twoHours, day(14))
	if left := remaining(storefrontOf(t, s, f.customer.AccessToken)); left[0] != 20 || left[1] != 20 || left[2] != 19 || left[3] != 20 {
		t.Fatalf("11、12 点和 B1 撞，13 点（到 15 点）两张都撞，14 点 D1 整张被约：%v", left)
	}

	// 晚上：20:00 之后排不下两小时，只剩 20:00 一个
	*f.clock = time.Date(2026, 10, 20, 18, 50, 0, 0, cst)
	if times := strings.Join(slotTimes(storefrontOf(t, s, "")), ","); times != "20:00" {
		t.Fatalf("19:00 离现在不到 30 分钟，21:00 起排不下两小时：%s", times)
	}
	// 打烊后、开门前
	*f.clock = time.Date(2026, 10, 20, 22, 5, 0, 0, cst)
	if got := storefrontOf(t, s, ""); got.Today.Status != "closed" || len(got.Slots) != 0 {
		t.Fatalf("打烊后：%+v", got)
	}
	*f.clock = time.Date(2026, 10, 21, 7, 40, 0, 0, cst)
	if got := storefrontOf(t, s, ""); got.Today.Status != "closed" || strings.Join(slotTimes(got), ",") != "09:00,10:00,11:00,12:00" {
		t.Fatalf("开门前：%+v %v", got.Today, slotTimes(got))
	}

	if w := f.settings(t, func(set *reserve.Settings) { set.ClosedWeekdays = []int{3} }); w.Code != 200 {
		t.Fatalf("设每周三休息：%d %s", w.Code, w.Body.String())
	}
	if got := storefrontOf(t, s, ""); got.Today.Status != "day_off" || len(got.Slots) != 0 {
		t.Fatalf("今天店休：%+v", got)
	}
	f.settings(t, func(set *reserve.Settings) { set.ClosedWeekdays = []int{}; set.Enabled = false })
	if got := storefrontOf(t, s, ""); got.SelfService || len(got.Slots) != 0 || got.Today.Status != "closed" {
		t.Fatalf("关了自助预约：%+v", got)
	}
}

// 门店地址和经纬度在预约设置里填：首页门店一行显示，经纬度要一起填；本周上新放 3 张，上新的在前、不够按图纸顺序补。
func TestStorefrontShowsAddressAndFeaturedPatterns(t *testing.T) {
	f := newStorefrontShop(t)
	s := f.s
	if w := f.settings(t, func(set *reserve.Settings) { lat := 39.1; set.Latitude = &lat }); w.Code != 400 || errorCodeOf(t, w) != "invalid_request" {
		t.Fatalf("只填纬度：%d %s", w.Code, w.Body.String())
	}
	if w := f.settings(t, func(set *reserve.Settings) {
		lat, lng := 39.118, 117.199
		set.Address, set.Latitude, set.Longitude, set.ContactPhone = " 天津市和平区南京路 1 号 ", &lat, &lng, "022-8888 6666"
	}); w.Code != 200 {
		t.Fatalf("填地址：%d %s", w.Code, w.Body.String())
	}
	got := storefrontOf(t, s, "").Contact
	if got.Address != "天津市和平区南京路 1 号" || *got.Latitude != 39.118 || *got.Longitude != 117.199 || got.Phone != "022-8888 6666" || got.Wechat != "" {
		t.Fatalf("门店联系方式：%+v", got)
	}

	// 十天前传了三张、上架两张；今天第一次上架第三张，又传了一张没上架的
	*f.clock = f.clock.AddDate(0, 0, -10)
	old1 := f.uploaded(t, "草莓", f.fruit, true)
	old2 := f.uploaded(t, "郁金香", f.flowers, true)
	later := f.uploaded(t, "小熊", nil, false)
	*f.clock = f.clock.AddDate(0, 0, 10)
	f.uploaded(t, "草稿", nil, false)
	call(t, s, http.MethodPatch, "/api/v2/pattern-order", f.clerk.AccessToken, "", map[string]any{"ids": func() []string {
		var ids []string
		for _, p := range f.library(t, f.clerk.AccessToken, "all").Patterns {
			ids = append([]string{p.ID}, ids...)
		}
		return ids
	}()})
	f.patch(t, f.clerk.AccessToken, later, map[string]any{"published": true})
	featured := storefrontOf(t, s, "").Featured
	if len(featured) != 3 || featured[0].ID != later || !featured[0].IsNew || featured[1].ID != old1 || featured[2].ID != old2 {
		t.Fatalf("上新的在前，再按图纸顺序（草莓、郁金香）：%+v", featured)
	}
}

// 首页公告：所有员工都能发，200 字以内可以换行，到期日不能早于今天，到期那天还显示、过了那天顾客不再看到
// （员工读得到，标着已过期）；清空就是删除。都记审计。
func TestStaffPostAnnouncements(t *testing.T) {
	f := newPatternShop(t)
	s := f.s
	get := func(bearer string) *httptest.ResponseRecorder {
		return call(t, s, http.MethodGet, "/api/v2/storefront/announcement", bearer, "", nil)
	}
	put := func(bearer string, body map[string]any) *httptest.ResponseRecorder {
		return call(t, s, http.MethodPatch, "/api/v2/storefront/announcement", bearer, "", body)
	}
	if w := get(f.clerk.AccessToken); w.Code != 200 || decodeMap(t, w)["announcement"] != nil {
		t.Fatalf("还没有公告：%d %s", w.Code, w.Body.String())
	}
	if w := get(f.customer.AccessToken); w.Code != 403 {
		t.Fatalf("顾客读编辑用的公告：%d", w.Code)
	}
	for label, c := range map[string]struct {
		bearer string
		body   map[string]any
		status int
		code   string
	}{
		"顾客不能发":   {f.customer.AccessToken, map[string]any{"body": "通知"}, 403, "forbidden"},
		"太长":      {f.clerk.AccessToken, map[string]any{"body": strings.Repeat("长", 201)}, 400, "invalid_announcement"},
		"到期日早于今天": {f.clerk.AccessToken, map[string]any{"body": "通知", "expiresOn": "2026-10-19"}, 400, "invalid_announcement"},
		"到期日不是日期": {f.clerk.AccessToken, map[string]any{"body": "通知", "expiresOn": "2026-02-30"}, 400, "invalid_announcement"},
	} {
		if w := put(c.bearer, c.body); w.Code != c.status || errorCodeOf(t, w) != c.code {
			t.Errorf("%s：%d %s", label, w.Code, w.Body.String())
		}
	}

	w := put(f.clerk.AccessToken, map[string]any{"body": " 10 月 22 日店休一天\n23 日照常营业 ", "expiresOn": "2026-10-22"})
	if w.Code != 200 {
		t.Fatalf("发公告：%d %s", w.Code, w.Body.String())
	}
	saved := decodeMap(t, w)["announcement"].(map[string]any)
	if saved["body"] != "10 月 22 日店休一天\n23 日照常营业" || saved["expiresOn"] != "2026-10-22" || saved["expired"] != false {
		t.Fatalf("公告：%v", saved)
	}
	if last := lastAudit(t, s); last.Action != "announcement.saved" || last.ActorID != f.clerk.User.ID || last.Reason != "10 月 22 日店休一天\n23 日照常营业（显示到 2026-10-22）" {
		t.Fatalf("审计：%+v", last)
	}
	*f.clock = time.Date(2026, 10, 22, 23, 59, 0, 0, cst)
	if got := storefrontOf(t, s, ""); got.Announcement == nil || !strings.HasPrefix(got.Announcement.Body, "10 月 22 日店休一天") {
		t.Fatalf("到期那天还显示：%+v", got.Announcement)
	}
	*f.clock = time.Date(2026, 10, 23, 0, 0, 0, 0, cst)
	if got := storefrontOf(t, s, ""); got.Announcement != nil {
		t.Fatal("过了到期日顾客不再看到")
	}
	if got := decodeMap(t, get(f.owner.AccessToken))["announcement"].(map[string]any); got["expired"] != true {
		t.Fatalf("员工看得到已过期的：%v", got)
	}

	if w := put(f.owner.AccessToken, map[string]any{"body": "新到一批马卡龙色", "expiresOn": nil}); w.Code != 200 || decodeMap(t, w)["announcement"].(map[string]any)["expiresOn"] != nil {
		t.Fatalf("不过期的公告：%d %s", w.Code, w.Body.String())
	}
	if got := storefrontOf(t, s, ""); got.Announcement == nil || got.Announcement.Body != "新到一批马卡龙色" {
		t.Fatalf("新公告：%+v", got.Announcement)
	}
	if w := put(f.clerk.AccessToken, map[string]any{"body": "  "}); w.Code != 200 || decodeMap(t, w)["announcement"] != nil {
		t.Fatalf("清空：%d %s", w.Code, w.Body.String())
	}
	if lastAudit(t, s).Action != "announcement.cleared" || storefrontOf(t, s, "").Announcement != nil {
		t.Fatal("清空要记审计，首页不再显示")
	}
	audits := len(auditsOf(t, s))
	if w := put(f.clerk.AccessToken, map[string]any{"body": ""}); w.Code != 200 || len(auditsOf(t, s)) != audits {
		t.Fatal("没有公告时再清空什么都不做")
	}
}
