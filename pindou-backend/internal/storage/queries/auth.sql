-- name: AuthSession :one
SELECT account_id::text AS account_id, developer_mode, expires_at, client FROM auth_sessions WHERE token_hash = $1;

-- name: PutAuthSession :exec
INSERT INTO auth_sessions(token_hash, account_id, developer_mode, expires_at, client) VALUES ($1, $2, $3, $4, $5);

-- name: DeleteAuthSession :exec
DELETE FROM auth_sessions WHERE token_hash = $1;

-- name: DeleteSessionsOfClient :execrows
DELETE FROM auth_sessions WHERE account_id = $1 AND client = $2;

-- name: PurgeExpiredSessions :exec
DELETE FROM auth_sessions WHERE expires_at <= $1;

-- name: PurgeWebLogins :exec
DELETE FROM web_logins WHERE expires_at < $1;

-- name: CountWebLogins :one
SELECT count(*) FROM web_logins WHERE status = $1 AND expires_at > $2;

-- name: InsertWebLogin :exec
INSERT INTO web_logins(id, poll_hash, status, created_at, expires_at, user_agent, ip) VALUES ($1, $2, $3, $4, $5, $6, $7);

-- approved_by 可空：不能写成 ::text（sqlc 会把转换的结果当成非空）。
-- name: WebLogin :one
SELECT id::text AS id, poll_hash, status, created_at, expires_at, user_agent, ip, approved_by_account_id AS approved_by
FROM web_logins WHERE id = $1;

-- 从 from_status 改成 to_status；approved_by 为空时不改批准人。
-- name: SetWebLoginStatus :execrows
UPDATE web_logins SET status = @to_status, approved_by_account_id = COALESCE(sqlc.narg(approved_by)::uuid, approved_by_account_id)
WHERE id = @id AND status = @from_status;

-- 网页密码登录（迁移 022）。phone 是去掉空格和横线后的登录手机号。
-- name: PasswordLoginByPhone :one
SELECT account_id::text AS account_id, password_hash, must_change, temporary_expires_at FROM account_passwords WHERE phone = $1;

-- name: PasswordLoginOf :one
SELECT phone, password_hash, must_change, temporary_expires_at FROM account_passwords WHERE account_id = $1;

-- name: PutPasswordLogin :exec
INSERT INTO account_passwords(account_id, phone, password_hash, must_change, temporary_expires_at, updated_at)
VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT (account_id) DO UPDATE SET phone = excluded.phone, password_hash = excluded.password_hash,
  must_change = excluded.must_change, temporary_expires_at = excluded.temporary_expires_at, updated_at = excluded.updated_at;

-- name: SetPasswordLoginPhone :exec
UPDATE account_passwords SET phone = $2, updated_at = $3 WHERE account_id = $1;

-- 这个号有没有被 other_than 以外的账户用过：资料里的手机号（去掉空格和横线后比）或网页登录用的号。
-- 注册时 other_than 传全零编号。
-- name: PhoneTaken :one
SELECT EXISTS (
  SELECT 1 FROM accounts WHERE id <> @other_than AND regexp_replace(coalesce(phone, ''), '[[:space:]-]', '', 'g') = @phone::text
  UNION ALL
  SELECT 1 FROM account_passwords WHERE account_id <> @other_than AND phone = @phone::text
) AS taken;

-- 代开、注册撞号时找回原账户，优先使用网页登录手机号的归属。
-- name: AccountByPhone :many
SELECT account_id::text AS account_id FROM (
  SELECT account_id, 0 AS priority FROM account_passwords WHERE phone = @phone::text
  UNION ALL
  SELECT id, 1 AS priority FROM accounts WHERE regexp_replace(coalesce(phone, ''), '[[:space:]-]', '', 'g') = @phone::text
) matches ORDER BY priority, account_id LIMIT 1;

-- name: AccountHasWechat :one
SELECT EXISTS (SELECT 1 FROM account_wechat_identities WHERE account_id = $1) AS linked;

-- 已发临时密码不算本人登录；本人设新密码或认领后会记下隐私同意。
-- name: UnclaimedMemberAccounts :many
SELECT a.id::text AS id FROM accounts a WHERE a.id = ANY(@ids::uuid[])
  AND a.state ? 'memberOpening' AND coalesce(a.privacy_contract_version, '') = ''
  AND NOT EXISTS (SELECT 1 FROM account_wechat_identities w WHERE w.account_id = a.id);

-- name: DeletePasswordLogin :exec
DELETE FROM account_passwords WHERE account_id = $1;

-- 小程序注册时不另建和未绑微信账户重复的手机号。
-- name: PhoneNeedsClaim :one
SELECT EXISTS (
  SELECT 1 FROM accounts a
  WHERE (regexp_replace(coalesce(a.phone, ''), '[[:space:]-]', '', 'g') = @phone::text
    OR EXISTS (SELECT 1 FROM account_passwords p WHERE p.account_id = a.id AND p.phone = @phone::text))
    AND NOT EXISTS (SELECT 1 FROM account_wechat_identities w WHERE w.account_id = a.id)
) AS needs_claim;
