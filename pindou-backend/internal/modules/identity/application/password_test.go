package application

import (
	"strings"
	"testing"
)

func TestNormalizePhone(t *testing.T) {
	for raw, want := range map[string]string{
		"13800138000":       "13800138000",
		"138 0013 8000":     "13800138000",
		"138-0013-8000":     "13800138000",
		"+86 138 0013 8000": "+8613800138000",
		"　138001380000":     "138001380000",
	} {
		if got, ok := NormalizePhone(raw); !ok || got != want {
			t.Errorf("NormalizePhone(%q) = %q %v, want %q", raw, got, ok, want)
		}
	}
	for _, raw := range []string{"", "12345", "1380013800012345", "138OO138000", "+", "86+13800138000", "１３８００１３８０００"} {
		if got, ok := NormalizePhone(raw); ok {
			t.Errorf("NormalizePhone(%q) accepted as %q", raw, got)
		}
	}
}

func TestHashAndVerifyPassword(t *testing.T) {
	hash, err := HashPassword("correct horse")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(hash, "$argon2id$v=19$m=19456,t=2,p=1$") {
		t.Fatalf("hash = %q", hash)
	}
	if !VerifyPassword(hash, "correct horse") {
		t.Fatal("正确的密码校验不过")
	}
	if VerifyPassword(hash, "correct horsE") || VerifyPassword(hash, "") {
		t.Fatal("错的密码校验通过了")
	}
	again, _ := HashPassword("correct horse")
	if again == hash {
		t.Fatal("同一个密码两次的哈希一样：盐没起作用")
	}
	parts := strings.Split(hash, "$")
	for label, broken := range map[string]string{
		"空":      "",
		"bcrypt": "$2a$10$abcdefghijklmnopqrstuu",
		"版本不对":   strings.Replace(hash, "v=19", "v=16", 1),
		"内存过大":   strings.Replace(hash, "m=19456", "m=4194304", 1),
		"轮数过多":   strings.Replace(hash, "t=2", "t=100", 1),
		"盐坏了":    strings.Join([]string{"", parts[1], parts[2], parts[3], "!!", parts[5]}, "$"),
		"少一段":    strings.Join(parts[:5], "$"),
	} {
		if VerifyPassword(broken, "correct horse") {
			t.Errorf("%s 的哈希被认了", label)
		}
	}
	if VerifyAbsent("correct horse") {
		t.Fatal("陪跑校验必须不符")
	}
}

func TestTemporaryPassword(t *testing.T) {
	seen := map[string]bool{}
	for range 20 {
		p, err := TemporaryPassword()
		if err != nil {
			t.Fatal(err)
		}
		if len(p) != 8 || strings.Trim(p, "0123456789") != "" {
			t.Fatalf("临时密码 %q 不是 8 位数字", p)
		}
		seen[p] = true
	}
	if len(seen) < 19 {
		t.Fatalf("20 次只出了 %d 个不同的临时密码", len(seen))
	}
}
