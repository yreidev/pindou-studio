package app

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// 面向用户的错误文案必须是中文。
//
// `writeError` 把 `err.Error()` 原样放进响应的 message，而员工侧页面**按设计直接展示
// 服务端原文**（顾客侧走前端白名单，不受影响）。所以这里写英文，店员在手机上看到的
// 就是英文 —— 2026-09-19 真机验收时老板看到的是 "manager start time must be today"。
//
// 例外是**客户端契约违反**那几条：缺幂等键、缺 expectedVersion、字段没传全、方法不允许。
// 那些不是用户操作错误，是前端 bug 的信号，保持英文反而更容易定位；翻成中文会让店员
// 以为是自己操作有问题。下面 allowEnglish 列的就是这一类，加新的要写清楚理由。
func TestUserFacingErrorsAreChinese(t *testing.T) {
	allowEnglish := map[string]string{
		"Idempotency-Key is required":                                                                 "契约违反：前端没带幂等键",
		"key already used for a different request":                                                    "契约违反：幂等键被复用",
		"expectedVersion and operation fields are required":                                           "契约违反：前端没带版本或操作",
		"expectedRevision is required":                                                                "契约违反：网页后台没带读到的修订号",
		"expectedRevision and colors are required":                                                    "契约违反：小程序没带修订号或颜色",
		"wechatLoginCode, nickname, privacyContractVersion and exactly one phone source are required": "契约违反：注册字段没传全",
		"wechatLoginCode is required":                                                                 "契约违反：登录码没传",
		"approve is required":                                                                         "契约违反：扫码登录的批准请求没带 approve",
		"pollToken is required":                                                                       "契约违反：网页轮询没带 pollToken",
		"stockItemId, non-zero quantityDelta and reason are required":                                 "契约违反：库存调整字段没传全",
		"supplierName and items are required":                                                         "契约违反：采购字段没传全",
		"serviceTableId and valid timingMode are required; startedAt, when given, must be RFC 3339":   "契约违反：开台字段没传全或开始时间格式不对",
		"PINDOU_DEVELOPER_ACCOUNT_IDS must contain comma-separated account UUIDs":                     "启动期配置校验，运维看的",
		"WeChat app ID and secret are required":                                                       "启动期配置校验，运维看的",
		"database URL is required":                                                                    "启动期配置校验，运维看的",
		"snapshot requires Users":                                                                     "持久化层内部一致性保护，不经 writeError",
		"state would remove existing business records":                                                "持久化层内部一致性保护，不经 writeError",
		"database state no longer matches memory":                                                     "持久化层内部一致性保护，不经 writeError，触发进程重启",
		"method not allowed":                                                                          "契约违反：HTTP 方法不对",
		"persistence dependency is unavailable":                                                       "启动期检查，用户看不到",
		"service is shutting down":                                                                    "就绪检查，运维看的",
		"PINDOU_WECHAT_OPENID_KEY must be 32 bytes (base64)":                                          "启动期配置校验，运维看的",
		"sealed openid is too short":                                                                  "后台发微信通知时解密失败，只记成通知的失败码 unseal，用户看不到",
	}

	pattern := regexp.MustCompile(`errors\.New\("([^"]+)"\)`)
	hasHan := regexp.MustCompile(`\p{Han}`)
	// 纯 snake_case 是错误码不是文案
	isCode := regexp.MustCompile(`^[a-z0-9_]+$`)

	root := filepath.Join("..", "..", "internal")
	var bad []string
	err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return err
		}
		body, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		for _, m := range pattern.FindAllStringSubmatch(string(body), -1) {
			msg := m[1]
			if hasHan.MatchString(msg) || isCode.MatchString(msg) {
				continue
			}
			if _, ok := allowEnglish[msg]; ok {
				continue
			}
			bad = append(bad, path+"  "+msg)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("遍历源码: %v", err)
	}
	if len(bad) > 0 {
		t.Errorf("%d 条面向用户的错误文案还是英文：", len(bad))
		for _, b := range bad {
			t.Errorf("  %s", b)
		}
		t.Error("  要么翻成中文，要么加进 allowEnglish 并写清楚为什么是契约违反类。")
	}
}
