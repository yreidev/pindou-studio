// Package application 是顾客「做图纸」工具（迁移 027，方案见 docs/plan-bead-maker.md）在后端的规则：
// 店里做图纸用的豆子怎么设，顾客存的图纸格子怎么核对，列表用的缩略格子、颗数和进度怎么算。
// 取色、配色、改图都在小程序里做，后端只核对存进来的格子合不合规矩。
package application

import (
	"encoding/base64"
	"errors"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/yreidev/pindou-studio/pindou-backend/internal/palettes"
)

const (
	// MaxPatterns 是一个账户最多存几张图纸。
	MaxPatterns = 30
	// MinSide、MaxSide 是图纸的宽高（格数）范围。
	MinSide, MaxSide = 4, 300
	// MaxColors 是一张图纸最多用几种颜色：格子里一个字符表示一种，字符集有 64 个。
	MaxColors = 64
	// PreviewSide 是列表里缩略格子的长边上限。
	PreviewSide = 32
	// DefaultBoardSize 是没设置过时店里底板的格数（52×52 钉最常见）。
	DefaultBoardSize = 52
	// MinBoardSize、MaxBoardSize 是底板格数的范围。
	MinBoardSize, MaxBoardSize = 10, 150
	// MaxBoxLength 是盒号最多几个字。
	MaxBoxLength = 8
)

// Empty 是格子里表示「这格没有豆子」的字符；cellChars 依次表示 colors 里第 0～63 种颜色。
const (
	Empty     = '.'
	cellChars = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-"
)

var (
	ErrName    = errors.New("图纸名字要 1～20 个字")
	ErrPalette = errors.New("没有这套色卡")
	ErrSize    = errors.New("图纸宽、高要在 4～300 格之间")
	ErrColors  = errors.New("颜色最多 64 种，每种都要是这套色卡里的色号，不能重复")
	ErrCells   = errors.New("格子数据不对：要正好宽×高个字符，每个字符是「.」或用到的颜色的序号")
	ErrDone    = errors.New("拼完的格子数据不对")
)

// Name 整理图纸名字：去掉首尾空白，1～20 个字，不能有换行等控制字符。
func Name(v string) (string, error) {
	v = strings.TrimSpace(v)
	if v == "" || utf8.RuneCountInString(v) > 20 || strings.IndexFunc(v, unicode.IsControl) >= 0 {
		return "", ErrName
	}
	return v, nil
}

// Pattern 是一张核对过的图纸：Done 已去掉空格子和多出来的位，Beads、DoneBeads、Preview 由格子算出。
type Pattern struct {
	Name, Palette string
	Width, Height int
	Colors        []string
	Cells, Done   string
	Beads         int
	DoneBeads     int
	Preview       string
	PreviewWidth  int
	PreviewHeight int
}

// Draft 是顾客传来的图纸。
type Draft struct {
	Name, Palette string
	Width, Height int
	Colors        []string
	Cells, Done   string
}

// Check 核对顾客传来的图纸并算出颗数、进度和缩略格子。
func Check(d Draft) (Pattern, error) {
	name, err := Name(d.Name)
	if err != nil {
		return Pattern{}, err
	}
	palette := palettes.Get(d.Palette)
	if palette == nil {
		return Pattern{}, ErrPalette
	}
	if d.Width < MinSide || d.Width > MaxSide || d.Height < MinSide || d.Height > MaxSide {
		return Pattern{}, ErrSize
	}
	if len(d.Colors) > MaxColors {
		return Pattern{}, ErrColors
	}
	seen := map[string]bool{}
	for _, c := range d.Colors {
		if !palette.Has(c) || seen[c] {
			return Pattern{}, ErrColors
		}
		seen[c] = true
	}
	n := d.Width * d.Height
	if len(d.Cells) != n {
		return Pattern{}, ErrCells
	}
	beads := 0
	for i := range n {
		c := d.Cells[i]
		if c == Empty {
			continue
		}
		if k := strings.IndexByte(cellChars, c); k < 0 || k >= len(d.Colors) {
			return Pattern{}, ErrCells
		}
		beads++
	}
	done, doneBeads, err := doneBits(d.Done, d.Cells)
	if err != nil {
		return Pattern{}, err
	}
	preview, pw, ph := Preview(d.Cells, d.Width, d.Height)
	return Pattern{
		Name: name, Palette: palette.ID, Width: d.Width, Height: d.Height, Colors: slices.Clone(d.Colors), Cells: d.Cells,
		Done: done, Beads: beads, DoneBeads: doneBeads, Preview: preview, PreviewWidth: pw, PreviewHeight: ph,
	}, nil
}

// doneBits 核对拼完的格子：按行排的位图（第 i 格是第 i/8 字节的第 i%8 位，低位在前），标准 base64，
// 空串表示一格都没拼。空格子和多出来的位清掉；一格都没拼完时回空串。
func doneBits(encoded, cells string) (string, int, error) {
	if encoded == "" {
		return "", 0, nil
	}
	bits, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || len(bits) != (len(cells)+7)/8 {
		return "", 0, ErrDone
	}
	count := 0
	for i := range len(bits) * 8 {
		on := bits[i/8]&(1<<(i%8)) != 0
		if !on {
			continue
		}
		if i >= len(cells) || cells[i] == Empty {
			bits[i/8] &^= 1 << (i % 8)
			continue
		}
		count++
	}
	if count == 0 {
		return "", 0, nil
	}
	return base64.StdEncoding.EncodeToString(bits), count, nil
}

// Preview 把格子缩成长边不超过 PreviewSide 的缩略格子：原图每 step×step 一块取一个字符，
// 空格子过半的块是空，否则取块里最多的颜色（一样多取序号小的）。
func Preview(cells string, width, height int) (string, int, int) {
	step := (max(width, height) + PreviewSide - 1) / PreviewSide
	pw, ph := (width+step-1)/step, (height+step-1)/step
	var out strings.Builder
	out.Grow(pw * ph)
	counts := make([]int, len(cellChars))
	for py := range ph {
		for px := range pw {
			clear(counts)
			total, empty := 0, 0
			for y := py * step; y < min((py+1)*step, height); y++ {
				for x := px * step; x < min((px+1)*step, width); x++ {
					total++
					c := cells[y*width+x]
					if c == Empty {
						empty++
						continue
					}
					counts[strings.IndexByte(cellChars, c)]++
				}
			}
			if empty*2 > total {
				out.WriteByte(Empty)
				continue
			}
			best := 0
			for k, v := range counts {
				if v > counts[best] {
					best = k
				}
			}
			out.WriteByte(cellChars[best])
		}
	}
	return out.String(), pw, ph
}

// Settings 是店里做图纸用的豆子：色卡、店里有的颜色（nil 表示这套色卡都有）、色号 → 盒号、底板格数、豆子大小。
type Settings struct {
	Palette   string
	Available []string
	Boxes     map[string]string
	BoardSize int
	BeadSize  string
}

// DefaultSettings 是没设置过时的样子：MARD 221 色都有、没有盒号、52 格底板、2.6 毫米豆。
func DefaultSettings() Settings {
	return Settings{Palette: palettes.Default, Boxes: map[string]string{}, BoardSize: DefaultBoardSize, BeadSize: "mini"}
}

// CheckSettings 核对员工保存的设置：色卡要存在；店里有的颜色至少 2 种、都是这套色卡的、不重复，
// 全有时存成 nil；盒号的色号要是这套色卡的，盒号去掉首尾空白后 1～8 个字（空的丢掉）；底板 10～150 格；豆子 mini 或 midi。
func CheckSettings(in Settings) (Settings, error) {
	palette := palettes.Get(in.Palette)
	if palette == nil {
		return Settings{}, ErrPalette
	}
	out := Settings{Palette: palette.ID, Boxes: map[string]string{}, BoardSize: in.BoardSize, BeadSize: in.BeadSize}
	if in.Available != nil {
		seen := map[string]bool{}
		for _, c := range in.Available {
			if !palette.Has(c) || seen[c] {
				return Settings{}, errors.New("店里有的颜色要是这套色卡里的色号，不能重复")
			}
			seen[c] = true
		}
		if len(seen) < 2 {
			return Settings{}, errors.New("店里有的颜色至少要 2 种")
		}
		if len(seen) < len(palette.Codes) {
			// 按色卡里的顺序存，同样的选择存出来一样
			for _, c := range palette.Codes {
				if seen[c] {
					out.Available = append(out.Available, c)
				}
			}
		}
	}
	for code, box := range in.Boxes {
		box = strings.TrimSpace(box)
		if !palette.Has(code) {
			return Settings{}, errors.New("盒号对应的色号要是这套色卡里的")
		}
		if box == "" {
			continue
		}
		if utf8.RuneCountInString(box) > MaxBoxLength || strings.IndexFunc(box, unicode.IsControl) >= 0 {
			return Settings{}, errors.New("盒号最多 8 个字")
		}
		out.Boxes[code] = box
	}
	if out.BoardSize < MinBoardSize || out.BoardSize > MaxBoardSize {
		return Settings{}, errors.New("底板格数要在 10～150 之间")
	}
	if out.BeadSize != "mini" && out.BeadSize != "midi" {
		return Settings{}, errors.New("豆子大小只能是 2.6 毫米或 5 毫米")
	}
	return out, nil
}

// Equal 报告两份设置是不是一样（Available、Boxes 都已整理过）。
func (s Settings) Equal(o Settings) bool {
	if s.Palette != o.Palette || s.BoardSize != o.BoardSize || s.BeadSize != o.BeadSize || !slices.Equal(s.Available, o.Available) || len(s.Boxes) != len(o.Boxes) {
		return false
	}
	for k, v := range s.Boxes {
		if o.Boxes[k] != v {
			return false
		}
	}
	return true
}
