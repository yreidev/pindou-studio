package main

import (
	"strings"
	"testing"
)

func TestStartupConfiguration(t *testing.T) {
	for _, tt := range []struct {
		name  string
		env   map[string]string
		valid bool
	}{
		{"development with a fake wechat", map[string]string{"PINDOU_DATABASE_URL": "test-dsn", "PINDOU_DEV_FAKE_WECHAT": "1"}, true},
		{"database is required", map[string]string{"PINDOU_DEV_FAKE_WECHAT": "1"}, false},
		{"retired in-memory storage flag", map[string]string{"PINDOU_DEV_STORAGE": "1", "PINDOU_DATABASE_URL": "test-dsn", "PINDOU_DEV_FAKE_WECHAT": "1"}, false},
		{"fake wechat cannot be combined with real credentials", map[string]string{"PINDOU_DATABASE_URL": "test-dsn", "PINDOU_DEV_FAKE_WECHAT": "1", "PINDOU_WECHAT_APP_ID": "test-id", "PINDOU_WECHAT_APP_SECRET": "test-secret"}, false},
		{"explicit listen address", map[string]string{"PINDOU_DATABASE_URL": "test-dsn", "PINDOU_DEV_FAKE_WECHAT": "1", "PINDOU_HTTP_ADDRESS": "127.0.0.1:18080"}, true},
		{"durable", map[string]string{"PINDOU_DATABASE_URL": "test-dsn", "PINDOU_WECHAT_APP_ID": "test-id", "PINDOU_WECHAT_APP_SECRET": "test-secret"}, true},
		{"durable without identity", map[string]string{"PINDOU_DATABASE_URL": "test-dsn"}, false},
		{"id only", map[string]string{"PINDOU_DATABASE_URL": "test-dsn", "PINDOU_WECHAT_APP_ID": "test-id"}, false},
		{"secret only", map[string]string{"PINDOU_DATABASE_URL": "test-dsn", "PINDOU_WECHAT_APP_SECRET": "test-secret"}, false},
		{"bootstrap owner", map[string]string{"PINDOU_DATABASE_URL": "test-dsn", "PINDOU_DEV_FAKE_WECHAT": "1", "PINDOU_BOOTSTRAP_OWNER_ID": "ceb515ed-e0d0-4255-95c4-8b5274fb70fc"}, true},
		{"bootstrap owner must be one uuid", map[string]string{"PINDOU_DATABASE_URL": "test-dsn", "PINDOU_DEV_FAKE_WECHAT": "1", "PINDOU_BOOTSTRAP_OWNER_ID": "not-a-uuid"}, false},
		{"wechat link verification file", map[string]string{"PINDOU_DATABASE_URL": "test-dsn", "PINDOU_DEV_FAKE_WECHAT": "1", "PINDOU_WECHAT_LINK_VERIFY_FILE": "abc123.txt", "PINDOU_WECHAT_LINK_VERIFY_CONTENT": "0123456789abcdef"}, true},
		{"verification file without content", map[string]string{"PINDOU_DATABASE_URL": "test-dsn", "PINDOU_DEV_FAKE_WECHAT": "1", "PINDOU_WECHAT_LINK_VERIFY_FILE": "abc123.txt"}, false},
		{"verification content without file", map[string]string{"PINDOU_DATABASE_URL": "test-dsn", "PINDOU_DEV_FAKE_WECHAT": "1", "PINDOU_WECHAT_LINK_VERIFY_CONTENT": "0123456789abcdef"}, false},
		{"verification file must be a bare name", map[string]string{"PINDOU_DATABASE_URL": "test-dsn", "PINDOU_DEV_FAKE_WECHAT": "1", "PINDOU_WECHAT_LINK_VERIFY_FILE": "../abc123.txt", "PINDOU_WECHAT_LINK_VERIFY_CONTENT": "0123456789abcdef"}, false},
		{"openid key", map[string]string{"PINDOU_DATABASE_URL": "test-dsn", "PINDOU_DEV_FAKE_WECHAT": "1", "PINDOU_WECHAT_OPENID_KEY": "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="}, true},
		{"openid key must be 32 bytes", map[string]string{"PINDOU_DATABASE_URL": "test-dsn", "PINDOU_DEV_FAKE_WECHAT": "1", "PINDOU_WECHAT_OPENID_KEY": "c2hvcnQ="}, false},
		{"openid key must be base64", map[string]string{"PINDOU_DATABASE_URL": "test-dsn", "PINDOU_DEV_FAKE_WECHAT": "1", "PINDOU_WECHAT_OPENID_KEY": "not base64!"}, false},
		{"bootstrap owner only one", map[string]string{"PINDOU_DATABASE_URL": "test-dsn", "PINDOU_DEV_FAKE_WECHAT": "1", "PINDOU_BOOTSTRAP_OWNER_ID": "ceb515ed-e0d0-4255-95c4-8b5274fb70fc,ceb515ed-e0d0-4255-95c4-8b5274fb70fd"}, false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			cfg, err := loadConfiguration(func(key string) string { return tt.env[key] })
			if (err == nil) != tt.valid {
				t.Fatalf("valid=%v, error=%v", tt.valid, err)
			}
			if err != nil {
				for _, secret := range []string{"test-dsn", "test-secret", "test-id"} {
					if strings.Contains(err.Error(), secret) {
						t.Fatal("configuration error leaks a credential")
					}
				}
				return
			}
			want := tt.env["PINDOU_HTTP_ADDRESS"]
			if want == "" {
				want = ":8080"
			}
			if cfg.address != want || cfg.databaseURL != tt.env["PINDOU_DATABASE_URL"] || cfg.appID != tt.env["PINDOU_WECHAT_APP_ID"] || cfg.appSecret != tt.env["PINDOU_WECHAT_APP_SECRET"] {
				t.Fatal("configuration changed supplied settings")
			}
		})
	}
}
