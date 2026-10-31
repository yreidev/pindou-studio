-- name: MembershipDrafts :many
SELECT id::text AS id, state FROM membership_drafts;

-- name: MembershipPublications :many
SELECT id::text AS id, state FROM membership_publications;

-- 资料按账户存，主键就是账户编号。
-- name: MembershipProfilesOf :many
SELECT account_id::text AS id, state FROM membership_profiles WHERE account_id = $1;

-- name: MembershipEntriesOf :many
SELECT id::text AS id, state FROM membership_entries WHERE account_id = $1;

-- name: MembershipEntriesOfAccounts :many
SELECT id::text AS id, state FROM membership_entries WHERE account_id = ANY(@accounts::uuid[]);

-- 指向这些订单的结账与送分流水。
-- name: CheckoutEntries :many
SELECT id::text AS id, state FROM membership_entries WHERE state->>'sourceId' = ANY(@orders::text[]) AND kind IN ('checkout','earned');

-- name: HasCheckoutEntry :one
SELECT EXISTS(SELECT 1 FROM membership_entries WHERE kind = 'checkout' AND state->>'sourceId' = @source_id::text);

-- 这条兑换规则已经兑换了多少次。
-- name: CountExchanges :one
SELECT count(*) FROM membership_entries WHERE kind = 'exchange' AND state->'rule'->>'id' = @rule_id::text;

-- name: MembershipAdmissionsOf :many
SELECT id::text AS id, state FROM membership_admissions WHERE account_id = $1;

-- name: AdmissionAccount :many
SELECT account_id::text AS account_id FROM membership_admissions WHERE id = $1;

-- 员工总览可能要看的入座申请：最近的待确认申请（since 之后）、今天（today 起）申请的、计时还在进行或今天结束的。
-- name: ShiftAdmissions :many
SELECT a.id::text AS id, a.state FROM membership_admissions a
 LEFT JOIN venue_sessions x ON x.id = NULLIF(a.state->>'venueSessionId','')::uuid
 WHERE (a.state->>'status' = 'pending' AND (a.state->>'createdAt')::timestamptz > @since::timestamptz)
    OR (a.state->>'createdAt')::timestamptz >= @today::timestamptz
    OR x.status IN ('active','paused','companion')
    OR (x.state->>'stoppedAt')::timestamptz >= @today::timestamptz;
