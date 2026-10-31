package postgres

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// SaveCollection 把 doc 里 name 这个集合的记录写进对应的表。doc 是快照形状的 JSON（集合 → 键 → 记录），
// 只含要写的记录；账户（Users）一并读同一个键下的 Phones、PrivateUsers。SQL 约束和不可改写触发器照常生效。
func SaveCollection(ctx context.Context, tx pgx.Tx, name string, doc []byte) error {
	for _, c := range collections {
		if c.name != name {
			continue
		}
		for i, statement := range c.statements {
			if _, err := tx.Exec(ctx, statement, string(doc)); err != nil {
				return fmt.Errorf("save %s step %d: %w", name, i, err)
			}
		}
		return nil
	}
	return fmt.Errorf("unknown collection %s", name)
}

// SaveAll 依次写入一整份快照（导入、测试夹具）：各集合按 collections 的顺序，会员在账户之后。
func SaveAll(ctx context.Context, tx pgx.Tx, doc []byte) error {
	for _, c := range collections {
		if err := SaveCollection(ctx, tx, c.name, doc); err != nil {
			return err
		}
	}
	for _, t := range membershipTables {
		if err := SaveMembership(ctx, tx, t.collection, doc); err != nil {
			return err
		}
	}
	return nil
}

// RevokeRole 撤销一条员工任命（保留历史行，只记撤销时间）。
func RevokeRole(ctx context.Context, tx pgx.Tx, id string) error {
	_, err := tx.Exec(ctx, `UPDATE staff_role_assignments SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL`, id)
	return err
}

// collections 是按写入先后排好的集合（被引用的在前）和各自的写入语句。每条语句的参数 $1 是
// 快照形状的 JSON（集合 → 键 → 记录），只含这次要写的记录；按 id 圈定行时一律
// 写成 id IN (SELECT key FROM jsonb_object_keys(...))，走主键索引。改动行用 WHERE ... IS DISTINCT FROM
// 跳过内容没变的行，不白白产生新的行版本。
var collections = []struct {
	name       string
	statements []string
}{
	// 账户：state 之外，手机号和隐私同意等列来自同一个键下的 Phones、PrivateUsers
	{"Users", []string{
		`INSERT INTO accounts(id,nickname,phone,phone_verification_status,privacy_contract_version,privacy_accepted_at,created_at,state)
 SELECT key::uuid,value->>'nickname', $1::jsonb->'Phones'->>key, value->>'phoneVerificationStatus',
 NULLIF($1::jsonb->'PrivateUsers'->key->>'PrivacyContractVersion',''), NULLIF($1::jsonb->'PrivateUsers'->key->>'PrivacyAcceptedAt','0001-01-01T00:00:00Z')::timestamptz,
 COALESCE(($1::jsonb->'PrivateUsers'->key->>'CreatedAt')::timestamptz,now()),value
 FROM jsonb_each(COALESCE($1::jsonb->'Users','{}'))
 ON CONFLICT(id) DO UPDATE SET nickname=excluded.nickname,phone=excluded.phone,phone_verification_status=excluded.phone_verification_status,privacy_contract_version=excluded.privacy_contract_version,privacy_accepted_at=excluded.privacy_accepted_at,created_at=excluded.created_at,state=excluded.state`,
	}},
	// 微信身份只增不改。不写 ON CONFLICT：两个请求同时用同一个微信注册，后提交的撞唯一键、整个请求重来，
	// 重来时看到已注册，回 409；DO NOTHING 会让它悄悄多建一个连不上微信的账户。
	{"Wechat", []string{
		`INSERT INTO account_wechat_identities(account_id,identity_hash) SELECT (value#>>'{}')::uuid,key FROM jsonb_each(COALESCE($1::jsonb->'Wechat','{}'))`,
	}},
	// 员工任命；撤销走 RevokeRole，不靠「不在集合里」判断
	{"Roles", []string{
		`INSERT INTO staff_role_assignments(id,account_id,role,assigned_at,state) SELECT key::uuid,(value->>'UserID')::uuid,value->>'Role',(value->>'AssignedAt')::timestamptz,value FROM jsonb_each(COALESCE($1::jsonb->'Roles','{}')) ON CONFLICT(id) DO UPDATE SET revoked_at=NULL,state=excluded.state WHERE staff_role_assignments.revoked_at IS NOT NULL OR staff_role_assignments.state IS DISTINCT FROM excluded.state`,
	}},
	{"Areas", []string{
		`INSERT INTO floor_areas(id,name,state) SELECT key::uuid,value->>'name',value FROM jsonb_each(COALESCE($1::jsonb->'Areas','{}')) ON CONFLICT(id) DO UPDATE SET name=excluded.name,state=excluded.state WHERE floor_areas.state IS DISTINCT FROM excluded.state`,
	}},
	{"Tables", []string{
		`INSERT INTO service_tables(id,floor_area_id,number,seat_count,code,enabled,state) SELECT key::uuid,(value->>'AreaID')::uuid,(value->>'Number')::integer,(value->>'SeatCount')::integer,value->>'Code',(value->>'Enabled')::boolean,value FROM jsonb_each(COALESCE($1::jsonb->'Tables','{}')) ON CONFLICT(id) DO UPDATE SET floor_area_id=excluded.floor_area_id,number=excluded.number,seat_count=excluded.seat_count,code=excluded.code,enabled=excluded.enabled,state=excluded.state WHERE service_tables.state IS DISTINCT FROM excluded.state`,
	}},
	// 商品条码（迁移 018）：没登记时记录里不带这个键，写成 NULL；同一条码只属于一件商品（唯一索引），
	// 两个请求同时把同一条码登记给两件商品时后提交的撞索引、整个请求重来，重来时看到已被占用回 409。
	{"Catalog", []string{
		`INSERT INTO catalog_items(id,name,unit_price_cents,barcode) SELECT key::uuid,value->>'name',(value->>'unitPriceCents')::bigint,NULLIF(value->>'barcode','') FROM jsonb_each(COALESCE(NULLIF($1::jsonb->'Catalog','null'),'{}')) ON CONFLICT(id) DO UPDATE SET name=excluded.name,unit_price_cents=excluded.unit_price_cents,barcode=excluded.barcode WHERE (catalog_items.name,catalog_items.unit_price_cents,catalog_items.barcode) IS DISTINCT FROM (excluded.name,excluded.unit_price_cents,excluded.barcode)`,
	}},
	// 库存项目引用的商品没有资料时先占一行
	{"Inventory", []string{
		`INSERT INTO catalog_items(id,name) SELECT DISTINCT (value->>'ProductID')::uuid,value->>'ProductID' FROM jsonb_each(COALESCE($1::jsonb->'Inventory','{}')) ON CONFLICT(id) DO NOTHING`,
		`INSERT INTO stock_items(id,catalog_item_id,quantity,alert_at,state) SELECT key::uuid,(value->>'ProductID')::uuid,(value->>'Quantity')::bigint,(value->>'AlertAt')::bigint,value FROM jsonb_each(COALESCE($1::jsonb->'Inventory','{}')) ON CONFLICT(id) DO UPDATE SET quantity=excluded.quantity,alert_at=excluded.alert_at,state=excluded.state WHERE stock_items.state IS DISTINCT FROM excluded.state`,
	}},
	{"Purchases", []string{
		`INSERT INTO stock_receipts(id,supplier_name,note,created_at,items,state) SELECT key::uuid,value->>'SupplierName',value->>'Note',(value->>'CreatedAt')::timestamptz,value->'Items',value FROM jsonb_each(COALESCE($1::jsonb->'Purchases','{}')) ON CONFLICT(id) DO UPDATE SET state=excluded.state WHERE stock_receipts.state IS DISTINCT FROM excluded.state`,
	}},
	// 库存流水只追加；盘点另记一行 stock_adjustments
	{"Movements", []string{
		`INSERT INTO stock_ledger_entries(id,stock_item_id,kind,quantity_delta,reason,created_at,state) SELECT key::uuid,(value->>'InventoryItemID')::uuid,value->>'Kind',(value->>'QuantityDelta')::bigint,value->>'Reason',(value->>'CreatedAt')::timestamptz,value FROM jsonb_each(COALESCE($1::jsonb->'Movements','{}')) ON CONFLICT(id) DO UPDATE SET state=excluded.state WHERE stock_ledger_entries.state IS DISTINCT FROM excluded.state`,
		`INSERT INTO stock_adjustments(id,stock_item_id,quantity_delta,reason,created_at) SELECT key::uuid,(value->>'InventoryItemID')::uuid,(value->>'QuantityDelta')::bigint,value->>'Reason',(value->>'CreatedAt')::timestamptz FROM jsonb_each(COALESCE($1::jsonb->'Movements','{}')) WHERE value->>'Kind'='adjustment' ON CONFLICT(id) DO NOTHING`,
	}},
	// 计时：先把要写的会话的座号清零再写回，同一次里两个会话换座不会撞唯一索引
	{"Sessions", []string{
		`UPDATE venue_sessions SET seat_number=0 WHERE seat_number<>0 AND id IN (SELECT key::uuid FROM jsonb_object_keys(COALESCE($1::jsonb->'Sessions','{}')) key)`,
		`INSERT INTO venue_sessions(id,service_table_id,account_id,status,started_at,duration_minutes,timing_mode,paused_at,paused_seconds,state) SELECT key::uuid,(value->>'serviceTableId')::uuid,NULLIF(value->>'accountId','')::uuid,value->>'status',(value->>'startedAt')::timestamptz,COALESCE((value->>'durationMinutes')::integer,0),COALESCE(NULLIF(value->>'timingMode',''),'timed'),(value->>'pausedAt')::timestamptz,COALESCE((value->>'pausedSeconds')::bigint,0),value FROM jsonb_each(COALESCE($1::jsonb->'Sessions','{}')) ON CONFLICT(id) DO UPDATE SET service_table_id=excluded.service_table_id,account_id=excluded.account_id,status=excluded.status,started_at=excluded.started_at,duration_minutes=excluded.duration_minutes,timing_mode=excluded.timing_mode,paused_at=excluded.paused_at,paused_seconds=excluded.paused_seconds,state=excluded.state WHERE venue_sessions.state IS DISTINCT FROM excluded.state`,
		`UPDATE venue_sessions SET seat_number=COALESCE((state->>'seatNumber')::integer,0) WHERE id IN (SELECT key::uuid FROM jsonb_object_keys(COALESCE($1::jsonb->'Sessions','{}')) key)`,
	}},
	// 呼叫店员（迁移 015）：叫的人、会话建时定下，之后只有店员处理会改状态与处理人
	{"ServiceCalls", []string{
		`INSERT INTO service_calls(id,venue_session_id,account_id,status,created_at,handled_at,handled_by_account_id,state) SELECT key::uuid,(value->>'venueSessionId')::uuid,(value->>'accountId')::uuid,value->>'status',(value->>'createdAt')::timestamptz,(value->>'handledAt')::timestamptz,NULLIF(value->>'handledByAccountId','')::uuid,value FROM jsonb_each(COALESCE($1::jsonb->'ServiceCalls','{}')) ON CONFLICT(id) DO UPDATE SET status=excluded.status,handled_at=excluded.handled_at,handled_by_account_id=excluded.handled_by_account_id,state=excluded.state WHERE service_calls.state IS DISTINCT FROM excluded.state`,
	}},
	// 订单连同明细、付款、退款、折扣；已有的付款、退款、折扣不动。
	// 顾客（account_id）随 state 一起写：待结账订单可以换顾客、改散客（PATCH /sales-orders/{id}/customer），
	// 顾客的订单列表和按顾客查订单读的是这一列；已付订单换不了（immutable_paid_order 触发器）。
	//
	// 先写明细、后改订单：一个请求里草稿的明细变了又收了款（读出草稿时计时明细按此刻重算，超时加收、自由计时多了一块，
	// 收款随请求一起保存），明细要趁订单在库里还是草稿时写进去——先把订单改成已付款（或部分付款），明细的触发器
	// （immutable_paid_line）就把这次改动当成改已付订单的明细拒收，整个收款 500。所以新订单先插入（明细的外键要它），
	// 已有订单的状态、金额和 state 放到明细之后再改。
	{"Orders", []string{
		`INSERT INTO sales_orders(id,venue_session_id,account_id,status,receivable_cents,paid_cents,created_at,state) SELECT key::uuid,NULLIF(value->>'venueSessionId','')::uuid,NULLIF(value->>'accountId','')::uuid,value->>'status',(value->>'receivableCents')::bigint,(value->>'paidCents')::bigint,(value->>'createdAt')::timestamptz,value FROM jsonb_each(COALESCE($1::jsonb->'Orders','{}')) ON CONFLICT(id) DO NOTHING`,
		`DELETE FROM sales_order_lines l USING sales_orders o, jsonb_each(COALESCE($1::jsonb->'Orders','{}')) j WHERE l.sales_order_id=o.id AND o.id=j.key::uuid AND o.status='draft' AND l.line_index > jsonb_array_length(COALESCE(j.value->'lines','[]'))`,
		`INSERT INTO catalog_items(id,name) SELECT DISTINCT (line->>'productId')::uuid, line->>'productId' FROM jsonb_each(COALESCE($1::jsonb->'Orders','{}')),LATERAL jsonb_array_elements(COALESCE(value->'lines','[]')) line WHERE NULLIF(line->>'productId','') IS NOT NULL ON CONFLICT(id) DO NOTHING`,
		`INSERT INTO sales_order_lines(sales_order_id,line_index,catalog_item_id,name,quantity,unit_price_cents) SELECT key::uuid,ordinality,NULLIF(line->>'productId','')::uuid,line->>'name',(line->>'quantity')::integer,(line->>'unitPriceCents')::bigint FROM jsonb_each(COALESCE($1::jsonb->'Orders','{}')),LATERAL jsonb_array_elements(COALESCE(value->'lines','[]')) WITH ORDINALITY AS lines(line,ordinality) ON CONFLICT(sales_order_id,line_index) DO UPDATE SET catalog_item_id=excluded.catalog_item_id,name=excluded.name,quantity=excluded.quantity,unit_price_cents=excluded.unit_price_cents WHERE (sales_order_lines.catalog_item_id,sales_order_lines.name,sales_order_lines.quantity,sales_order_lines.unit_price_cents) IS DISTINCT FROM (excluded.catalog_item_id,excluded.name,excluded.quantity,excluded.unit_price_cents)`,
		`UPDATE sales_orders o SET account_id=NULLIF(value->>'accountId','')::uuid,status=value->>'status',receivable_cents=(value->>'receivableCents')::bigint,paid_cents=(value->>'paidCents')::bigint,state=value FROM jsonb_each(COALESCE($1::jsonb->'Orders','{}')) WHERE o.id=key::uuid AND o.state IS DISTINCT FROM value`,
		// 现金的实收与找零（迁移 017）：没填时两列都是 NULL
		`INSERT INTO payment_records(id,sales_order_id,method,amount_cents,created_at,cash_received_cents,change_cents,state) SELECT (line->>'id')::uuid,key::uuid,line->>'method',(line->>'amountCents')::bigint,(line->>'createdAt')::timestamptz,(line->>'cashReceivedCents')::bigint,(line->>'changeCents')::bigint,line FROM jsonb_each(COALESCE($1::jsonb->'Orders','{}')),LATERAL jsonb_array_elements(COALESCE(value->'payments','[]')) line ON CONFLICT(id) DO NOTHING`,
		`INSERT INTO refund_records(id,sales_order_id,amount_cents,reason,created_at,state) SELECT (line->>'id')::uuid,key::uuid,(line->>'amountCents')::bigint,line->>'reason',(line->>'createdAt')::timestamptz,line FROM jsonb_each(COALESCE($1::jsonb->'Orders','{}')),LATERAL jsonb_array_elements(COALESCE(value->'refunds','[]')) line ON CONFLICT(id) DO NOTHING`,
		`INSERT INTO sales_order_discounts(id,sales_order_id,kind,amount_cents,rate_basis_points,reason,created_at,state) SELECT (line->>'id')::uuid,key::uuid,line->>'kind',(line->>'amountCents')::bigint,(line->>'rateBasisPoints')::bigint,line->>'reason',(line->>'createdAt')::timestamptz,line FROM jsonb_each(COALESCE($1::jsonb->'Orders','{}')),LATERAL jsonb_array_elements(COALESCE(value->'discounts','[]')) line ON CONFLICT(id) DO NOTHING`,
	}},
	{"Reservations", []string{
		`INSERT INTO reservations(id,account_id,service_table_id,seat_number,start_at,duration_minutes,status,venue_session_id,created_at,state)
 SELECT key::uuid,NULLIF(value->>'accountId','')::uuid,(value->>'serviceTableId')::uuid,(value->>'seatNumber')::integer,
 (value->>'startAt')::timestamptz,(value->>'durationMinutes')::integer,value->>'status',NULLIF(value->>'venueSessionId','')::uuid,
 (value->>'createdAt')::timestamptz,value FROM jsonb_each(COALESCE($1::jsonb->'Reservations','{}'))
 ON CONFLICT(id) DO UPDATE SET account_id=excluded.account_id,service_table_id=excluded.service_table_id,seat_number=excluded.seat_number,start_at=excluded.start_at,duration_minutes=excluded.duration_minutes,status=excluded.status,venue_session_id=excluded.venue_session_id,state=excluded.state WHERE reservations.state IS DISTINCT FROM excluded.state`,
	}},
	{"ReservationSettings", []string{
		`INSERT INTO reservation_settings(id,state) SELECT true,settings FROM (SELECT NULLIF($1::jsonb->'ReservationSettings','null') AS settings) candidate WHERE settings IS NOT NULL ON CONFLICT(id) DO UPDATE SET state=excluded.state WHERE reservation_settings.state IS DISTINCT FROM excluded.state`,
	}},
	{"Audits", []string{
		`INSERT INTO audit_events(id,actor_account_id,action,object_id,reason,request_id,created_at,state) SELECT (value->>'ID')::uuid,NULLIF(value->>'ActorID','system')::uuid,value->>'Action',NULLIF(value->>'ObjectID','')::uuid,value->>'Reason',value->>'RequestID',(value->>'CreatedAt')::timestamptz,value FROM jsonb_array_elements(COALESCE(NULLIF($1::jsonb->'Audits','null'),'[]')) ON CONFLICT(id) DO UPDATE SET state=excluded.state WHERE audit_events.state IS DISTINCT FROM excluded.state`,
	}},
	// 幂等记录同理：同一个键的两个请求同时到，后一个撞唯一键、重来时重放第一个的结果，不会把业务做两遍。
	{"Idem", []string{
		`INSERT INTO idempotency_keys(key,status,response,created_at) SELECT key,(value->>'Status')::integer,value,COALESCE((value->>'CreatedAt')::timestamptz,now()) FROM jsonb_each(COALESCE($1::jsonb->'Idem','{}'))`,
	}},
}

// Load reconstructs aggregates from their owning tables, not the legacy snapshot.
func Load(ctx context.Context, tx pgx.Tx) ([]byte, error) {
	var data []byte
	err := tx.QueryRow(ctx, loadSQL).Scan(&data)
	return data, err
}

const loadSQL = `SELECT jsonb_build_object(
 'Membership',jsonb_build_object(
 'drafts',COALESCE((SELECT jsonb_object_agg(id,state) FROM membership_drafts),'{}'),
 'publications',COALESCE((SELECT jsonb_object_agg(id,state) FROM membership_publications),'{}'),
 'profiles',COALESCE((SELECT jsonb_object_agg(account_id,state) FROM membership_profiles),'{}'),
 'entries',COALESCE((SELECT jsonb_object_agg(id,state) FROM membership_entries),'{}'),
 'admissions',COALESCE((SELECT jsonb_object_agg(id,state) FROM membership_admissions),'{}')),

 'Users',COALESCE((SELECT jsonb_object_agg(id,state) FROM accounts),'{}'),
 'Phones',COALESCE((SELECT jsonb_object_agg(id,COALESCE(phone,'')) FROM accounts),'{}'),
 'PrivateUsers',COALESCE((SELECT jsonb_object_agg(id,jsonb_build_object('PrivacyContractVersion',COALESCE(privacy_contract_version,''),'PrivacyAcceptedAt',privacy_accepted_at,'CreatedAt',created_at)) FROM accounts),'{}'),
 'Wechat',COALESCE((SELECT jsonb_object_agg(identity_hash,account_id) FROM account_wechat_identities),'{}'),
 'Roles',COALESCE((SELECT jsonb_object_agg(id,state) FROM staff_role_assignments WHERE revoked_at IS NULL),'{}'),
 'Areas',COALESCE((SELECT jsonb_object_agg(id,state) FROM floor_areas),'{}'),
 'Tables',COALESCE((SELECT jsonb_object_agg(id,state) FROM service_tables),'{}'),
 'Sessions',COALESCE((SELECT jsonb_object_agg(id,state) FROM venue_sessions),'{}'),
 'Reservations',COALESCE((SELECT jsonb_object_agg(id,state) FROM reservations),'{}'),
 'ReservationSettings',(SELECT state FROM reservation_settings WHERE id=true),
 'Orders',COALESCE((SELECT jsonb_object_agg(id,state) FROM sales_orders),'{}'),
 'Inventory',COALESCE((SELECT jsonb_object_agg(id,state) FROM stock_items),'{}'),
 'Catalog',COALESCE((SELECT jsonb_object_agg(id,jsonb_strip_nulls(jsonb_build_object('id',id,'name',CASE WHEN name=id::text THEN '' ELSE name END,'unitPriceCents',unit_price_cents,'barcode',barcode))) FROM catalog_items),'{}'),
 'Purchases',COALESCE((SELECT jsonb_object_agg(id,state) FROM stock_receipts),'{}'),
 'Movements',COALESCE((SELECT jsonb_object_agg(id,state) FROM stock_ledger_entries),'{}'),
 'Audits',COALESCE((SELECT jsonb_agg(state ORDER BY created_at,seq) FROM audit_events),'[]'),
 'Idem',COALESCE((SELECT jsonb_object_agg(key,response) FROM idempotency_keys),'{}')
)`
