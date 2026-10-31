package storage

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

// 数据库晚于 API 就绪时，启动要等它，而不是立刻退出交给 k8s 退避重启。
func TestWaitForRetriesUntilReady(t *testing.T) {
	calls := 0
	err := waitFor(context.Background(), time.Second, time.Millisecond, func(context.Context) error {
		calls++
		if calls < 3 {
			return errors.New("connection refused")
		}
		return nil
	})
	if err != nil || calls != 3 {
		t.Fatalf("err=%v calls=%d, want success on the third attempt", err, calls)
	}
}

func TestWaitForGivesUpAfterTheWait(t *testing.T) {
	down := errors.New("connection refused")
	started := time.Now()
	err := waitFor(context.Background(), 50*time.Millisecond, time.Millisecond, func(context.Context) error { return down })
	if !errors.Is(err, down) {
		t.Fatalf("err=%v, want the last connection error", err)
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("waited %s for a 50ms budget", elapsed)
	}
}

func TestWaitForWithoutBudgetTriesOnce(t *testing.T) {
	calls := 0
	_ = waitFor(context.Background(), 0, time.Millisecond, func(context.Context) error {
		calls++
		return errors.New("down")
	})
	if calls != 1 {
		t.Fatalf("calls=%d, want a single attempt", calls)
	}
}

// 数据库错误分三类：冲突（整个请求重来）、数据被拒（重试没用，要修代码）、其余（数据库这一侧的故障，可以再试）。
func TestDatabaseErrorsAreClassified(t *testing.T) {
	for code, want := range map[string][2]bool{ // {Retryable, Rejected}
		"40001": {true, false},  // 串行化失败
		"40P01": {true, false},  // 死锁
		"23505": {true, false},  // 唯一键冲突：两个请求同时建同一条
		"23514": {false, true},  // CHECK 约束
		"23503": {false, true},  // 外键
		"23502": {false, true},  // NOT NULL
		"22P02": {false, true},  // 类型转换失败（比如不是 UUID）
		"P0001": {false, true},  // 不可改写记录的触发器
		"53100": {false, false}, // 磁盘满
		"57P01": {false, false}, // 管理员关停
	} {
		err := fmt.Errorf("wrapped: %w", &pgconn.PgError{Code: code})
		if Retryable(err) != want[0] || Rejected(err) != want[1] {
			t.Errorf("%s: retryable=%v rejected=%v, want %v", code, Retryable(err), Rejected(err), want)
		}
	}
	if Retryable(errors.New("connection reset")) || Rejected(errors.New("connection reset")) {
		t.Error("a network error was classified as a database verdict")
	}
}
