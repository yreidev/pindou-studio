-- 限流计数：几个副本共用一个窗口，过期的窗口从 1 重新数。
-- name: HitRateLimit :one
INSERT INTO rate_limit_windows(key, reset_at, count) VALUES (@key, @reset_at, 1)
ON CONFLICT (key) DO UPDATE SET
  count = CASE WHEN rate_limit_windows.reset_at <= @now THEN 1 ELSE rate_limit_windows.count + 1 END,
  reset_at = CASE WHEN rate_limit_windows.reset_at <= @now THEN @reset_at ELSE rate_limit_windows.reset_at END
RETURNING count, reset_at;

-- name: PurgeRateLimitWindows :exec
DELETE FROM rate_limit_windows WHERE reset_at < $1;

-- 最近一次本机、异地备份（/statusz）。
-- name: LatestBackups :many
SELECT DISTINCT ON (kind) kind, name, size_bytes, finished_at FROM backup_runs ORDER BY kind, id DESC;

-- 启动时记一行数据规模。
-- name: DataScale :one
SELECT
  (SELECT count(*) FROM accounts)::bigint AS accounts,
  (SELECT count(*) FROM sales_orders)::bigint AS orders,
  (SELECT count(*) FROM stock_ledger_entries)::bigint AS movements,
  (SELECT count(*) FROM membership_entries)::bigint AS loyalty_entries,
  (SELECT count(*) FROM audit_events)::bigint AS audits;

-- 推送：提交后才送到各个副本，回滚了就不发。
-- name: Notify :exec
SELECT pg_notify(@channel::text, @payload::text);

-- 事务级咨询锁，提交或回滚时自动释放。
-- name: TransactionLock :exec
SELECT pg_advisory_xact_lock(@lock_key::bigint);

-- 小程序码指向的版本（迁移 023）：没有行表示老板没改过。
-- name: MiniprogramCodeSettings :many
SELECT env_version, updated_by::text AS updated_by, updated_at FROM miniprogram_code_settings WHERE id = true;

-- name: SaveMiniprogramCodeSettings :exec
INSERT INTO miniprogram_code_settings(id, env_version, updated_by, updated_at) VALUES (true, @env_version, @updated_by, @updated_at)
ON CONFLICT (id) DO UPDATE SET env_version = excluded.env_version, updated_by = excluded.updated_by, updated_at = excluded.updated_at;

-- 员工最近上报的小程序正式版运行版本；没有行表示从未收到。
-- name: MiniappVersionObservation :many
SELECT version, reported_at FROM miniapp_version_observation WHERE id = true;

-- name: SaveMiniappVersionObservation :exec
INSERT INTO miniapp_version_observation(id, version, reported_at) VALUES (true, @version, @reported_at)
ON CONFLICT (id) DO UPDATE SET version = excluded.version, reported_at = excluded.reported_at;

-- 门店开关「系统内收费」（迁移 024）：没有行表示关。
-- name: BillingSettings :many
SELECT enabled, updated_by::text AS updated_by, updated_at FROM billing_settings WHERE id = true;

-- name: SaveBillingSettings :exec
INSERT INTO billing_settings(id, enabled, updated_by, updated_at) VALUES (true, @enabled, @updated_by, @updated_at)
ON CONFLICT (id) DO UPDATE SET enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
