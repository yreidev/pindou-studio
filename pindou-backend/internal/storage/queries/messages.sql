-- 本人最近 90 天的消息。先对全部来源算未读总数，再截取列表，limit 不影响 unread_count。
-- 预约确认、代客登记和门店取消按审计的发生时刻保留历史，不随预约状态变化；本人操作不生成消息，视图仍取当前预约。
-- 例外是员工确认自己的预约：照样发了微信「预约成功」通知，消息里也有一条，两边对得上。
-- name: MyMessages :many
WITH events AS (
  SELECT 'entry:' || e.id::text AS id, 'loyalty'::text AS kind, e.created_at AS at, e.state
  FROM membership_entries e
  WHERE e.account_id = @account_id::uuid AND e.created_at >= @since::timestamptz AND e.created_at <= @now::timestamptz
  UNION ALL
  SELECT 'reservation:' || r.id::text || ':' || CASE WHEN a.action = 'reservation.cancel' THEN 'cancelled' ELSE 'confirmed' END AS id,
    CASE WHEN a.action = 'reservation.cancel' THEN 'reservation_cancelled' ELSE 'reservation_confirmed' END AS kind,
    a.created_at AS at, r.state
  FROM audit_events a JOIN reservations r ON r.id = a.object_id
  WHERE r.account_id = @account_id::uuid
    AND a.action IN ('reservation.confirm', 'reservation.register', 'reservation.cancel')
    AND (a.actor_account_id <> r.account_id OR a.action = 'reservation.confirm')
    AND a.created_at >= @since::timestamptz AND a.created_at <= @now::timestamptz
)
SELECT e.id::text AS id, e.kind, e.at, e.state,
  (seen.read_at IS NULL OR e.at > seen.read_at)::boolean AS unread,
  (count(*) FILTER (WHERE seen.read_at IS NULL OR e.at > seen.read_at) OVER ())::bigint AS unread_count
FROM events e LEFT JOIN message_reads seen ON seen.account_id = @account_id::uuid
ORDER BY e.at DESC, e.id DESC LIMIT @max_items::integer;

-- 重复读、几个设备同时读都只往后挪，不能让更早发起的请求把时刻倒退。
-- name: MarkMessagesRead :exec
INSERT INTO message_reads(account_id, read_at) VALUES (@account_id, @read_at)
ON CONFLICT (account_id) DO UPDATE SET read_at = GREATEST(message_reads.read_at, excluded.read_at);
