// Package palettes 持有顾客「做图纸」工具用的拼豆色卡（docs/plan-bead-maker.md）：后端只用它核对色卡编号和色号，
// 取色、配色都在小程序里做。
//
// ★ 这份 JSON 与仓库根 palettes/palettes.json **必须字节相同**。go:embed 出不了模块目录，只能放副本；
//
//	palettes_test.go 会逐字节比对，漏同步就红。
package palettes

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"regexp"
)

//go:embed palettes.json
var raw []byte

// Default 是没设置过时店里用的色卡。
const Default = "mard-221"

// Palette 是一套色卡：编号、名字、牌子、国内还是国外（cn、intl）和色号（按色卡里的顺序）。
type Palette struct {
	ID     string
	Name   string
	Brand  string
	Region string
	Codes  []string
	known  map[string]bool
}

// Has 报告色号是不是这套色卡里的。
func (p *Palette) Has(code string) bool { return p.known[code] }

var (
	all  []*Palette
	byID = map[string]*Palette{}
)

var (
	idPattern = regexp.MustCompile(`^[a-z0-9-]{1,32}$`)
	// Perler 的色号是 80-15179 这种带连字符的 8 位编号
	codePattern = regexp.MustCompile(`^[A-Z0-9][A-Z0-9-]{0,7}$`)
	hexPattern  = regexp.MustCompile(`^#[0-9A-F]{6}$`)
)

func init() {
	var file struct {
		Palettes []struct {
			ID     string      `json:"id"`
			Name   string      `json:"name"`
			Brand  string      `json:"brand"`
			Region string      `json:"region"`
			Colors [][2]string `json:"colors"`
		} `json:"palettes"`
	}
	if err := json.Unmarshal(raw, &file); err != nil {
		panic(fmt.Sprintf("palettes.json: %v", err))
	}
	for _, f := range file.Palettes {
		if !idPattern.MatchString(f.ID) || byID[f.ID] != nil || f.Name == "" || f.Brand == "" || (f.Region != "cn" && f.Region != "intl") || len(f.Colors) == 0 {
			panic("palettes.json: 色卡编号不合格式、重复，或没有名字、牌子、地区（cn、intl）、颜色：" + f.ID)
		}
		p := &Palette{ID: f.ID, Name: f.Name, Brand: f.Brand, Region: f.Region, known: map[string]bool{}}
		for _, c := range f.Colors {
			if !codePattern.MatchString(c[0]) || !hexPattern.MatchString(c[1]) || p.known[c[0]] {
				panic(fmt.Sprintf("palettes.json: %s 的色号 %q 或颜色 %q 不合格式，或色号重复", f.ID, c[0], c[1]))
			}
			p.known[c[0]] = true
			p.Codes = append(p.Codes, c[0])
		}
		all = append(all, p)
		byID[p.ID] = p
	}
	if byID[Default] == nil {
		panic("palettes.json: 没有默认色卡 " + Default)
	}
}

// Get 取一套色卡；没有这个编号返回 nil。
func Get(id string) *Palette { return byID[id] }

// All 是全部色卡，按文件里的顺序。
func All() []*Palette { return all }
