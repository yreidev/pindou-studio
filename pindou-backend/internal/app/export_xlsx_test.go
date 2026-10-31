package app

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"strings"
	"testing"
	"time"

	"github.com/xuri/excelize/v2"
)

// [Content_Types].xml 必须是 zip 的**第一个**条目。
//
// OPC 规范要求它在最前：流式阅读器靠它确定各部件的内容类型。Excel 宽容（会先扫完整个中央目录），
// 但微信的文档预览器不宽容：2026-09-19 真机验收实测，它不在最前时导出的 xlsx 在手机上打开完全空白，
// 连表头都没有（当时是手拼 zip 时按 map 的随机顺序写）。excelize 自己按部件名倒序写，会把它放到最后，
// 所以导出时换了 zip 写入器（contentTypesFirst）。去掉那个写入器、或 excelize 改了写法时这条会变红。
func TestXLSXContentTypesIsFirstEntry(t *testing.T) {
	var buf bytes.Buffer
	rows := [][]string{{"id", "status"}, {"a", "paid"}}
	if err := writeXLSX(&buf, rows); err != nil {
		t.Fatalf("writeXLSX: %v", err)
	}
	reader, err := zip.NewReader(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil {
		t.Fatalf("产物不是合法 zip: %v", err)
	}
	names := make([]string, 0, len(reader.File))
	for _, f := range reader.File {
		names = append(names, f.Name)
	}
	if len(names) == 0 || names[0] != "[Content_Types].xml" {
		t.Fatalf("第一个条目必须是 [Content_Types].xml。实际顺序：%v", names)
	}
	// 其后和 Excel 自己存的一样：包关系、工作簿和它的关系表在表格内容之前。
	if want := []string{"[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels"}; len(names) < len(want) || !sameRow(names[:len(want)], want) {
		t.Fatalf("前几个条目应为 %v。实际顺序：%v", want, names)
	}
}

// 每个部件都要在、每个 XML 都要能解析；表名是 Export，范围（dimension）写对，数据原样落进单元格，
// 一律是文本（金额、数量也是文字，和以前手拼的 inlineStr 一样）。
func TestXLSXPartsAndContent(t *testing.T) {
	var buf bytes.Buffer
	rows := [][]string{
		{"id", "status", "receivable_cents", "paid_cents"},
		{"10000001", "paid", "2990", "2990"},
		{"10000002", "paid", "9900", ""},
	}
	if err := writeXLSX(&buf, rows); err != nil {
		t.Fatalf("writeXLSX: %v", err)
	}
	reader, err := zip.NewReader(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil {
		t.Fatalf("产物不是合法 zip: %v", err)
	}
	parts := map[string]string{}
	for _, f := range reader.File {
		rc, err := f.Open()
		if err != nil {
			t.Fatalf("打开 %s: %v", f.Name, err)
		}
		parts[f.Name] = string(readAll(t, rc))
		rc.Close()
	}

	// styles.xml 不能少：不少阅读器拿不到它就放弃整个工作簿。
	for _, want := range []string{
		"[Content_Types].xml", "_rels/.rels", "xl/workbook.xml",
		"xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/worksheets/sheet1.xml",
	} {
		if _, ok := parts[want]; !ok {
			t.Errorf("缺部件 %s", want)
		}
	}
	for name, body := range parts {
		if err := xml.Unmarshal([]byte(body), new(struct{ XMLName xml.Name })); err != nil {
			t.Errorf("%s 不是合法 XML: %v", name, err)
		}
	}
	if !strings.Contains(parts["[Content_Types].xml"], "styles+xml") {
		t.Error("styles.xml 在包里但没在 [Content_Types].xml 里登记")
	}

	book, err := excelize.OpenReader(bytes.NewReader(buf.Bytes()))
	if err != nil {
		t.Fatalf("excelize 读不回来: %v", err)
	}
	defer book.Close()
	if sheets := book.GetSheetList(); len(sheets) != 1 || sheets[0] != "Export" {
		t.Fatalf("工作表: %v", sheets)
	}
	// dimension 缺了或停在 A1 的话，严格的阅读器会把表当成空的。
	if dimension, err := book.GetSheetDimension("Export"); err != nil || dimension != "A1:D3" {
		t.Errorf("dimension=%q err=%v", dimension, err)
	}
	got := xlsxRows(t, buf.Bytes())
	for i := range rows {
		if !sameRow(got[i], rows[i]) {
			t.Errorf("第 %d 行 %v，应为 %v", i+1, got[i], rows[i])
		}
	}
	for _, cell := range []string{"A1", "C2", "D2", "C3", "D3"} {
		if kind, err := book.GetCellType("Export", cell); err != nil || (kind != excelize.CellTypeSharedString && kind != excelize.CellTypeInlineString) {
			t.Errorf("%s 不是文本单元格: %v %v", cell, kind, err)
		}
	}
}

// 老板/店长的「开始时间必须是今天」按**门店时区**判，不按服务器时区，也不按客户端传来的偏移。
//
// 服务器跑在 America/Los_Angeles，而门店在 UTC+8：同一时刻两边的「今天」差一天。
// 原来直接比 now.YearDay() 与 started.YearDay()，结果是老板在中国时间的上午永远开不了台
// （2026-09-19 真机验收实测报 "manager start time must be today"，而选的就是当天）。
func TestValidateStartedAtCrossTimezoneToday(t *testing.T) {
	shop := time.FixedZone("UTC+8", 8*3600)
	la, err := time.LoadLocation("America/Los_Angeles")
	if err != nil {
		t.Skipf("没有时区数据库: %v", err)
	}
	owner := &User{Roles: []Role{Owner}}

	// 门店当地 2026-09-19 10:46；同一时刻在洛杉矶是 09-18 19:46（前一天）。
	started := time.Date(2026, 9, 19, 10, 46, 0, 0, shop)
	now := started.Add(2 * time.Minute).In(la)
	if now.Day() == started.Day() {
		t.Fatalf("夹具没造出跨天：服务器侧 %s，门店侧 %s", now.Format(time.RFC3339), started.Format(time.RFC3339))
	}
	if err := validateStartedAt(now, started, owner); err != nil {
		t.Fatalf("门店当天的时间被拒了：%v", err)
	}

	// 真的不是今天（门店时区的昨天）仍要拒。
	yesterday := started.AddDate(0, 0, -1)
	if err := validateStartedAt(now, yesterday, owner); err == nil {
		t.Fatal("门店时区的昨天应该被拒，却放过了")
	}

	// 客户端把偏移写成 -12:00，门店时区里那是昨天：不能靠改偏移把「今天」挪走。
	// 门店 09-19 08:00 时，西十二区还是 09-18 12:00；拿那边「当天」的 09-18 00:30 来回填，
	// 换算到门店是 09-18 20:30，昨天。
	early := time.Date(2026, 9, 19, 8, 0, 0, 0, shop)
	westOfEverything := time.FixedZone("UTC-12", -12*3600)
	if err := validateStartedAt(early, time.Date(2026, 9, 18, 0, 30, 0, 0, westOfEverything), owner); err == nil {
		t.Fatal("伪造的时区偏移把门店昨天当成了今天")
	}

	// 未来时间仍要拒，与时区无关。
	if err := validateStartedAt(now, started.Add(time.Hour), owner); err == nil {
		t.Fatal("未来时间应该被拒")
	}
}

func readAll(t *testing.T, r interface{ Read([]byte) (int, error) }) []byte {
	t.Helper()
	var out []byte
	buf := make([]byte, 4096)
	for {
		n, err := r.Read(buf)
		out = append(out, buf[:n]...)
		if err != nil {
			return out
		}
	}
}
