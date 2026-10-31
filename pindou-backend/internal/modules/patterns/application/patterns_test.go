package application

import (
	"bytes"
	"encoding/base64"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"math/rand/v2"
	"strings"
	"testing"
	"time"
)

func dataURL(t *testing.T, kind string, b []byte) string {
	t.Helper()
	return "data:image/" + kind + ";base64," + base64.StdEncoding.EncodeToString(b)
}

func pngBytes(t *testing.T, img image.Image) []byte {
	t.Helper()
	var b bytes.Buffer
	if err := png.Encode(&b, img); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func jpegBytes(t *testing.T, img image.Image) []byte {
	t.Helper()
	var b bytes.Buffer
	if err := jpeg.Encode(&b, img, &jpeg.Options{Quality: 90}); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func decodeAs(t *testing.T, b []byte, want string) image.Image {
	t.Helper()
	img, format, err := image.Decode(bytes.NewReader(b))
	if err != nil || format != want {
		t.Fatalf("应当是 %s：%s %v", want, format, err)
	}
	return img
}

// 格子图纸多是带透明的小 PNG：保留无损 PNG，缩略图是 JPEG、透明处垫白（直接编码会变黑）。
func TestSmallPNGStaysLosslessAndThumbnailIsWhiteBacked(t *testing.T) {
	src := image.NewNRGBA(image.Rect(0, 0, 600, 300))
	src.Set(10, 10, color.NRGBA{R: 200, A: 255})
	img, err := NormalizeImage(dataURL(t, "png", pngBytes(t, src)))
	if err != nil {
		t.Fatal(err)
	}
	if img.Type != "image/png" || img.Width != 600 || img.Height != 300 || len(img.Version) != 16 {
		t.Fatalf("%s %dx%d %q", img.Type, img.Width, img.Height, img.Version)
	}
	if got := decodeAs(t, img.Data, "png").At(10, 10); got != (color.NRGBA{R: 200, A: 255}) {
		t.Fatalf("PNG 应当无损：%v", got)
	}
	thumb := decodeAs(t, img.Thumbnail, "jpeg")
	if b := thumb.Bounds(); b.Dx() != 480 || b.Dy() != 240 {
		t.Fatalf("缩略图长边应为 480：%v", b)
	}
	if r, g, b, _ := thumb.At(400, 200).RGBA(); r>>8 < 240 || g>>8 < 240 || b>>8 < 240 {
		t.Fatalf("透明处应当是白的：%d %d %d", r>>8, g>>8, b>>8)
	}
}

// 浏览器没缩够的大图在服务器再缩到长边 1600；JPEG 重新编码后不再带 EXIF（拍摄地点等）。
func TestLargeJPEGIsScaledAndLosesMetadata(t *testing.T) {
	src := image.NewRGBA(image.Rect(0, 0, 2000, 1000))
	raw := jpegBytes(t, src)
	exif := append([]byte{0xFF, 0xE1, 0x00, 0x10}, []byte("Exif\x00\x00GPSINFO!")...)
	raw = append(append(append([]byte{}, raw[:2]...), exif...), raw[2:]...)
	img, err := NormalizeImage(dataURL(t, "jpeg", raw))
	if err != nil {
		t.Fatal(err)
	}
	if img.Type != "image/jpeg" || img.Width != 1600 || img.Height != 800 {
		t.Fatalf("%s %dx%d", img.Type, img.Width, img.Height)
	}
	if bytes.Contains(img.Data, []byte("GPSINFO")) || bytes.Contains(img.Data, []byte("Exif")) {
		t.Fatal("重新编码后不该还带着 EXIF")
	}
	if b := decodeAs(t, img.Thumbnail, "jpeg").Bounds(); b.Dx() != 480 || b.Dy() != 240 {
		t.Fatalf("缩略图：%v", b)
	}
}

// 照片存成 PNG 会很大：重新编码后超过 1 MB 的 PNG 转成 JPEG。
func TestBulkyPNGBecomesJPEG(t *testing.T) {
	src := image.NewRGBA(image.Rect(0, 0, 650, 650))
	rng := rand.New(rand.NewPCG(1, 2)) //nolint:gosec // 测试用的噪点
	for i := range src.Pix {
		src.Pix[i] = byte(rng.UintN(256))
		if i%4 == 3 {
			src.Pix[i] = 255
		}
	}
	raw := pngBytes(t, src)
	if len(raw) <= maxPNGBytes || len(raw) > MaxUploadBytes {
		t.Fatalf("前置条件：噪点 PNG 应在 1 MB 和上限之间：%d", len(raw))
	}
	img, err := NormalizeImage(dataURL(t, "png", raw))
	if err != nil {
		t.Fatal(err)
	}
	if img.Type != "image/jpeg" {
		t.Fatalf("应当转成 JPEG：%s", img.Type)
	}
	decodeAs(t, img.Data, "jpeg")
}

func TestRejectsWhatIsNotAnAcceptableImage(t *testing.T) {
	small := pngBytes(t, image.NewRGBA(image.Rect(0, 0, 4, 4)))
	cases := map[string]string{
		"不是 data URL":    "hello",
		"GIF":            "data:image/gif;base64," + base64.StdEncoding.EncodeToString(small),
		"声明与内容不符":        dataURL(t, "jpeg", small),
		"不是 base64":      "data:image/png;base64,***",
		"不是图片":           dataURL(t, "png", []byte("plain text")),
		"尺寸超过 4096":      dataURL(t, "png", pngBytes(t, image.NewGray(image.Rect(0, 0, 4097, 1)))),
		"超过上限":           dataURL(t, "png", append(small, make([]byte, MaxUploadBytes)...)),
		"base64 本身就超过上限": "data:image/png;base64," + strings.Repeat("A", MaxUploadBytes*2),
	}
	for label, input := range cases {
		if _, err := NormalizeImage(input); !errors.Is(err, ErrImage) {
			t.Errorf("%s应当拒收：%v", label, err)
		}
	}
}

func TestNamesAreTrimmedAndBounded(t *testing.T) {
	if v, err := Name("  草莓  "); err != nil || v != "草莓" {
		t.Fatalf("%q %v", v, err)
	}
	for _, bad := range []string{"", "   ", strings.Repeat("莓", 21), "草\n莓"} {
		if _, err := Name(bad); !errors.Is(err, ErrName) {
			t.Errorf("%q 应当拒收", bad)
		}
	}
	if _, err := CategoryName(strings.Repeat("花", 10)); err != nil {
		t.Fatal(err)
	}
	if _, err := CategoryName(strings.Repeat("花", 11)); !errors.Is(err, ErrCategoryName) {
		t.Fatal("11 个字的分类名应当拒收")
	}
}

func TestNewForSevenDaysAfterFirstPublished(t *testing.T) {
	first := time.Date(2026, 10, 20, 10, 0, 0, 0, time.UTC)
	if IsNew(nil, first) {
		t.Fatal("没上过架的不算上新")
	}
	if !IsNew(&first, first.Add(7*24*time.Hour-time.Second)) {
		t.Fatal("7 天之内算上新")
	}
	if IsNew(&first, first.Add(7*24*time.Hour)) {
		t.Fatal("满 7 天不再算上新")
	}
}
