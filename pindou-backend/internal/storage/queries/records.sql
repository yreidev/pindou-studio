-- 完整账户：state 之外，手机号与隐私同意在单独的列里。
-- name: Account :many
SELECT id::text AS id, state, COALESCE(phone, '')::text AS phone, COALESCE(privacy_contract_version, '')::text AS privacy_contract_version,
  privacy_accepted_at, created_at
FROM accounts WHERE id = $1;

-- name: AccountByWechat :many
SELECT account_id::text AS account_id FROM account_wechat_identities WHERE identity_hash = $1;

-- 一组账户的昵称与手机号（打码前）。
-- name: AccountNames :many
SELECT id::text AS id, COALESCE(state->>'nickname', '')::text AS nickname, COALESCE(phone, '')::text AS phone
FROM accounts WHERE id = ANY(@ids::uuid[]);

-- name: ActiveRoles :many
SELECT id::text AS id, state FROM staff_role_assignments WHERE revoked_at IS NULL ORDER BY assigned_at, id;

-- name: ActiveRolesOf :many
SELECT id::text AS id, state FROM staff_role_assignments WHERE revoked_at IS NULL AND account_id = $1;

-- name: ActiveRole :many
SELECT id::text AS id, state FROM staff_role_assignments WHERE revoked_at IS NULL AND id = $1;

-- name: AllAreas :many
SELECT id::text AS id, state FROM floor_areas ORDER BY name, id;

-- name: AllTables :many
SELECT id::text AS id, state FROM service_tables ORDER BY code, id;

-- name: ServiceTable :many
SELECT id::text AS id, state FROM service_tables WHERE id = $1;

-- name: VenueSession :many
SELECT id::text AS id, state FROM venue_sessions WHERE id = $1;

-- name: VenueSessions :many
SELECT id::text AS id, state FROM venue_sessions WHERE id = ANY(@ids::uuid[]);

-- 还在进行的会话（计时、暂停、陪同）。
-- name: LiveSessions :many
SELECT id::text AS id, state FROM venue_sessions WHERE status IN ('active','paused','companion') ORDER BY started_at, id;

-- name: LiveSessionsOnTable :many
SELECT id::text AS id, state FROM venue_sessions WHERE service_table_id = $1 AND status IN ('active','paused','companion') ORDER BY id;

-- name: LiveSessionsOf :many
SELECT id::text AS id, state FROM venue_sessions WHERE account_id = $1::uuid AND status IN ('active','paused','companion');

-- name: SalesOrder :many
SELECT id::text AS id, state FROM sales_orders WHERE id = $1;

-- name: OrdersOfSession :many
SELECT id::text AS id, state FROM sales_orders WHERE venue_session_id = $1::uuid ORDER BY created_at, id;

-- name: OrdersOfSessions :many
SELECT id::text AS id, state FROM sales_orders WHERE venue_session_id = ANY(@sessions::uuid[]) ORDER BY created_at, id;

-- name: OrdersOfAccount :many
SELECT id::text AS id, state FROM sales_orders WHERE account_id = $1::uuid ORDER BY created_at, id;

-- 建单时间在范围内的订单（导出用），不限的一端传空。
-- name: OrdersCreatedBetween :many
SELECT id::text AS id, state FROM sales_orders
WHERE (sqlc.narg(from_time)::timestamptz IS NULL OR created_at >= sqlc.narg(from_time))
  AND (sqlc.narg(to_time)::timestamptz IS NULL OR created_at <= sqlc.narg(to_time))
ORDER BY created_at, id;

-- 退款时间在范围内的退款记录和所属订单（导出用）。
-- name: RefundsBetween :many
SELECT sales_order_id::text AS sales_order_id, state FROM refund_records
WHERE (sqlc.narg(from_time)::timestamptz IS NULL OR created_at >= sqlc.narg(from_time))
  AND (sqlc.narg(to_time)::timestamptz IS NULL OR created_at <= sqlc.narg(to_time))
ORDER BY created_at, id;

-- 商品资料拼成和以前快照里一样的 JSON；只因被引用而占位的行名称就是编号，显示为空。
-- 条码（迁移 018）没登记时不带这个键（jsonb_strip_nulls）。
-- name: CatalogItem :many
SELECT id::text AS id, jsonb_strip_nulls(jsonb_build_object('id', id, 'name', CASE WHEN name = id::text THEN '' ELSE name END, 'unitPriceCents', unit_price_cents, 'barcode', barcode))::jsonb AS state
FROM catalog_items WHERE id = $1;

-- name: AllCatalogItems :many
SELECT id::text AS id, jsonb_strip_nulls(jsonb_build_object('id', id, 'name', CASE WHEN name = id::text THEN '' ELSE name END, 'unitPriceCents', unit_price_cents, 'barcode', barcode))::jsonb AS state
FROM catalog_items ORDER BY id;

-- 按条码精确找商品（走部分唯一索引 catalog_items_barcode），最多一件。
-- name: CatalogItemByBarcode :many
SELECT id::text AS id, jsonb_strip_nulls(jsonb_build_object('id', id, 'name', CASE WHEN name = id::text THEN '' ELSE name END, 'unitPriceCents', unit_price_cents, 'barcode', barcode))::jsonb AS state
FROM catalog_items WHERE barcode = $1;

-- name: StockItem :many
SELECT id::text AS id, state FROM stock_items WHERE id = $1;

-- name: AllStockItems :many
SELECT id::text AS id, state FROM stock_items ORDER BY id;

-- name: StockItemOfProduct :many
SELECT id::text AS id, state FROM stock_items WHERE catalog_item_id = $1 ORDER BY id LIMIT 1;

-- 采购时间在范围内的采购单（导出用）。
-- name: PurchasesBetween :many
SELECT id::text AS id, state FROM stock_receipts
WHERE (sqlc.narg(from_time)::timestamptz IS NULL OR created_at >= sqlc.narg(from_time))
  AND (sqlc.narg(to_time)::timestamptz IS NULL OR created_at <= sqlc.narg(to_time))
ORDER BY created_at, id;

-- name: Reservation :many
SELECT id::text AS id, state FROM reservations WHERE id = $1;

-- name: ReservationsOf :many
SELECT id::text AS id, state FROM reservations WHERE account_id = $1::uuid ORDER BY start_at, id;

-- 待确认或已确认、开始时间在 after 之后的预约。
-- name: OpenReservations :many
SELECT id::text AS id, state FROM reservations WHERE status IN ('pending','confirmed') AND start_at > $1 ORDER BY start_at, id;

-- name: PendingReservations :many
SELECT id::text AS id, state FROM reservations WHERE status IN ('pending','confirmed') ORDER BY start_at, id;

-- 处理完的预约（已到店、已取消、爽约）总数；带了开始时间范围 [from_time, to_time) 就只数这一段（按门店日期筛，
-- 范围由调用方按门店时区算好），不限的一端传空。
-- name: CountEndedReservations :one
SELECT count(*) FROM reservations WHERE status NOT IN ('pending','confirmed')
  AND (sqlc.narg(from_time)::timestamptz IS NULL OR start_at >= sqlc.narg(from_time))
  AND (sqlc.narg(to_time)::timestamptz IS NULL OR start_at < sqlc.narg(to_time));

-- 某个账户开始时间在 since 及以后、被标记爽约的预约数（爽约限制按这个数暂停自助预约）。
-- name: CountNoShows :one
SELECT count(*) FROM reservations WHERE account_id = @account_id::uuid AND status = 'no_show' AND start_at >= @since::timestamptz;

-- 处理完的预约（已到店、已取消、爽约）的一页，开始时间新的在前；开始时间范围同 CountEndedReservations。
-- name: EndedReservations :many
SELECT id::text AS id, state FROM reservations WHERE status NOT IN ('pending','confirmed')
  AND (sqlc.narg(from_time)::timestamptz IS NULL OR start_at >= sqlc.narg(from_time))
  AND (sqlc.narg(to_time)::timestamptz IS NULL OR start_at < sqlc.narg(to_time))
ORDER BY start_at DESC, id LIMIT @page_size::bigint OFFSET @skip::bigint;

-- 开始时间在 [from_time, to_time) 里（调用方按门店时区算好的今天）、被顾客本人取消、还没有员工点过「知道了」的预约：
-- 员工现场页提醒用。谁取消的看审计：reservation.cancel 的操作者就是预约的账户（员工替顾客取消的不算）；
-- 点过「知道了」的有一条 reservation.acknowledge 审计。
-- name: CustomerCancellations :many
SELECT r.id::text AS id, r.state FROM reservations r
WHERE r.status = 'cancelled' AND r.start_at >= @from_time::timestamptz AND r.start_at < @to_time::timestamptz
  AND EXISTS (SELECT 1 FROM audit_events a WHERE a.object_id = r.id AND a.action = 'reservation.cancel' AND a.actor_account_id = r.account_id)
  AND NOT EXISTS (SELECT 1 FROM audit_events a WHERE a.object_id = r.id AND a.action = 'reservation.acknowledge')
ORDER BY r.start_at, r.id;

-- name: ReservationSettings :many
SELECT state FROM reservation_settings WHERE id = true;

-- name: IdempotentResponse :many
SELECT response FROM idempotency_keys WHERE key = $1 AND created_at > $2;

-- name: PurgeIdempotencyKeys :exec
DELETE FROM idempotency_keys WHERE created_at <= $1;
