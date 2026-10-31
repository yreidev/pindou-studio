package application

import (
	"errors"
	"strings"
	"testing"
)

func TestChangeValidatesCatalogInput(t *testing.T) {
	for _, tt := range []struct {
		name, input string
		price       int64
		valid       bool
		normalized  string
	}{
		{"trim", "  拼豆材料 \n", 29, true, "拼豆材料"},
		{"free item", "赠品", 0, true, "赠品"},
		{"unicode length limit", strings.Repeat("豆", 100), 9007199254740991, true, strings.Repeat("豆", 100)},
		{"empty", " \n\t", 100, false, ""},
		{"too long", strings.Repeat("豆", 101), 100, false, ""},
		{"negative", "材料", -1, false, ""},
		{"unsafe integer", "材料", 9007199254740992, false, ""},
	} {
		t.Run(tt.name, func(t *testing.T) {
			item, err := Change("product-id", tt.input, tt.price)
			if (err == nil) != tt.valid {
				t.Fatalf("valid=%v, error=%v", tt.valid, err)
			}
			if !tt.valid {
				if item != (Item{}) {
					t.Fatal("invalid request returned usable item")
				}
				return
			}
			if item.ID != "product-id" || item.Name != tt.normalized || item.UnitPriceCents != tt.price {
				t.Fatalf("unexpected item: %+v", item)
			}
		})
	}
}

func TestApplyKeepsFieldsThatWereNotSent(t *testing.T) {
	ptr := func(s string) *string { return &s }
	current := Item{ID: "p", Name: "拼豆 5mm 白", UnitPriceCents: 1200, Barcode: "6901234567892"}
	// 只改名：售价、条码不动
	got, err := Apply(current, Patch{Name: ptr(" 拼豆 5mm 白（大包） ")})
	if err != nil || got != (Item{ID: "p", Name: "拼豆 5mm 白（大包）", UnitPriceCents: 1200, Barcode: "6901234567892"}) {
		t.Fatalf("只改名：%+v %v", got, err)
	}
	// 只绑条码（手机上绑定）：名称、售价不动，条码去掉首尾空白
	got, err = Apply(Item{ID: "p", Name: "拼豆 5mm 白", UnitPriceCents: 1200}, Patch{Barcode: ptr(" 6901234567892\n")})
	if err != nil || got != current {
		t.Fatalf("只绑条码：%+v %v", got, err)
	}
	// 空串清除条码
	got, err = Apply(current, Patch{Barcode: ptr("")})
	if err != nil || got.Barcode != "" || got.Name != current.Name {
		t.Fatalf("清除条码：%+v %v", got, err)
	}
	// 条码格式不对
	if _, err := Apply(current, Patch{Barcode: ptr("690 123")}); !errors.Is(err, ErrInvalidBarcode) {
		t.Fatalf("条码带空格应当是 ErrInvalidBarcode：%v", err)
	}
	// 没有名称的占位商品不能只绑条码
	if _, err := Apply(Item{ID: "p"}, Patch{Barcode: ptr("123")}); err == nil {
		t.Fatal("没有名称的商品不能直接绑条码")
	}
	// current 不被改动
	if current.Barcode != "6901234567892" || current.Name != "拼豆 5mm 白" {
		t.Fatalf("Apply 改动了 current：%+v", current)
	}
}

func TestBarcodeNormalizesAndValidates(t *testing.T) {
	for _, tt := range []struct {
		name, input, want string
		valid             bool
	}{
		{"EAN-13", "6901234567892", "6901234567892", true},
		{"UPC-A", "036000291452", "036000291452", true},
		{"Code128 带符号、区分大小写", "Ab-12/x.~!", "Ab-12/x.~!", true},
		{"去掉首尾空白（扫码枪带回车）", " \t6901234567892\r\n", "6901234567892", true},
		{"空串是清除", "", "", true},
		{"只有空白也是清除", "  \n", "", true},
		{"64 位", strings.Repeat("7", 64), strings.Repeat("7", 64), true},
		{"65 位", strings.Repeat("7", 65), "", false},
		{"中间有空格", "690 1234", "", false},
		{"中间有制表符", "690\t1234", "", false},
		{"中文", "条码1234", "", false},
		{"全角数字", "６９０１２３", "", false},
		{"控制字符", "690\x001234", "", false},
		{"DEL", "690\x7f", "", false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			got, err := Barcode(tt.input)
			if (err == nil) != tt.valid {
				t.Fatalf("valid=%v, error=%v", tt.valid, err)
			}
			if got != tt.want {
				t.Fatalf("got %q, want %q", got, tt.want)
			}
		})
	}
}
