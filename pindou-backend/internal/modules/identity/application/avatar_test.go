package application

import (
	"bytes"
	"encoding/base64"
	"image"
	"image/png"
	"strings"
	"testing"
)

func TestNormalizeAvatar(t *testing.T) {
	var pngData bytes.Buffer
	if err := png.Encode(&pngData, image.NewRGBA(image.Rect(0, 0, 32, 32))); err != nil {
		t.Fatal(err)
	}
	input := "data:image/png;base64," + base64.StdEncoding.EncodeToString(pngData.Bytes())
	output, err := NormalizeAvatar(input)
	if err != nil || !strings.HasPrefix(output, "data:image/jpeg;base64,") {
		t.Fatalf("normalization: %v", err)
	}
	data, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(output, "data:image/jpeg;base64,"))
	if err != nil {
		t.Fatal(err)
	}
	config, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || format != "jpeg" || config.Width != 32 || config.Height != 32 {
		t.Fatal("invalid normalized image")
	}
	if value, err := NormalizeAvatar(""); err != nil || value != "" {
		t.Fatal("clear failed")
	}
	var huge bytes.Buffer
	_ = png.Encode(&huge, image.NewRGBA(image.Rect(0, 0, 513, 1)))
	for _, invalid := range []string{"https://example.com/avatar.jpg", "wxfile://tmp.jpg", "data:image/svg+xml;base64,PHN2Zy8+", "data:image/png;base64,not-an-image", "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(pngData.Bytes()), "data:image/png;base64," + base64.StdEncoding.EncodeToString(huge.Bytes()), "data:image/jpeg;base64," + strings.Repeat("A", 131080)} {
		if _, err := NormalizeAvatar(invalid); err == nil {
			t.Fatal("invalid avatar accepted")
		}
	}
}
