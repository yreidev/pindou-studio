package app

import (
	"encoding/base64"
	"net/http"
	"strings"
	"testing"
	"time"
)

// 店里做图纸用的豆子：游客读到默认值；只有员工能改，带读到的修订号，别人先改了回 409；和现在一样不写、不记审计；不合规的拒收。
func TestStaffSetBeadSettingsEveryoneReadsThem(t *testing.T) {
	s := newTestServer(t)
	clerk := register(t, s, "bead-clerk", "店员")
	setRoles(t, s, clerk.User.ID, Clerk)
	customer := register(t, s, "bead-customer", "顾客")

	read := func() map[string]any {
		t.Helper()
		w := call(t, s, http.MethodGet, "/api/v2/bead-settings", "", "", nil)
		if w.Code != 200 {
			t.Fatalf("读设置：%d %s", w.Code, w.Body.String())
		}
		return decodeMap(t, w)
	}
	got := read()
	if got["palette"] != "mard-221" || got["available"] != nil || len(got["boxes"].(map[string]any)) != 0 || got["boardSize"] != 52.0 ||
		got["beadSize"] != "mini" || got["revision"] != 0.0 || got["updatedAt"] != nil {
		t.Fatalf("没设置过是默认值：%v", got)
	}

	body := map[string]any{"expectedRevision": 0, "palette": "mard-291", "available": []string{"ZG1", "A1", "A2"}, "boxes": map[string]string{"A1": " 1 号 ", "A2": ""}, "boardSize": 29, "beadSize": "midi"}
	if w := call(t, s, http.MethodPatch, "/api/v2/bead-settings", "", "", body); w.Code != 401 {
		t.Fatalf("游客改：%d", w.Code)
	}
	if w := call(t, s, http.MethodPatch, "/api/v2/bead-settings", customer.AccessToken, "", body); w.Code != 403 {
		t.Fatalf("顾客改：%d", w.Code)
	}
	for label, edit := range map[string]func(map[string]any){
		"没有这套色卡":  func(b map[string]any) { b["palette"] = "nope" },
		"色号不是这套的": func(b map[string]any) { b["palette"] = "mard-221" },
		"只有一种颜色":  func(b map[string]any) { b["available"] = []string{"A1"} },
		"盒号太长":    func(b map[string]any) { b["boxes"] = map[string]string{"A1": "一二三四五六七八九"} },
		"底板太大":    func(b map[string]any) { b["boardSize"] = 151 },
		"豆子大小不认识": func(b map[string]any) { b["beadSize"] = "huge" },
	} {
		bad := map[string]any{}
		for k, v := range body {
			bad[k] = v
		}
		edit(bad)
		if w := call(t, s, http.MethodPatch, "/api/v2/bead-settings", clerk.AccessToken, "", bad); w.Code != 400 || errorCodeOf(t, w) != "invalid_bead_settings" {
			t.Fatalf("%s：%d %s", label, w.Code, w.Body.String())
		}
	}
	if w := call(t, s, http.MethodPatch, "/api/v2/bead-settings", clerk.AccessToken, "", map[string]any{"palette": "mard-221", "available": nil, "boxes": map[string]string{}, "boardSize": 52, "beadSize": "mini"}); w.Code != 400 {
		t.Fatalf("不带修订号：%d", w.Code)
	}
	if read()["revision"] != 0.0 {
		t.Fatal("拒收的什么都没改")
	}

	audits := len(auditsOf(t, s))
	w := call(t, s, http.MethodPatch, "/api/v2/bead-settings", clerk.AccessToken, "", body)
	if w.Code != 200 {
		t.Fatalf("店员保存：%d %s", w.Code, w.Body.String())
	}
	saved := decodeMap(t, w)
	if saved["revision"] != 1.0 || saved["boardSize"] != 29.0 || saved["beadSize"] != "midi" || saved["updatedAt"] == nil {
		t.Fatalf("保存后：%v", saved)
	}
	if strings.Join(toStrings(saved["available"]), ",") != "A1,A2,ZG1" {
		t.Fatalf("店里有的颜色按色卡顺序存：%v", saved["available"])
	}
	if boxes := saved["boxes"].(map[string]any); len(boxes) != 1 || boxes["A1"] != "1 号" {
		t.Fatalf("盒号去空白、空的丢掉：%v", boxes)
	}
	if a := lastAudit(t, s); a.Action != "bead_settings.saved" || a.ActorID != clerk.User.ID || a.Reason != "MARD 291 色，店里有 3 种，填了 1 个盒号，29 格底板，5 毫米豆" {
		t.Fatalf("审计：%+v", a)
	}
	if read()["revision"] != 1.0 {
		t.Fatal("游客读到保存后的")
	}

	// 网络重试：修订号已经过时，但内容一样，原样返回、不再记审计
	if w := call(t, s, http.MethodPatch, "/api/v2/bead-settings", clerk.AccessToken, "", body); w.Code != 200 || decodeMap(t, w)["revision"] != 1.0 || len(auditsOf(t, s)) != audits+1 {
		t.Fatalf("重试：%d %s", w.Code, w.Body.String())
	}
	// 别人先改了：修订号对不上，内容不一样
	body["boardSize"] = 52
	if w := call(t, s, http.MethodPatch, "/api/v2/bead-settings", clerk.AccessToken, "", body); w.Code != 409 || errorCodeOf(t, w) != "bead_settings_conflict" {
		t.Fatalf("修订号过时：%d %s", w.Code, w.Body.String())
	}
	body["expectedRevision"], body["available"] = 1, nil
	if w := call(t, s, http.MethodPatch, "/api/v2/bead-settings", clerk.AccessToken, "", body); w.Code != 200 || decodeMap(t, w)["revision"] != 2.0 || decodeMap(t, w)["available"] != nil {
		t.Fatalf("带对修订号、改回都有：%d %s", w.Code, w.Body.String())
	}
}

func toStrings(v any) []string {
	var out []string
	for _, x := range v.([]any) {
		out = append(out, x.(string))
	}
	return out
}

// beadDraft 是一张 6×4 的图纸：两种颜色、20 颗，第一行拼完了。
func beadDraft(revision int) map[string]any {
	return map[string]any{
		"expectedRevision": revision, "name": "小猫", "palette": "mard-221", "width": 6, "height": 4, "colors": []string{"A1", "H7"},
		"cells": "000000" + "011110" + "0.11.0" + "0.00.0", "done": base64.StdEncoding.EncodeToString([]byte{0b0011_1111, 0, 0}),
	}
}

// 顾客存自己的图纸：编号自己生成，新建带 0，网络重试原样返回，修订号过时回 409；后端算颗数、进度和缩略格子；
// 别人（含员工）看不到、改不了、删不掉；最多 30 张；删了就没了，再删也不报错。
func TestCustomersKeepTheirOwnBeadPatterns(t *testing.T) {
	s := newTestServer(t)
	clock := time.Date(2026, 10, 20, 15, 0, 0, 0, cst)
	s.now = func() time.Time { return clock }
	lin := register(t, s, "bead-lin", "小林")
	wang := register(t, s, "bead-wang", "小王")
	clerk := register(t, s, "bead-staff", "店员")
	setRoles(t, s, clerk.User.ID, Clerk)
	cat := id()
	path := "/api/v2/bead-patterns/" + cat

	if w := call(t, s, http.MethodGet, "/api/v2/bead-patterns", "", "", nil); w.Code != 401 {
		t.Fatalf("游客读列表：%d", w.Code)
	}
	if w := call(t, s, http.MethodPatch, path, "", "", beadDraft(0)); w.Code != 401 {
		t.Fatalf("游客保存：%d", w.Code)
	}
	for label, edit := range map[string]func(map[string]any){
		"格子少了":    func(b map[string]any) { b["cells"] = "0000" },
		"色号不在色卡里": func(b map[string]any) { b["colors"] = []string{"A1", "ZG1"} },
		"名字太长":    func(b map[string]any) { b["name"] = strings.Repeat("猫", 21) },
		"拼完的长度不对": func(b map[string]any) { b["done"] = "AA==" },
	} {
		bad := beadDraft(0)
		edit(bad)
		if w := call(t, s, http.MethodPatch, path, lin.AccessToken, "", bad); w.Code != 400 || errorCodeOf(t, w) != "invalid_bead_pattern" {
			t.Fatalf("%s：%d %s", label, w.Code, w.Body.String())
		}
	}
	if w := call(t, s, http.MethodPatch, "/api/v2/bead-patterns/not-an-id", lin.AccessToken, "", beadDraft(0)); w.Code != 404 {
		t.Fatalf("编号不对：%d", w.Code)
	}
	if w := call(t, s, http.MethodPatch, path, lin.AccessToken, "", beadDraft(1)); w.Code != 409 || errorCodeOf(t, w) != "bead_pattern_conflict" {
		t.Fatalf("没有的图纸带修订号 1（别处删掉了）：%d %s", w.Code, w.Body.String())
	}

	w := call(t, s, http.MethodPatch, path, lin.AccessToken, "", beadDraft(0))
	if w.Code != 200 {
		t.Fatalf("新建：%d %s", w.Code, w.Body.String())
	}
	got := decodeMap(t, w)
	if got["id"] != cat || got["revision"] != 1.0 || got["beads"] != 20.0 || got["doneBeads"] != 6.0 || got["cells"] != beadDraft(0)["cells"] {
		t.Fatalf("新建后：%v", got)
	}
	if w := call(t, s, http.MethodPatch, path, lin.AccessToken, "", beadDraft(0)); w.Code != 200 || decodeMap(t, w)["revision"] != 1.0 {
		t.Fatalf("网络重试原样返回：%d %s", w.Code, w.Body.String())
	}

	// 别人：看不到、改不了、删不掉
	for _, other := range []sessionResponse{wang, clerk} {
		if w := call(t, s, http.MethodGet, path, other.AccessToken, "", nil); w.Code != 404 {
			t.Fatalf("%s 读别人的：%d", other.User.Nickname, w.Code)
		}
		if w := call(t, s, http.MethodPatch, path, other.AccessToken, "", beadDraft(1)); w.Code != 404 {
			t.Fatalf("%s 改别人的：%d", other.User.Nickname, w.Code)
		}
		if w := call(t, s, http.MethodDelete, path, other.AccessToken, "", nil); w.Code != 204 {
			t.Fatalf("%s 删别人的（当作没有）：%d", other.User.Nickname, w.Code)
		}
		if w := call(t, s, http.MethodGet, "/api/v2/bead-patterns", other.AccessToken, "", nil); w.Code != 200 || len(decodeMap(t, w)["patterns"].([]any)) != 0 {
			t.Fatalf("%s 的列表里没有别人的：%s", other.User.Nickname, w.Body.String())
		}
	}

	// 边拼边看标了一格：带对修订号保存；拿旧修订号再存别的内容回 409
	clock = clock.Add(time.Minute)
	next := beadDraft(1)
	next["done"] = base64.StdEncoding.EncodeToString([]byte{0b0111_1111, 0, 0})
	if w := call(t, s, http.MethodPatch, path, lin.AccessToken, "", next); w.Code != 200 || decodeMap(t, w)["revision"] != 2.0 || decodeMap(t, w)["doneBeads"] != 7.0 {
		t.Fatalf("保存进度：%d %s", w.Code, w.Body.String())
	}
	stale := beadDraft(1)
	stale["name"] = "大猫"
	if w := call(t, s, http.MethodPatch, path, lin.AccessToken, "", stale); w.Code != 409 || errorCodeOf(t, w) != "bead_pattern_conflict" {
		t.Fatalf("修订号过时：%d %s", w.Code, w.Body.String())
	}
	if w := call(t, s, http.MethodGet, path, lin.AccessToken, "", nil); w.Code != 200 || decodeMap(t, w)["name"] != "小猫" || decodeMap(t, w)["revision"] != 2.0 {
		t.Fatalf("读回：%d %s", w.Code, w.Body.String())
	}

	// 列表：新改的在前，不带完整格子，带缩略格子
	clock = clock.Add(time.Minute)
	dog := id()
	if w := call(t, s, http.MethodPatch, "/api/v2/bead-patterns/"+dog, lin.AccessToken, "", beadDraft(0)); w.Code != 200 {
		t.Fatalf("第二张：%d", w.Code)
	}
	w = call(t, s, http.MethodGet, "/api/v2/bead-patterns", lin.AccessToken, "", nil)
	list := decodeMap(t, w)
	items := list["patterns"].([]any)
	if w.Code != 200 || list["limit"] != 30.0 || len(items) != 2 || items[0].(map[string]any)["id"] != dog || items[1].(map[string]any)["preview"] != beadDraft(0)["cells"] {
		t.Fatalf("列表：%s", w.Body.String())
	}
	if _, has := items[0].(map[string]any)["cells"]; has {
		t.Fatal("列表不带完整格子")
	}

	// 最多 30 张
	for range 28 {
		if w := call(t, s, http.MethodPatch, "/api/v2/bead-patterns/"+id(), lin.AccessToken, "", beadDraft(0)); w.Code != 200 {
			t.Fatalf("存满：%d", w.Code)
		}
	}
	if w := call(t, s, http.MethodPatch, "/api/v2/bead-patterns/"+id(), lin.AccessToken, "", beadDraft(0)); w.Code != 409 || errorCodeOf(t, w) != "bead_pattern_limit" {
		t.Fatalf("第 31 张：%d %s", w.Code, w.Body.String())
	}
	if w := call(t, s, http.MethodPatch, path, lin.AccessToken, "", beadDraft(2)); w.Code != 200 {
		t.Fatalf("存满了照样能改已有的：%d %s", w.Code, w.Body.String())
	}

	// 删了就没了，再删也不报错
	if w := call(t, s, http.MethodDelete, path, lin.AccessToken, "", nil); w.Code != 204 {
		t.Fatalf("删除：%d", w.Code)
	}
	if w := call(t, s, http.MethodGet, path, lin.AccessToken, "", nil); w.Code != 404 {
		t.Fatalf("删了读不到：%d", w.Code)
	}
	if w := call(t, s, http.MethodDelete, path, lin.AccessToken, "", nil); w.Code != 204 {
		t.Fatalf("再删：%d", w.Code)
	}
}

// 最大的图（300×300）和国外色卡（Perler 的色号带连字符）照样能存、能读回（2026-10-21 业主定）。
func TestLargestBeadPatternWithForeignPalette(t *testing.T) {
	s := newTestServer(t)
	lin := register(t, s, "bead-big", "小林")
	path := "/api/v2/bead-patterns/" + id()
	big := map[string]any{
		"expectedRevision": 0, "name": "墙上的大图", "palette": "perler-103", "width": 300, "height": 300,
		"colors": []string{"80-15179", "80-15181"}, "cells": strings.Repeat("01", 300*300/2), "done": "",
	}
	if w := call(t, s, http.MethodPatch, path, lin.AccessToken, "", big); w.Code != 200 || decodeMap(t, w)["beads"] != 90000.0 {
		t.Fatalf("存 300×300：%d %s", w.Code, w.Body.String())
	}
	w := call(t, s, http.MethodGet, path, lin.AccessToken, "", nil)
	if got := decodeMap(t, w); w.Code != 200 || got["cells"] != big["cells"] || toStrings(got["colors"])[0] != "80-15179" {
		t.Fatalf("读回：%d", w.Code)
	}
	big["width"], big["cells"] = 301, strings.Repeat("0", 301*300)
	if w := call(t, s, http.MethodPatch, "/api/v2/bead-patterns/"+id(), lin.AccessToken, "", big); w.Code != 400 {
		t.Fatalf("301 格宽：%d", w.Code)
	}
}
