package application

import (
	"errors"
	"strings"
	"unicode/utf8"
)

type Item struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	UnitPriceCents int64  `json:"unitPriceCents"`
	// Barcode 是商品条码（迁移 018），没登记时为空、响应里不带。同一条码只属于一件商品。
	Barcode string `json:"barcode,omitempty"`
}

// Change leaves order snapshots untouched; prices here are defaults for new lines.
func Change(id, name string, price int64) (Item, error) {
	name = strings.TrimSpace(name)
	if name == "" || utf8.RuneCountInString(name) > 100 || price < 0 || price > 9007199254740991 {
		return Item{}, errors.New("商品名称必填，价格必须是不小于 0 的整数")
	}
	return Item{ID: id, Name: name, UnitPriceCents: price}, nil
}

// Patch 是对商品资料的一次改动，nil 的字段不改。
type Patch struct {
	Name           *string
	UnitPriceCents *int64
	Barcode        *string
}

// Apply 把改动套到 current 上，返回规范、校验过的新内容（不改 current）。新建时 current 只有编号。
// 条码格式不对返回 ErrInvalidBarcode；条码是否已被别的商品占用由调用方查库。
func Apply(current Item, p Patch) (Item, error) {
	name, price := current.Name, current.UnitPriceCents
	if p.Name != nil {
		name = *p.Name
	}
	if p.UnitPriceCents != nil {
		price = *p.UnitPriceCents
	}
	item, err := Change(current.ID, name, price)
	if err != nil {
		return Item{}, err
	}
	item.Barcode = current.Barcode
	if p.Barcode != nil {
		if item.Barcode, err = Barcode(*p.Barcode); err != nil {
			return Item{}, err
		}
	}
	return item, nil
}

// MaxBarcodeLength 是条码的最大长度。EAN-13 是 13 位、UPC-A 12 位，Code128 理论上不限长，
// 商品包装上的一般不超过 30 位；64 位留足余量，又挡住把整段网址之类的二维码内容当条码。
const MaxBarcodeLength = 64

// ErrInvalidBarcode 是条码格式不对：去掉首尾空白后不是 1–64 个可打印 ASCII，或中间有空白。
var ErrInvalidBarcode = errors.New("条码只能是 1–64 位英文字母、数字或符号，不能有空格或中文")

// Barcode 规范员工填的或扫到的条码：去掉首尾空白；空串表示没有条码（清除）。
// 其余必须是 1–64 个可打印 ASCII（! 到 ~，不含空格），覆盖 EAN-13、UPC、Code128。区分大小写。
// 迁移 018 在库里有同样的检查兜底。
func Barcode(raw string) (string, error) {
	code := strings.TrimSpace(raw)
	if code == "" {
		return "", nil
	}
	if len(code) > MaxBarcodeLength {
		return "", ErrInvalidBarcode
	}
	for i := 0; i < len(code); i++ {
		if code[i] < '!' || code[i] > '~' {
			return "", ErrInvalidBarcode
		}
	}
	return code, nil
}
