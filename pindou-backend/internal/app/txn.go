package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"

	catalogapp "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/catalog/application"
	records "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/persistence/infrastructure/postgres"
	reserve "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/reservations/domain"
	"github.com/yreidev/pindou-studio/pindou-backend/internal/storage"
	"github.com/yreidev/pindou-studio/pindou-backend/internal/storage/queries"
)

// txn 是一个请求的数据库事务和工作集（docs/plan-postgres-source-of-truth.md「代码约定」）。
//
// 处理函数通过它读写数据：q.order(id) 这类方法按需从库里读出记录、放进工作集，同一条记录在一个请求里
// 只有一个实例。处理函数直接改这些实例，不用手动保存：写回前按 JSON 比较找出变了的记录，新建的记录用
// q.add… 登记。每次查询之前先写回已改的记录，查到的总是最新的。
//
// 数据库出错时这些方法 panic(dbFailure)，由 serveTx 接住：冲突（串行化失败、唯一键冲突）就把整个请求
// 重来一遍，别的错误回 503。处理函数因此不用到处判断数据库错误。
type txn struct {
	ctx   context.Context
	tx    pgx.Tx
	s     *Server
	write bool

	users        *workset[User]
	roles        *workset[roleAssignment]
	areas        *workset[FloorArea]
	tables       *workset[Table]
	catalog      *workset[catalogapp.Item]
	stock        *workset[inventoryItem]
	purchases    *workset[purchase]
	movements    *workset[movement]
	sessions     *workset[TableSession]
	orders       *workset[Order]
	reservations *workset[Reservation]
	calls        *workset[ServiceCall]
	idem         *workset[idemResponse]
	member       *memberWorkset

	settings      *reserve.Settings
	settingsClean []byte
	wechat        map[string]string
	audits        []*auditLog

	// owners 是这次写回的记录归属的顾客账户（写回前后都算），推送时据此决定发给哪些顾客。
	owners map[string]bool
	// viewers 缓存这次请求里核对过的登录凭证。
	viewers map[string]*User
	// after 是提交成功之后要做的事（调微信发通知，见 notices.go）：事务里不调外部服务。冲突重来时这一次的作废。
	after []func(context.Context)
}

// dbFailure 是数据库出错时处理函数里 panic 的值，serveTx 据此回滚、重试或回 503。
type dbFailure struct{ err error }

func (f dbFailure) Error() string { return f.err.Error() }

func (q *txn) fail(err error) {
	if err != nil {
		panic(dbFailure{err})
	}
}

func newTxn(ctx context.Context, s *Server, tx pgx.Tx, write bool) *txn {
	return &txn{
		ctx: ctx, tx: tx, s: s, write: write,
		users:        newUserWorkset(),
		roles:        newWorkset[roleAssignment]("Roles", func(a *roleAssignment) string { return a.UserID }),
		areas:        newWorkset[FloorArea]("Areas", nil),
		tables:       newWorkset[Table]("Tables", nil),
		catalog:      newWorkset[catalogapp.Item]("Catalog", nil),
		stock:        newWorkset[inventoryItem]("Inventory", nil),
		purchases:    newWorkset[purchase]("Purchases", nil),
		movements:    newWorkset[movement]("Movements", nil),
		sessions:     newWorkset[TableSession]("Sessions", func(x *TableSession) string { return x.UserID }),
		orders:       newWorkset[Order]("Orders", func(o *Order) string { return o.UserID }),
		reservations: newWorkset[Reservation]("Reservations", func(x *Reservation) string { return x.AccountID }),
		calls:        newWorkset[ServiceCall]("ServiceCalls", func(c *ServiceCall) string { return c.AccountID }),
		idem:         newWorkset[idemResponse]("Idem", nil),
		member:       newMemberWorkset(),
		wechat:       map[string]string{},
		owners:       map[string]bool{},
		viewers:      map[string]*User{},
	}
}

type txnKey struct{}

func withTxn(ctx context.Context, q *txn) context.Context { return context.WithValue(ctx, txnKey{}, q) }

// txnOf 取请求的事务。事件流这类不在请求事务里的连接没有，返回 nil。
func txnOf(r *http.Request) *txn {
	q, _ := r.Context().Value(txnKey{}).(*txn)
	return q
}

// tx 取请求的事务；处理函数一定在 serveTx 里执行，没有就是接错了线。
func (s *Server) tx(r *http.Request) *txn {
	q := txnOf(r)
	if q == nil {
		panic("request is not running inside serveTx")
	}
	return q
}

// workset 是一类记录的工作集：读进来的、新建的，以及读入或上次写回时的 JSON（据此判断改没改）。
type workset[T any] struct {
	name   string
	items  map[string]*T
	order  []string
	clean  map[string][]byte
	owners map[string]string
	owner  func(*T) string
	// encode 把要写的记录拼成 records.SaveCollection 认得的快照形状；nil 时是 {name: {id: 记录}}。
	encode func(ids []string, items map[string]*T) ([]byte, error)
	// fingerprint 是判断改没改用的内容；nil 时就是记录本身的 JSON。账户另有不进 state 的列。
	fingerprint func(*T) ([]byte, error)
}

func newWorkset[T any](name string, owner func(*T) string) *workset[T] {
	return &workset[T]{name: name, items: map[string]*T{}, clean: map[string][]byte{}, owners: map[string]string{}, owner: owner}
}

func (w *workset[T]) print(v *T) ([]byte, error) {
	if w.fingerprint != nil {
		return w.fingerprint(v)
	}
	return json.Marshal(v)
}

func (w *workset[T]) ownerOf(v *T) string {
	if w.owner == nil || v == nil {
		return ""
	}
	return w.owner(v)
}

// adopt 把从库里读到的记录放进工作集。已经在工作集里的以工作集里的为准（查询前已写回，内容一致）。
func (w *workset[T]) adopt(q *txn, id string, v *T) *T {
	if existing, ok := w.items[id]; ok {
		return existing
	}
	w.items[id] = v
	w.order = append(w.order, id)
	if q.write {
		b, err := w.print(v)
		q.fail(err)
		w.clean[id] = b
		w.owners[id] = w.ownerOf(v)
	}
	return v
}

// add 登记一条新建的记录，写回时插入。
func (w *workset[T]) add(id string, v *T) *T {
	if _, ok := w.items[id]; ok {
		panic(fmt.Sprintf("%s %s added twice", w.name, id))
	}
	w.items[id] = v
	w.order = append(w.order, id)
	return v
}

// flush 写回改过和新建的记录。
func (w *workset[T]) flush(q *txn) {
	var ids []string
	prints := map[string][]byte{}
	for _, id := range w.order {
		b, err := w.print(w.items[id])
		q.fail(err)
		if old, ok := w.clean[id]; ok && bytes.Equal(old, b) {
			continue
		}
		ids = append(ids, id)
		prints[id] = b
	}
	if len(ids) == 0 {
		return
	}
	var doc []byte
	var err error
	if w.encode != nil {
		doc, err = w.encode(ids, w.items)
	} else {
		changed := make(map[string]*T, len(ids))
		for _, id := range ids {
			changed[id] = w.items[id]
		}
		doc, err = json.Marshal(map[string]any{w.name: changed})
	}
	q.fail(err)
	q.fail(records.SaveCollection(q.ctx, q.tx, w.name, doc))
	for _, id := range ids {
		if old, ok := w.owners[id]; ok && old != "" {
			q.owners[old] = true
		}
		owner := w.ownerOf(w.items[id])
		if owner != "" {
			q.owners[owner] = true
		}
		w.clean[id] = prints[id]
		w.owners[id] = owner
	}
}

// row 是查询读到的一条记录：主键和 state。
type row struct {
	id    string
	state []byte
}

// query 先写回工作集里改过的记录，再执行查询。结果的每一行是 (id::text, state)。
func (q *txn) query(sql string, args ...any) []row {
	q.flush()
	rows, err := q.tx.Query(q.ctx, sql, args...)
	q.fail(err)
	defer rows.Close()
	var out []row
	for rows.Next() {
		var r row
		q.fail(rows.Scan(&r.id, &r.state))
		out = append(out, r)
	}
	q.fail(rows.Err())
	return out
}

// load 执行查询（条件在运行时拼出来的那些），把读到的记录放进工作集，按查询的顺序返回工作集里的实例。
func load[T any](q *txn, w *workset[T], sql string, args ...any) []*T {
	return adoptRows(q, w, q.query(sql, args...))
}

// adoptRows 把读到的记录放进工作集，按读到的顺序返回工作集里的实例：已经在工作集里的以工作集里的为准
// （查询前已写回，内容一致）。
func adoptRows[T any](q *txn, w *workset[T], rows []row) []*T {
	out := make([]*T, 0, len(rows))
	for _, r := range rows {
		if existing, ok := w.items[r.id]; ok {
			out = append(out, existing)
			continue
		}
		v := new(T)
		q.fail(json.Unmarshal(r.state, v))
		out = append(out, w.adopt(q, r.id, v))
	}
	return out
}

// 固定写法的查询由 sqlc 生成（internal/storage/queries）。q.db() 先写回改过的记录再给出跑在请求事务上的
// 查询，must 取结果、数据库出错时 panic(dbFailure)，和手写的 q.query、q.fail 一样由 serveTx 接住。

// db 先写回工作集里改过的记录，再给出跑在这个请求事务上的固定查询：查到的总是最新的。
func (q *txn) db() *queries.Queries {
	q.flush()
	return queries.New(q.tx)
}

// dbWrite 同 db，给写语句用（撤销、作废、清理这类不经工作集的写入）：只读请求里写库是代码的错。
func (q *txn) dbWrite() *queries.Queries {
	if !q.write {
		panic("write statement in a read-only request")
	}
	return q.db()
}

// must 取一条固定查询的结果；数据库出错时 panic(dbFailure)，由 serveTx 接住（同 q.fail）。
func must[T any](v T, err error) T {
	if err != nil {
		panic(dbFailure{err})
	}
	return v
}

// stateRecord 是读完整记录的查询的结果形状：主键与 state（列名一律写成 id、state）。sqlc 给每条查询各生成
// 一个行类型，形状相同的都能转换成它。
type stateRecord interface {
	~struct {
		ID    string
		State []byte
	}
}

// stateRows 把 sqlc 读到的 (id, state) 行换成 row。
func stateRows[R stateRecord](rows []R) []row {
	out := make([]row, 0, len(rows))
	for _, r := range rows {
		rec := struct {
			ID    string
			State []byte
		}(r)
		out = append(out, row{id: rec.ID, state: rec.State})
	}
	return out
}

// adopt 把 sqlc 读到的记录放进工作集，按读到的顺序返回工作集里的实例（同 load）。
func adopt[T any, R stateRecord](q *txn, w *workset[T], rows []R) []*T {
	return adoptRows(q, w, stateRows(rows))
}

// loadOne 按主键读一条：先看工作集，没有再用 query 查库；不存在返回 nil。
func loadOne[T any, R stateRecord](q *txn, w *workset[T], id string, query func(*queries.Queries, context.Context, string) ([]R, error)) *T {
	if v, ok := w.items[id]; ok {
		return v
	}
	if !validID(id) {
		return nil
	}
	found := adopt(q, w, must(query(q.db(), q.ctx, id)))
	if len(found) == 0 {
		return nil
	}
	return found[0]
}

// scalar 执行一条只返回一个值的查询（计数、是否存在）。
func scalar[T any](q *txn, sql string, args ...any) T {
	q.flush()
	var v T
	q.fail(q.tx.QueryRow(q.ctx, sql, args...).Scan(&v))
	return v
}

// exec 执行一条不读结果的语句（撤销任命、作废会话这类不经工作集的写入）。
func (q *txn) exec(sql string, args ...any) {
	if !q.write {
		panic("write statement in a read-only request")
	}
	q.flush()
	_, err := q.tx.Exec(q.ctx, sql, args...)
	q.fail(err)
}

// flush 按被引用的在前的顺序写回全部改过和新建的记录。只读请求不写回。
func (q *txn) flush() {
	if !q.write {
		return
	}
	q.users.flush(q)
	if len(q.wechat) > 0 {
		doc, err := json.Marshal(map[string]any{"Wechat": q.wechat})
		q.fail(err)
		q.fail(records.SaveCollection(q.ctx, q.tx, "Wechat", doc))
		q.wechat = map[string]string{}
	}
	q.roles.flush(q)
	q.areas.flush(q)
	q.tables.flush(q)
	q.catalog.flush(q)
	q.stock.flush(q)
	q.purchases.flush(q)
	q.movements.flush(q)
	q.sessions.flush(q)
	q.calls.flush(q)
	q.orders.flush(q)
	q.reservations.flush(q)
	if q.settings != nil {
		b, err := json.Marshal(q.settings)
		q.fail(err)
		if !bytes.Equal(b, q.settingsClean) {
			doc, err := json.Marshal(map[string]any{"ReservationSettings": q.settings})
			q.fail(err)
			q.fail(records.SaveCollection(q.ctx, q.tx, "ReservationSettings", doc))
			q.settingsClean = b
		}
	}
	q.member.flush(q)
	if len(q.audits) > 0 {
		doc, err := json.Marshal(map[string]any{"Audits": q.audits})
		q.fail(err)
		q.fail(records.SaveCollection(q.ctx, q.tx, "Audits", doc))
		q.audits = nil
	}
	q.idem.flush(q)
}

// dirty 报告只读请求里有没有改了却写不回的记录（是代码的错：读接口不该改数据）。
func (q *txn) dirty() bool {
	return len(q.wechat) > 0 || len(q.audits) > 0
}

// eventChannel 是推送事件的 LISTEN/NOTIFY 频道。
const eventChannel = "pindou_events"

// maxNotifiedAccounts 以内逐个列出受影响的顾客；更多时改成发给全部顾客（NOTIFY 的内容上限 8000 字节）。
const maxNotifiedAccounts = 100

// notification 是 NOTIFY 的内容：哪个资源变了，影响到哪些顾客。扫码接力（Type 为 scan.relayed，见 scanrelay.go）
// 另带转给谁（To，员工账户）和扫到的码（Code），Resource 为空；滚动发布时旧版本照常把它当成资源事件推给员工，
// 只带 type 和空的 resource，客户端不认识就忽略，码不会被旧版本推出去。
type notification struct {
	Type      string   `json:"type"`
	Resource  string   `json:"resource"`
	Accounts  []string `json:"accounts,omitempty"`
	Customers bool     `json:"customers,omitempty"`
	To        string   `json:"to,omitempty"`
	Code      string   `json:"code,omitempty"`
}

// notify 在事务里登记一条推送：提交后才送到各个副本，回滚了就不发。
func (q *txn) notify(resource string) {
	n := notification{Type: "resource.updated", Resource: resource}
	if len(q.owners) > maxNotifiedAccounts {
		n.Customers = true
	} else {
		for account := range q.owners {
			n.Accounts = append(n.Accounts, account)
		}
		sort.Strings(n.Accounts)
	}
	payload, err := json.Marshal(n)
	q.fail(err)
	q.fail(queries.New(q.tx).Notify(q.ctx, queries.NotifyParams{Channel: eventChannel, Payload: string(payload)}))
}

// commit 写回改动、登记推送（publish 非空时）并提交。
func (q *txn) commit(publish string) {
	q.flush()
	if publish != "" {
		q.notify(publish)
	}
	q.fail(q.tx.Commit(q.ctx))
}

func (q *txn) rollback() {
	_ = q.tx.Rollback(context.WithoutCancel(q.ctx))
}

// now 是这次请求的时钟（测试会换成固定时间）。
func (q *txn) now() time.Time { return q.s.now() }

// writeTx 在一个写事务里执行 fn（启动时的布局校正、首位老板、测试夹具这类不经 HTTP 的写入）。
// fn 返回错误就回滚；数据库冲突时整个重来。不推送。
func (s *Server) writeTx(ctx context.Context, fn func(q *txn) error) error {
	for attempt := 1; ; attempt++ {
		err := s.writeOnce(ctx, fn)
		if err == nil || !storage.Retryable(err) || attempt >= maxAttempts {
			return err
		}
		sleepBeforeRetry(attempt)
	}
}

func (s *Server) writeOnce(ctx context.Context, fn func(q *txn) error) (err error) {
	tx, err := s.postgres.BeginWrite(ctx)
	if err != nil {
		return err
	}
	q := newTxn(ctx, s, tx, true)
	defer q.rollback()
	defer func() {
		if v := recover(); v != nil {
			f, ok := v.(dbFailure)
			if !ok {
				panic(v)
			}
			err = f.err
		}
	}()
	if err := fn(q); err != nil {
		return err
	}
	q.commit("")
	return nil
}
