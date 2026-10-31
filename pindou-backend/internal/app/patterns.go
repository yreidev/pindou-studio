package app

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	patterns "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/patterns/application"
	"github.com/yreidev/pindou-studio/pindou-backend/internal/storage/queries"
)

// 图纸（迁移 025，2026-10-20 业主定，方案见 docs/plan-home-and-patterns.md）：员工在网页后台「首页内容」上传图纸、
// 管分类，顾客在小程序首页的「本周上新」和「图纸」页看。只填名字和分类；第一次上架起 7 天算「上新」。所有员工都能管，
// 增删改记审计。图片在浏览器里先缩过，服务器重新编码（去掉元数据）再存库，重新编码在事务外做（同调微信，见 routes.go）。
//
// 员工的写操作都回整个图纸库（libraryView），网页后台按它重画，不自己拼。

// patternImagePath 是图片地址（相对接口根地址，如 /api/v2）：带上图片版本，换图后客户端不再用旧缓存。
func patternImagePath(p queries.PatternsRow, size string) string {
	return "/pattern-images/" + p.ID + "/" + size + "?v=" + p.ImageVersion
}

func patternView(p queries.PatternsRow, now time.Time) map[string]any {
	return map[string]any{
		"id": p.ID, "name": p.Name, "categoryId": p.CategoryID, "published": p.Published,
		"isNew": p.Published && patterns.IsNew(p.FirstPublishedAt, now), "firstPublishedAt": p.FirstPublishedAt,
		"width": p.Width, "height": p.Height, "updatedAt": p.UpdatedAt,
		"imagePath": patternImagePath(p, "full"), "thumbnailPath": patternImagePath(p, "thumb"),
	}
}

func categoryView(c queries.PatternCategoriesRow) map[string]any {
	return map[string]any{"id": c.ID, "name": c.Name, "enabled": c.Enabled}
}

// patternLibrary 是图纸与分类：staff 为假时只有上架的图纸和启用的分类（顾客看的）。
func (q *txn) patternLibrary(staff bool) ([]queries.PatternCategoriesRow, []queries.PatternsRow) {
	categories := must(q.db().PatternCategories(q.ctx))
	list := must(q.db().Patterns(q.ctx))
	if !staff {
		categories = slices.DeleteFunc(categories, func(c queries.PatternCategoriesRow) bool { return !c.Enabled })
		list = slices.DeleteFunc(list, func(p queries.PatternsRow) bool { return !p.Published })
	}
	return categories, list
}

func (q *txn) libraryView(staff bool) map[string]any {
	categories, list := q.patternLibrary(staff)
	now := q.now()
	cs, ps := make([]map[string]any, 0, len(categories)), make([]map[string]any, 0, len(list))
	for _, c := range categories {
		cs = append(cs, categoryView(c))
	}
	for _, p := range list {
		ps = append(ps, patternView(p, now))
	}
	return map[string]any{"categories": cs, "patterns": ps}
}

// featuredPatterns 是首页「本周上新」的几张：上新的在前，不够按图纸顺序补。
func (q *txn) featuredPatterns(n int) []map[string]any {
	_, list := q.patternLibrary(false)
	now := q.now()
	slices.SortStableFunc(list, func(a, b queries.PatternsRow) int {
		an, bn := patterns.IsNew(a.FirstPublishedAt, now), patterns.IsNew(b.FirstPublishedAt, now)
		switch {
		case an == bn:
			return 0
		case an:
			return -1
		default:
			return 1
		}
	})
	out := []map[string]any{}
	for _, p := range list[:min(n, len(list))] {
		out = append(out, patternView(p, now))
	}
	return out
}

// listPatterns 是图纸库。不带 scope 时游客也能看：上架的图纸和启用的分类；scope=all 给员工，含下架的和停用的分类。
func (s *Server) listPatterns(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Query().Get("scope") {
	case "":
		writeJSON(w, 200, s.tx(r).libraryView(false))
	case "all":
		if _, ok := s.staffMember(w, r); !ok {
			return
		}
		writeJSON(w, 200, s.tx(r).libraryView(true))
	default:
		s.writeError(w, r, 400, "invalid_request", errors.New("scope 只能不带或是 all"))
	}
}

// patternImage 回图片本身（size 为 full 原图、thumb 缩略图）。不用登录：图片标签带不了令牌，编号是随机的 UUID。
// 地址里的版本和现在的对得上时让客户端长期缓存；对不上（换过图的旧地址）照样给现在的图，但不让缓存。
func (s *Server) patternImage(w http.ResponseWriter, r *http.Request) {
	target, size := r.PathValue("id"), r.PathValue("size")
	if !validID(target) || (size != "full" && size != "thumb") {
		s.writeError(w, r, 404, "not_found", errNotFound)
		return
	}
	q := s.tx(r)
	var data []byte
	var kind, version string
	if size == "full" {
		rows := must(q.db().PatternImage(q.ctx, target))
		if len(rows) == 0 {
			s.writeError(w, r, 404, "not_found", errNotFound)
			return
		}
		data, kind, version = rows[0].Image, rows[0].ImageType, rows[0].ImageVersion
	} else {
		rows := must(q.db().PatternThumbnail(q.ctx, target))
		if len(rows) == 0 {
			s.writeError(w, r, 404, "not_found", errNotFound)
			return
		}
		data, kind, version = rows[0].Thumbnail, "image/jpeg", rows[0].ImageVersion
	}
	etag := `"` + version + "-" + size + `"`
	w.Header().Set("ETag", etag)
	if r.URL.Query().Get("v") == version {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		w.Header().Set("Cache-Control", "no-cache")
	}
	if r.Header.Get("If-None-Match") == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.Header().Set("Content-Type", kind)
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.WriteHeader(200)
	_, _ = w.Write(data)
}

// optionalID 区分 JSON 里没带（不改）、带了 null（清空）和带了编号。
type optionalID struct {
	set   bool
	value *string
}

func (o *optionalID) UnmarshalJSON(b []byte) error {
	o.set = true
	if string(b) == "null" {
		o.value = nil
		return nil
	}
	var v string
	if err := json.Unmarshal(b, &v); err != nil {
		return err
	}
	o.value = &v
	return nil
}

func (o optionalID) MarshalJSON() ([]byte, error) {
	if o.value == nil {
		return []byte("null"), nil
	}
	return json.Marshal(*o.value)
}

// patternCategory 核对图纸要放进的分类：没给（nil）表示不分类；给了就得是存在、启用的分类。
func (q *txn) patternCategory(categoryID *string) (string, error) {
	if categoryID == nil {
		return "不分类", nil
	}
	for _, c := range must(q.db().PatternCategories(q.ctx)) {
		if c.ID == *categoryID && c.Enabled {
			return c.Name, nil
		}
	}
	return "", errors.New("这个分类不存在或已停用，请刷新后重新选择")
}

// createPattern 是员工上传一张图纸。要 Idempotency-Key：网络重试不能传出两张。图片先在事务外重新编码。
func (s *Server) createPattern(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.staffMember(w, r); !ok {
		return
	}
	if idemKey(r) == "" {
		s.writeError(w, r, 400, "idempotency_required", errors.New("Idempotency-Key is required"))
		return
	}
	var in struct {
		Name       string     `json:"name"`
		CategoryID optionalID `json:"categoryId"`
		Published  bool       `json:"published"`
		Image      string     `json:"image"`
	}
	if err := decode(r, &in); err != nil {
		s.writeError(w, r, 400, "invalid_request", err)
		return
	}
	name, err := patterns.Name(in.Name)
	if err != nil {
		s.writeError(w, r, 400, "invalid_pattern", err)
		return
	}
	img, err := patterns.NormalizeImage(in.Image)
	if err != nil {
		s.writeError(w, r, 400, "invalid_pattern_image", err)
		return
	}
	b, _ := json.Marshal(in)
	fingerprint := fmt.Sprintf("%x", sha256.Sum256(b))
	s.serveTx(w, r, true, "patterns", func(w http.ResponseWriter, r *http.Request) {
		u, ok := s.staffMember(w, r)
		if !ok {
			return
		}
		q := s.tx(r)
		key := "patterns:" + u.ID + ":POST:" + idemKey(r)
		if prior := q.idemGet(key); prior != nil {
			replayIdem(w, r, s, prior, fingerprint)
			return
		}
		category, err := q.patternCategory(in.CategoryID.value)
		if err != nil {
			s.writeError(w, r, 409, "pattern_category_unavailable", err)
			return
		}
		now := q.now()
		var first *time.Time
		if in.Published {
			first = &now
		}
		pattern := queries.InsertPatternParams{ID: id(), Name: name, CategoryID: in.CategoryID.value, Published: in.Published, FirstPublishedAt: first,
			Image: img.Data, ImageType: img.Type, Thumbnail: img.Thumbnail, Width: int32(img.Width), Height: int32(img.Height), //nolint:gosec // 边长不超过 MaxSide
			ImageVersion: img.Version, UpdatedBy: u.ID, UpdatedAt: now}
		q.fail(q.dbWrite().InsertPattern(q.ctx, pattern))
		q.audit(u.ID, "pattern.created", pattern.ID, "「"+name+"」 · "+category+" · "+choose(in.Published, "上架", "先不上架"), requestID(r))
		body, _ := json.Marshal(q.libraryView(true))
		q.rememberIdem(key, idemResponse{Fingerprint: fingerprint, Status: 201, ContentType: "application/json", Body: body})
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		_, _ = w.Write(append(body, '\n'))
	})
}

// replayIdem 重放同一个幂等键记下的响应；请求内容变了回 409。
func replayIdem(w http.ResponseWriter, r *http.Request, s *Server, prior *idemResponse, fingerprint string) {
	if prior.Fingerprint != fingerprint {
		s.writeError(w, r, 409, "idempotency_conflict", errors.New("key already used for a different request"))
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(prior.Status)
	_, _ = w.Write(prior.Body)
}

// updatePattern 改一张图纸：只改带了的字段（名字、分类、上下架、换图），至少一项。第一次上架时记下时刻（之后 7 天算上新），
// 下架再上架不重记。换图同样先在事务外重新编码。
func (s *Server) updatePattern(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.staffMember(w, r); !ok {
		return
	}
	target := r.PathValue("id")
	if !validID(target) {
		s.writeError(w, r, 404, "not_found", errNotFound)
		return
	}
	var in struct {
		Name       *string    `json:"name"`
		CategoryID optionalID `json:"categoryId"`
		Published  *bool      `json:"published"`
		Image      *string    `json:"image"`
	}
	if err := decode(r, &in); err != nil {
		s.writeError(w, r, 400, "invalid_request", err)
		return
	}
	if in.Name == nil && !in.CategoryID.set && in.Published == nil && in.Image == nil {
		s.writeError(w, r, 400, "invalid_pattern", errors.New("没有要修改的内容"))
		return
	}
	var name string
	if in.Name != nil {
		var err error
		if name, err = patterns.Name(*in.Name); err != nil {
			s.writeError(w, r, 400, "invalid_pattern", err)
			return
		}
	}
	var img *patterns.Image
	if in.Image != nil {
		normalized, err := patterns.NormalizeImage(*in.Image)
		if err != nil {
			s.writeError(w, r, 400, "invalid_pattern_image", err)
			return
		}
		img = &normalized
	}
	s.serveTx(w, r, true, "patterns", func(w http.ResponseWriter, r *http.Request) {
		u, ok := s.staffMember(w, r)
		if !ok {
			return
		}
		q := s.tx(r)
		_, list := q.patternLibrary(true)
		i := slices.IndexFunc(list, func(p queries.PatternsRow) bool { return p.ID == target })
		if i < 0 {
			s.writeError(w, r, 404, "not_found", errNotFound)
			return
		}
		before, now := list[i], q.now()
		after := queries.UpdatePatternParams{ID: target, Name: before.Name, CategoryID: before.CategoryID, Published: before.Published,
			FirstPublishedAt: before.FirstPublishedAt, UpdatedBy: u.ID, UpdatedAt: now}
		var changes []string
		if in.Name != nil && name != before.Name {
			after.Name = name
			changes = append(changes, "名字「"+before.Name+"」→「"+name+"」")
		}
		if in.CategoryID.set && !sameID(in.CategoryID.value, before.CategoryID) {
			category, err := q.patternCategory(in.CategoryID.value)
			if err != nil {
				s.writeError(w, r, 409, "pattern_category_unavailable", err)
				return
			}
			after.CategoryID = in.CategoryID.value
			changes = append(changes, "分类改为"+category)
		}
		if in.Published != nil && *in.Published != before.Published {
			after.Published = *in.Published
			if after.Published && after.FirstPublishedAt == nil {
				after.FirstPublishedAt = &now
			}
			changes = append(changes, choose(after.Published, "上架", "下架"))
		}
		if img != nil && img.Version != before.ImageVersion {
			q.fail(errIfNone(q.dbWrite().ReplacePatternImage(q.ctx, queries.ReplacePatternImageParams{ID: target, Image: img.Data, ImageType: img.Type,
				Thumbnail: img.Thumbnail, Width: int32(img.Width), Height: int32(img.Height), ImageVersion: img.Version, //nolint:gosec // 边长不超过 MaxSide
				UpdatedBy: u.ID, UpdatedAt: now})))
			changes = append(changes, "换图")
		}
		if len(changes) > 0 {
			q.fail(errIfNone(q.dbWrite().UpdatePattern(q.ctx, after)))
			q.audit(u.ID, "pattern.updated", target, "「"+after.Name+"」："+strings.Join(changes, "，"), requestID(r))
		}
		writeJSON(w, 200, q.libraryView(true))
	})
}

func choose(cond bool, yes, no string) string {
	if cond {
		return yes
	}
	return no
}

func sameID(a, b *string) bool { return (a == nil && b == nil) || (a != nil && b != nil && *a == *b) }

// errIfNone 把「一行都没改到」当成错误：编号是事务里刚查到的，改不到说明数据不对，整个请求回滚。
func errIfNone(rows int64, err error) error {
	if err == nil && rows == 0 {
		return errors.New("数据刚被别人改过，请刷新后重试")
	}
	return err
}

// deletePattern 删一张图纸（图纸不是财务记录，可以删；记审计，写明名字）。
func (s *Server) deletePattern(w http.ResponseWriter, r *http.Request) {
	u, ok := s.staffMember(w, r)
	if !ok {
		return
	}
	target := r.PathValue("id")
	if !validID(target) {
		s.writeError(w, r, 404, "not_found", errNotFound)
		return
	}
	q := s.tx(r)
	_, list := q.patternLibrary(true)
	i := slices.IndexFunc(list, func(p queries.PatternsRow) bool { return p.ID == target })
	if i < 0 {
		s.writeError(w, r, 404, "not_found", errNotFound)
		return
	}
	q.fail(errIfNone(q.dbWrite().DeletePattern(q.ctx, target)))
	q.audit(u.ID, "pattern.deleted", target, "「"+list[i].Name+"」", requestID(r))
	writeJSON(w, 200, q.libraryView(true))
}

// readOrder 读排顺序的请求：ids 必须恰好是现有的全部编号（各一次）；对不上说明别人刚增删过，回 409 让员工刷新。
func (s *Server) readOrder(w http.ResponseWriter, r *http.Request, current []string, what string) ([]string, bool) {
	var in struct {
		IDs []string `json:"ids"`
	}
	if err := decode(r, &in); err != nil {
		s.writeError(w, r, 400, "invalid_request", err)
		return nil, false
	}
	sorted := slices.Clone(in.IDs)
	slices.Sort(sorted)
	want := slices.Clone(current)
	slices.Sort(want)
	if !slices.Equal(sorted, want) {
		s.writeError(w, r, 409, "order_outdated", errors.New(what+"刚有增减，请刷新后重新排"))
		return nil, false
	}
	return in.IDs, true
}

// orderPatterns 按给出的顺序重排全部图纸（顾客端「全部」和首页补位都按它）。
func (s *Server) orderPatterns(w http.ResponseWriter, r *http.Request) {
	u, ok := s.staffMember(w, r)
	if !ok {
		return
	}
	q := s.tx(r)
	_, list := q.patternLibrary(true)
	current := make([]string, 0, len(list))
	for _, p := range list {
		current = append(current, p.ID)
	}
	ids, ok := s.readOrder(w, r, current, "图纸")
	if !ok {
		return
	}
	if !slices.Equal(ids, current) {
		for i, pid := range ids {
			q.fail(q.dbWrite().SetPatternPosition(q.ctx, queries.SetPatternPositionParams{ID: pid, Position: int32(i + 1)})) //nolint:gosec // 图纸数量很少
		}
		q.audit(u.ID, "pattern.reordered", "", "", requestID(r))
	}
	writeJSON(w, 200, q.libraryView(true))
}

// createPatternCategory 加一个分类，排在最后。重名回 409（先查再写：撞唯一索引会被当成冲突整个请求重来）。
func (s *Server) createPatternCategory(w http.ResponseWriter, r *http.Request) {
	u, ok := s.staffMember(w, r)
	if !ok {
		return
	}
	var in struct {
		Name string `json:"name"`
	}
	if err := decode(r, &in); err != nil {
		s.writeError(w, r, 400, "invalid_request", err)
		return
	}
	name, err := patterns.CategoryName(in.Name)
	if err != nil {
		s.writeError(w, r, 400, "invalid_pattern_category", err)
		return
	}
	q := s.tx(r)
	for _, c := range must(q.db().PatternCategories(q.ctx)) {
		if c.Name == name {
			s.writeError(w, r, 409, "pattern_category_taken", fmt.Errorf("已经有叫「%s」的分类了", name))
			return
		}
	}
	category := id()
	q.fail(q.dbWrite().InsertPatternCategory(q.ctx, queries.InsertPatternCategoryParams{ID: category, Name: name, UpdatedBy: &u.ID, UpdatedAt: q.now()}))
	q.audit(u.ID, "pattern_category.created", category, "「"+name+"」", requestID(r))
	writeJSON(w, 201, q.libraryView(true))
}

// updatePatternCategory 改分类的名字或启用、停用（停用后顾客端不出现，里面的图纸仍在「全部」里；空分类可以删，见 deletePatternCategory）。
func (s *Server) updatePatternCategory(w http.ResponseWriter, r *http.Request) {
	u, ok := s.staffMember(w, r)
	if !ok {
		return
	}
	target := r.PathValue("id")
	var in struct {
		Name    *string `json:"name"`
		Enabled *bool   `json:"enabled"`
	}
	if err := decode(r, &in); err != nil {
		s.writeError(w, r, 400, "invalid_request", err)
		return
	}
	if in.Name == nil && in.Enabled == nil {
		s.writeError(w, r, 400, "invalid_pattern_category", errors.New("没有要修改的内容"))
		return
	}
	q := s.tx(r)
	categories := must(q.db().PatternCategories(q.ctx))
	i := slices.IndexFunc(categories, func(c queries.PatternCategoriesRow) bool { return c.ID == target })
	if !validID(target) || i < 0 {
		s.writeError(w, r, 404, "not_found", errNotFound)
		return
	}
	before := categories[i]
	after := queries.UpdatePatternCategoryParams{ID: target, Name: before.Name, Enabled: before.Enabled, UpdatedBy: &u.ID, UpdatedAt: q.now()}
	var changes []string
	if in.Name != nil {
		name, err := patterns.CategoryName(*in.Name)
		if err != nil {
			s.writeError(w, r, 400, "invalid_pattern_category", err)
			return
		}
		if name != before.Name {
			for _, c := range categories {
				if c.Name == name {
					s.writeError(w, r, 409, "pattern_category_taken", fmt.Errorf("已经有叫「%s」的分类了", name))
					return
				}
			}
			after.Name = name
			changes = append(changes, "改名「"+before.Name+"」→「"+name+"」")
		}
	}
	if in.Enabled != nil && *in.Enabled != before.Enabled {
		after.Enabled = *in.Enabled
		changes = append(changes, choose(after.Enabled, "启用", "停用"))
	}
	if len(changes) > 0 {
		q.fail(errIfNone(q.dbWrite().UpdatePatternCategory(q.ctx, after)))
		q.audit(u.ID, "pattern_category.updated", target, "「"+after.Name+"」："+strings.Join(changes, "，"), requestID(r))
	}
	writeJSON(w, 200, q.libraryView(true))
}

// deletePatternCategory 删一个空分类（2026-10-20 业主定）：里面还有图纸（含下架的）时不删，先把图纸改到别的分类；
// 删了这个名字就能再用。有图纸的分类仍只能停用。
func (s *Server) deletePatternCategory(w http.ResponseWriter, r *http.Request) {
	u, ok := s.staffMember(w, r)
	if !ok {
		return
	}
	target := r.PathValue("id")
	q := s.tx(r)
	categories, list := q.patternLibrary(true)
	i := slices.IndexFunc(categories, func(c queries.PatternCategoriesRow) bool { return c.ID == target })
	if !validID(target) || i < 0 {
		s.writeError(w, r, 404, "not_found", errNotFound)
		return
	}
	inside := 0
	for _, p := range list {
		if p.CategoryID != nil && *p.CategoryID == target {
			inside++
		}
	}
	if inside > 0 {
		s.writeError(w, r, 409, "pattern_category_in_use", fmt.Errorf("「%s」里还有 %d 张图纸（含下架的），先把它们改到别的分类再删", categories[i].Name, inside))
		return
	}
	q.fail(errIfNone(q.dbWrite().DeletePatternCategory(q.ctx, target)))
	q.audit(u.ID, "pattern_category.deleted", target, "「"+categories[i].Name+"」", requestID(r))
	writeJSON(w, 200, q.libraryView(true))
}

// orderPatternCategories 按给出的顺序重排全部分类（顾客端筛选条按它）。
func (s *Server) orderPatternCategories(w http.ResponseWriter, r *http.Request) {
	u, ok := s.staffMember(w, r)
	if !ok {
		return
	}
	q := s.tx(r)
	categories := must(q.db().PatternCategories(q.ctx))
	current := make([]string, 0, len(categories))
	for _, c := range categories {
		current = append(current, c.ID)
	}
	ids, ok := s.readOrder(w, r, current, "分类")
	if !ok {
		return
	}
	if !slices.Equal(ids, current) {
		for i, cid := range ids {
			q.fail(q.dbWrite().SetPatternCategoryPosition(q.ctx, queries.SetPatternCategoryPositionParams{ID: cid, Position: int32(i + 1)})) //nolint:gosec // 分类数量很少
		}
		q.audit(u.ID, "pattern_category.reordered", "", "", requestID(r))
	}
	writeJSON(w, 200, q.libraryView(true))
}
