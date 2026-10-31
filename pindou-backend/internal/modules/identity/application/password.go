package application

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"math/big"
	"regexp"
	"strings"
	"sync"

	"golang.org/x/crypto/argon2"
)

// 认领用的密码（员工发的临时密码，或以前在顾客网页设的密码）：顾客在小程序里用手机号加它认领账户。
// 顾客网页 2026-10-31 下线后不再有人自己设密码（docs/plan-split-release.md）。
//
// 密码只存 argon2id 的 PHC 字符串（$argon2id$v=19$m=…,t=…,p=…$盐$哈希）。参数取 OWASP 密码存储速查表
// 给的基线：19 MiB 内存、2 轮、1 路并行。参数写在哈希里，以后调参旧哈希照样能校验。

const (
	argonMemoryKiB = 19 * 1024
	argonTime      = 2
	argonThreads   = 1
	argonSaltLen   = 16
	argonKeyLen    = 32

	// MaxPasswordLength 是认领时收的密码最长多少个字符（不是字节）。
	MaxPasswordLength = 128
)

var loginPhone = regexp.MustCompile(`^\+?[0-9]{6,15}$`)

// NormalizePhone 把顾客填的手机号整理成登录用的写法：去掉空格和横线后须为 6～15 位数字，可带开头的 +。
func NormalizePhone(raw string) (string, bool) {
	phone := strings.Map(func(r rune) rune {
		if r == ' ' || r == '-' || r == '\t' || r == '　' {
			return -1
		}
		return r
	}, raw)
	return phone, loginPhone.MatchString(phone)
}

// HashPassword 算出要存的 PHC 字符串。CPU 与内存都花得不少（约几十毫秒、19 MiB），不要在数据库事务里调用。
func HashPassword(password string) (string, error) {
	salt := make([]byte, argonSaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key := argon2.IDKey([]byte(password), salt, argonTime, argonMemoryKiB, argonThreads, argonKeyLen)
	b64 := base64.RawStdEncoding
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s", argon2.Version, argonMemoryKiB, argonTime, argonThreads, b64.EncodeToString(salt), b64.EncodeToString(key)), nil
}

// VerifyPassword 核对密码与存的 PHC 字符串是否相符。格式不认识的一律不符。
func VerifyPassword(encoded, password string) bool {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[0] != "" || parts[1] != "argon2id" {
		return false
	}
	var version int
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil || version != argon2.Version {
		return false
	}
	var memory, iterations uint32
	var threads uint8
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &memory, &iterations, &threads); err != nil {
		return false
	}
	// 只认合理范围内的参数：库里的值被改坏时，不能让一次校验吃掉几 GB 内存或跑上几分钟。
	if memory < 8 || memory > 256*1024 || iterations < 1 || iterations > 10 || threads < 1 || threads > 8 {
		return false
	}
	b64 := base64.RawStdEncoding
	salt, err := b64.DecodeString(parts[4])
	if err != nil || len(salt) < 8 {
		return false
	}
	want, err := b64.DecodeString(parts[5])
	if err != nil || len(want) < 16 || len(want) > 64 {
		return false
	}
	keyLen := uint32(len(want)) //nolint:gosec // 上面已限定 16～64 字节
	got := argon2.IDKey([]byte(password), salt, iterations, memory, threads, keyLen)
	return subtle.ConstantTimeCompare(got, want) == 1
}

// dummyHash 给没注册的手机号陪跑一次校验：号存在与否，登录花的时间差不多，不能靠计时探出哪些号注册过。
// 第一次用到时才算，启动不多花这几十毫秒。
var dummyHash = sync.OnceValue(func() string {
	h, err := HashPassword("pindou-dummy-password")
	if err != nil {
		panic(err)
	}
	return h
})

// VerifyAbsent 是手机号没注册时的陪跑校验，结果总是不符。
func VerifyAbsent(password string) bool {
	VerifyPassword(dummyHash(), password)
	return false
}

// TemporaryPassword 是员工给顾客发的一次性临时密码：8 位数字，方便当面念给顾客。
// 只能用来设新密码、24 小时过期、按手机号限流，8 位数字够用。
func TemporaryPassword() (string, error) {
	n, err := rand.Int(rand.Reader, big.NewInt(100_000_000))
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%08d", n.Int64()), nil
}
