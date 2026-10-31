package storage

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"embed"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"strings"
	"time"

	"github.com/pressly/goose/v3"
	"github.com/pressly/goose/v3/database"
	"github.com/pressly/goose/v3/lock"
)

// 迁移由 goose 执行，只向上（没有回滚迁移：滚动发布时新旧版本同时连着库，迁移只做向后兼容的改动），
// 登记在 goose 的版本表 goose_db_version。以前的手写执行器留下的 schema_migrations 只给 0.0.8 及更早的程序看，
// 014 之后已经退不回那些版本，016 把它删了（0.0.11、0.0.12 启动时会自己建一张空表，退回它们不受影响）。

//go:embed migrations/*.sql
var migrationFS embed.FS

const (
	// migrationLock 是执行迁移时持有的会话级咨询锁：滚动发布时几个副本可能同时启动，只能有一个在跑迁移，
	// 其余的等它跑完再看还有没有没执行的。编号沿用以前的执行器，和已发布的各版本在同一把锁上排队。
	migrationLock = 7_310_202_610
	// lastLegacyMigration 是 goose 接手之前写的最后一个迁移（001–013）。它们是给旧执行器写的，没有 goose 的注解：
	// 整个文件在一个事务里一次执行（无参数的 Exec 走简单协议，多条语句原样交给数据库，$$ 函数体不会被拆开）。
	// 生产早已执行过，文件一个字节不改；交给 goose 时登记成执行整份文件的 Go 迁移（legacyMigration），
	// 执行方式和以前完全一样。之后的迁移照 goose 的写法自带 -- +goose Up 注解（TestMigrationFiles）。
	lastLegacyMigration = 13
)

// migrationFiles 是 dir 里的全部迁移文件，按版本号（文件名开头的数字）。
func migrationFiles(dir fs.FS) (map[int64]string, error) {
	entries, err := fs.ReadDir(dir, ".")
	if err != nil {
		return nil, err
	}
	files := map[int64]string{}
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".sql") {
			continue
		}
		version, err := goose.NumericComponent(name)
		if err != nil {
			return nil, fmt.Errorf("migration %s: %w", name, err)
		}
		if other, ok := files[version]; ok {
			return nil, fmt.Errorf("migrations %s and %s share version %d", other, name, version)
		}
		files[version] = name
	}
	return files, nil
}

// Migrate 在 db 上执行还没执行过的迁移，全程持有迁移锁。
// 要从 db 同时取两条连接（一条持锁，一条给 goose），连接池不能只有一条。
func Migrate(ctx context.Context, db *sql.DB) error {
	dir, err := fs.Sub(migrationFS, "migrations")
	if err != nil {
		return err
	}
	return migrate(ctx, db, dir)
}

// migrate 执行 dir 里的迁移（测试可以换一组文件）。
func migrate(ctx context.Context, db *sql.DB, dir fs.FS) error {
	files, err := migrationFiles(dir)
	if err != nil {
		return err
	}
	store, err := database.NewStore(database.DialectPostgres, goose.DefaultTablename)
	if err != nil {
		return err
	}
	var legacy []*goose.Migration
	var legacyVersions []int64
	for version, name := range files {
		if version <= lastLegacyMigration {
			m, err := legacyMigration(dir, version, name)
			if err != nil {
				return err
			}
			legacy = append(legacy, m)
			legacyVersions = append(legacyVersions, version)
		}
	}
	// goose 自己不加锁：锁由下面这条专用连接持有，覆盖建版本表和执行迁移的全过程。
	provider, err := goose.NewProvider(goose.DialectCustom, db, dir,
		goose.WithStore(store),
		goose.WithDisableGlobalRegistry(true),
		goose.WithExcludeVersions(legacyVersions),
		goose.WithGoMigrations(legacy...),
	)
	if err != nil {
		return err
	}
	conn, err := db.Conn(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = conn.Close() }()
	// 最多等 15 分钟（每秒试一次）：别的副本在跑耗时的迁移时排队等它。
	locker, err := lock.NewPostgresSessionLocker(lock.WithLockID(migrationLock), lock.WithLockTimeout(1, 900))
	if err != nil {
		return err
	}
	if err := locker.SessionLock(ctx, conn); err != nil {
		return fmt.Errorf("acquire migration lock: %w", err)
	}
	defer func() { _ = locker.SessionUnlock(context.WithoutCancel(ctx), conn) }()
	results, err := provider.Up(ctx)
	for _, r := range results {
		slog.Info("migration applied", "file", files[r.Source.Version], "duration", r.Duration.Round(time.Millisecond).String())
	}
	if partial := (*goose.PartialError)(nil); errors.As(err, &partial) {
		return fmt.Errorf("migration %s: %w", files[partial.Failed.Source.Version], partial.Err)
	}
	return err
}

// legacyMigration 把 goose 接手之前的一个迁移文件登记成 Go 迁移：在 goose 开的事务里把整份文件一次执行，
// 和以前的执行器一样（见 lastLegacyMigration）。
func legacyMigration(dir fs.FS, version int64, name string) (*goose.Migration, error) {
	body, err := fs.ReadFile(dir, name)
	if err != nil {
		return nil, err
	}
	script := string(body)
	return goose.NewGoMigration(version, &goose.GoFunc{RunTx: func(ctx context.Context, tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, script)
		return err
	}}, nil), nil
}

// MigrationsDigest 是全部迁移文件内容的摘要（测试按它给模板库命名，迁移一变就建新模板）。
func MigrationsDigest() string {
	entries, err := fs.ReadDir(migrationFS, "migrations")
	if err != nil {
		panic(err)
	}
	h := sha256.New()
	for _, entry := range entries {
		b, err := migrationFS.ReadFile("migrations/" + entry.Name())
		if err != nil {
			panic(err)
		}
		h.Write([]byte(entry.Name()))
		h.Write(b)
	}
	return hex.EncodeToString(h.Sum(nil))
}
