package storage

import (
	"context"
	"errors"
	"log"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
)

// Postgres 是业务数据的唯一来源。进程不持有业务状态：每个请求在自己的事务里读写它涉及的记录，
// 所以可以同时跑多个副本（见 docs/plan-postgres-source-of-truth.md）。
type Postgres struct {
	pool *pgxpool.Pool
	dsn  string
}

func Open(ctx context.Context, dsn string) (*Postgres, error) {
	return OpenWhenReady(ctx, dsn, 0)
}

// OpenWhenReady 在 wait 时间内反复尝试连上数据库，连上后再执行迁移。
//
// 服务器重启时数据库和 API 一起启动，API 常常先起来。只试一次就退出的话，k8s 会按
// 10s、20s、40s… 最长 5 分钟的退避重启它，门店要白等。只有「连上」这一步重试：
// 迁移失败是代码或数据的问题，重试没有用，照样立刻退出。
func OpenWhenReady(ctx context.Context, dsn string, wait time.Duration) (*Postgres, error) {
	if dsn == "" {
		return nil, errors.New("database URL is required")
	}
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return nil, err
	}
	if err := waitFor(ctx, wait, time.Second, pool.Ping); err != nil {
		pool.Close()
		return nil, err
	}
	// 迁移经 database/sql 跑在同一个连接池上（goose 用 *sql.DB）；关掉这个 *sql.DB 不会关连接池。
	db := stdlib.OpenDBFromPool(pool)
	err = Migrate(ctx, db)
	_ = db.Close()
	if err != nil {
		pool.Close()
		return nil, err
	}
	return &Postgres{pool: pool, dsn: dsn}, nil
}

// waitFor 反复调用 ready，直到成功或用完 wait；间隔从 interval 起每次翻倍，最多 5 秒。
// wait 为 0 时只试一次。
func waitFor(ctx context.Context, wait, interval time.Duration, ready func(context.Context) error) error {
	deadline := time.Now().Add(wait)
	for {
		err := ready(ctx)
		if err == nil || !time.Now().Add(interval).Before(deadline) {
			return err
		}
		log.Printf("database not ready, retrying in %s: %v", interval, err)
		select {
		case <-ctx.Done():
			return err
		case <-time.After(interval):
		}
		interval = min(interval*2, 5*time.Second)
	}
}

func (p *Postgres) Close()                         { p.pool.Close() }
func (p *Postgres) Ping(ctx context.Context) error { return p.pool.Ping(ctx) }

// Pool 给不在请求事务里的单条语句用（限流计数、清理过期记录）。
func (p *Postgres) Pool() *pgxpool.Pool { return p.pool }

// BeginWrite 开一个写事务。SERIALIZABLE：并发的请求像一个个排队执行一样，读到什么、据此写了什么都成立；
// 冲突时提交或语句失败（Retryable），调用方丢掉这次的结果整个重来。门店的并发很低，重来极少发生。
func (p *Postgres) BeginWrite(ctx context.Context) (pgx.Tx, error) {
	return p.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
}

// BeginRead 开一个只读事务，一个请求里的几次查询看到的是同一个时刻的数据。
func (p *Postgres) BeginRead(ctx context.Context) (pgx.Tx, error) {
	return p.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
}

// Retryable 报告 err 是否是「换个时机重来就可能成功」的冲突：串行化失败、死锁，以及唯一键冲突——
// 两个请求同时插入同一条（同一个幂等键、同一个微信身份），重来时会看到对方已经插入的那条，
// 按业务规则回 409 或重放第一次的结果。
func Retryable(err error) bool {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		return false
	}
	switch pgErr.Code {
	case "40001", "40P01", "23505":
		return true
	}
	return false
}

// Rejected 报告数据库是不是因为数据本身拒绝了这次写入：违反约束或类型（SQLSTATE 22、23 类，唯一键冲突除外，
// 它按冲突重试）、不可改写记录的触发器（P0001）。这类错误重试也不会好，说明有校验漏在了应用层，要修代码。
func Rejected(err error) bool {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || Retryable(err) {
		return false
	}
	return strings.HasPrefix(pgErr.Code, "22") || strings.HasPrefix(pgErr.Code, "23") || pgErr.Code == "P0001"
}

// Listen 用一条专用连接监听 channel，每收到一条通知调用 deliver。每次连上（含断开后重连）调用
// connected：first 为 false 时是重连，断开期间的通知收不到了，调用方应让在线的客户端整体重读。ctx 结束时返回。
func (p *Postgres) Listen(ctx context.Context, channel string, deliver func(payload string), connected func(first bool)) {
	first := true
	for ctx.Err() == nil {
		err := p.listenOnce(ctx, channel, deliver, func() {
			connected(first)
			first = false
		})
		if ctx.Err() != nil {
			return
		}
		log.Printf("event listener reconnecting: %v", err)
		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Second):
		}
	}
}

func (p *Postgres) listenOnce(ctx context.Context, channel string, deliver func(string), connected func()) error {
	pooled, err := p.pool.Acquire(ctx)
	if err != nil {
		return err
	}
	// 监听连接不还给连接池：断开后整条丢掉，免得别的请求拿到一条还在 LISTEN 的连接。
	conn := pooled.Hijack()
	defer conn.Close(context.WithoutCancel(ctx))
	if _, err := conn.Exec(ctx, "LISTEN "+pgx.Identifier{channel}.Sanitize()); err != nil {
		return err
	}
	connected()
	for {
		n, err := conn.WaitForNotification(ctx)
		if err != nil {
			return err
		}
		deliver(n.Payload)
	}
}
