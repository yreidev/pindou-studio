-- 顾客预约的微信订阅消息（迁移 026，internal/app/notices.go）。

-- name: SealWechatOpenID :execrows
UPDATE account_wechat_identities SET openid_sealed = @sealed WHERE identity_hash = @identity_hash AND account_id = @account_id;

-- name: SealedWechatOpenID :many
SELECT identity_hash, openid_sealed FROM account_wechat_identities
WHERE account_id = @account_id AND openid_sealed IS NOT NULL ORDER BY created_at DESC LIMIT 1;

-- name: AddReservationNotice :exec
-- 已经有这一种的（发过的、作废的也算）不再加：一种通知每条预约最多发一次。
INSERT INTO reservation_notices (reservation_id, kind, account_id, status, created_at, updated_at)
VALUES (@reservation_id, @kind, @account_id, 'pending', @now, @now)
ON CONFLICT (reservation_id, kind) DO NOTHING;

-- name: ReservationNoticeKinds :many
SELECT reservation_id, kind FROM reservation_notices WHERE reservation_id = ANY(@ids::uuid[]) ORDER BY reservation_id, kind;

-- name: ClaimReservationNotice :many
UPDATE reservation_notices SET status = 'sending', updated_at = @now
WHERE reservation_id = @reservation_id AND kind = @kind AND status = 'pending'
RETURNING account_id;

-- name: VoidReservationNotices :exec
UPDATE reservation_notices SET status = 'void', updated_at = @now WHERE reservation_id = @reservation_id AND status = 'pending';

-- name: FinishReservationNotice :execrows
UPDATE reservation_notices SET status = @status, failure = sqlc.narg(failure), updated_at = @now
WHERE reservation_id = @reservation_id AND kind = @kind AND status = 'sending';

-- name: ClaimDueReminders :many
-- 到点的开始前提醒：预约已确认、还没开始、离开始不到 hours 小时；离开始已经不到 hours 小时才确认的不提醒（刚确认过，不用再提醒）。
UPDATE reservation_notices SET status = 'sending', updated_at = @now
FROM reservations
WHERE reservation_notices.reservation_id = reservations.id AND reservation_notices.kind = 'reminder'
  AND reservation_notices.status = 'pending' AND reservations.status = 'confirmed'
  AND reservations.start_at > @now AND reservations.start_at <= @due_before
  AND (reservations.state->>'decidedAt')::timestamptz <= reservations.start_at - @lead::interval
RETURNING reservation_notices.reservation_id, reservation_notices.account_id;
