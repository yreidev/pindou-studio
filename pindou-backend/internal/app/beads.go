package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strconv"
	"time"

	beads "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/beads/application"
	"github.com/yreidev/pindou-studio/pindou-backend/internal/palettes"
	"github.com/yreidev/pindou-studio/pindou-backend/internal/storage/queries"
)

// 顾客的「做图纸」工具（迁移 027，2026-10-20，方案见 docs/plan-bead-maker.md）：顾客在小程序把照片转成拼豆图纸、改图、边拼边看，
// 图纸存在自己的账户里，只有本人能看、能改，员工看不到。店里用哪套色卡、有哪些颜色、盒号和底板由员工在网页后台设，游客也能读。
// 图纸不是业务记录：顾客删了就删了，不记审计；店里的设置记审计。

const (
	// beadSaveLimit、beadSaveWindow 是每个账户保存、删除图纸的频率上限（边拼边看时标格子也要存）。
	beadSaveLimit  = 300
	beadSaveWindow = 10 * time.Minute
)

// beadSettings 是店里现在的设置和它的修订号（0 表示没设置过，用默认值）。
func (q *txn) beadSettings() (beads.Settings, int32, *time.Time) {
	rows := must(q.db().BeadSettings(q.ctx))
	if len(rows) == 0 {
		return beads.DefaultSettings(), 0, nil
	}
	row := rows[0]
	set := beads.Settings{Palette: row.Palette, Available: row.Available, Boxes: map[string]string{}, BoardSize: int(row.BoardSize), BeadSize: row.BeadSize}
	if err := json.Unmarshal(row.Boxes, &set.Boxes); err != nil {
		panic(dbFailure{err})
	}
	return set, row.Revision, &row.UpdatedAt
}

func beadSettingsView(set beads.Settings, revision int32, updated *time.Time) map[string]any {
	return map[string]any{
		"palette": set.Palette, "available": set.Available, "boxes": set.Boxes, "boardSize": set.BoardSize, "beadSize": set.BeadSize,
		"revision": revision, "updatedAt": updated,
	}
}

// getBeadSettings 是店里做图纸用的豆子，游客也能读（没登录也能做图纸）。
func (s *Server) getBeadSettings(w http.ResponseWriter, r *http.Request) {
	q := s.tx(r)
	writeJSON(w, 200, beadSettingsView(q.beadSettings()))
}

// saveBeadSettings 是员工保存店里做图纸用的豆子。带上读到的修订号，别人先改了回 409；和现在一样就不写、不记审计（网络重试也是这样）。
func (s *Server) saveBeadSettings(w http.ResponseWriter, r *http.Request) {
	u, ok := s.staffMember(w, r)
	if !ok {
		return
	}
	var in struct {
		ExpectedRevision *int32            `json:"expectedRevision"`
		Palette          string            `json:"palette"`
		Available        []string          `json:"available"`
		Boxes            map[string]string `json:"boxes"`
		BoardSize        int               `json:"boardSize"`
		BeadSize         string            `json:"beadSize"`
	}
	if err := decode(r, &in); err != nil {
		s.writeError(w, r, 400, "invalid_request", err)
		return
	}
	if in.ExpectedRevision == nil {
		s.writeError(w, r, 400, "invalid_request", errors.New("expectedRevision is required"))
		return
	}
	next, err := beads.CheckSettings(beads.Settings{Palette: in.Palette, Available: in.Available, Boxes: in.Boxes, BoardSize: in.BoardSize, BeadSize: in.BeadSize})
	if err != nil {
		s.writeError(w, r, 400, "invalid_bead_settings", err)
		return
	}
	q := s.tx(r)
	current, revision, updated := q.beadSettings()
	if revision > 0 && next.Equal(current) {
		writeJSON(w, 200, beadSettingsView(current, revision, updated))
		return
	}
	if *in.ExpectedRevision != revision {
		s.writeError(w, r, 409, "bead_settings_conflict", errors.New("别人刚改过做图纸用的豆子，请刷新后再改"))
		return
	}
	boxes, err := json.Marshal(next.Boxes)
	if err != nil {
		panic(dbFailure{err})
	}
	now := q.now()
	q.fail(q.dbWrite().SaveBeadSettings(q.ctx, queries.SaveBeadSettingsParams{
		Palette: next.Palette, Available: next.Available, Boxes: boxes, BoardSize: int32(next.BoardSize), BeadSize: next.BeadSize, //nolint:gosec // 已核对 10～150
		Revision: revision + 1, UpdatedBy: u.ID, UpdatedAt: now,
	}))
	q.audit(u.ID, "bead_settings.saved", "", beadSettingsSummary(next), requestID(r))
	writeJSON(w, 200, beadSettingsView(next, revision+1, &now))
}

// beadSettingsSummary 是审计里的一句话，如「MARD 221 色，店里有 180 种，填了 40 个盒号，52 格底板，2.6 毫米豆」。
func beadSettingsSummary(set beads.Settings) string {
	palette := palettes.Get(set.Palette)
	have := "都有"
	if set.Available != nil {
		have = "有 " + strconv.Itoa(len(set.Available)) + " 种"
	}
	size := "2.6 毫米豆"
	if set.BeadSize == "midi" {
		size = "5 毫米豆"
	}
	return fmt.Sprintf("%s，店里%s，填了 %d 个盒号，%d 格底板，%s", palette.Name, have, len(set.Boxes), set.BoardSize, size)
}

func beadPatternSummaryView(p queries.BeadPatternsOfRow) map[string]any {
	return map[string]any{
		"id": p.ID, "name": p.Name, "palette": p.Palette, "width": p.Width, "height": p.Height, "colors": p.Colors,
		"preview": p.Preview, "previewWidth": p.PreviewWidth, "previewHeight": p.PreviewHeight,
		"beads": p.Beads, "doneBeads": p.DoneBeads, "revision": p.Revision, "createdAt": p.CreatedAt, "updatedAt": p.UpdatedAt,
	}
}

func beadPatternView(p queries.BeadPatternRow) map[string]any {
	return map[string]any{
		"id": p.ID, "name": p.Name, "palette": p.Palette, "width": p.Width, "height": p.Height, "colors": p.Colors,
		"cells": p.Cells, "done": p.Done, "beads": p.Beads, "doneBeads": p.DoneBeads, "revision": p.Revision,
		"createdAt": p.CreatedAt, "updatedAt": p.UpdatedAt,
	}
}

// listBeadPatterns 是我的图纸，新改的在前，不带完整格子（列表用缩略格子）。
func (s *Server) listBeadPatterns(w http.ResponseWriter, r *http.Request) {
	u, ok := s.signedIn(w, r)
	if !ok {
		return
	}
	q := s.tx(r)
	rows := must(q.db().BeadPatternsOf(q.ctx, u.ID))
	list := make([]map[string]any, 0, len(rows))
	for _, p := range rows {
		list = append(list, beadPatternSummaryView(p))
	}
	writeJSON(w, 200, map[string]any{"patterns": list, "limit": beads.MaxPatterns})
}

// getBeadPattern 取本人的一张图纸（含完整格子）；编号不对、没有或不是本人的都回 404。
func (s *Server) getBeadPattern(w http.ResponseWriter, r *http.Request) {
	u, ok := s.signedIn(w, r)
	if !ok {
		return
	}
	target := r.PathValue("id")
	if !validID(target) {
		s.writeError(w, r, 404, "not_found", errNotFound)
		return
	}
	q := s.tx(r)
	rows := must(q.db().BeadPattern(q.ctx, queries.BeadPatternParams{ID: target, AccountID: u.ID}))
	if len(rows) == 0 {
		s.writeError(w, r, 404, "not_found", errNotFound)
		return
	}
	writeJSON(w, 200, beadPatternView(rows[0]))
}

// saveBeadPattern 新建或保存本人的一张图纸。编号由小程序生成；expectedRevision 是读到的修订号，新建是 0。
// 和现有的内容一样就原样返回（网络重试、两台手机存了同样的东西），不算冲突；否则修订号对不上回 409。
// 编号被别人的图纸占了也回 404（编号随机生成，碰不上）。
func (s *Server) saveBeadPattern(w http.ResponseWriter, r *http.Request) {
	u, ok := s.signedIn(w, r)
	if !ok {
		return
	}
	target := r.PathValue("id")
	if !validID(target) {
		s.writeError(w, r, 404, "not_found", errNotFound)
		return
	}
	var in struct {
		ExpectedRevision *int32   `json:"expectedRevision"`
		Name             string   `json:"name"`
		Palette          string   `json:"palette"`
		Width            int      `json:"width"`
		Height           int      `json:"height"`
		Colors           []string `json:"colors"`
		Cells            string   `json:"cells"`
		Done             string   `json:"done"`
	}
	if err := decode(r, &in); err != nil {
		s.writeError(w, r, 400, "invalid_request", err)
		return
	}
	if in.ExpectedRevision == nil || in.Colors == nil {
		s.writeError(w, r, 400, "invalid_request", errors.New("expectedRevision and colors are required"))
		return
	}
	p, err := beads.Check(beads.Draft{Name: in.Name, Palette: in.Palette, Width: in.Width, Height: in.Height, Colors: in.Colors, Cells: in.Cells, Done: in.Done})
	if err != nil {
		s.writeError(w, r, 400, "invalid_bead_pattern", err)
		return
	}
	q := s.tx(r)
	locked := must(q.dbWrite().LockBeadPattern(q.ctx, target))
	if len(locked) > 0 && locked[0].AccountID != u.ID {
		s.writeError(w, r, 404, "not_found", errNotFound)
		return
	}
	now := q.now()
	//nolint:gosec // 宽高、颗数都已核对在 300×300 以内
	w32, h32, pw, ph, n, done := int32(p.Width), int32(p.Height), int32(p.PreviewWidth), int32(p.PreviewHeight), int32(p.Beads), int32(p.DoneBeads)
	if len(locked) == 0 {
		if *in.ExpectedRevision != 0 {
			s.writeError(w, r, 409, "bead_pattern_conflict", errors.New("这张图纸已经在别处删掉了"))
			return
		}
		if must(q.db().CountBeadPatterns(q.ctx, u.ID)) >= beads.MaxPatterns {
			s.writeError(w, r, 409, "bead_pattern_limit", fmt.Errorf("最多存 %d 张图纸，删掉几张再存", beads.MaxPatterns))
			return
		}
		q.fail(q.dbWrite().InsertBeadPattern(q.ctx, queries.InsertBeadPatternParams{
			ID: target, AccountID: u.ID, Name: p.Name, Palette: p.Palette, Width: w32, Height: h32, Colors: p.Colors, Cells: p.Cells, Done: p.Done,
			Preview: p.Preview, PreviewWidth: pw, PreviewHeight: ph, Beads: n, DoneBeads: done, Now: now,
		}))
	} else {
		old := locked[0]
		same := old.Name == p.Name && old.Palette == p.Palette && old.Width == w32 && old.Height == h32 && slices.Equal(old.Colors, p.Colors) &&
			old.Cells == p.Cells && old.Done == p.Done
		if !same {
			if *in.ExpectedRevision != old.Revision {
				s.writeError(w, r, 409, "bead_pattern_conflict", errors.New("这张图纸刚在别处改过，请重新打开再改"))
				return
			}
			q.fail(q.dbWrite().UpdateBeadPattern(q.ctx, queries.UpdateBeadPatternParams{
				ID: target, AccountID: u.ID, Name: p.Name, Palette: p.Palette, Width: w32, Height: h32, Colors: p.Colors, Cells: p.Cells, Done: p.Done,
				Preview: p.Preview, PreviewWidth: pw, PreviewHeight: ph, Beads: n, DoneBeads: done, Now: now,
			}))
		}
	}
	saved := must(q.dbWrite().BeadPattern(q.ctx, queries.BeadPatternParams{ID: target, AccountID: u.ID}))
	writeJSON(w, 200, beadPatternView(saved[0]))
}

// deleteBeadPattern 删本人的一张图纸（不记审计）。已经没有了也回 204：重试和两台手机先后删都不报错。
func (s *Server) deleteBeadPattern(w http.ResponseWriter, r *http.Request) {
	u, ok := s.signedIn(w, r)
	if !ok {
		return
	}
	target := r.PathValue("id")
	if !validID(target) {
		s.writeError(w, r, 404, "not_found", errNotFound)
		return
	}
	q := s.tx(r)
	must(q.dbWrite().DeleteBeadPattern(q.ctx, queries.DeleteBeadPatternParams{ID: target, AccountID: u.ID}))
	w.WriteHeader(http.StatusNoContent)
}
