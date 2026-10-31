package app

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/yreidev/pindou-studio/pindou-backend/internal/storetime"
)

// 会越积越多的列表在库里筛选分页（docs/plan-postgres-source-of-truth.md）：账户、会员、预约历史。
// 旧的整份视图留给还没升级的小程序，新接口对同一份数据要给出相同的内容。

// paged 读一页列表和响应头里的总数、实际页码。
func paged(t *testing.T, w *httptest.ResponseRecorder) (items []map[string]any, total, page int) {
	t.Helper()
	if w.Code != http.StatusOK {
		t.Fatalf("list: %d %s", w.Code, w.Body.String())
	}
	total, err := strconv.Atoi(w.Header().Get("X-Total-Count"))
	if err != nil {
		t.Fatalf("X-Total-Count %q", w.Header().Get("X-Total-Count"))
	}
	page, err = strconv.Atoi(w.Header().Get("X-Page"))
	if err != nil {
		t.Fatalf("X-Page %q", w.Header().Get("X-Page"))
	}
	if err := json.Unmarshal(w.Body.Bytes(), &items); err != nil {
		t.Fatal(err)
	}
	return items, total, page
}

func idsOf(items []map[string]any) []string {
	out := make([]string, 0, len(items))
	for _, x := range items {
		out = append(out, x["id"].(string))
	}
	return out
}

// registerCustomer 注册一位带指定手机号的顾客，注册时刻比上一位晚一分钟（新注册的排在前面）。
func registerCustomer(t *testing.T, s *Server, clock *time.Time, nickname, phone string) string {
	t.Helper()
	*clock = clock.Add(time.Minute)
	w := call(t, s, http.MethodPost, "/api/v2/accounts", "", "", map[string]any{"wechatLoginCode": "list-" + phone, "nickname": nickname, "phone": phone, "privacyContractVersion": "v1"})
	if w.Code != http.StatusCreated {
		t.Fatalf("register %s: %d %s", nickname, w.Code, w.Body.String())
	}
	return decodeMap(t, w)["user"].(map[string]any)["id"].(string)
}

func TestAccountSearchPagesInTheDatabase(t *testing.T) {
	s := newTestServer(t)
	clock := time.Date(2026, 10, 1, 10, 0, 0, 0, storetime.Location)
	s.now = func() time.Time { return clock }
	owner := register(t, s, "list-owner", "老板")
	if err := s.BootstrapOwner(owner.User.ID); err != nil {
		t.Fatal(err)
	}
	zhang := registerCustomer(t, s, &clock, "张三", "13800000001")
	alice := registerCustomer(t, s, &clock, "Alice", "13900001234")
	alice2 := registerCustomer(t, s, &clock, "alice 二号", "13700005678")
	customer := registerCustomer(t, s, &clock, "李四", "13600009999")
	search := func(query string) ([]string, int, int) {
		t.Helper()
		items, total, page := paged(t, call(t, s, http.MethodGet, "/api/v2/accounts?"+query, owner.AccessToken, "", nil))
		for _, x := range items {
			if x["phoneMasked"] == nil || x["avatarDataUrl"] != nil || x["phone"] != nil {
				t.Fatalf("account summary leaks or lacks fields: %v", x)
			}
		}
		return idsOf(items), total, page
	}
	cases := []struct {
		query string
		want  []string
	}{
		{"q=alice&pageSize=10", []string{alice2, alice}},  // 不分大小写，新注册的在前
		{"q=ALICE&pageSize=10", []string{alice2, alice}},  // 关键字也不分大小写
		{"q=%20张%20&pageSize=10", []string{zhang}},        // 去掉首尾空白
		{"q=1234&pageSize=10", []string{alice}},           // 打码手机号的后四位
		{"q=139****1234&pageSize=10", []string{alice}},    // 与页面上显示的打码手机号一致
		{"q=13600009999&pageSize=10", []string{customer}}, // 完整手机号
		{"q=" + zhang[:8] + "&pageSize=10", []string{zhang}},
		{"q=00000&pageSize=10", []string{}}, // 完整手机号的中段不在打码后的号码里，找不到
		{"q=没有这个人&pageSize=10", []string{}},
	}
	for _, c := range cases {
		got, total, _ := search(c.query)
		if !reflect.DeepEqual(got, c.want) || total != len(c.want) {
			t.Errorf("%s: got %v (total %d), want %v", c.query, got, total, c.want)
		}
	}
	// 分页：新注册的在前，页码超出落到最后一页
	all := []string{customer, alice2, alice, zhang, owner.User.ID}
	if got, total, page := search("pageSize=2&page=2"); !reflect.DeepEqual(got, all[2:4]) || total != 5 || page != 2 {
		t.Fatalf("page 2: %v total=%d page=%d", got, total, page)
	}
	if got, _, page := search("pageSize=2&page=9"); !reflect.DeepEqual(got, all[4:]) || page != 3 {
		t.Fatalf("clamped page: %v page=%d", got, page)
	}
	// 只带关键字时每页 defaultPageSize 条（关键字里有非十六进制字母，不会碰巧匹配上编号开头）
	if _, total, page := search("q=lic"); total != 2 || page != 1 {
		t.Fatalf("keyword without pageSize: total=%d page=%d", total, page)
	}
	if w := call(t, s, http.MethodGet, "/api/v2/accounts?pageSize=101", owner.AccessToken, "", nil); w.Code != http.StatusBadRequest {
		t.Fatalf("oversized page: %d", w.Code)
	}
	// 不带参数：第一页，每页 defaultPageSize 条，新注册的在前（不再有回全部账户的整表）
	if got, total, page := search(""); !reflect.DeepEqual(got, all) || total != 5 || page != 1 {
		t.Fatalf("no parameters: %v total=%d page=%d", got, total, page)
	}
	// 顾客不能列账户
	login := call(t, s, http.MethodPost, "/api/v2/auth/wechat-sessions", "", "", map[string]any{"wechatLoginCode": "list-13600009999"})
	if w := call(t, s, http.MethodGet, "/api/v2/accounts?q=a", decodeMap(t, login)["accessToken"].(string), "", nil); w.Code != http.StatusForbidden {
		t.Fatalf("customer listed accounts: %d", w.Code)
	}
}

// 会员列表、规则设置、这一班的入座申请：会员逐页取完正好是全部账户，余额与单个会员的资产视图一致。
func TestLoyaltyListsCoverEveryMember(t *testing.T) {
	s := newTestServer(t)
	exerciseMembership(t, s)
	owner := loginWith(t, s, "member-owner")
	for i := 0; i < 23; i++ {
		register(t, s, fmt.Sprintf("member-extra-%02d", i), fmt.Sprintf("顾客%02d", i))
	}
	_, accounts, _ := paged(t, call(t, s, http.MethodGet, "/api/v2/accounts?pageSize=1", owner, "", nil))

	// 会员：逐页取完，正好是全部账户；每人的余额与 /loyalty/account 看到的一样；顺序按昵称拼音
	var members []map[string]any
	for page := 1; ; page++ {
		items, total, _ := paged(t, call(t, s, http.MethodGet, fmt.Sprintf("/api/v2/loyalty/members?pageSize=10&page=%d", page), owner, "", nil))
		if total != accounts {
			t.Fatalf("members total %d, want %d accounts", total, accounts)
		}
		members = append(members, items...)
		if len(members) >= total {
			break
		}
	}
	seen := map[string]bool{}
	nicknames := make([]string, 0, len(members))
	withBalance := 0
	for _, m := range members {
		id := m["id"].(string)
		if seen[id] {
			t.Fatalf("member %s listed twice", id)
		}
		seen[id] = true
		assets := decodeMap(t, call(t, s, http.MethodGet, "/api/v2/loyalty/account?accountId="+id, owner, "", nil))
		if !reflect.DeepEqual(m["balance"], assets["balance"]) {
			t.Fatalf("member %s balance %v, account view %v", id, m["balance"], assets["balance"])
		}
		nicknames = append(nicknames, m["nickname"].(string))
		if b := m["balance"].(map[string]any); b["principalCents"].(float64)+b["giftCents"].(float64)+b["points"].(float64) > 0 {
			withBalance++
		}
	}
	if len(members) != accounts {
		t.Fatalf("members %d, want %d", len(members), accounts)
	}
	if withBalance == 0 {
		t.Fatal("fixture has no member with a balance: the comparison proves nothing")
	}
	// 按拼音：「顾客」gu 在「老板」lao 之前（按码点「老」U+8001 反而在「顾」U+987E 之前），顾客00…22 按数字顺序
	boss := -1
	var customers []string
	for i, name := range nicknames {
		switch {
		case name == "老板":
			boss = i
		case strings.HasPrefix(name, "顾客"):
			if boss >= 0 {
				t.Fatalf("members not ordered by pinyin: %v", nicknames)
			}
			customers = append(customers, name)
		}
	}
	if boss < 0 || len(customers) != 24 || !sort.StringsAreSorted(customers) {
		t.Fatalf("members not ordered by pinyin: %v", nicknames)
	}
	found, total, _ := paged(t, call(t, s, http.MethodGet, "/api/v2/loyalty/members?q=顾客07", owner, "", nil))
	if total != 1 || found[0]["nickname"] != "顾客07" {
		t.Fatalf("member search: %v", found)
	}

	// 规则设置：草稿、生效规则、版本都在；发布记录带发布人的称呼
	settings := decodeMap(t, call(t, s, http.MethodGet, "/api/v2/loyalty/settings", owner, "", nil))
	for _, key := range []string{"drafts", "rules", "version"} {
		if settings[key] == nil {
			t.Fatalf("settings lacks %s", key)
		}
	}
	publications := settings["publications"].([]any)
	if len(publications) == 0 {
		t.Fatal("fixture published nothing: the actor check proves nothing")
	}
	for _, p := range publications {
		publication := p.(map[string]any)
		actor := publication["actor"].(map[string]any)
		if actor["nickname"] != "老板" || actor["id"] != publication["actorId"] || actor["phoneMasked"] == "" {
			t.Fatalf("publication actor: %v", actor)
		}
	}

	// 这一班：入座申请带顾客称呼，桌位占用都在
	shift := decodeMap(t, call(t, s, http.MethodGet, "/api/v2/loyalty/shift", owner, "", nil))
	if shift["tables"] == nil || len(shift["admissions"].([]any)) == 0 {
		t.Fatalf("shift view: %v", shift)
	}
	for _, a := range shift["admissions"].([]any) {
		admission := a.(map[string]any)
		customer := admission["customer"].(map[string]any)
		if customer["id"] != admission["admission"].(map[string]any)["accountId"] || customer["nickname"] == "" {
			t.Fatalf("admission customer: %v", customer)
		}
	}

	customer := loginWith(t, s, "member-extra-00")
	for _, path := range []string{"members", "settings", "shift"} {
		if w := call(t, s, http.MethodGet, "/api/v2/loyalty/"+path, customer, "", nil); w.Code != http.StatusForbidden {
			t.Fatalf("customer read /loyalty/%s: %d", path, w.Code)
		}
	}
}

// 员工预约：还要处理的（含过了时间没标记的）一次给全，处理完的按开始时间新的在前分页。
func TestStaffReservationsSplitIntoOpenAndEndedPages(t *testing.T) {
	f := newReservationFixture(t)
	s := f.server
	add := func(start time.Time, status string) string {
		t.Helper()
		x := &Reservation{ID: id(), AccountID: f.customer.User.ID, TableID: f.table, SeatNumber: 1, PackageID: f.pack, PackageName: "三小时",
			DurationMinutes: 60, StartAt: start, Status: status, CreatedBy: f.owner.User.ID, CreatedAt: f.now}
		edit(t, s, func(q *txn) { q.addReservation(x) })
		return x.ID
	}
	expired := add(f.now.Add(-3*time.Hour), "pending")
	pending := add(f.now.Add(2*time.Hour), "pending")
	confirmed := add(f.now.Add(time.Hour), "confirmed")
	var ended []string // 开始时间新的在前
	statuses := []string{"seated", "cancelled", "no_show"}
	for i := 0; i < 25; i++ {
		ended = append(ended, add(f.now.Add(-time.Duration(i+1)*24*time.Hour), statuses[i%3]))
	}
	staffGet := func(query string) *httptest.ResponseRecorder {
		return call(t, s, http.MethodGet, "/api/v2/reservations/staff"+query, f.owner.AccessToken, "", nil)
	}
	entryIDs := func(view map[string]any) []string {
		var out []string
		for _, e := range view["reservations"].([]any) {
			out = append(out, e.(map[string]any)["reservation"].(map[string]any)["id"].(string))
		}
		return out
	}
	open := decodeMap(t, staffGet("?scope=open"))
	if got := entryIDs(open); !reflect.DeepEqual(got, []string{expired, confirmed, pending}) {
		t.Fatalf("open reservations: %v", got)
	}
	if status := open["reservations"].([]any)[0].(map[string]any)["displayStatus"]; status != "expired" {
		t.Fatalf("overdue reservation shows %v", status)
	}
	for _, key := range []string{"busy", "packages", "tables", "settings", "settingsVersion"} {
		if open[key] == nil {
			t.Fatalf("open view lacks %s", key)
		}
	}
	page := func(query string) ([]string, int, int) {
		t.Helper()
		w := staffGet(query)
		total, _ := strconv.Atoi(w.Header().Get("X-Total-Count"))
		at, _ := strconv.Atoi(w.Header().Get("X-Page"))
		return entryIDs(decodeMap(t, w)), total, at
	}
	if got, total, at := page("?scope=ended&pageSize=10&page=2"); !reflect.DeepEqual(got, ended[10:20]) || total != 25 || at != 2 {
		t.Fatalf("ended page 2: total=%d page=%d", total, at)
	}
	if got, _, at := page("?scope=ended&pageSize=10&page=7"); !reflect.DeepEqual(got, ended[20:]) || at != 3 {
		t.Fatalf("ended clamped page: %d entries, page %d", len(got), at)
	}
	if got, total, _ := page("?scope=ended"); len(got) != defaultPageSize || total != 25 {
		t.Fatalf("ended default page: %d of %d", len(got), total)
	}
	// 必须带 scope：不再有回全部预约的整表
	if w := staffGet(""); w.Code != http.StatusBadRequest {
		t.Fatalf("staff reservations without scope: %d", w.Code)
	}
	if w := staffGet("?scope=all"); w.Code != http.StatusBadRequest {
		t.Fatalf("unknown scope: %d", w.Code)
	}
	if w := call(t, s, http.MethodGet, "/api/v2/reservations/staff?scope=open", f.customer.AccessToken, "", nil); w.Code != http.StatusForbidden {
		t.Fatalf("customer read staff reservations: %d", w.Code)
	}
	// 员工操作的响应是「还要处理的」那份，不再带着全部历史
	out := reservationOK(t, s, f.owner.AccessToken, reservationInput{Action: "confirm", TargetID: pending})
	if got := entryIDs(out); !reflect.DeepEqual(got, []string{expired, confirmed, pending}) {
		t.Fatalf("action response: %v", got)
	}
	// 过了时间的待确认预约仍能标记爽约，之后进入处理完的那一页最前面……按开始时间排在它该在的位置
	reservationOK(t, s, f.owner.AccessToken, reservationInput{Action: "no_show", TargetID: expired, Reason: "没来"})
	if got := entryIDs(decodeMap(t, staffGet("?scope=open"))); !reflect.DeepEqual(got, []string{confirmed, pending}) {
		t.Fatalf("open after no-show: %v", got)
	}
	if got, total, _ := page("?scope=ended&pageSize=1"); got[0] != expired || total != 26 {
		t.Fatalf("ended after no-show: %v total=%d", got, total)
	}
}

// 处理完的预约按门店日期筛（网页「预约 › 已结束」）：哪一天按中国标准时间算，不看服务器时区——
// 门店 9 月 13 日 00:30 开始的那条在 UTC 还是 12 日，也算 13 日；14 日 0 点整开始的算 14 日。总数、翻页都只算这一天的。
func TestEndedReservationsFilterByStoreDate(t *testing.T) {
	f := newReservationFixture(t)
	s := f.server
	add := func(start time.Time, status string) string {
		t.Helper()
		x := &Reservation{ID: id(), AccountID: f.customer.User.ID, TableID: f.table, SeatNumber: 1, PackageID: f.pack, PackageName: "三小时",
			DurationMinutes: 60, StartAt: start.UTC(), Status: status, CreatedBy: f.owner.User.ID, CreatedAt: f.now}
		edit(t, s, func(q *txn) { q.addReservation(x) })
		return x.ID
	}
	lateTwelfth := add(time.Date(2026, 9, 12, 23, 30, 0, 0, cst), "cancelled")
	earlyThirteenth := add(time.Date(2026, 9, 13, 0, 30, 0, 0, cst), "no_show") // UTC 还是 12 日 16:30
	lateThirteenth := add(time.Date(2026, 9, 13, 23, 59, 0, 0, cst), "seated")
	midnight := add(time.Date(2026, 9, 14, 0, 0, 0, 0, cst), "cancelled")
	add(time.Date(2026, 9, 13, 15, 0, 0, 0, cst), "pending") // 还要处理的，不在已结束里

	page := func(query string) ([]string, int, int) {
		t.Helper()
		w := call(t, s, http.MethodGet, "/api/v2/reservations/staff"+query, f.owner.AccessToken, "", nil)
		if w.Code != http.StatusOK {
			t.Fatalf("%s: %d %s", query, w.Code, w.Body.String())
		}
		total, _ := strconv.Atoi(w.Header().Get("X-Total-Count"))
		at, _ := strconv.Atoi(w.Header().Get("X-Page"))
		var ids []string
		for _, e := range decodeMap(t, w)["reservations"].([]any) {
			ids = append(ids, e.(map[string]any)["reservation"].(map[string]any)["id"].(string))
		}
		return ids, total, at
	}
	if got, total, _ := page("?scope=ended&date=2026-09-13"); !reflect.DeepEqual(got, []string{lateThirteenth, earlyThirteenth}) || total != 2 {
		t.Fatalf("13 日：%v 共 %d", got, total)
	}
	if got, total, at := page("?scope=ended&date=2026-09-13&pageSize=1&page=2"); !reflect.DeepEqual(got, []string{earlyThirteenth}) || total != 2 || at != 2 {
		t.Fatalf("13 日第 2 页：%v 共 %d 第 %d 页", got, total, at)
	}
	if got, total, _ := page("?scope=ended&date=2026-09-12"); !reflect.DeepEqual(got, []string{lateTwelfth}) || total != 1 {
		t.Fatalf("12 日：%v 共 %d", got, total)
	}
	if got, total, _ := page("?scope=ended&date=2026-09-14"); !reflect.DeepEqual(got, []string{midnight}) || total != 1 {
		t.Fatalf("14 日：%v 共 %d", got, total)
	}
	if got, total, at := page("?scope=ended&date=2026-09-20"); len(got) != 0 || total != 0 || at != 1 {
		t.Fatalf("没有预约的那天：%v 共 %d 第 %d 页", got, total, at)
	}
	if got, total, _ := page("?scope=ended"); len(got) != 4 || total != 4 {
		t.Fatalf("不带日期：%v 共 %d", got, total)
	}
	for _, bad := range []string{"2026-13-01", "20260913", "2026-9-13"} {
		w := call(t, s, http.MethodGet, "/api/v2/reservations/staff?scope=ended&date="+bad, f.owner.AccessToken, "", nil)
		if body := decodeMap(t, w); w.Code != http.StatusBadRequest || body["code"] != "invalid_request" || body["message"] != "日期格式应为 YYYY-MM-DD" {
			t.Fatalf("日期 %s：%d %v", bad, w.Code, body)
		}
	}
}

// 列表里的称呼由后端带上：订单的顾客、审计的操作人、员工任命的账户。客户端不再为了显示名字去拉全部账户。
func TestListsCarryAccountLabels(t *testing.T) {
	s := newTestServer(t)
	owner := register(t, s, "label-owner", "老板")
	if err := s.BootstrapOwner(owner.User.ID); err != nil {
		t.Fatal(err)
	}
	customer := register(t, s, "label-customer", "小明")
	withCustomer := decodeMap(t, call(t, s, http.MethodPost, "/api/v2/sales-orders", owner.AccessToken, id(), map[string]any{"accountId": customer.User.ID}))
	walkIn := decodeMap(t, call(t, s, http.MethodPost, "/api/v2/sales-orders", owner.AccessToken, id(), map[string]any{}))
	label := map[string]any{"id": customer.User.ID, "nickname": "小明", "phoneMasked": "138****8000"}
	if !reflect.DeepEqual(withCustomer["customer"], label) || walkIn["customer"] != nil {
		t.Fatalf("created order customers: %v / %v", withCustomer["customer"], walkIn["customer"])
	}
	listed, _, _ := paged(t, call(t, s, http.MethodGet, "/api/v2/sales-orders?pageSize=10", owner.AccessToken, "", nil))
	byID := map[string]any{}
	for _, o := range listed {
		byID[o["id"].(string)] = o["customer"]
	}
	if !reflect.DeepEqual(byID[withCustomer["id"].(string)], label) || byID[walkIn["id"].(string)] != nil {
		t.Fatalf("listed order customers: %v", byID)
	}
	// 顾客改了昵称，订单的 version 不变（称呼不进入 version）
	if w := call(t, s, http.MethodPatch, "/api/v2/accounts/"+customer.User.ID, customer.AccessToken, "", map[string]any{"nickname": "小明同学"}); w.Code != http.StatusOK {
		t.Fatalf("rename: %d %s", w.Code, w.Body.String())
	}
	again := decodeMap(t, call(t, s, http.MethodGet, "/api/v2/sales-orders/"+withCustomer["id"].(string), owner.AccessToken, "", nil))
	if again["version"] != withCustomer["version"] || again["customer"].(map[string]any)["nickname"] != "小明同学" {
		t.Fatalf("rename changed order version or kept the old name: %v", again["customer"])
	}

	roles := decodeList(t, call(t, s, http.MethodGet, "/api/v2/staff-role-assignments", owner.AccessToken, "", nil))
	if len(roles) != 1 || !reflect.DeepEqual(roles[0]["account"], map[string]any{"id": owner.User.ID, "nickname": "老板", "phoneMasked": "138****8000"}) {
		t.Fatalf("role assignment account: %v", roles)
	}

	if w := call(t, s, http.MethodPost, "/api/v2/staff-role-assignments", owner.AccessToken, "", map[string]any{"accountId": customer.User.ID, "role": "clerk"}); w.Code != http.StatusCreated {
		t.Fatalf("appoint: %d %s", w.Code, w.Body.String())
	}
	audits, _, _ := paged(t, call(t, s, http.MethodGet, "/api/v2/system/audit-events?pageSize=50", owner.AccessToken, "", nil))
	var system, staff bool
	for _, a := range audits {
		switch a["accountId"] {
		case "system":
			system = system || a["actor"] == nil
		case owner.User.ID:
			staff = staff || a["actor"].(map[string]any)["nickname"] == "老板"
		}
	}
	if !system || !staff {
		t.Fatalf("audit actors: system=%v staff=%v", system, staff)
	}
}

// 迁移 013：关键字搜索走三元组索引。打码规则在 Go（页面显示）和 SQL（搜索匹配）各有一份，必须一致；
// 关键字里的 %、_、\ 照字面匹配；形状不规整的旧记录（明细是 null、没有昵称、没有手机号）不让搜索出错。
func TestKeywordSearchUsesTheIndexedSearchText(t *testing.T) {
	s := newTestServer(t)
	for _, phone := range []string{"", "1", "1234", "12345", "123456", "1234567", "13800138000", "+8613800138000"} {
		var masked string
		if phone == "" {
			masked = view(t, s, func(q *txn) string { return scalar[string](q, `SELECT pindou_masked_phone(NULL)`) })
		} else {
			masked = view(t, s, func(q *txn) string { return scalar[string](q, `SELECT pindou_masked_phone($1)`, phone) })
		}
		if masked != maskPhone(phone) {
			t.Errorf("phone %q: SQL masks %q, Go masks %q", phone, masked, maskPhone(phone))
		}
	}
	owner := register(t, s, "search-owner", "老板")
	if err := s.BootstrapOwner(owner.User.ID); err != nil {
		t.Fatal(err)
	}
	plain := &Order{ID: id(), Status: "draft", CreatedAt: s.now(), Lines: []OrderLine{{Name: "100% 纯棉_拼豆", Quantity: 1, UnitPriceCents: 100}}}
	other := &Order{ID: id(), Status: "draft", CreatedAt: s.now(), Lines: []OrderLine{{Name: "普通拼豆", Quantity: 1, UnitPriceCents: 100}}}
	edit(t, s, func(q *txn) { q.addOrder(plain); q.addOrder(other) })
	odd := id()
	edit(t, s, func(q *txn) {
		q.exec(`INSERT INTO sales_orders(id,status,receivable_cents,paid_cents,created_at,state)
 VALUES ($1::uuid,'draft',0,0,now(),jsonb_build_object('id',$1::text,'status','draft','lines',NULL::jsonb))`, odd)
		q.exec(`INSERT INTO accounts(id,nickname,phone_verification_status,created_at,state) VALUES ($1,'', 'unverified', now(), '{}')`, id())
	})
	orders := func(q string) []string {
		items, _, _ := paged(t, call(t, s, http.MethodGet, "/api/v2/sales-orders?pageSize=50&q="+q, owner.AccessToken, "", nil))
		return idsOf(items)
	}
	if got := orders("100%25"); len(got) != 1 || got[0] != plain.ID {
		t.Fatalf("literal %%: %v", got)
	}
	if got := orders("%25"); len(got) != 1 || got[0] != plain.ID {
		t.Fatalf("%% must not match everything: %v", got)
	}
	if got := orders("_"); len(got) != 1 || got[0] != plain.ID {
		t.Fatalf("_ must not match any character: %v", got)
	}
	if got := orders(odd[:13]); len(got) != 1 || got[0] != odd {
		t.Fatalf("order without lines by id: %v", got)
	}
	if got := orders("拼豆"); len(got) != 2 {
		t.Fatalf("two orders mention 拼豆: %v", got)
	}
	audits, total, _ := paged(t, call(t, s, http.MethodGet, "/api/v2/system/audit-events?pageSize=50&q=bootstrap", owner.AccessToken, "", nil))
	if total != 1 || audits[0]["action"] != "role.bootstrap-owner" {
		t.Fatalf("audit search: %v", audits)
	}
	if _, total, _ := paged(t, call(t, s, http.MethodGet, "/api/v2/system/audit-events?pageSize=50&q=%25", owner.AccessToken, "", nil)); total != 0 {
		t.Fatalf("%% matched %d audits", total)
	}
	// 按操作人的昵称找审计
	edit(t, s, func(q *txn) { q.audit(owner.User.ID, "order.created", plain.ID, "", id()) })
	if _, total, _ := paged(t, call(t, s, http.MethodGet, "/api/v2/system/audit-events?pageSize=50&q=老板", owner.AccessToken, "", nil)); total != 1 {
		t.Fatalf("audit by actor nickname: %d", total)
	}
}
