package storage

import (
	"crypto/sha256"
	"encoding/hex"
	"io/fs"
	"regexp"
	"slices"
	"strings"
	"testing"
)

// 执行器把每个迁移和它的登记包在一个事务里。迁移文件自带的 COMMIT 会提前提交这个
// 事务：迁移执行到一半崩溃时，已提交的部分留在库里却没有登记，下次启动再跑一遍。
// PL/pgSQL 块里的 BEGIN 后面没有分号，不在此列。
func TestMigrationsLeaveTransactionsToTheRunner(t *testing.T) {
	control := regexp.MustCompile(`(?im)^\s*(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION)(\s+(WORK|TRANSACTION))?\s*;`)
	entries, err := fs.ReadDir(migrationFS, "migrations")
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		sql, err := migrationFS.ReadFile("migrations/" + entry.Name())
		if err != nil {
			t.Fatal(err)
		}
		if match := control.Find(sql); match != nil {
			t.Errorf("%s controls its own transaction (%q); the runner already wraps each migration", entry.Name(), match)
		}
	}
}

// 001–013 是 goose 接手之前写的、生产早已执行过的迁移：一个字节也不能改（改了也不会再执行，
// 新库和老库就对不上了），要改表结构就写新的迁移。之后的迁移按 goose 的写法：以 -- +goose Up 开头；
// 只向上，不写 Down；不用 NO TRANSACTION（每个迁移和它的登记在同一个事务里）。
func TestMigrationFiles(t *testing.T) {
	dir, err := fs.Sub(migrationFS, "migrations")
	if err != nil {
		t.Fatal(err)
	}
	files, err := migrationFiles(dir)
	if err != nil {
		t.Fatal(err)
	}
	versions := make([]int64, 0, len(files))
	for version := range files {
		versions = append(versions, version)
	}
	slices.Sort(versions)
	if len(versions) < lastLegacyMigration || versions[lastLegacyMigration-1] != lastLegacyMigration {
		t.Fatalf("legacy migrations 001–%03d are incomplete: %v", lastLegacyMigration, versions)
	}
	legacy := sha256.New()
	for _, version := range versions {
		name := files[version]
		body, err := fs.ReadFile(dir, name)
		if err != nil {
			t.Fatal(err)
		}
		if version <= lastLegacyMigration {
			legacy.Write([]byte(name))
			legacy.Write(body)
			continue
		}
		text := string(body)
		if !strings.HasPrefix(text, "-- +goose Up\n") {
			t.Errorf("%s must start with the line -- +goose Up", name)
		}
		for _, banned := range []string{"+goose Down", "+goose NO TRANSACTION"} {
			if strings.Contains(text, banned) {
				t.Errorf("%s contains %q: migrations are up-only and run in a transaction", name, banned)
			}
		}
	}
	if got := hex.EncodeToString(legacy.Sum(nil)); got != "ba772f73424bcde69afa39a9fa84c7bbfb0d1a920f89375f9abdf8263f7591c9" && got != "70ffa16869b3946664aacbc6e62213e5077761769fbec71eb862a92046e56654" {
		t.Errorf("migrations 001–%03d were edited (digest %s); production already applied them, add a new migration instead", lastLegacyMigration, got)
	}
}
