package app

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	catalogapp "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/catalog/application"
	member "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/membership/application"
	"github.com/yreidev/pindou-studio/pindou-backend/internal/storetime"
)

// 规模测试：一家生意很好的店一整年的数据量（大约是实际的好几倍），看常用接口还快不快、两个副本同时写会不会出错。
// 平时不跑（灌数据要一两分钟）：PINDOU_SCALE_TEST=1 go test ./internal/app -run TestScaleOneYear -v
//
//	每天 100 单（3.65 万单、7 万多条明细、3.65 万笔付款）、5000 位顾客、2 万条会员流水、5000 多条预约、
//	4 万多条库存流水、15 万条审计。
func TestScaleOneYear(t *testing.T) {
	if os.Getenv("PINDOU_SCALE_TEST") == "" {
		t.Skip("规模测试：设 PINDOU_SCALE_TEST=1 时运行")
	}
	s := newTestServer(t)
	now := time.Date(2026, 10, 1, 15, 0, 0, 0, storetime.Location)
	s.now = func() time.Time { return now }
	yearAgo := now.AddDate(-1, 0, 0)
	owner := register(t, s, "scale-owner", "老板")
	if err := s.BootstrapOwner(owner.User.ID); err != nil {
		t.Fatal(err)
	}
	seeded := time.Now()
	data := seedYear(t, s, owner.User.ID, yearAgo, now)
	t.Logf("灌数据 %s：%s", time.Since(seeded).Round(time.Second), data.summary)

	// ---------- 常用接口的耗时 ----------
	type timing struct {
		name     string
		p50, p95 time.Duration
		limit    time.Duration
	}
	var timings []timing
	measure := func(name string, limit time.Duration, n int, do func(i int) int) {
		t.Helper()
		var spent []time.Duration
		for i := 0; i < n; i++ {
			started := time.Now()
			if status := do(i); status >= 300 {
				t.Fatalf("%s: status %d", name, status)
			}
			spent = append(spent, time.Since(started))
		}
		sort.Slice(spent, func(i, j int) bool { return spent[i] < spent[j] })
		timings = append(timings, timing{name, spent[len(spent)/2], spent[len(spent)*95/100], limit})
	}
	get := func(path string) func(int) int {
		return func(int) int { return call(t, s, http.MethodGet, path, owner.AccessToken, "", nil).Code }
	}
	const read = 150 * time.Millisecond
	measure("订单列表一页", read, 40, get("/api/v2/sales-orders?pageSize=20"))
	measure("订单关键字搜索", 300*time.Millisecond, 40, get("/api/v2/sales-orders?pageSize=20&q="+data.searchName))
	measure("单张订单", read, 40, func(i int) int {
		return call(t, s, http.MethodGet, "/api/v2/sales-orders/"+data.orders[i*97%len(data.orders)], owner.AccessToken, "", nil).Code
	})
	measure("桌位总览", read, 40, get("/api/v2/service-tables"))
	measure("进行中的计时", read, 40, get("/api/v2/venue-sessions?status=live"))
	measure("找顾客", read, 40, func(i int) int {
		return call(t, s, http.MethodGet, fmt.Sprintf("/api/v2/accounts?pageSize=20&q=%04d", i), owner.AccessToken, "", nil).Code
	})
	measure("会员列表一页（带余额）", read, 40, func(i int) int {
		return call(t, s, http.MethodGet, fmt.Sprintf("/api/v2/loyalty/members?pageSize=20&page=%d", 1+i*7), owner.AccessToken, "", nil).Code
	})
	measure("流水最多的会员", read, 40, get("/api/v2/loyalty/account?accountId="+data.busiestMember))
	measure("这一班的入座申请", read, 40, get("/api/v2/loyalty/shift"))
	measure("规则设置", read, 40, get("/api/v2/loyalty/settings"))
	measure("待处理的预约", read, 40, get("/api/v2/reservations/staff?scope=open"))
	measure("处理完的预约一页", read, 40, get("/api/v2/reservations/staff?scope=ended&pageSize=20&page=50"))
	measure("审计一页", read, 40, get("/api/v2/system/audit-events?pageSize=50&page=100"))
	measure("审计搜索", 400*time.Millisecond, 20, get("/api/v2/system/audit-events?pageSize=50&q="+data.orders[len(data.orders)/2][:8]))
	measure("库存流水一页", read, 40, get("/api/v2/stock-movements?pageSize=50&page=20"))
	measure("库存与商品", read, 40, get("/api/v2/stock-items"))
	measure("导出一个月的订单", 2*time.Second, 5, get("/api/v2/reports/exports/orders?from=2026-09-01&to=2026-09-30"))

	// 写：建单、加明细、收款，一整套
	var table = data.freeTables
	measure("开台到收款（4 个写请求）", 600*time.Millisecond, 20, func(i int) int {
		session := call(t, s, http.MethodPost, "/api/v2/venue-sessions", owner.AccessToken, id(), map[string]any{
			"serviceTableId": table[i%len(table)], "startedAt": now.Add(-time.Minute).Format(time.RFC3339), "timingMode": "free"})
		if session.Code != http.StatusCreated {
			return session.Code
		}
		sid := decodeMap(t, session)["id"].(string)
		order := call(t, s, http.MethodPost, "/api/v2/sales-orders", owner.AccessToken, id(), map[string]any{"venueSessionId": sid})
		if order.Code >= 300 {
			return order.Code
		}
		o := decodeMap(t, order)
		edited := call(t, s, http.MethodPatch, "/api/v2/sales-orders/"+o["id"].(string), owner.AccessToken, id(), map[string]any{
			"expectedVersion": o["version"], "lines": []map[string]any{{"productId": data.product, "name": "拼豆", "quantity": 2, "unitPriceCents": 1500}}})
		if edited.Code >= 300 {
			return edited.Code
		}
		e := decodeMap(t, edited)
		return call(t, s, http.MethodPost, "/api/v2/sales-orders/"+o["id"].(string)+"/payments", owner.AccessToken, id(), map[string]any{
			"expectedVersion": e["version"], "method": "cash", "amountCents": e["receivableCents"]}).Code
	})
	measure("会员充值", 300*time.Millisecond, 20, func(i int) int {
		return loyaltyCall(t, s, owner.AccessToken, loyaltyInput{Action: "recharge", TargetID: data.rechargeRule, AccountID: data.members[i], Method: "cash"}).Code
	})

	var report strings.Builder
	slow := 0
	for _, x := range timings {
		mark := ""
		if x.p95 > x.limit {
			mark, slow = "  ← 超过 "+x.limit.String(), slow+1
		}
		fmt.Fprintf(&report, "\n  %-22s p50 %6.1fms  p95 %6.1fms%s", x.name, ms(x.p50), ms(x.p95), mark)
	}
	t.Logf("一年数据量下的耗时（本机）：%s", report.String())
	if slow > 0 {
		t.Errorf("%d 个接口超过了预期", slow)
	}

	// ---------- 两个副本同时写 ----------
	// 16 个并发，一半落在另一个副本上：同一件热门商品的库存调整、各自的建单收款、会员充值，全部成功、库存一件不差。
	other := serverOn(t, s.postgres)
	other.now = s.now
	hot := data.hotStock
	before := stockOf(t, s, hot).Quantity
	var failed, adjustments atomic.Int64
	var wg sync.WaitGroup
	started := time.Now()
	const workers, rounds = 16, 15
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			replica := s
			if w%2 == 1 {
				replica = other
			}
			for r := 0; r < rounds; r++ {
				var status int
				switch r % 3 {
				case 0:
					status = call(t, replica, http.MethodPost, "/api/v2/stock-adjustments", owner.AccessToken, id(), map[string]any{"stockItemId": hot, "quantityDelta": 1, "reason": "盘点"}).Code
					if status == http.StatusCreated {
						adjustments.Add(1)
					}
				case 1:
					status = call(t, replica, http.MethodPost, "/api/v2/sales-orders", owner.AccessToken, id(), map[string]any{"accountId": data.members[(w*rounds+r)%len(data.members)]}).Code
				case 2:
					status = loyaltyCall(t, replica, owner.AccessToken, loyaltyInput{Action: "recharge", TargetID: data.rechargeRule, AccountID: data.members[(w*rounds+r)%len(data.members)], Method: "cash"}).Code
				}
				if status >= 300 {
					failed.Add(1)
					t.Errorf("concurrent write %d/%d: %d", w, r, status)
				}
			}
		}(w)
	}
	wg.Wait()
	elapsed := time.Since(started)
	t.Logf("两个副本 %d 个并发共 %d 个写请求：%s（%.0f 个/秒），失败 %d", workers, workers*rounds, elapsed.Round(time.Millisecond), float64(workers*rounds)/elapsed.Seconds(), failed.Load())
	if got := stockOf(t, s, hot).Quantity; got != before+adjustments.Load() {
		t.Fatalf("hot stock %d, want %d: a concurrent adjustment was lost", got, before+adjustments.Load())
	}
}

func ms(d time.Duration) float64 { return float64(d.Microseconds()) / 1000 }

type yearData struct {
	summary       string
	orders        []string
	members       []string
	busiestMember string
	searchName    string
	product       string
	hotStock      string
	rechargeRule  string
	freeTables    []string
}

// seedYear 用请求事务的工作集一批批写进去（走的是和线上一样的落库语句），不经 HTTP。
func seedYear(t *testing.T, s *Server, ownerID string, from, to time.Time) yearData {
	t.Helper()
	var d yearData
	const customers, perDay, productsCount = 5000, 100, 60
	// 24 张整桌：前 4 张承载一年的历史计时，其余给测写入时开台用（每次换一张，不撞占用）
	var busyTables []*Table
	for i := 1; i <= 24; i++ {
		table := seedTable(t, s, fmt.Sprintf("A%d", i), "大厅", i, 2, true)
		if i <= 4 {
			busyTables = append(busyTables, table)
		} else {
			d.freeTables = append(d.freeTables, table.ID)
		}
	}

	accounts := make([]string, customers)
	for batch := 0; batch < customers; batch += 1000 {
		edit(t, s, func(q *txn) {
			for i := batch; i < batch+1000; i++ {
				at := from.Add(time.Duration(i) * to.Sub(from) / customers)
				u := &User{ID: id(), Nickname: fmt.Sprintf("顾客%04d", i), Phone: fmt.Sprintf("139%08d", i), PhoneVerificationStatus: "unverified",
					Roles: []Role{}, CreatedAt: at, PrivacyContractVersion: "v1", PrivacyAcceptedAt: at}
				q.addUser(u)
				accounts[i] = u.ID
			}
		})
	}
	d.members = accounts[:200]
	d.busiestMember = accounts[0]

	products := make([]string, productsCount)
	stock := map[string]string{}
	edit(t, s, func(q *txn) {
		for i := range products {
			item := &catalogapp.Item{ID: id(), Name: fmt.Sprintf("拼豆材料包%02d", i), UnitPriceCents: int64(1000 + i*100)}
			q.addCatalogItem(item)
			products[i] = item.ID
			it := &inventoryItem{ID: id(), ProductID: item.ID, Quantity: 1_000_000, AlertAt: 10}
			q.addStockItem(it)
			stock[item.ID] = it.ID
		}
	})
	d.product, d.hotStock = products[0], stock[products[0]]
	d.searchName = "拼豆材料包07"

	days := int(to.Sub(from).Hours() / 24)
	orders, lines, movements, audits := 0, 0, 0, 0
	for day := 0; day < days; day++ {
		edit(t, s, func(q *txn) {
			for n := 0; n < perDay; n++ {
				at := from.AddDate(0, 0, day).Add(time.Duration(n) * 6 * time.Minute)
				stopped := at.Add(2 * time.Hour)
				account := ""
				if n%3 == 0 {
					account = accounts[(day*perDay+n)%customers]
				}
				session := &TableSession{ID: id(), TableID: busyTables[n%len(busyTables)].ID, UserID: account, Status: "settled",
					StartedAt: at, StoppedAt: &stopped, TimingMode: "timed", DurationMinutes: 120}
				q.addSession(session)
				p1, p2 := products[(day+n)%productsCount], products[(day*7+n)%productsCount]
				o := &Order{ID: id(), TableSessionID: session.ID, UserID: account, Status: "paid", CreatedAt: at,
					Lines: []OrderLine{{Name: "手作 2 小时", Quantity: 1, UnitPriceCents: 6800}, {ProductID: p1, Name: "拼豆材料包", Quantity: 1, UnitPriceCents: 1500}, {ProductID: p2, Name: "拼豆材料包", Quantity: 2, UnitPriceCents: 1200}}}
				o.ReceivableCents = 6800 + 1500 + 2400
				o.PaidCents = o.ReceivableCents
				o.Payments = []Payment{{ID: id(), Method: "cash", AmountCents: o.ReceivableCents, CreatedAt: stopped}}
				q.addOrder(o)
				d.orders = append(d.orders, o.ID)
				orders, lines = orders+1, lines+3
				for _, p := range []string{p1, p2} {
					q.addMovementRecord(&movement{ID: id(), InventoryItemID: stock[p], Kind: "sale", Reason: o.ID, QuantityDelta: -1, CreatedAt: stopped, ActorID: ownerID})
					movements++
				}
				for _, action := range []string{"session.created", "order.created", "order.updated", "payment.created"} {
					q.audits = append(q.audits, &auditLog{ID: id(), ActorID: ownerID, Action: action, ObjectID: o.ID, RequestID: id(), CreatedAt: at})
					audits++
				}
			}
		})
	}

	// 会员：200 位常客，每人每月充值一次、到店消费几次（流水最多的那位每天都来）
	recharge := publishRule(t, s, loginWith(t, s, "scale-owner"), member.Rule{Kind: "recharge", Name: "充 500 送 50", AmountCents: 50000, GiftCents: 5000, Points: 500, ValidDays: 365})
	d.rechargeRule = recharge.ID
	entries := 0
	for i, account := range d.members {
		visits := 100
		if i == 0 {
			visits = 365
		}
		var batch []member.Entry
		for v := 0; v < visits; v++ {
			at := from.Add(time.Duration(v) * to.Sub(from) / time.Duration(visits))
			expires := at.AddDate(1, 0, 0)
			if v%8 == 0 {
				batch = append(batch, member.Entry{ID: id(), AccountID: account, Kind: "recharge", SourceID: id(), Method: "cash", PrincipalCents: 50000, GiftCents: 5000,
					Points: []member.PointChange{{LotID: id(), Delta: 500, ExpiresAt: &expires}}, CreatedAt: at})
			} else {
				batch = append(batch, member.Entry{ID: id(), AccountID: account, Kind: "checkout", SourceID: d.orders[(i*visits+v)%len(d.orders)], PrincipalCents: -3000, CreatedAt: at})
			}
		}
		edit(t, s, func(q *txn) {
			for _, e := range batch {
				state, err := json.Marshal(e)
				if err != nil {
					t.Fatal(err)
				}
				q.exec(`INSERT INTO membership_entries(id,account_id,kind,principal_cents,gift_cents,created_at,state) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
					e.ID, e.AccountID, e.Kind, e.PrincipalCents, e.GiftCents, e.CreatedAt, state)
			}
		})
		entries += len(batch)
	}

	// 预约：每天 15 个，几乎都处理完了；最近有 20 个待处理的
	reservations := 0
	pack := publishRule(t, s, loginWith(t, s, "scale-owner"), member.Rule{Kind: "package", Name: "两小时", AmountCents: 6800, DurationMinutes: 120, RenewalMinutes: 60, RenewalCents: 2000, PauseLimitMinutes: 10, Overtime: "manual"})
	statuses := []string{"seated", "seated", "seated", "cancelled", "no_show"}
	for day := 0; day < days; day += 30 {
		edit(t, s, func(q *txn) {
			for n := 0; n < 30*15 && day+n/15 < days; n++ {
				start := from.AddDate(0, 0, day+n/15).Add(time.Duration(n%15) * 30 * time.Minute)
				status := statuses[n%len(statuses)]
				if day+n/15 >= days-2 {
					status = []string{"pending", "confirmed"}[n%2]
				}
				q.addReservation(&Reservation{ID: id(), AccountID: accounts[n%customers], TableID: d.freeTables[n%len(d.freeTables)], SeatNumber: 1, PackageID: pack.ID, PackageName: pack.Name,
					DurationMinutes: 120, AmountCents: 6800, StartAt: start, Status: status, CreatedBy: ownerID, CreatedAt: start.Add(-24 * time.Hour)})
				reservations++
			}
		})
	}
	d.summary = fmt.Sprintf("%d 位顾客、%d 单（%d 条明细）、%d 条库存流水、%d 条审计、%d 条会员流水、%d 个预约",
		customers, orders, lines, movements, audits, entries, reservations)
	return d
}
