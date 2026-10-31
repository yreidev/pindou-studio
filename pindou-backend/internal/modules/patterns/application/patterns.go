// Package application 是图纸（迁移 025）的规则：名字、分类名、「上新」怎么算，以及上传的图片怎么重新编码。
// 图纸由员工在网页后台上传，顾客在小程序首页和「图纸」页看（方案见 docs/plan-home-and-patterns.md）。
package application

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	xdraw "golang.org/x/image/draw"
)

// NewForDays 是第一次上架之后算「上新」的天数（2026-10-20 业主定：满 7 天自动去掉，下架再上架不重算）。
const NewForDays = 7

// IsNew 报告第一次上架于 first 的图纸此刻还算不算「上新」。没上过架的不算。
func IsNew(first *time.Time, now time.Time) bool {
	return first != nil && now.Before(first.Add(NewForDays*24*time.Hour))
}

var (
	ErrName         = errors.New("图纸名字要 1～20 个字")
	ErrCategoryName = errors.New("分类名字要 1～10 个字")
	ErrImage        = errors.New("图片需为 JPG 或 PNG，压缩后不超过 1.4 MB、边长不超过 4096 像素")
)

// Name 整理图纸名字：去掉首尾空白，1～20 个字，不能有换行等控制字符。
func Name(v string) (string, error) { return text(v, 20, ErrName) }

// CategoryName 整理分类名字：去掉首尾空白，1～10 个字。
func CategoryName(v string) (string, error) { return text(v, 10, ErrCategoryName) }

func text(v string, limit int, invalid error) (string, error) {
	v = strings.TrimSpace(v)
	if v == "" || utf8.RuneCountInString(v) > limit || strings.IndexFunc(v, unicode.IsControl) >= 0 {
		return "", invalid
	}
	return v, nil
}

const (
	// MaxUploadBytes 是解码前的图片大小上限。网页后台先在浏览器里缩到长边 MaxSide 再传；请求体上限 2 MB，
	// base64 会大三分之一，再留出 JSON 其余字段的余量，原始字节最多 1.4 MB（编成 base64 约 1.87 MB）。
	MaxUploadBytes = 1400 << 10
	// MaxSourceSide 按文件头里的尺寸先拦一道：很小的文件也能解出巨大的位图，占满内存。
	MaxSourceSide = 4096
	// MaxSide 是存下来的图片的长边；浏览器没缩够时这里再缩。
	MaxSide = 1600
	// ThumbSide 是缩略图的长边：小程序两列卡片在 3 倍屏上大约 510 像素宽。
	ThumbSide = 480
	// maxPNGBytes 以内的 PNG 原样保留无损（格子图纸的细线和色号压成 JPEG 会糊），再大就转 JPEG。
	maxPNGBytes = 1 << 20
)

// Image 是重新编码过、可以存库的图纸图片：重新编码丢掉了拍摄地点等元数据。缩略图一律 JPEG（透明处垫白）。
type Image struct {
	Data          []byte
	Type          string
	Thumbnail     []byte
	Width, Height int
	// Version 是图片内容的摘要，图片地址里带它，换图后客户端不再用旧缓存。
	Version string
}

// NormalizeImage 校验网页后台传来的 data URL（data:image/jpeg;base64,… 或 data:image/png;base64,…）并重新编码。
func NormalizeImage(dataURL string) (Image, error) {
	header, encoded, ok := strings.Cut(dataURL, ",")
	if !ok || (header != "data:image/jpeg;base64" && header != "data:image/png;base64") {
		return Image{}, ErrImage
	}
	if base64.StdEncoding.DecodedLen(len(encoded)) > MaxUploadBytes+3 {
		return Image{}, ErrImage
	}
	raw, err := base64.StdEncoding.Strict().DecodeString(encoded)
	if err != nil || len(raw) > MaxUploadBytes {
		return Image{}, ErrImage
	}
	config, format, err := image.DecodeConfig(bytes.NewReader(raw))
	if err != nil || header != "data:image/"+format+";base64" ||
		config.Width < 1 || config.Height < 1 || config.Width > MaxSourceSide || config.Height > MaxSourceSide {
		return Image{}, ErrImage
	}
	src, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return Image{}, ErrImage
	}
	full := fit(src, MaxSide, false)
	out := Image{Width: full.Bounds().Dx(), Height: full.Bounds().Dy()}
	if format == "png" {
		var b bytes.Buffer
		if err := (&png.Encoder{CompressionLevel: png.BestCompression}).Encode(&b, full); err != nil {
			return Image{}, ErrImage
		}
		if b.Len() <= maxPNGBytes {
			out.Data, out.Type = b.Bytes(), "image/png"
		}
	}
	if out.Data == nil {
		if out.Data, err = encodeJPEG(onWhite(full), 88); err != nil {
			return Image{}, ErrImage
		}
		out.Type = "image/jpeg"
	}
	if out.Thumbnail, err = encodeJPEG(fit(full, ThumbSide, true), 82); err != nil {
		return Image{}, ErrImage
	}
	sum := sha256.Sum256(out.Data)
	out.Version = hex.EncodeToString(sum[:8])
	return out, nil
}

// fit 把 src 等比缩到长边不超过 side；本来就不大于 side 时原样返回（white 为真时仍垫白）。white 为真时缩到白底上。
func fit(src image.Image, side int, white bool) image.Image {
	b := src.Bounds()
	w, h := b.Dx(), b.Dy()
	if w <= side && h <= side {
		if white {
			return onWhite(src)
		}
		return src
	}
	if w >= h {
		w, h = side, max(1, h*side/w)
	} else {
		w, h = max(1, w*side/h), side
	}
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	op := xdraw.Src
	if white {
		xdraw.Draw(dst, dst.Bounds(), image.NewUniform(color.White), image.Point{}, xdraw.Src)
		op = xdraw.Over
	}
	xdraw.CatmullRom.Scale(dst, dst.Bounds(), src, b, op, nil)
	return dst
}

// onWhite 把可能带透明的图垫到白底上：JPEG 没有透明，直接编码时透明处会变黑。
func onWhite(src image.Image) image.Image {
	b := src.Bounds()
	dst := image.NewRGBA(image.Rect(0, 0, b.Dx(), b.Dy()))
	xdraw.Draw(dst, dst.Bounds(), image.NewUniform(color.White), image.Point{}, xdraw.Src)
	xdraw.Draw(dst, dst.Bounds(), src, b.Min, xdraw.Over)
	return dst
}

func encodeJPEG(img image.Image, quality int) ([]byte, error) {
	var b bytes.Buffer
	if err := jpeg.Encode(&b, img, &jpeg.Options{Quality: quality}); err != nil {
		return nil, err
	}
	return b.Bytes(), nil
}
