-- 会员码（迁移 019）：只存令牌的 SHA-256。

-- name: InsertMemberCode :exec
INSERT INTO member_codes(token_hash, account_id, created_at, expires_at) VALUES ($1, $2, $3, $4);

-- name: MemberCode :one
SELECT account_id::text AS account_id, expires_at FROM member_codes WHERE token_hash = $1;

-- 过期一小时以上的码没有任何用处了（查到也只说「不是本店的会员码」）。
-- name: PurgeMemberCodes :exec
DELETE FROM member_codes WHERE expires_at < $1;

-- 网页后台实时连接的报到（UNLOGGED）：连上时插入、每次心跳续期、断开时删掉。
-- name: PutWebPresence :exec
INSERT INTO web_presences(connection_id, account_id, expires_at) VALUES ($1, $2, $3)
ON CONFLICT (connection_id) DO UPDATE SET expires_at = excluded.expires_at;

-- name: DeleteWebPresence :exec
DELETE FROM web_presences WHERE connection_id = $1;

-- name: CountWebPresences :one
SELECT count(*) FROM web_presences WHERE account_id = $1 AND expires_at > $2;

-- 进程崩了没来得及删的报到，过期一小时后清掉。
-- name: PurgeWebPresences :exec
DELETE FROM web_presences WHERE expires_at < $1;
