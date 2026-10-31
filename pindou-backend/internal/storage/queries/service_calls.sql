-- 呼叫店员（迁移 015）：按编号读一条，选出 id、state 两列交给 adopt 放进请求事务的工作集。
-- name: ServiceCall :many
SELECT id::text AS id, state FROM service_calls WHERE id = $1;

-- 这些会话各自最近的一条呼叫：顾客再叫之前看有没有还没处理的、是不是刚处理过，顾客页据此显示状态。
-- name: LatestServiceCalls :many
SELECT DISTINCT ON (venue_session_id) id::text AS id, state FROM service_calls
WHERE venue_session_id = ANY(@sessions::uuid[])
ORDER BY venue_session_id, created_at DESC, id DESC;

-- 员工要去处理的：since 之后叫的（更早的已显示为过期）、还没处理、会话还在计时或暂停中（顾客结账走了的不再催）。
-- 先叫的在前。
-- name: OpenServiceCalls :many
SELECT c.id::text AS id, c.state FROM service_calls c
JOIN venue_sessions x ON x.id = c.venue_session_id
WHERE c.status = 'pending' AND c.created_at > @since::timestamptz AND x.status IN ('active', 'paused')
ORDER BY c.created_at, c.id;
