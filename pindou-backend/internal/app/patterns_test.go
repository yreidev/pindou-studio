package app

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"math/rand/v2"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	patterns "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/patterns/application"
)

// patternPNG 是一张 w×h 的纯色 PNG（data URL），颜色不同版本就不同。
func patternPNG(t *testing.T, w, h int, c color.Color) string {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		for x := range w {
			img.Set(x, y, c)
		}
	}
	var b bytes.Buffer
	if err := png.Encode(&b, img); err != nil {
		t.Fatal(err)
	}
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(b.Bytes())
}

type patternShop struct {
	s                         *Server
	owner, clerk, customer    sessionResponse
	clock                     *time.Time
	fruit, flowers, beginners string
}

func newPatternShop(t *testing.T) *patternShop {
	t.Helper()
	s := newTestServer(t)
	clock := time.Date(2026, 10, 20, 10, 20, 0, 0, cst)
	s.now = func() time.Time { return clock }
	owner := register(t, s, "pattern-owner", "老板")
	if err := s.BootstrapOwner(owner.User.ID); err != nil {
		t.Fatal(err)
	}
	clerk := register(t, s, "pattern-clerk", "店员")
	setRoles(t, s, clerk.User.ID, Clerk)
	p := &patternShop{s: s, owner: owner, clerk: clerk, customer: register(t, s, "pattern-customer", "顾客"), clock: &clock}
	// 用例会把时钟拨过好几天：发一年期的会话，免得小程序会话（24 小时）先过期
	for _, sess := range []*sessionResponse{&p.owner, &p.clerk, &p.customer} {
		sess.AccessToken = "long-lived-" + id()
		putAuth(t, s, sess.AccessToken, authSession{UserID: sess.User.ID, ExpiresAt: clock.AddDate(1, 0, 0), Client: clientMiniapp})
	}
	for _, c := range p.library(t, "", "").Categories {
		switch c.Name {
		case "水果":
			p.fruit = c.ID
		case "花草":
			p.flowers = c.ID
		case "新手":
			p.beginners = c.ID
		}
	}
	return p
}

type libraryCategory struct {
	ID, Name string
	Enabled  bool
}

type libraryPattern struct {
	ID, Name, ImagePath, ThumbnailPath string
	CategoryID                         *string
	Published, IsNew                   bool
	FirstPublishedAt                   *time.Time
	Width, Height                      int
}

type library struct {
	Categories []libraryCategory
	Patterns   []libraryPattern
}

func decodeLibrary(t *testing.T, w *httptest.ResponseRecorder) library {
	t.Helper()
	var out library
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode %q: %v", w.Body.String(), err)
	}
	return out
}

func (p *patternShop) library(t *testing.T, bearer, scope string) library {
	t.Helper()
	path := "/api/v2/patterns"
	if scope != "" {
		path += "?scope=" + scope
	}
	w := call(t, p.s, http.MethodGet, path, bearer, "", nil)
	if w.Code != 200 {
		t.Fatalf("list patterns: %d %s", w.Code, w.Body.String())
	}
	return decodeLibrary(t, w)
}

func (p *patternShop) upload(t *testing.T, bearer, key string, body map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	return call(t, p.s, http.MethodPost, "/api/v2/patterns", bearer, key, body)
}

// uploaded 传一张图纸，返回它的编号（新传的排在最前面）。
func (p *patternShop) uploaded(t *testing.T, name string, category any, published bool) string {
	t.Helper()
	w := p.upload(t, p.clerk.AccessToken, id(), map[string]any{"name": name, "categoryId": category, "published": published, "image": patternPNG(t, 40, 30, color.RGBA{R: 200, A: 255})})
	if w.Code != 201 {
		t.Fatalf("upload %s: %d %s", name, w.Code, w.Body.String())
	}
	return decodeLibrary(t, w).Patterns[0].ID
}

func (p *patternShop) patch(t *testing.T, bearer, pattern string, body map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	return call(t, p.s, http.MethodPatch, "/api/v2/patterns/"+pattern, bearer, "", body)
}

func findPattern(t *testing.T, l library, pattern string) libraryPattern {
	t.Helper()
	for _, x := range l.Patterns {
		if x.ID == pattern {
			return x
		}
	}
	t.Fatalf("pattern %s missing", pattern)
	return libraryPattern{}
}

func errorCodeOf(t *testing.T, w *httptest.ResponseRecorder) string {
	t.Helper()
	code, _ := decodeMap(t, w)["code"].(string)
	return code
}

// 所有员工都能上传图纸：要 Idempotency-Key，同键重放不会传出两张、同键改内容回 409；名字、图片、分类不对的拒收，
// 什么都不改。新传的排在最前面，立即上架的记下第一次上架的时刻、7 天内算上新；顾客和游客只看到上架的。
func TestStaffUploadPatternsCustomersSeePublishedOnes(t *testing.T) {
	p := newPatternShop(t)
	s := p.s
	if got := p.library(t, "", ""); len(got.Categories) != 4 || len(got.Patterns) != 0 {
		t.Fatalf("迁移预置四个分类、没有图纸：%+v", got)
	}
	if w := call(t, s, http.MethodGet, "/api/v2/patterns?scope=all", "", "", nil); w.Code != 401 {
		t.Fatalf("游客读全部：%d", w.Code)
	}
	if w := call(t, s, http.MethodGet, "/api/v2/patterns?scope=all", p.customer.AccessToken, "", nil); w.Code != 403 {
		t.Fatalf("顾客读全部：%d", w.Code)
	}
	if w := call(t, s, http.MethodGet, "/api/v2/patterns?scope=everything", "", "", nil); w.Code != 400 {
		t.Fatalf("不认识的 scope：%d", w.Code)
	}

	strawberry := map[string]any{"name": " 草莓 ", "categoryId": p.fruit, "published": true, "image": patternPNG(t, 600, 300, color.RGBA{R: 220, A: 255})}
	before := s.snapshotData()
	for label, c := range map[string]struct {
		bearer, key string
		body        map[string]any
		status      int
		code        string
	}{
		"顾客不能传":    {p.customer.AccessToken, id(), strawberry, 403, "forbidden"},
		"没有幂等键":    {p.clerk.AccessToken, "", strawberry, 400, "idempotency_required"},
		"名字太长":     {p.clerk.AccessToken, id(), with(strawberry, "name", strings.Repeat("莓", 21)), 400, "invalid_pattern"},
		"不是图片":     {p.clerk.AccessToken, id(), with(strawberry, "image", "data:image/png;base64,aGVsbG8="), 400, "invalid_pattern_image"},
		"分类不存在":    {p.clerk.AccessToken, id(), with(strawberry, "categoryId", id()), 409, "pattern_category_unavailable"},
		"多了不认识的字段": {p.clerk.AccessToken, id(), with(strawberry, "beads", 300), 400, "invalid_request"},
	} {
		if w := p.upload(t, c.bearer, c.key, c.body); w.Code != c.status || errorCodeOf(t, w) != c.code {
			t.Errorf("%s：%d %s", label, w.Code, w.Body.String())
		}
	}
	if !bytes.Equal(before, s.snapshotData()) {
		t.Fatal("被拒的上传不该改任何东西")
	}

	key := id()
	w := p.upload(t, p.clerk.AccessToken, key, strawberry)
	if w.Code != 201 {
		t.Fatalf("店员上传：%d %s", w.Code, w.Body.String())
	}
	first := decodeLibrary(t, w).Patterns[0]
	if first.Name != "草莓" || *first.CategoryID != p.fruit || !first.Published || !first.IsNew || first.Width != 600 || first.Height != 300 ||
		first.FirstPublishedAt == nil || !first.FirstPublishedAt.Equal(*p.clock) {
		t.Fatalf("上传的图纸：%+v", first)
	}
	if !strings.HasPrefix(first.ImagePath, "/pattern-images/"+first.ID+"/full?v=") || !strings.HasPrefix(first.ThumbnailPath, "/pattern-images/"+first.ID+"/thumb?v=") {
		t.Fatalf("图片地址：%s %s", first.ImagePath, first.ThumbnailPath)
	}
	if last := lastAudit(t, s); last.Action != "pattern.created" || last.ActorID != p.clerk.User.ID || last.ObjectID != first.ID || last.Reason != "「草莓」 · 水果 · 上架" {
		t.Fatalf("审计：%+v", last)
	}
	if w := p.upload(t, p.clerk.AccessToken, key, strawberry); w.Code != 201 || len(decodeLibrary(t, w).Patterns) != 1 {
		t.Fatalf("同键重放：%d %s", w.Code, w.Body.String())
	}
	if w := p.upload(t, p.clerk.AccessToken, key, with(strawberry, "name", "蓝莓")); w.Code != 409 || errorCodeOf(t, w) != "idempotency_conflict" {
		t.Fatalf("同键改内容：%d %s", w.Code, w.Body.String())
	}

	draft := p.uploaded(t, "小猫", nil, false)
	staff := p.library(t, p.owner.AccessToken, "all")
	if len(staff.Patterns) != 2 || staff.Patterns[0].ID != draft || staff.Patterns[0].CategoryID != nil || staff.Patterns[0].FirstPublishedAt != nil || staff.Patterns[0].IsNew {
		t.Fatalf("新传的排在最前面，没上架的不记上架时刻：%+v", staff.Patterns)
	}
	for _, bearer := range []string{"", p.customer.AccessToken} {
		if got := p.library(t, bearer, "").Patterns; len(got) != 1 || got[0].ID != first.ID {
			t.Fatalf("顾客只看到上架的：%+v", got)
		}
	}

	// 7 天之后不再算上新
	*p.clock = p.clock.Add(7 * 24 * time.Hour)
	if got := p.library(t, "", "").Patterns[0]; got.IsNew {
		t.Fatal("满 7 天不再算上新")
	}
}

// 改图纸只改带了的字段：第一次上架时记下时刻，下架再上架不重记；换图后地址里的版本跟着变。没改动的不记审计。
// 图片不用登录就能读：版本对得上长期缓存，旧地址照样给现在的图但不缓存，ETag 对得上回 304。
func TestStaffEditPatternsAndImagesAreCacheable(t *testing.T) {
	p := newPatternShop(t)
	s := p.s
	cat := p.uploaded(t, "小猫", p.beginners, false)
	started := *p.clock

	*p.clock = started.Add(time.Hour)
	w := p.patch(t, p.clerk.AccessToken, cat, map[string]any{"published": true, "categoryId": nil, "name": "橘猫"})
	if w.Code != 200 {
		t.Fatalf("上架：%d %s", w.Code, w.Body.String())
	}
	got := findPattern(t, decodeLibrary(t, w), cat)
	if !got.Published || got.CategoryID != nil || got.Name != "橘猫" || !got.FirstPublishedAt.Equal(started.Add(time.Hour)) {
		t.Fatalf("上架后：%+v", got)
	}
	if last := lastAudit(t, s); last.Action != "pattern.updated" || last.Reason != "「橘猫」：名字「小猫」→「橘猫」，分类改为不分类，上架" {
		t.Fatalf("审计：%+v", last)
	}
	*p.clock = started.Add(2 * time.Hour)
	p.patch(t, p.clerk.AccessToken, cat, map[string]any{"published": false})
	w = p.patch(t, p.clerk.AccessToken, cat, map[string]any{"published": true})
	if got := findPattern(t, decodeLibrary(t, w), cat); !got.FirstPublishedAt.Equal(started.Add(time.Hour)) {
		t.Fatalf("下架再上架不重记第一次上架：%v", got.FirstPublishedAt)
	}
	audits := len(auditsOf(t, s))
	if w := p.patch(t, p.clerk.AccessToken, cat, map[string]any{"name": "橘猫", "published": true}); w.Code != 200 || len(auditsOf(t, s)) != audits {
		t.Fatalf("没改动：%d，多了 %d 条审计", w.Code, len(auditsOf(t, s))-audits)
	}
	for label, c := range map[string]struct {
		bearer, pattern string
		body            map[string]any
		status          int
		code            string
	}{
		"顾客不能改":     {p.customer.AccessToken, cat, map[string]any{"name": "黑猫"}, 403, "forbidden"},
		"什么都没带":     {p.clerk.AccessToken, cat, map[string]any{}, 400, "invalid_pattern"},
		"名字是空的":     {p.clerk.AccessToken, cat, map[string]any{"name": "  "}, 400, "invalid_pattern"},
		"图片不对":      {p.clerk.AccessToken, cat, map[string]any{"image": "data:image/gif;base64,R0lG"}, 400, "invalid_pattern_image"},
		"分类不存在":     {p.clerk.AccessToken, cat, map[string]any{"categoryId": id()}, 409, "pattern_category_unavailable"},
		"图纸不存在":     {p.clerk.AccessToken, id(), map[string]any{"name": "黑猫"}, 404, "not_found"},
		"编号不是 UUID": {p.clerk.AccessToken, "cat", map[string]any{"name": "黑猫"}, 404, "not_found"},
	} {
		if w := p.patch(t, c.bearer, c.pattern, c.body); w.Code != c.status || errorCodeOf(t, w) != c.code {
			t.Errorf("%s：%d %s", label, w.Code, w.Body.String())
		}
	}

	old := findPattern(t, p.library(t, "", ""), cat)
	w = p.patch(t, p.owner.AccessToken, cat, map[string]any{"image": patternPNG(t, 30, 60, color.RGBA{B: 200, A: 255})})
	fresh := findPattern(t, decodeLibrary(t, w), cat)
	if fresh.ImagePath == old.ImagePath || fresh.Width != 30 || fresh.Height != 60 || lastAudit(t, s).Reason != "「橘猫」：换图" {
		t.Fatalf("换图：%+v", fresh)
	}

	fetch := func(path, etag string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodGet, "/api/v2"+path, nil)
		if etag != "" {
			r.Header.Set("If-None-Match", etag)
		}
		return serve(t, s, r)
	}
	full := fetch(fresh.ImagePath, "")
	if full.Code != 200 || full.Header().Get("Content-Type") != "image/png" || full.Header().Get("Cache-Control") != "public, max-age=31536000, immutable" {
		t.Fatalf("原图：%d %v", full.Code, full.Header())
	}
	if cfg, _, err := image.DecodeConfig(bytes.NewReader(full.Body.Bytes())); err != nil || cfg.Width != 30 || cfg.Height != 60 {
		t.Fatalf("原图内容：%+v %v", cfg, err)
	}
	thumb := fetch(fresh.ThumbnailPath, "")
	if thumb.Code != 200 || thumb.Header().Get("Content-Type") != "image/jpeg" {
		t.Fatalf("缩略图：%d %v", thumb.Code, thumb.Header())
	}
	if stale := fetch(old.ImagePath, ""); stale.Code != 200 || stale.Header().Get("Cache-Control") != "no-cache" || !bytes.Equal(stale.Body.Bytes(), full.Body.Bytes()) {
		t.Fatalf("旧地址给现在的图、不缓存：%d %v", stale.Code, stale.Header())
	}
	if again := fetch(fresh.ImagePath, full.Header().Get("ETag")); again.Code != 304 || again.Body.Len() != 0 {
		t.Fatalf("ETag 对得上应回 304：%d", again.Code)
	}
	for _, path := range []string{"/pattern-images/" + id() + "/full", "/pattern-images/" + cat + "/huge", "/pattern-images/cat/full"} {
		if w := fetch(path, ""); w.Code != 404 {
			t.Errorf("%s：%d", path, w.Code)
		}
	}

	// 下架的图纸图片照样能读（网页后台要预览）
	p.patch(t, p.clerk.AccessToken, cat, map[string]any{"published": false})
	if w := fetch(fresh.ThumbnailPath, ""); w.Code != 200 {
		t.Fatalf("下架的图纸图片：%d", w.Code)
	}
}

// 排顺序要给出全部图纸，对不上（别人刚增删过）回 409；删除图纸记审计，删了再删回 404。
func TestStaffReorderAndDeletePatterns(t *testing.T) {
	p := newPatternShop(t)
	s := p.s
	a := p.uploaded(t, "草莓", p.fruit, true)
	b := p.uploaded(t, "郁金香", p.flowers, true)
	c := p.uploaded(t, "小熊", nil, false)
	order := func(bearer string, ids ...string) *httptest.ResponseRecorder {
		return call(t, s, http.MethodPatch, "/api/v2/pattern-order", bearer, "", map[string]any{"ids": ids})
	}
	if got := p.library(t, p.clerk.AccessToken, "all").Patterns; got[0].ID != c || got[2].ID != a {
		t.Fatalf("新传的在前：%+v", got)
	}
	if w := order(p.customer.AccessToken, a, b, c); w.Code != 403 {
		t.Fatalf("顾客排序：%d", w.Code)
	}
	for _, ids := range [][]string{{a, b}, {a, b, c, id()}, {a, a, b}} {
		if w := order(p.clerk.AccessToken, ids...); w.Code != 409 || errorCodeOf(t, w) != "order_outdated" {
			t.Errorf("%v：%d %s", ids, w.Code, w.Body.String())
		}
	}
	w := order(p.clerk.AccessToken, a, c, b)
	if got := decodeLibrary(t, w).Patterns; w.Code != 200 || got[0].ID != a || got[1].ID != c || got[2].ID != b {
		t.Fatalf("重排：%d %+v", w.Code, got)
	}
	if lastAudit(t, s).Action != "pattern.reordered" {
		t.Fatal("重排要记审计")
	}
	if got := p.library(t, "", "").Patterns; len(got) != 2 || got[0].ID != a || got[1].ID != b {
		t.Fatalf("顾客按同一顺序看上架的：%+v", got)
	}

	if w := call(t, s, http.MethodDelete, "/api/v2/patterns/"+b, p.customer.AccessToken, "", nil); w.Code != 403 {
		t.Fatalf("顾客删除：%d", w.Code)
	}
	w = call(t, s, http.MethodDelete, "/api/v2/patterns/"+b, p.clerk.AccessToken, "", nil)
	if w.Code != 200 || len(decodeLibrary(t, w).Patterns) != 2 {
		t.Fatalf("删除：%d %s", w.Code, w.Body.String())
	}
	if last := lastAudit(t, s); last.Action != "pattern.deleted" || last.ObjectID != b || last.Reason != "「郁金香」" {
		t.Fatalf("审计：%+v", last)
	}
	if w := call(t, s, http.MethodDelete, "/api/v2/patterns/"+b, p.clerk.AccessToken, "", nil); w.Code != 404 {
		t.Fatalf("删了再删：%d", w.Code)
	}
	if w := fetchImage(t, s, "/pattern-images/"+b+"/thumb"); w.Code != 404 {
		t.Fatalf("删了的图片：%d", w.Code)
	}
}

func fetchImage(t *testing.T, s *Server, path string) *httptest.ResponseRecorder {
	t.Helper()
	return serve(t, s, httptest.NewRequest(http.MethodGet, "/api/v2"+path, nil))
}

// 分类由员工自己管：加（排在最后）、改名、启用停用、排顺序，不能重名；停用的分类顾客看不到，里面的图纸照样在，
// 也不能再把图纸放进去。
func TestStaffManagePatternCategories(t *testing.T) {
	p := newPatternShop(t)
	s := p.s
	add := func(bearer, name string) *httptest.ResponseRecorder {
		return call(t, s, http.MethodPost, "/api/v2/pattern-categories", bearer, "", map[string]any{"name": name})
	}
	edit := func(bearer, category string, body map[string]any) *httptest.ResponseRecorder {
		return call(t, s, http.MethodPatch, "/api/v2/pattern-categories/"+category, bearer, "", body)
	}
	w := add(p.clerk.AccessToken, " 节日 ")
	if w.Code != 201 {
		t.Fatalf("加分类：%d %s", w.Code, w.Body.String())
	}
	categories := decodeLibrary(t, w).Categories
	festival := categories[len(categories)-1]
	if len(categories) != 5 || festival.Name != "节日" || !festival.Enabled {
		t.Fatalf("新分类排在最后、启用：%+v", categories)
	}
	if last := lastAudit(t, s); last.Action != "pattern_category.created" || last.ObjectID != festival.ID {
		t.Fatalf("审计：%+v", last)
	}
	for label, c := range map[string]struct {
		w      *httptest.ResponseRecorder
		status int
		code   string
	}{
		"顾客不能加":   {add(p.customer.AccessToken, "节气"), 403, "forbidden"},
		"重名":      {add(p.clerk.AccessToken, "水果"), 409, "pattern_category_taken"},
		"名字太长":    {add(p.clerk.AccessToken, strings.Repeat("节", 11)), 400, "invalid_pattern_category"},
		"改成已有的名字": {edit(p.clerk.AccessToken, festival.ID, map[string]any{"name": "花草"}), 409, "pattern_category_taken"},
		"什么都没带":   {edit(p.clerk.AccessToken, festival.ID, map[string]any{}), 400, "invalid_pattern_category"},
		"分类不存在":   {edit(p.clerk.AccessToken, id(), map[string]any{"enabled": false}), 404, "not_found"},
		"顾客不能改":   {edit(p.customer.AccessToken, festival.ID, map[string]any{"enabled": false}), 403, "forbidden"},
	} {
		if c.w.Code != c.status || errorCodeOf(t, c.w) != c.code {
			t.Errorf("%s：%d %s", label, c.w.Code, c.w.Body.String())
		}
	}

	rose := p.uploaded(t, "玫瑰", p.flowers, true)
	w = edit(p.owner.AccessToken, p.flowers, map[string]any{"name": "花花草草", "enabled": false})
	if w.Code != 200 {
		t.Fatalf("改名并停用：%d %s", w.Code, w.Body.String())
	}
	if last := lastAudit(t, s); last.Action != "pattern_category.updated" || last.Reason != "「花花草草」：改名「花草」→「花花草草」，停用" {
		t.Fatalf("审计：%+v", last)
	}
	guest := p.library(t, "", "")
	for _, c := range guest.Categories {
		if c.ID == p.flowers {
			t.Fatal("停用的分类顾客看不到")
		}
	}
	if got := findPattern(t, guest, rose); *got.CategoryID != p.flowers {
		t.Fatal("停用分类里的图纸照样在")
	}
	if w := p.patch(t, p.clerk.AccessToken, p.uploaded(t, "雏菊", nil, true), map[string]any{"categoryId": p.flowers}); w.Code != 409 {
		t.Fatalf("不能放进停用的分类：%d", w.Code)
	}

	all := p.library(t, p.clerk.AccessToken, "all").Categories
	ids := make([]string, 0, len(all))
	for i := len(all) - 1; i >= 0; i-- {
		ids = append(ids, all[i].ID)
	}
	order := func(ids []string) *httptest.ResponseRecorder {
		return call(t, s, http.MethodPatch, "/api/v2/pattern-category-order", p.clerk.AccessToken, "", map[string]any{"ids": ids})
	}
	if w := order(ids[1:]); w.Code != 409 || errorCodeOf(t, w) != "order_outdated" {
		t.Fatalf("少给了分类：%d %s", w.Code, w.Body.String())
	}
	w = order(ids)
	if got := decodeLibrary(t, w).Categories; w.Code != 200 || got[0].ID != festival.ID || got[len(got)-1].ID != p.beginners {
		t.Fatalf("重排分类：%d %+v", w.Code, got)
	}
	if lastAudit(t, s).Action != "pattern_category.reordered" {
		t.Fatal("重排分类要记审计")
	}
}

// 空分类可以删（2026-10-20 业主定）：有图纸的（含下架的）不删，回 409 说明有几张；删了名字能再用；记审计。
func TestStaffDeleteEmptyPatternCategories(t *testing.T) {
	p := newPatternShop(t)
	s := p.s
	remove := func(bearer, category string) *httptest.ResponseRecorder {
		return call(t, s, http.MethodDelete, "/api/v2/pattern-categories/"+category, bearer, "", nil)
	}
	p.uploaded(t, "草莓", p.fruit, true)
	p.uploaded(t, "葡萄", p.fruit, false)
	w := remove(p.clerk.AccessToken, p.fruit)
	if w.Code != 409 || errorCodeOf(t, w) != "pattern_category_in_use" || !strings.Contains(decodeMap(t, w)["message"].(string), "还有 2 张图纸") {
		t.Fatalf("有图纸（含下架的）不删：%d %s", w.Code, w.Body.String())
	}
	for label, c := range map[string]struct {
		w      *httptest.ResponseRecorder
		status int
		code   string
	}{
		"顾客不能删": {remove(p.customer.AccessToken, p.flowers), 403, "forbidden"},
		"分类不存在": {remove(p.clerk.AccessToken, id()), 404, "not_found"},
		"编号不对":  {remove(p.clerk.AccessToken, "not-a-uuid"), 404, "not_found"},
	} {
		if c.w.Code != c.status || errorCodeOf(t, c.w) != c.code {
			t.Errorf("%s：%d %s", label, c.w.Code, c.w.Body.String())
		}
	}

	w = remove(p.clerk.AccessToken, p.flowers)
	if w.Code != 200 {
		t.Fatalf("删空分类：%d %s", w.Code, w.Body.String())
	}
	for _, c := range decodeLibrary(t, w).Categories {
		if c.ID == p.flowers {
			t.Fatal("删掉的分类不该再出现")
		}
	}
	if last := lastAudit(t, s); last.Action != "pattern_category.deleted" || last.ObjectID != p.flowers || last.Reason != "「花草」" {
		t.Fatalf("审计：%+v", last)
	}
	if w := remove(p.clerk.AccessToken, p.flowers); w.Code != 404 {
		t.Fatalf("删过的再删：%d", w.Code)
	}
	if w := call(t, s, http.MethodPost, "/api/v2/pattern-categories", p.clerk.AccessToken, "", map[string]any{"name": "花草"}); w.Code != 201 {
		t.Fatalf("删了的名字能再用：%d %s", w.Code, w.Body.String())
	}
}

// with 是 body 改了一个字段的副本。
func with(body map[string]any, key string, value any) map[string]any {
	out := make(map[string]any, len(body)+1)
	for k, v := range body {
		out[k] = v
	}
	out[key] = value
	return out
}

// 接近上限的图片（原始字节 1 MB 多，base64 后约 1.7 MB）连同其余字段也装得进 2 MB 的请求体。
func TestPatternNearTheSizeLimitFitsTheRequestBody(t *testing.T) {
	p := newPatternShop(t)
	img := image.NewRGBA(image.Rect(0, 0, 650, 650))
	rng := rand.New(rand.NewPCG(3, 4)) //nolint:gosec // 测试用的噪点
	for i := range img.Pix {
		img.Pix[i] = byte(rng.UintN(256))
		if i%4 == 3 {
			img.Pix[i] = 255
		}
	}
	var b bytes.Buffer
	if err := png.Encode(&b, img); err != nil {
		t.Fatal(err)
	}
	if b.Len() < 1<<20 || b.Len() > patterns.MaxUploadBytes {
		t.Fatalf("前置条件：%d 字节", b.Len())
	}
	body := map[string]any{"name": strings.Repeat("莓", 20), "categoryId": p.fruit, "published": true, "image": "data:image/png;base64," + base64.StdEncoding.EncodeToString(b.Bytes())}
	if w := p.upload(t, p.clerk.AccessToken, id(), body); w.Code != 201 {
		t.Fatalf("接近上限的图片：%d %s", w.Code, w.Body.String())
	}
}
