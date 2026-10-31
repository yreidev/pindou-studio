package postgres_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/jackc/pgx/v5"
	records "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/persistence/infrastructure/postgres"
	"github.com/yreidev/pindou-studio/pindou-backend/internal/storage"
	"github.com/yreidev/pindou-studio/pindou-backend/internal/testdb"
)

const userID = "00000000-0000-4000-8000-000000000001"
const orderID = "00000000-0000-4000-8000-000000000006"
const productID = "00000000-0000-4000-8000-000000000005"
const reservationID = "00000000-0000-4000-8000-000000000013"

func fixture(t *testing.T) map[string]any {
	t.Helper()
	var state map[string]any
	err := json.Unmarshal([]byte(`{
 "Users":{"00000000-0000-4000-8000-000000000001":{"id":"00000000-0000-4000-8000-000000000001","nickname":"Test owner","phoneVerificationStatus":"unverified","roles":["owner"]}},
 "Phones":{"00000000-0000-4000-8000-000000000001":"test-only-phone"},
 "PrivateUsers":{"00000000-0000-4000-8000-000000000001":{"PrivacyContractVersion":"test-v1","PrivacyAcceptedAt":"2026-09-08T00:00:00Z","CreatedAt":"2026-09-08T00:00:00Z"}},
 "Wechat":{"test-identity":"00000000-0000-4000-8000-000000000001"},
 "Roles":{"00000000-0000-4000-8000-000000000002":{"ID":"00000000-0000-4000-8000-000000000002","UserID":"00000000-0000-4000-8000-000000000001","Role":"owner","AssignedAt":"2026-09-08T00:00:00Z"}},
 "Areas":{"00000000-0000-4000-8000-000000000003":{"id":"00000000-0000-4000-8000-000000000003","name":"Test area","gridColumns":8,"gridRows":8,"locked":true}},
 "Tables":{"00000000-0000-4000-8000-000000000004":{"ID":"00000000-0000-4000-8000-000000000004","AreaID":"00000000-0000-4000-8000-000000000003","Code":"A1","Number":1,"SeatCount":2,"Enabled":true,"WholeTable":true}},
 "Sessions":{"00000000-0000-4000-8000-000000000010":{"id":"00000000-0000-4000-8000-000000000010","serviceTableId":"00000000-0000-4000-8000-000000000004","accountId":"00000000-0000-4000-8000-000000000001","status":"settled","startedAt":"2026-09-08T00:00:00Z","durationMinutes":60,"timingMode":"timed","pausedSeconds":120}},
 "Catalog":{"00000000-0000-4000-8000-000000000005":{"id":"00000000-0000-4000-8000-000000000005","name":"Test beads","unitPriceCents":900}},
 "Orders":{"00000000-0000-4000-8000-000000000006":{"id":"00000000-0000-4000-8000-000000000006","accountId":"00000000-0000-4000-8000-000000000001","venueSessionId":"00000000-0000-4000-8000-000000000010","status":"paid","receivableCents":900,"paidCents":900,"createdAt":"2026-09-08T00:00:00Z","lines":[{"productId":"00000000-0000-4000-8000-000000000005","name":"Test beads","quantity":1,"unitPriceCents":900}],"payments":[{"id":"00000000-0000-4000-8000-000000000007","method":"cash","amountCents":900,"createdAt":"2026-09-08T00:00:00Z"}]}},
 "Inventory":{"00000000-0000-4000-8000-000000000008":{"ID":"00000000-0000-4000-8000-000000000008","ProductID":"00000000-0000-4000-8000-000000000005","Quantity":10,"AlertAt":2}},
 "Movements":{"00000000-0000-4000-8000-000000000009":{"ID":"00000000-0000-4000-8000-000000000009","InventoryItemID":"00000000-0000-4000-8000-000000000008","Kind":"purchase","QuantityDelta":10,"Reason":"test receipt","CreatedAt":"2026-09-08T00:00:00Z"}},
 "Purchases":{"00000000-0000-4000-8000-000000000011":{"ID":"00000000-0000-4000-8000-000000000011","SupplierName":"Test supplier","Note":"fixture","CreatedAt":"2026-09-08T00:00:00Z","Items":[{"productId":"00000000-0000-4000-8000-000000000005","quantity":10,"unitCostCents":500}]}},
 "Reservations":{"00000000-0000-4000-8000-000000000013":{"id":"00000000-0000-4000-8000-000000000013","accountId":"00000000-0000-4000-8000-000000000001","serviceTableId":"00000000-0000-4000-8000-000000000004","seatNumber":1,"packageId":"00000000-0000-4000-8000-000000000014","packageName":"Test package","durationMinutes":120,"amountCents":9900,"startAt":"2026-09-09T06:00:00Z","status":"seated","venueSessionId":"00000000-0000-4000-8000-000000000010","createdBy":"00000000-0000-4000-8000-000000000001","createdAt":"2026-09-08T00:00:00Z"}},
 "ReservationSettings":{"enabled":true,"openMinute":600,"closeMinute":1260,"slotMinutes":30,"advanceDays":7,"leadMinutes":60,"graceMinutes":20},
 "Audits":[],"Idem":{"test-key":{"Status":201,"Fingerprint":"test-fingerprint","Body":"e30="}}
 }`), &state)
	if err != nil {
		t.Fatal(err)
	}
	return state
}
func encoded(t *testing.T, state map[string]any) []byte {
	t.Helper()
	data, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	return data
}
func object(state map[string]any, group, id string) map[string]any {
	return state[group].(map[string]any)[id].(map[string]any)
}
func database(t *testing.T) *pgx.Conn {
	t.Helper()
	dsn := testdb.New(t)
	ctx := context.Background()
	db, err := storage.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	db.Close()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close(ctx) })
	return conn
}

// save 在一个事务里写入整份夹具（新库，第一次）。
func save(t *testing.T, conn *pgx.Conn, state map[string]any) error {
	t.Helper()
	ctx := context.Background()
	tx, err := conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if err = records.SaveAll(ctx, tx, encoded(t, state)); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// saveOnly 在一个事务里只写这几个集合（请求事务写回改动的记录就是这样）。
func saveOnly(t *testing.T, conn *pgx.Conn, state map[string]any, collections ...string) error {
	t.Helper()
	ctx := context.Background()
	tx, err := conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	for _, name := range collections {
		if err = records.SaveCollection(ctx, tx, name, encoded(t, state)); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
func load(t *testing.T, conn *pgx.Conn) map[string]any {
	t.Helper()
	ctx := context.Background()
	tx, err := conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	data, err := records.Load(ctx, tx)
	if err != nil {
		t.Fatal(err)
	}
	var state map[string]any
	if err = json.Unmarshal(data, &state); err != nil {
		t.Fatal(err)
	}
	return state
}

func TestSaveLoadRoundTripAndReplay(t *testing.T) {
	conn := database(t)
	state := fixture(t)
	if err := save(t, conn, state); err != nil {
		t.Fatal(err)
	}
	// 再写一遍可改写的集合（请求重试、或同一条记录先后被写两次）：不会多出付款、明细、流水。
	if err := saveOnly(t, conn, state, "Users", "Roles", "Areas", "Tables", "Catalog", "Inventory", "Purchases", "Movements", "Sessions", "Orders", "Reservations", "ReservationSettings"); err != nil {
		t.Fatal(err)
	}
	restored := load(t, conn)
	for _, key := range []string{"Users", "Phones", "Wechat", "Roles", "Areas", "Tables", "Sessions", "Reservations", "ReservationSettings", "Catalog", "Orders", "Inventory", "Purchases", "Movements", "Idem"} {
		a, _ := json.Marshal(state[key])
		b, _ := json.Marshal(restored[key])
		if string(a) != string(b) {
			t.Fatalf("%s failed lossless round trip", key)
		}
	}
	if object(restored, "PrivateUsers", userID)["PrivacyContractVersion"] != "test-v1" {
		t.Fatal("private account metadata was lost")
	}
	for _, table := range []string{"payment_records", "sales_order_lines", "stock_ledger_entries", "stock_receipts"} {
		var count int
		if err := conn.QueryRow(context.Background(), "SELECT count(*) FROM "+pgx.Identifier{table}.Sanitize()).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != 1 {
			t.Fatalf("replay duplicated %s", table)
		}
	}
	// Editing a catalog default must not change a paid order's price snapshot.
	object(state, "Catalog", productID)["unitPriceCents"] = 1200
	if err := saveOnly(t, conn, state, "Catalog", "Orders"); err != nil {
		t.Fatal(err)
	}
	var price int64
	if err := conn.QueryRow(context.Background(), "SELECT unit_price_cents FROM sales_order_lines").Scan(&price); err != nil {
		t.Fatal(err)
	}
	if price != 900 {
		t.Fatal("catalog update repriced historical sale")
	}
}

// 写入只碰 $1 里有的记录：没写到的记录原样留在库里（业务历史从不靠「不在快照里」删除）。
func TestSaveLeavesRecordsItDoesNotMention(t *testing.T) {
	conn := database(t)
	if err := save(t, conn, fixture(t)); err != nil {
		t.Fatal(err)
	}
	empty := map[string]any{}
	for _, group := range []string{"Users", "Areas", "Tables", "Sessions", "Reservations", "Orders", "Inventory", "Purchases", "Movements"} {
		empty[group] = map[string]any{}
	}
	if err := saveOnly(t, conn, empty, "Users", "Areas", "Tables", "Sessions", "Reservations", "Orders", "Inventory", "Purchases", "Movements"); err != nil {
		t.Fatal(err)
	}
	restored := load(t, conn)
	for _, group := range []string{"Users", "Areas", "Tables", "Sessions", "Reservations", "Orders", "Inventory", "Purchases", "Movements"} {
		if len(restored[group].(map[string]any)) != 1 {
			t.Fatalf("%s lost a record", group)
		}
	}
}

func TestImmutableFailureRollsBackEarlierMutableWrites(t *testing.T) {
	conn := database(t)
	state := fixture(t)
	if err := save(t, conn, state); err != nil {
		t.Fatal(err)
	}
	object(state, "Users", userID)["nickname"] = "must roll back"
	object(state, "Orders", orderID)["payments"].([]any)[0].(map[string]any)["amountCents"] = 800
	if err := saveOnly(t, conn, state, "Users", "Orders"); err == nil {
		t.Fatal("paid record rewrite accepted")
	}
	restored := load(t, conn)
	if object(restored, "Users", userID)["nickname"] != "Test owner" {
		t.Fatal("earlier mutable write survived transaction rollback")
	}
	if object(restored, "Orders", orderID)["payments"].([]any)[0].(map[string]any)["amountCents"] != float64(900) {
		t.Fatal("historical payment changed")
	}
}

func TestPaidOrderAcceptsOnlyAppendOnlyRefund(t *testing.T) {
	conn := database(t)
	state := fixture(t)
	if err := save(t, conn, state); err != nil {
		t.Fatal(err)
	}
	order := object(state, "Orders", orderID)
	order["refunds"] = []any{map[string]any{"id": "00000000-0000-4000-8000-000000000012", "reason": "test return", "amountCents": 100, "returnedProducts": map[string]any{productID: 1}, "createdAt": "2026-09-08T01:00:00Z"}}
	if err := saveOnly(t, conn, state, "Orders"); err != nil {
		t.Fatal(err)
	}
	if err := saveOnly(t, conn, state, "Orders"); err != nil {
		t.Fatal("same refund replay rejected:", err)
	}
	// 退回件数决定库存回补多少，重载后丢了就再也说不清这笔退款退了什么货。
	reloaded := object(load(t, conn), "Orders", orderID)["refunds"].([]any)[0].(map[string]any)
	if returned, ok := reloaded["returnedProducts"].(map[string]any); !ok || returned[productID] != float64(1) {
		t.Fatalf("returned quantities lost on reload: %v", reloaded)
	}
	delete(order, "refunds")
	if err := saveOnly(t, conn, state, "Orders"); err == nil {
		t.Fatal("existing refund could be erased")
	}
	var count int
	if err := conn.QueryRow(context.Background(), "SELECT count(*) FROM refund_records").Scan(&count); err != nil || count != 1 {
		t.Fatal("refund history not preserved")
	}
}

// 一次保存里草稿的明细变了又收了款（读草稿时计时明细按此刻重算、收款随请求保存）：明细要趁订单在库里还是草稿时写进去，
// 再改订单的状态，否则明细的触发器把它当成改已付订单的明细拒收。多出的行删掉、改了的行改掉；之后明细就不能再改了。
func TestDraftLinesChangeInTheSameSaveAsPayment(t *testing.T) {
	conn := database(t)
	state := fixture(t)
	order := object(state, "Orders", orderID)
	order["status"], order["paidCents"], order["receivableCents"] = "draft", 0.0, 2400.0
	delete(order, "payments")
	order["lines"] = []any{
		map[string]any{"name": "1小时", "quantity": 1, "unitPriceCents": 900},
		map[string]any{"name": "1小时 · 超时加收", "quantity": 1, "unitPriceCents": 1500},
		map[string]any{"name": "旧的一行", "quantity": 1, "unitPriceCents": 0},
	}
	if err := save(t, conn, state); err != nil {
		t.Fatal(err)
	}
	// 同一次保存：超时加收变 2 块、去掉第三行，并收了款
	order["lines"] = []any{
		map[string]any{"name": "1小时", "quantity": 1, "unitPriceCents": 900},
		map[string]any{"name": "1小时 · 超时加收", "quantity": 2, "unitPriceCents": 1500},
	}
	order["status"], order["paidCents"], order["receivableCents"] = "paid", 3900.0, 3900.0
	order["payments"] = []any{map[string]any{"id": "00000000-0000-4000-8000-000000000015", "method": "wechat", "amountCents": 3900, "createdAt": "2026-09-08T01:00:00Z"}}
	if err := saveOnly(t, conn, state, "Orders"); err != nil {
		t.Fatalf("明细与收款同一次保存：%v", err)
	}
	var lines, blocks int
	if err := conn.QueryRow(context.Background(), `SELECT count(*), max(quantity) FILTER (WHERE line_index = 2) FROM sales_order_lines WHERE sales_order_id = $1`, orderID).Scan(&lines, &blocks); err != nil || lines != 2 || blocks != 2 {
		t.Fatalf("明细按收款时的存下：%d 行，超时 %d 块，%v", lines, blocks, err)
	}
	order["lines"].([]any)[1].(map[string]any)["quantity"] = 3
	if err := saveOnly(t, conn, state, "Orders"); err == nil {
		t.Fatal("收款之后明细不能再改")
	}
}

// A reservation moves through its states in place, and each new state must
// survive the same reload path the rest of the business records use.
func TestReservationStatusAndSettingsSurviveReload(t *testing.T) {
	conn := database(t)
	state := fixture(t)
	if err := save(t, conn, state); err != nil {
		t.Fatal(err)
	}
	reservation := object(state, "Reservations", reservationID)
	reservation["status"] = "cancelled"
	reservation["reason"] = "顾客改期"
	delete(reservation, "venueSessionId")
	state["ReservationSettings"].(map[string]any)["enabled"] = false
	if err := saveOnly(t, conn, state, "Reservations", "ReservationSettings"); err != nil {
		t.Fatal(err)
	}
	restored := object(load(t, conn), "Reservations", reservationID)
	if restored["status"] != "cancelled" || restored["reason"] != "顾客改期" {
		t.Fatalf("reservation state was not reloaded: %v", restored)
	}
	if _, ok := restored["venueSessionId"]; ok {
		t.Fatal("cancelled reservation kept its venue session")
	}
	var linked *string
	if err := conn.QueryRow(context.Background(), "SELECT venue_session_id::text FROM reservations WHERE id=$1", reservationID).Scan(&linked); err != nil {
		t.Fatal(err)
	}
	if linked != nil {
		t.Fatal("typed column still points at the released session")
	}
	if load(t, conn)["ReservationSettings"].(map[string]any)["enabled"] != false {
		t.Fatal("reservation settings were not reloaded")
	}
}
