package application

import (
	"bytes"
	"encoding/base64"
	"errors"
	"image"
	"image/jpeg"
	_ "image/png"
	"strings"
)

// NormalizeAvatar checks bounded image data and drops metadata by re-encoding it.
func NormalizeAvatar(value string) (string, error) {
	if value == "" {
		return "", nil
	}
	invalid := errors.New("头像需为 JPEG 或 PNG，不超过 96 KB、边长不超过 512 像素")
	if len(value) > 131100 {
		return "", invalid
	}
	header, encoded, ok := strings.Cut(value, ",")
	if !ok || (header != "data:image/jpeg;base64" && header != "data:image/png;base64") {
		return "", invalid
	}
	data, err := base64.StdEncoding.Strict().DecodeString(encoded)
	if err != nil || len(data) > 96*1024 {
		return "", invalid
	}
	config, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || header != "data:image/"+format+";base64" || config.Width < 1 || config.Height < 1 || config.Width > 512 || config.Height > 512 {
		return "", invalid
	}
	decoded, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return "", invalid
	}
	var result bytes.Buffer
	if err := jpeg.Encode(&result, decoded, &jpeg.Options{Quality: 80}); err != nil || result.Len() > 96*1024 {
		return "", invalid
	}
	return "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(result.Bytes()), nil
}
