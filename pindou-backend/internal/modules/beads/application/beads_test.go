package application

import (
	"encoding/base64"
	"errors"
	"slices"
	"strings"
	"testing"

	"github.com/yreidev/pindou-studio/pindou-backend/internal/palettes"
)

func draft() Draft {
	return Draft{
		Name: " 小猫 ", Palette: "mard-221", Width: 4, Height: 4, Colors: []string{"A1", "H7"},
		Cells: "0011" + "0011" + "...." + "1..1",
	}
}

func TestCheckCountsBeadsAndCleansDone(t *testing.T) {
	d := draft()
	// 拼完：第 0、1 格（有豆子）、第 2 格（有豆子）、第 8 格（空，要清掉）
	d.Done = base64.StdEncoding.EncodeToString([]byte{0b0000_0111, 0b0000_0001})
	p, err := Check(d)
	if err != nil {
		t.Fatal(err)
	}
	if p.Name != "小猫" || p.Beads != 10 || p.DoneBeads != 3 {
		t.Fatalf("名字去掉空白、10 颗、拼完 3 颗：%+v", p)
	}
	if want := base64.StdEncoding.EncodeToString([]byte{0b0000_0111, 0}); p.Done != want {
		t.Fatalf("空格子上的位要清掉：%q", p.Done)
	}
	d.Done = base64.StdEncoding.EncodeToString([]byte{0, 0b0000_0001}) // 只标了空格子
	if p, _ := Check(d); p.Done != "" || p.DoneBeads != 0 {
		t.Fatalf("一格都没拼完回空串：%+v", p)
	}
}

func TestCheckRejectsBadPatterns(t *testing.T) {
	for label, c := range map[string]struct {
		edit func(*Draft)
		want error
	}{
		"名字空":     {func(d *Draft) { d.Name = "  " }, ErrName},
		"名字太长":    {func(d *Draft) { d.Name = strings.Repeat("猫", 21) }, ErrName},
		"没有这套色卡":  {func(d *Draft) { d.Palette = "nope" }, ErrPalette},
		"太窄":      {func(d *Draft) { d.Width, d.Cells = 3, d.Cells[:12] }, ErrSize},
		"太高":      {func(d *Draft) { d.Height = 301 }, ErrSize},
		"色号不在色卡里": {func(d *Draft) { d.Colors = []string{"A1", "ZG1"} }, ErrColors},
		"色号重复":    {func(d *Draft) { d.Colors = []string{"A1", "A1"} }, ErrColors},
		"格子少一个":   {func(d *Draft) { d.Cells = d.Cells[:15] }, ErrCells},
		"序号超出颜色":  {func(d *Draft) { d.Cells = "2" + d.Cells[1:] }, ErrCells},
		"不认识的字符":  {func(d *Draft) { d.Cells = "#" + d.Cells[1:] }, ErrCells},
		"拼完的不是位图": {func(d *Draft) { d.Done = "!!" }, ErrDone},
		"拼完的长度不对": {func(d *Draft) { d.Done = base64.StdEncoding.EncodeToString([]byte{1}) }, ErrDone},
	} {
		d := draft()
		c.edit(&d)
		if _, err := Check(d); !errors.Is(err, c.want) {
			t.Fatalf("%s：%v", label, err)
		}
	}
}

func TestPreviewShrinksToAtMost32(t *testing.T) {
	// 小图原样
	if got, w, h := Preview("01..", 2, 2); got != "01.." || w != 2 || h != 2 {
		t.Fatalf("%q %d×%d", got, w, h)
	}
	// 100×40：每 4×4 一块，缩成 25×10
	cells := strings.Repeat("0", 100*40)
	got, w, h := Preview(cells, 100, 40)
	if w != 25 || h != 10 || got != strings.Repeat("0", 250) {
		t.Fatalf("%d×%d", w, h)
	}
	// 一块里空的过半是空；不过半取最多的颜色，一样多取序号小的
	if got, _, _ := Preview(strings.Repeat("..", 32)+strings.Repeat("1.", 32), 64, 2); got[0] != '.' {
		t.Fatalf("空的过半：%q", got)
	}
	if got, _, _ := Preview(strings.Repeat("10", 32)+strings.Repeat("..", 32), 64, 2); got[0] != '0' {
		t.Fatalf("一样多取序号小的：%q", got)
	}
}

func TestCheckSettings(t *testing.T) {
	got, err := CheckSettings(Settings{Palette: "mard-221", Available: []string{"H7", "A1"}, Boxes: map[string]string{"A1": " 3 号 ", "H7": " "}, BoardSize: 52, BeadSize: "mini"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(got.Available, ",") != "A1,H7" || len(got.Boxes) != 1 || got.Boxes["A1"] != "3 号" {
		t.Fatalf("按色卡顺序存、盒号去空白、空盒号丢掉：%+v", got)
	}
	whole, err := CheckSettings(Settings{Palette: "mard-221", Available: slices.Clone(palettes.Get("mard-221").Codes), BoardSize: 29, BeadSize: "midi"})
	if err != nil || whole.Available != nil {
		t.Fatalf("选全了存成 nil：%v %v", whole.Available, err)
	}
	for label, in := range map[string]Settings{
		"没有这套色卡":  {Palette: "nope", BoardSize: 52, BeadSize: "mini"},
		"只有一种颜色":  {Palette: "mard-221", Available: []string{"A1"}, BoardSize: 52, BeadSize: "mini"},
		"颜色重复":    {Palette: "mard-221", Available: []string{"A1", "A1"}, BoardSize: 52, BeadSize: "mini"},
		"色号不是这套的": {Palette: "mard-221", Available: []string{"A1", "ZG1"}, BoardSize: 52, BeadSize: "mini"},
		"盒号的色号不对": {Palette: "mard-221", Boxes: map[string]string{"ZG1": "1"}, BoardSize: 52, BeadSize: "mini"},
		"盒号太长":    {Palette: "mard-221", Boxes: map[string]string{"A1": "123456789"}, BoardSize: 52, BeadSize: "mini"},
		"底板太小":    {Palette: "mard-221", BoardSize: 9, BeadSize: "mini"},
		"豆子大小不对":  {Palette: "mard-221", BoardSize: 52, BeadSize: "huge"},
	} {
		if _, err := CheckSettings(in); err == nil {
			t.Fatalf("%s 应被拒绝", label)
		}
	}
	if !DefaultSettings().Equal(Settings{Palette: "mard-221", BoardSize: 52, BeadSize: "mini"}) {
		t.Fatal("默认：MARD 221 都有、没有盒号、52 格、2.6 毫米")
	}
}

// 300×300 是能存的最大的图（2026-10-21 业主定），Perler 的色号带连字符。
func TestCheckAcceptsLargestPattern(t *testing.T) {
	d := Draft{Name: "大图", Palette: "perler-103", Width: MaxSide, Height: MaxSide, Colors: []string{"80-15179"}, Cells: strings.Repeat("0", MaxSide*MaxSide)}
	p, err := Check(d)
	if err != nil || p.Beads != MaxSide*MaxSide {
		t.Fatalf("%v %d", err, p.Beads)
	}
	if _, w, h := Preview(d.Cells, MaxSide, MaxSide); w > PreviewSide || h > PreviewSide {
		t.Fatalf("缩略 %d×%d", w, h)
	}
}
