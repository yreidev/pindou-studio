package app

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	catalogapp "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/catalog/application"
	records "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/persistence/infrastructure/postgres"
	reserve "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/reservations/domain"
	calls "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/servicecalls/domain"
	"github.com/yreidev/pindou-studio/pindou-backend/internal/storage/queries"
)

// 这一组方法是请求事务的「仓库」：处理函数只通过它们读写数据，SQL 都在这里。
// 读到的完整记录放进工作集（见 txn）；只用于展示、内容不全的读取（比如不带头像的账户列表）返回副本，
// 不进工作集——否则改了别的字段写回时，缺的那部分会被抹掉。

// ---------- 账户 ----------

// accountFingerprint 是判断账户改没改用的内容：state 之外，手机号和隐私同意存在单独的列里。
type accountFingerprint struct {
	User    *User
	Phone   string
	Private persistedUserPrivate
}

func privateOf(u *User) persistedUserPrivate {
	return persistedUserPrivate{u.PrivacyContractVersion, u.PrivacyAcceptedAt, u.CreatedAt}
}

// newUserWorkset 是账户的工作集。账户 state 里没有手机号与私密字段（json:"-"），它们存在单独的列里：
// 判断改没改要连它们一起比，写回时要连同 Phones、PrivateUsers 一起拼出来。
func newUserWorkset() *workset[User] {
	w := newWorkset[User]("Users", func(u *User) string { return u.ID })
	w.fingerprint = func(u *User) ([]byte, error) {
		return json.Marshal(accountFingerprint{u, u.Phone, privateOf(u)})
	}
	w.encode = func(ids []string, items map[string]*User) ([]byte, error) {
		users, phones, private := map[string]*User{}, map[string]string{}, map[string]persistedUserPrivate{}
		for _, id := range ids {
			u := items[id]
			users[id], phones[id], private[id] = u, u.Phone, privateOf(u)
		}
		return json.Marshal(map[string]any{"Users": users, "Phones": phones, "PrivateUsers": private})
	}
	return w
}

// user 按编号找账户（完整记录，放进工作集），没有返回 nil。
func (q *txn) user(id string) *User {
	if u, ok := q.users.items[id]; ok {
		return u
	}
	if !validID(id) {
		return nil
	}
	rows := must(q.db().Account(q.ctx, id))
	if len(rows) == 0 {
		return nil
	}
	r := rows[0]
	u := new(User)
	q.fail(json.Unmarshal(r.State, u))
	u.Phone, u.PrivacyContractVersion, u.CreatedAt = r.Phone, r.PrivacyContractVersion, r.CreatedAt
	if r.PrivacyAcceptedAt != nil {
		u.PrivacyAcceptedAt = *r.PrivacyAcceptedAt
	}
	return q.users.adopt(q, u.ID, u)
}

// userByWechat 按微信身份（openid 的哈希）找账户。
func (q *txn) userByWechat(identityHash string) *User {
	for hash, account := range q.wechat {
		if hash == identityHash {
			return q.user(account)
		}
	}
	if accounts := must(q.db().AccountByWechat(q.ctx, identityHash)); len(accounts) > 0 {
		return q.user(accounts[0])
	}
	return nil
}

func (q *txn) addUser(u *User) { q.users.add(u.ID, u) }

func (q *txn) addWechatIdentity(identityHash, account string) { q.wechat[identityHash] = account }

// summary 是一个账户的展示用副本：state（不带头像）加上手机号。
func (q *txn) summary(state []byte, phone string) User {
	var u User
	q.fail(json.Unmarshal(state, &u))
	u.Phone = phone
	return u
}

// summaries 按 SQL（选出 state 与手机号两列）读出账户的展示用副本：不带头像，不进工作集。
func (q *txn) summaries(sql string, args ...any) []User {
	q.flush()
	rows, err := q.tx.Query(q.ctx, sql, args...)
	q.fail(err)
	defer rows.Close()
	out := []User{}
	for rows.Next() {
		var state []byte
		var phone string
		q.fail(rows.Scan(&state, &phone))
		out = append(out, q.summary(state, phone))
	}
	q.fail(rows.Err())
	return out
}

// accountMatchSQL 是员工按关键字找顾客的条件：昵称或打码手机号（与页面显示的一致，见迁移 013 的
// pindou_account_search）包含关键字（$2 是 likePattern），账户编号以它开头，或完整手机号等于它（$1 是关键字本身）。
const accountMatchSQL = `(pindou_account_search(a.state, a.phone) LIKE $2 OR starts_with(a.id::text, $1) OR a.phone = $1)`

// 账户分页的两种排法：找顾客时新注册的在前；会员列表按昵称的拼音排（与网页以前在前端排的一致），同名按编号。
const (
	newestAccountsFirst = `a.created_at DESC, a.id`
	accountsByNickname  = `COALESCE(a.state->>'nickname','') COLLATE "zh-x-icu", a.id`
)

// accountsPage 是按关键字（去掉首尾空白、不分大小写，空的不筛）找到的账户的一页（展示用副本）和匹配的总数；
// 页码超出时落到最后一页。
func (q *txn) accountsPage(needle, order string, page, size int) ([]User, int) {
	needle = strings.ToLower(strings.TrimSpace(needle))
	where, args := ``, []any{}
	if needle != "" {
		where, args = ` WHERE `+accountMatchSQL, []any{needle, likePattern(needle)}
	}
	total := scalar[int](q, `SELECT count(*) FROM accounts a`+where, args...)
	page = min(page, max(1, (total+size-1)/size))
	n := len(args)
	args = append(args, size, (page-1)*size)
	return q.summaries(fmt.Sprintf(`SELECT a.state - 'avatarDataUrl', COALESCE(a.phone,'') FROM accounts a%s ORDER BY %s LIMIT $%d OFFSET $%d`,
		where, order, n+1, n+2), args...), total
}

// likePattern 是「包含 needle」的 LIKE 模式：needle 里的 \、%、_ 照字面匹配。
func likePattern(needle string) string {
	return "%" + strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(needle) + "%"
}

// accountLabel 是列表里给人看的账户称呼：昵称与打码手机号。不带头像，不是权限依据。
type accountLabel struct {
	ID          string `json:"id"`
	Nickname    string `json:"nickname"`
	PhoneMasked string `json:"phoneMasked"`
}

// accountLabels 一次查出一组账户的称呼；查不到的（比如 system）不在结果里。
func (q *txn) accountLabels(ids []string) map[string]accountLabel {
	out := map[string]accountLabel{}
	for id, name := range q.accountNames(ids) {
		out[id] = accountLabel{ID: id, Nickname: name.Nickname, PhoneMasked: maskPhone(name.Phone)}
	}
	return out
}

// labelOf 是 labels 里的一个账户，没有时为 nil（JSON 里是 null）。
func labelOf(labels map[string]accountLabel, id string) *accountLabel {
	if l, ok := labels[id]; ok {
		return &l
	}
	return nil
}

// ---------- 员工任命 ----------

func (q *txn) activeRoles() []*roleAssignment {
	return adopt(q, q.roles, must(q.db().ActiveRoles(q.ctx)))
}

func (q *txn) rolesOf(account string) []*roleAssignment {
	if !validID(account) {
		return nil
	}
	return adopt(q, q.roles, must(q.db().ActiveRolesOf(q.ctx, account)))
}

func (q *txn) role(id string) *roleAssignment {
	return loadOne(q, q.roles, id, (*queries.Queries).ActiveRole)
}

func (q *txn) addRole(a *roleAssignment) { q.roles.add(a.ID, a) }

// revokeRole 撤销一条任命：保留历史行，只记撤销时间。
func (q *txn) revokeRole(a *roleAssignment) {
	q.flush()
	q.fail(records.RevokeRole(q.ctx, q.tx, a.ID))
	q.roles.forget(a.ID)
	q.owners[a.UserID] = true
}

// forget 把一条记录移出工作集（已经由专门的语句处理过，不再按普通记录写回）。
func (w *workset[T]) forget(id string) {
	delete(w.items, id)
	delete(w.clean, id)
	delete(w.owners, id)
	for i, existing := range w.order {
		if existing == id {
			w.order = append(w.order[:i], w.order[i+1:]...)
			break
		}
	}
}

// ---------- 布局 ----------

func (q *txn) allAreas() []*FloorArea {
	return adopt(q, q.areas, must(q.db().AllAreas(q.ctx)))
}

func (q *txn) addArea(a *FloorArea) { q.areas.add(a.ID, a) }

func (q *txn) allTables() []*Table {
	return adopt(q, q.tables, must(q.db().AllTables(q.ctx)))
}

func (q *txn) table(id string) *Table {
	return loadOne(q, q.tables, id, (*queries.Queries).ServiceTable)
}

func (q *txn) addTable(t *Table) { q.tables.add(t.ID, t) }

// ---------- 计时会话 ----------

func (q *txn) session(id string) *TableSession {
	return loadOne(q, q.sessions, id, (*queries.Queries).VenueSession)
}

func (q *txn) liveSessions() []*TableSession {
	return adopt(q, q.sessions, must(q.db().LiveSessions(q.ctx)))
}

func (q *txn) liveSessionsOnTable(table string) []*TableSession {
	if !validID(table) {
		return nil
	}
	return adopt(q, q.sessions, must(q.db().LiveSessionsOnTable(q.ctx, table)))
}

func (q *txn) liveSessionsOf(account string) []*TableSession {
	if !validID(account) {
		return nil
	}
	return adopt(q, q.sessions, must(q.db().LiveSessionsOf(q.ctx, account)))
}

// sessionsByIDs 读一组会话（入座申请视图用）。
func (q *txn) sessionsByIDs(ids []string) map[string]*TableSession {
	out := map[string]*TableSession{}
	var missing []string
	for _, id := range ids {
		if x, ok := q.sessions.items[id]; ok {
			out[id] = x
		} else if validID(id) {
			missing = append(missing, id)
		}
	}
	if len(missing) > 0 {
		for _, x := range adopt(q, q.sessions, must(q.db().VenueSessions(q.ctx, missing))) {
			out[x.ID] = x
		}
	}
	return out
}

func (q *txn) addSession(x *TableSession) { q.sessions.add(x.ID, x) }

// ---------- 订单 ----------

// 读出来的订单都经 followTime：草稿开头系统生成的计时明细按此刻重算（见 session_billing.go）。

func (q *txn) order(id string) *Order {
	o := loadOne(q, q.orders, id, (*queries.Queries).SalesOrder)
	if o != nil {
		q.followTime([]*Order{o})
	}
	return o
}

func (q *txn) ordersOfSession(session string) []*Order {
	if !validID(session) {
		return nil
	}
	return q.followTime(adopt(q, q.orders, must(q.db().OrdersOfSession(q.ctx, session))))
}

// ordersOfSessions 是每个会话的第一张订单（按建单先后）。
func (q *txn) ordersOfSessions(sessions []string) map[string]*Order {
	out := map[string]*Order{}
	var ids []string
	for _, id := range sessions {
		if validID(id) {
			ids = append(ids, id)
		}
	}
	if len(ids) == 0 {
		return out
	}
	for _, o := range q.followTime(adopt(q, q.orders, must(q.db().OrdersOfSessions(q.ctx, ids)))) {
		if out[o.TableSessionID] == nil {
			out[o.TableSessionID] = o
		}
	}
	return out
}

func (q *txn) ordersOf(account string) []*Order {
	if !validID(account) {
		return nil
	}
	return q.followTime(adopt(q, q.orders, must(q.db().OrdersOfAccount(q.ctx, account))))
}

func (q *txn) addOrder(o *Order) { q.orders.add(o.ID, o) }

// ---------- 商品与库存 ----------

func (q *txn) catalogItem(id string) *catalogapp.Item {
	return loadOne(q, q.catalog, id, (*queries.Queries).CatalogItem)
}

// allCatalog 是全部商品资料。只因被库存或订单引用而占位的行（名称就是编号、没有售价）也在里面，
// 与以前快照里的商品资料一致。
func (q *txn) allCatalog() []*catalogapp.Item {
	return adopt(q, q.catalog, must(q.db().AllCatalogItems(q.ctx)))
}

func (q *txn) addCatalogItem(v *catalogapp.Item) { q.catalog.add(v.ID, v) }

// catalogByBarcode 是登记了这个条码的商品（条码已经 catalogapp.Barcode 规范过），没有返回 nil。
// 同一条码最多一件（迁移 018 的唯一索引）。
func (q *txn) catalogByBarcode(code string) *catalogapp.Item {
	found := adopt(q, q.catalog, must(q.db().CatalogItemByBarcode(q.ctx, &code)))
	if len(found) == 0 {
		return nil
	}
	return found[0]
}

// purchasePrefill 是收货入库要预填的：最近一次入库的供应商（还没入过库为空）和每件商品最近一次的进价。
func (q *txn) purchasePrefill() (string, []queries.LatestPurchaseUnitCostsRow) {
	supplier := ""
	if rows := must(q.db().LatestPurchaseSupplier(q.ctx)); len(rows) > 0 {
		supplier = rows[0]
	}
	return supplier, must(q.db().LatestPurchaseUnitCosts(q.ctx))
}

func (q *txn) stockItem(id string) *inventoryItem {
	return loadOne(q, q.stock, id, (*queries.Queries).StockItem)
}

func (q *txn) allStock() []*inventoryItem {
	return adopt(q, q.stock, must(q.db().AllStockItems(q.ctx)))
}

// stockByProduct 是这件商品的库存项目，没有返回 nil。
func (q *txn) stockByProduct(product string) *inventoryItem {
	for _, id := range q.stock.order {
		if it := q.stock.items[id]; it.ProductID == product {
			return it
		}
	}
	if !validID(product) {
		return nil
	}
	found := adopt(q, q.stock, must(q.db().StockItemOfProduct(q.ctx, product)))
	if len(found) == 0 {
		return nil
	}
	return found[0]
}

func (q *txn) addStockItem(it *inventoryItem) { q.stock.add(it.ID, it) }

func (q *txn) addPurchase(p *purchase) { q.purchases.add(p.ID, p) }

func (q *txn) addMovementRecord(m *movement) { q.movements.add(m.ID, m) }

// ---------- 预约 ----------

func (q *txn) reservation(id string) *Reservation {
	return loadOne(q, q.reservations, id, (*queries.Queries).Reservation)
}

// openReservations 是还可能占座的预约：待确认或已确认、结束时间没过去太久的（是否真的还在占座由
// Reservation.Live 按当前时间和宽限期判断）。预约最长不过一天，往前多看两天足够。
func (q *txn) openReservations(now time.Time) []*Reservation {
	return adopt(q, q.reservations, must(q.db().OpenReservations(q.ctx, now.Add(-48*time.Hour))))
}

// pendingReservations 是员工还要处理的预约：待确认或已确认的，不论时间过没过（过了宽限期的要标记到店或爽约）。
func (q *txn) pendingReservations() []*Reservation {
	return adopt(q, q.reservations, must(q.db().PendingReservations(q.ctx)))
}

// endedReservations 是处理完的预约（已到店、已取消、爽约）的一页，开始时间新的在前，和总数。
// from、to 不为零时只要开始时间在 [from, to) 里的（按门店日期筛，见 storeDayRange）。
func (q *txn) endedReservations(page, size int, from, to time.Time) ([]*Reservation, int) {
	total := int(must(q.db().CountEndedReservations(q.ctx, queries.CountEndedReservationsParams{FromTime: timeBound(from), ToTime: timeBound(to)})))
	page = min(page, max(1, (total+size-1)/size))
	window := queries.EndedReservationsParams{FromTime: timeBound(from), ToTime: timeBound(to), PageSize: int64(size), Skip: int64((page - 1) * size)}
	return adopt(q, q.reservations, must(q.db().EndedReservations(q.ctx, window))), total
}

func (q *txn) addReservation(x *Reservation) { q.reservations.add(x.ID, x) }

// customerCancellations 是开始时间在 [from, to) 里、被顾客本人取消、还没有员工点过「知道了」的预约，按开始时间。
func (q *txn) customerCancellations(from, to time.Time) []*Reservation {
	return adopt(q, q.reservations, must(q.db().CustomerCancellations(q.ctx, queries.CustomerCancellationsParams{FromTime: from, ToTime: to})))
}

// noShowsSince 是这个账户开始时间在 since 及以后、被标记爽约的预约数（先写回改过的预约，本次请求刚标的也算）。
func (q *txn) noShowsSince(account string, since time.Time) int {
	return int(must(q.db().CountNoShows(q.ctx, queries.CountNoShowsParams{AccountID: account, Since: since})))
}

// reservationSettings 是门店的预约设置；老板没保存过时是默认值。
func (q *txn) reservationSettings() *reserve.Settings {
	if q.settings != nil {
		return q.settings
	}
	set := reserve.DefaultSettings()
	if rows := must(q.db().ReservationSettings(q.ctx)); len(rows) > 0 {
		q.fail(json.Unmarshal(rows[0], &set))
		if q.write {
			b, err := json.Marshal(set)
			q.fail(err)
			q.settingsClean = b
		}
	}
	q.settings = &set
	return q.settings
}

// ---------- 呼叫店员 ----------

func (q *txn) serviceCall(id string) *ServiceCall {
	return loadOne(q, q.calls, id, (*queries.Queries).ServiceCall)
}

// latestServiceCalls 是这些会话各自最近的一条呼叫，按会话编号；没叫过的会话不在结果里。
func (q *txn) latestServiceCalls(sessions []string) map[string]*ServiceCall {
	out := map[string]*ServiceCall{}
	var ids []string
	for _, id := range sessions {
		if validID(id) {
			ids = append(ids, id)
		}
	}
	if len(ids) == 0 {
		return out
	}
	for _, c := range adopt(q, q.calls, must(q.db().LatestServiceCalls(q.ctx, ids))) {
		out[c.SessionID] = c
	}
	return out
}

// openServiceCalls 是员工要去处理的呼叫：还没处理、没过期、会话还在计时或暂停中，先叫的在前。
func (q *txn) openServiceCalls(now time.Time) []*ServiceCall {
	return adopt(q, q.calls, must(q.db().OpenServiceCalls(q.ctx, now.Add(-calls.Window))))
}

func (q *txn) addServiceCall(c *ServiceCall) { q.calls.add(c.ID, c) }

// ---------- 幂等与审计 ----------

// idempotencyRetention 是幂等键记下的结果保留多久。幂等键只为让客户端自己的重试安全，没有客户端会隔这么久重试；
// 业务历史在各自的表里，永久保留，和它无关。
const idempotencyRetention = 30 * 24 * time.Hour

// idemGet 是这个键记下的结果（保留期内的），没有返回 nil。
func (q *txn) idemGet(key string) *idemResponse {
	if v, ok := q.idem.items[key]; ok {
		return v
	}
	rows := must(q.db().IdempotentResponse(q.ctx, queries.IdempotentResponseParams{Key: key, CreatedAt: q.now().Add(-idempotencyRetention)}))
	if len(rows) == 0 {
		return nil
	}
	v := new(idemResponse)
	q.fail(json.Unmarshal(rows[0], v))
	return q.idem.adopt(q, key, v)
}

// rememberIdem 记下一个幂等键的结果，和业务数据同一事务写入；顺手清掉过了保留期的键，表不会一直长。
// 过期的同一个键（极少见：客户端隔了一个月拿同一个键重试）先删掉，这次当新请求处理。
func (q *txn) rememberIdem(key string, value idemResponse) {
	now := q.now()
	value.CreatedAt = now
	q.fail(q.dbWrite().PurgeIdempotencyKeys(q.ctx, now.Add(-idempotencyRetention)))
	q.idem.add(key, &value)
}

func (q *txn) audit(actor, action, object, reason, requestID string) {
	q.audits = append(q.audits, &auditLog{ID: id(), ActorID: actor, Action: action, ObjectID: object, Reason: reason, RequestID: requestID, CreatedAt: q.now()})
}

func (q *txn) reservationsOf(account string) []*Reservation {
	if !validID(account) {
		return nil
	}
	return adopt(q, q.reservations, must(q.db().ReservationsOf(q.ctx, account)))
}

// accountName 是展示用的顾客称呼与手机号（打码前）。
type accountName struct{ Nickname, Phone string }

// accountNames 一次查出一组账户的昵称与手机号，不读头像、不进工作集。
func (q *txn) accountNames(ids []string) map[string]accountName {
	out := map[string]accountName{}
	seen := map[string]bool{}
	var valid []string
	for _, id := range ids {
		if validID(id) && !seen[id] {
			seen[id] = true
			valid = append(valid, id)
		}
	}
	if len(valid) == 0 {
		return out
	}
	for _, r := range must(q.db().AccountNames(q.ctx, valid)) {
		out[r.ID] = accountName{Nickname: r.Nickname, Phone: r.Phone}
	}
	return out
}

// ordersPage 是员工订单列表的一页：可按状态、关键字筛选，新的在前（同一时刻按编号）。关键字（已转小写）匹配订单编号、
// 明细名称（pindou_order_search），或顾客的昵称、打码后的手机号（与网页显示的一致；按完整手机号搜不到）。
// size 为 0 时返回全部匹配的订单。返回这一页的订单和匹配的总数；页码超出时落到最后一页。
// settlement 为 comp 时只列免单结清的订单（付款记录里有 method 为 comp 的一条）。
func (q *txn) ordersPage(status, needle, settlement string, page, size int) ([]*Order, int) {
	var conds []string
	var args []any
	if status == statusOpen {
		// 待结账：还没收齐的单，草稿和部分付款
		conds = append(conds, `o.status IN ('draft', 'partially_paid')`)
	} else if status != "" {
		args = append(args, status)
		conds = append(conds, fmt.Sprintf(`o.status = $%d`, len(args)))
	}
	if settlement == settlementComp {
		conds = append(conds, `o.id IN (SELECT sales_order_id FROM payment_records WHERE method = 'comp')`)
	}
	if needle != "" {
		// 两路各走各的索引再合起来（写成一个 OR，数据库只能整表扫描、逐行算搜索文本）
		args = append(args, likePattern(needle))
		n := len(args)
		conds = append(conds, fmt.Sprintf(`o.id IN (SELECT id FROM sales_orders WHERE pindou_order_search(id, state) LIKE $%d
 UNION SELECT x.id FROM sales_orders x JOIN accounts a ON a.id = x.account_id WHERE pindou_account_search(a.state, a.phone) LIKE $%d)`, n, n))
	}
	where := ""
	if len(conds) > 0 {
		where = ` WHERE ` + strings.Join(conds, ` AND `)
	}
	total := scalar[int](q, `SELECT count(*) FROM sales_orders o`+where, args...)
	limit := ""
	if size > 0 {
		page = min(page, max(1, (total+size-1)/size))
		limit = fmt.Sprintf(` LIMIT $%d OFFSET $%d`, len(args)+1, len(args)+2)
		args = append(args, size, (page-1)*size)
	}
	return q.followTime(load(q, q.orders, `SELECT o.id::text, o.state FROM sales_orders o`+where+` ORDER BY o.created_at DESC, o.id`+limit, args...)), total
}

// dateBound 把空的起止时间换成 SQL 里的 NULL（不限）。
func dateBound(t time.Time) any {
	if t.IsZero() {
		return nil
	}
	return t
}

// timeBound 同 dateBound，给 sqlc 生成的查询（空的是 nil）。
func timeBound(t time.Time) *time.Time {
	if t.IsZero() {
		return nil
	}
	return &t
}

// movementFilter 是库存流水的筛选：库存项目、类型、门店日期范围（见 exportDateRange），以及先后顺序。
type movementFilter struct {
	item, kind  string
	from, to    time.Time
	newestFirst bool
}

// movementViews 是库存流水的展示视图：按类型拆出原因、关联单号，带上商品、采购的供应商与备注、操作人当前昵称。
// size 为 0 时返回全部匹配的流水。返回这一页和匹配的总数；页码超出时落到最后一页。
func (q *txn) movementViews(f movementFilter, page, size int) ([]stockMovementView, int) {
	where := ` WHERE ($1 = '' OR m.stock_item_id::text = $1) AND ($2 = '' OR m.kind = $2)
 AND ($3::timestamptz IS NULL OR m.created_at >= $3) AND ($4::timestamptz IS NULL OR m.created_at <= $4)`
	args := []any{f.item, f.kind, dateBound(f.from), dateBound(f.to)}
	total := scalar[int](q, `SELECT count(*) FROM stock_ledger_entries m`+where, args...)
	order := ` ORDER BY m.created_at, m.id`
	if f.newestFirst {
		order = ` ORDER BY m.created_at DESC, m.id DESC`
	}
	limit := ""
	if size > 0 {
		page = min(page, max(1, (total+size-1)/size))
		limit = ` LIMIT $5 OFFSET $6`
		args = append(args, size, (page-1)*size)
	}
	q.flush()
	rows, err := q.tx.Query(q.ctx, `SELECT m.state, COALESCE(si.catalog_item_id::text, ''), COALESCE(a.state->>'nickname', ''), COALESCE(p.supplier_name, ''), COALESCE(p.note, '')
 FROM stock_ledger_entries m
 LEFT JOIN stock_items si ON si.id = m.stock_item_id
 LEFT JOIN accounts a ON a.id = NULLIF(m.state->>'ActorID', '')::uuid
 LEFT JOIN stock_receipts p ON m.kind = 'purchase' AND p.id::text = m.reason`+where+order+limit, args...)
	q.fail(err)
	defer rows.Close()
	out := []stockMovementView{}
	for rows.Next() {
		var state []byte
		var product, actor, supplier, note string
		q.fail(rows.Scan(&state, &product, &actor, &supplier, &note))
		var m movement
		q.fail(json.Unmarshal(state, &m))
		view := stockMovementView{ID: m.ID, StockItemID: m.InventoryItemID, ProductID: product, Kind: m.Kind, QuantityDelta: m.QuantityDelta, CreatedAt: m.CreatedAt, ActorID: m.ActorID}
		if m.ActorID != "" {
			view.ActorName = actor
		}
		switch m.Kind {
		case "adjustment":
			view.Reason = m.Reason
		case "purchase":
			view.ReferenceID = m.Reason
			view.SupplierName, view.Note = supplier, note
		default:
			view.ReferenceID = m.Reason
		}
		out = append(out, view)
	}
	q.fail(rows.Err())
	return out, total
}

// ordersCreatedBetween 是建单时间在门店日期范围内的订单（导出用），按建单先后。
func (q *txn) ordersCreatedBetween(from, to time.Time) []*Order {
	return q.followTime(adopt(q, q.orders, must(q.db().OrdersCreatedBetween(q.ctx, queries.OrdersCreatedBetweenParams{FromTime: timeBound(from), ToTime: timeBound(to)}))))
}

// refundRow 是导出用的一笔退款和它所属的订单。
type refundRow struct {
	Refund
	orderID string
}

// refundsBetween 是退款时间在门店日期范围内的退款记录（导出用），按先后。
func (q *txn) refundsBetween(from, to time.Time) []refundRow {
	var out []refundRow
	for _, r := range must(q.db().RefundsBetween(q.ctx, queries.RefundsBetweenParams{FromTime: timeBound(from), ToTime: timeBound(to)})) {
		x := refundRow{orderID: r.SalesOrderID}
		q.fail(json.Unmarshal(r.State, &x.Refund))
		out = append(out, x)
	}
	return out
}

// purchasesBetween 是采购时间在门店日期范围内的采购单（导出用），按先后。
func (q *txn) purchasesBetween(from, to time.Time) []*purchase {
	return adopt(q, q.purchases, must(q.db().PurchasesBetween(q.ctx, queries.PurchasesBetweenParams{FromTime: timeBound(from), ToTime: timeBound(to)})))
}

// auditPage 是审计的一页，新的在前。needle（已转小写）匹配动作代码、对象编号、请求编号、原因、操作人编号与当前昵称；
// actions 里的动作代码直接命中；两者都空时不筛。size 为 0 时返回全部。返回这一页和匹配的总数。
func (q *txn) auditPage(needle string, actions []string, page, size int) ([]auditLog, int) {
	// 各路条件各走各的索引再合起来（写成一个 OR，数据库只能整表扫描、逐行算搜索文本）
	var branches []string
	var args []any
	if len(actions) > 0 {
		args = append(args, actions)
		branches = append(branches, fmt.Sprintf(`SELECT id FROM audit_events WHERE action = ANY($%d::text[])`, len(args)))
	}
	if needle != "" {
		args = append(args, likePattern(needle))
		n := len(args)
		branches = append(branches, fmt.Sprintf(`SELECT id FROM audit_events WHERE pindou_audit_search(state) LIKE $%d`, n),
			fmt.Sprintf(`SELECT x.id FROM audit_events x JOIN accounts a ON a.id = x.actor_account_id WHERE pindou_account_search(a.state, a.phone) LIKE $%d`, n))
	}
	from, where := ` FROM audit_events e`, ""
	if len(branches) > 0 {
		where = ` WHERE e.id IN (` + strings.Join(branches, ` UNION `) + `)`
	}
	total := scalar[int](q, `SELECT count(*)`+from+where, args...)
	limit := ""
	if size > 0 {
		page = min(page, max(1, (total+size-1)/size))
		limit = fmt.Sprintf(` LIMIT $%d OFFSET $%d`, len(args)+1, len(args)+2)
		args = append(args, size, (page-1)*size)
	}
	rows := q.query(`SELECT e.id::text, e.state`+from+where+` ORDER BY e.created_at DESC, e.seq`+limit, args...)
	out := make([]auditLog, 0, len(rows))
	for _, r := range rows {
		var a auditLog
		q.fail(json.Unmarshal(r.state, &a))
		out = append(out, a)
	}
	return out, total
}
