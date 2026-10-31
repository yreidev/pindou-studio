package palettes

import (
	"bytes"
	"os"
	"testing"
)

// 后端这份色卡和仓库根 palettes/palettes.json（小程序、网页后台用的那份）一个字节都不能差。
func TestEmbeddedPalettesMatchRepository(t *testing.T) {
	root, err := os.ReadFile("../../../palettes/palettes.json")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(root, raw) {
		t.Fatal("internal/palettes/palettes.json 和仓库根 palettes/palettes.json 不一致：改了一份要把另一份也换成同样的内容")
	}
}

func TestPalettes(t *testing.T) {
	want := map[string]int{
		"mard-221": 221, "mard-291": 291, "manman-278": 278, "panpan-289": 285, "mixiaowo-290": 286, "coco-291": 291,
		"perler-103": 103, "perler-mini-41": 41, "hama-midi-92": 92, "hama-mini-78": 78,
		"artkal-a-145": 145, "artkal-c-174": 174, "artkal-m-220": 220, "artkal-r-89": 89, "artkal-s-199": 199,
		"nabbi-30": 30, "yant-119": 119,
	}
	if len(All()) != len(want) {
		t.Fatalf("色卡 %d 套", len(All()))
	}
	for id, n := range want {
		p := Get(id)
		if p == nil || len(p.Codes) != n {
			t.Fatalf("%s：%v", id, p)
		}
	}
	mard := Get(Default)
	if !mard.Has("A1") || !mard.Has("H7") || mard.Has("ZG1") || mard.Has("a1") {
		t.Fatal("MARD 221 的色号不对")
	}
	if !Get("mard-291").Has("ZG1") || Get("nope") != nil {
		t.Fatal("MARD 291 要有扩展的 ZG 系列；没有的编号取不到")
	}
	if p := Get("perler-103"); !p.Has("80-15179") || p.Brand != "Perler" || p.Region != "intl" || mard.Region != "cn" {
		t.Fatalf("Perler 的色号带连字符，国外色卡标 intl：%+v", p)
	}
}
