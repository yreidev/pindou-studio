package app

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	catalogapp "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/catalog/application"
	member "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/membership/application"
	reserve "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/reservations/domain"
	"github.com/yreidev/pindou-studio/pindou-backend/internal/storage"
	"github.com/yreidev/pindou-studio/pindou-backend/internal/testdb"
)

// 测试一律连真实 PostgreSQL：每台测试服务一个从迁移好的模板复制来的独立库。

// migrated 是跑完全部迁移的模板：按迁移内容的摘要命名，迁移一变就建新模板。
var migrated = testdb.Migrations("goose-"+storage.MigrationsDigest(), storage.Migrate)

// newTestServer 是一台连着独立临时库的服务，推送监听已经连上。
func newTestServer(t *testing.T) *Server {
	t.Helper()
	db := newTestDatabase(t)
	return serverOn(t, db)
}

// newTestDatabase 是一个迁移好的独立临时库。
func newTestDatabase(t *testing.T) *storage.Postgres {
	t.Helper()
	_, db := newTestDatabaseAt(t)
	return db
}

// newTestDatabaseAt 同 newTestDatabase，另给出连接串（测试要另开连接直接查库时用）。
func newTestDatabaseAt(t *testing.T) (string, *storage.Postgres) {
	t.Helper()
	dsn := testdb.Prepared(t, migrated)
	db, err := storage.Open(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(db.Close)
	return dsn, db
}

// serverOn 是连着 db 的又一台服务：模拟同一个库上的另一个副本，或进程重启之后。
func serverOn(t *testing.T, db *storage.Postgres) *Server {
	t.Helper()
	s := NewServer(db)
	// 生产由 service.Run 配好（见 cmd/pindou-api）；/system/code-settings 按契约必须回一个地址
	s.ConfigureCustomerWebsite("https://pindou.example")
	ctx, cancel := context.WithCancel(context.Background())
	go s.ListenEvents(ctx)
	t.Cleanup(cancel)
	select {
	case <-s.Listening():
	case <-time.After(10 * time.Second):
		t.Fatal("event listener did not connect")
	}
	return s
}

// snapshotData 是库里当前的全部业务数据，测试据此核对「被拒的请求什么都没改」。
func (s *Server) snapshotData() []byte { return s.Snapshot() }

// edit 在一个写事务里改数据（造夹具、模拟库里已有的状态）。
func edit(t *testing.T, s *Server, fn func(q *txn)) {
	t.Helper()
	if err := s.writeTx(context.Background(), func(q *txn) error { fn(q); return nil }); err != nil {
		t.Fatal(err)
	}
}

// view 在一个只读事务里读数据。
func view[T any](t *testing.T, s *Server, fn func(q *txn) T) T {
	t.Helper()
	var out T
	if err := s.read(context.Background(), func(q *txn) { out = fn(q) }); err != nil {
		t.Fatal(err)
	}
	return out
}

func userOf(t *testing.T, s *Server, id string) *User {
	t.Helper()
	return view(t, s, func(q *txn) *User { return q.user(id) })
}

func orderOf(t *testing.T, s *Server, id string) *Order {
	t.Helper()
	return view(t, s, func(q *txn) *Order { return q.order(id) })
}

func sessionOf(t *testing.T, s *Server, id string) *TableSession {
	t.Helper()
	return view(t, s, func(q *txn) *TableSession { return q.session(id) })
}

func stockOf(t *testing.T, s *Server, id string) *inventoryItem {
	t.Helper()
	return view(t, s, func(q *txn) *inventoryItem { return q.stockItem(id) })
}

func reservationOf(t *testing.T, s *Server, id string) *Reservation {
	t.Helper()
	return view(t, s, func(q *txn) *Reservation { return q.reservation(id) })
}

// setRoles 直接改账户的有效角色（不经任命接口；和以前在内存里改 user.Roles 一样）。
func setRoles(t *testing.T, s *Server, id string, roles ...Role) {
	t.Helper()
	edit(t, s, func(q *txn) { q.user(id).Roles = roles })
}

// auditsOf 是全部审计，按写入先后。
func auditsOf(t *testing.T, s *Server) []*auditLog {
	t.Helper()
	return view(t, s, func(q *txn) []*auditLog {
		var out []*auditLog
		for _, r := range q.query(`SELECT id::text, state FROM audit_events ORDER BY seq`) {
			a := new(auditLog)
			q.fail(json.Unmarshal(r.state, a))
			out = append(out, a)
		}
		return out
	})
}

// movementsOf 是全部库存流水，按发生先后。
func movementsOf(t *testing.T, s *Server) []*movement {
	t.Helper()
	return view(t, s, func(q *txn) []*movement {
		return load(q, q.movements, `SELECT id::text, state FROM stock_ledger_entries ORDER BY created_at, id`)
	})
}

// idemOf 是记下的全部幂等结果，按键。
func idemOf(t *testing.T, s *Server) map[string]idemResponse {
	t.Helper()
	return view(t, s, func(q *txn) map[string]idemResponse {
		out := map[string]idemResponse{}
		for _, r := range q.query(`SELECT key, response FROM idempotency_keys`) {
			var v idemResponse
			q.fail(json.Unmarshal(r.state, &v))
			out[r.id] = v
		}
		return out
	})
}

// memberOf 是这位顾客的会员数据（全部流水、资料、申请，连同规则）。
func memberOf(t *testing.T, s *Server, account string) *member.State {
	t.Helper()
	return view(t, s, func(q *txn) *member.State { return q.memberAccount(account) })
}

// putAuth 直接发一张会话（不经登录接口）。
func putAuth(t *testing.T, s *Server, credential string, sess authSession) {
	t.Helper()
	edit(t, s, func(q *txn) { q.putAuthSession(identityKey(credential), sess) })
}

// hasAuth 报告这张令牌的会话是否还有效。
func hasAuth(t *testing.T, s *Server, credential string) bool {
	t.Helper()
	return view(t, s, func(q *txn) bool { _, ok := q.authSession(identityKey(credential)); return ok })
}

func stockByProductOf(t *testing.T, s *Server, product string) *inventoryItem {
	t.Helper()
	return view(t, s, func(q *txn) *inventoryItem { return q.stockByProduct(product) })
}

func lastAudit(t *testing.T, s *Server) *auditLog {
	t.Helper()
	all := auditsOf(t, s)
	if len(all) == 0 {
		t.Fatal("no audit recorded")
	}
	return all[len(all)-1]
}

func tableOf(t *testing.T, s *Server, id string) *Table {
	t.Helper()
	return view(t, s, func(q *txn) *Table { return q.table(id) })
}

func settingsVersionOf(t *testing.T, s *Server) string {
	t.Helper()
	return view(t, s, s.settingsVersion)
}

func accountVersionOf(t *testing.T, s *Server, account string) string {
	t.Helper()
	return view(t, s, func(q *txn) string { return s.accountVersion(q, account) })
}

// bearerAccount 是这张令牌所属的账户。
func bearerAccount(t *testing.T, s *Server, bearer string) string {
	t.Helper()
	return view(t, s, func(q *txn) string { sess, _ := q.authSession(identityKey(bearer)); return sess.UserID })
}

func ruleOf(t *testing.T, s *Server, ruleID string) (member.Rule, bool) {
	t.Helper()
	type found struct {
		rule member.Rule
		ok   bool
	}
	f := view(t, s, func(q *txn) found { r, ok := q.membership().Rule(ruleID); return found{r, ok} })
	return f.rule, f.ok
}

func sessionsOf(t *testing.T, s *Server) []*TableSession {
	t.Helper()
	return view(t, s, func(q *txn) []*TableSession {
		return load(q, q.sessions, `SELECT id::text, state FROM venue_sessions ORDER BY started_at, id`)
	})
}

func ordersOf(t *testing.T, s *Server) []*Order {
	t.Helper()
	return view(t, s, func(q *txn) []*Order { o, _ := q.ordersPage("", "", "", 1, 0); return o })
}

// orderOfSession 是这个计时会话的第一张订单。
func orderOfSession(t *testing.T, s *Server, session string) *Order {
	t.Helper()
	return view(t, s, func(q *txn) *Order { return q.ordersOfSessions([]string{session})[session] })
}

// tableViewOf 是员工端桌位列表里这张桌的视图。
func tableViewOf(t *testing.T, s *Server, tableID string) map[string]any {
	t.Helper()
	return view(t, s, func(q *txn) map[string]any { return s.tableViews(q, []*Table{q.table(tableID)})[0] })
}

func activeRolesOf(t *testing.T, s *Server) []*roleAssignment {
	t.Helper()
	return view(t, s, func(q *txn) []*roleAssignment { return q.activeRoles() })
}

// failWrites 让数据库在写 table 时报错（模拟磁盘满这类数据库一侧的故障，可重试），返回撤销它的函数。
func failWrites(t *testing.T, s *Server, table string) func() {
	t.Helper()
	ctx := context.Background()
	if _, err := s.postgres.Pool().Exec(ctx, `CREATE OR REPLACE FUNCTION simulated_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated failure' USING ERRCODE = 'disk_full'; END $$`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.postgres.Pool().Exec(ctx, `CREATE TRIGGER simulated_failure BEFORE INSERT OR UPDATE ON `+table+` FOR EACH ROW EXECUTE FUNCTION simulated_failure()`); err != nil {
		t.Fatal(err)
	}
	return func() {
		if _, err := s.postgres.Pool().Exec(ctx, `DROP TRIGGER simulated_failure ON `+table); err != nil {
			t.Fatal(err)
		}
	}
}

func reservationSettingsOf(t *testing.T, s *Server) reserve.Settings {
	t.Helper()
	return view(t, s, func(q *txn) reserve.Settings { return *q.reservationSettings() })
}

// admissionOf 是这条入座申请（连同申请人的会员数据一起读）。
func admissionOf(t *testing.T, s *Server, id string) member.Admission {
	t.Helper()
	return view(t, s, func(q *txn) member.Admission { a, _ := q.admission(id); return a })
}

func tablesOf(t *testing.T, s *Server) []*Table {
	t.Helper()
	return view(t, s, func(q *txn) []*Table { return q.allTables() })
}

func areasOf(t *testing.T, s *Server) []*FloorArea {
	t.Helper()
	return view(t, s, func(q *txn) []*FloorArea { return q.allAreas() })
}

// tableByCode 是布局编码为 code 的桌，没有返回 nil。
func tableByCode(t *testing.T, s *Server, code string) *Table {
	t.Helper()
	for _, table := range tablesOf(t, s) {
		if table.Code == code {
			return table
		}
	}
	return nil
}

// sessionCount 是库里的会话条数。
func sessionCount(t *testing.T, s *Server) int {
	t.Helper()
	return view(t, s, func(q *txn) int { return scalar[int](q, `SELECT count(*) FROM auth_sessions`) })
}

// sessionClient 是这张令牌的会话是哪个客户端发的。
func sessionClient(t *testing.T, s *Server, credential string) string {
	t.Helper()
	return view(t, s, func(q *txn) string { sess, _ := q.authSession(identityKey(credential)); return sess.Client })
}

func catalogOf(t *testing.T, s *Server) []*catalogapp.Item {
	t.Helper()
	return view(t, s, func(q *txn) []*catalogapp.Item { return q.allCatalog() })
}

func purchasesOf(t *testing.T, s *Server) []*purchase {
	t.Helper()
	return view(t, s, func(q *txn) []*purchase { return q.purchasesBetween(time.Time{}, time.Time{}) })
}

// count 是这张表的行数。
func count(t *testing.T, s *Server, table string) int {
	t.Helper()
	return view(t, s, func(q *txn) int { return scalar[int](q, `SELECT count(*) FROM `+table) })
}

// authSessionOf 是这张令牌的会话（没有或已过期时是零值）。
func authSessionOf(t *testing.T, s *Server, credential string) authSession {
	t.Helper()
	return view(t, s, func(q *txn) authSession { sess, _ := q.authSession(identityKey(credential)); return sess })
}

// enableBilling 打开系统内收费（迁移 024 的门店开关，没有这一行时按关）：测结账、草稿单的用例要先打开，
// 否则确认入座、到店开台不建单。actor 是记成修改人的账户（要真实存在）。
func enableBilling(t *testing.T, s *Server, actor string) {
	t.Helper()
	edit(t, s, func(q *txn) { q.saveBilling(true, actor) })
}
