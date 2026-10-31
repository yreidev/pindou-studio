package app

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// 写请求的处理函数中途 panic：事务回滚，什么都没留下，回 500；进程照常服务（没有全局锁可漏）。
func TestPanickingWriteRollsBack(t *testing.T) {
	s := newTestServer(t)
	owner := register(t, s, "panic-owner", "老板")
	if err := s.BootstrapOwner(owner.User.ID); err != nil {
		t.Fatal(err)
	}
	before := s.snapshotData()
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/api/v2/sales-orders", nil)
	s.serveTx(w, r, true, "sales-orders", func(http.ResponseWriter, *http.Request) {
		q := s.tx(r)
		q.addOrder(&Order{ID: id(), Status: "draft", CreatedAt: s.now()})
		q.flush() // 已经写进事务了，panic 之后也要回滚掉
		panic("boom")
	})
	if w.Code != http.StatusInternalServerError || !strings.Contains(w.Body.String(), "internal_error") {
		t.Fatalf("panic response: %d %s", w.Code, w.Body.String())
	}
	if string(before) != string(s.snapshotData()) {
		t.Fatal("half-written state survived a panic")
	}
	if next := call(t, s, http.MethodPost, "/api/v2/sales-orders", owner.AccessToken, id(), map[string]any{}); next.Code != http.StatusCreated {
		t.Fatalf("server stopped working after a panic: %d %s", next.Code, next.Body.String())
	}
}

// 读接口 panic：记日志、回 500，不拖垮整个进程。
func TestPanickingReadAnswers500(t *testing.T) {
	s := newTestServer(t)
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/api/v2/sales-orders", nil)
	func() {
		defer s.recoverPanic(w, r)
		panic("read failed")
	}()
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("panic response: %d", w.Code)
	}
}

// 几个请求同时改同一件商品的库存（落在不同副本上也一样）：数据库发现冲突，输的那个整个重来，
// 每一笔都成功、一笔都不丢。以前靠进程里的全局写锁排队，现在靠 SERIALIZABLE 事务加重试。
func TestConcurrentWritesToOneRecordAreAllApplied(t *testing.T) {
	s := newTestServer(t)
	other := serverOn(t, s.postgres)
	owner := register(t, s, "concurrent-stock-owner", "老板")
	if err := s.BootstrapOwner(owner.User.ID); err != nil {
		t.Fatal(err)
	}
	product := decodeMap(t, call(t, s, http.MethodPost, "/api/v2/catalog-items", owner.AccessToken, id(), map[string]any{"name": "拼豆", "unitPriceCents": 100}))["id"].(string)
	item := &inventoryItem{ID: id(), ProductID: product, Quantity: 0}
	edit(t, s, func(q *txn) { q.addStockItem(item) })
	const writers = 8
	var wg sync.WaitGroup
	for i := 0; i < writers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			replica := s
			if i%2 == 1 {
				replica = other
			}
			w := call(t, replica, http.MethodPost, "/api/v2/stock-adjustments", owner.AccessToken, id(), map[string]any{"stockItemId": item.ID, "quantityDelta": 1, "reason": "盘点"})
			if w.Code != http.StatusCreated {
				t.Errorf("adjustment %d: %d %s", i, w.Code, w.Body.String())
			}
		}(i)
	}
	wg.Wait()
	if got := stockOf(t, s, item.ID).Quantity; got != writers {
		t.Fatalf("quantity %d, want %d: a concurrent write was lost", got, writers)
	}
	if got := len(movementsOf(t, s)); got != writers {
		t.Fatalf("movements %d, want %d", got, writers)
	}
}

// 数据库按约束拒收（说明应用层漏了校验）：重试也不会好，只执行一次，回 500 persistence_rejected，
// 不让人「再试一次」；数据库一侧的故障（磁盘满）仍回 503 persistence_failed。
func TestRejectedWritesAreNotRetried(t *testing.T) {
	s := newTestServer(t)
	owner := register(t, s, "rejected-owner", "老板")
	if err := s.BootstrapOwner(owner.User.ID); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	for _, sql := range []string{
		`CREATE SEQUENCE rejected_attempts`,
		`CREATE FUNCTION reject_order() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM nextval('rejected_attempts');
		 RAISE EXCEPTION 'order rejected' USING ERRCODE = 'check_violation'; END $$`,
		`CREATE TRIGGER reject_order BEFORE INSERT ON sales_orders FOR EACH ROW EXECUTE FUNCTION reject_order()`,
	} {
		if _, err := s.postgres.Pool().Exec(ctx, sql); err != nil {
			t.Fatal(err)
		}
	}
	w := call(t, s, http.MethodPost, "/api/v2/sales-orders", owner.AccessToken, id(), map[string]any{})
	if w.Code != http.StatusInternalServerError || decodeMap(t, w)["code"] != "persistence_rejected" {
		t.Fatalf("rejected write: %d %s", w.Code, w.Body.String())
	}
	var attempts int
	if err := s.postgres.Pool().QueryRow(ctx, `SELECT last_value FROM rejected_attempts`).Scan(&attempts); err != nil || attempts != 1 {
		t.Fatalf("rejected write ran %d times (%v), want once", attempts, err)
	}
	if _, err := s.postgres.Pool().Exec(ctx, `DROP TRIGGER reject_order ON sales_orders`); err != nil {
		t.Fatal(err)
	}
	restore := failWrites(t, s, "sales_orders")
	w = call(t, s, http.MethodPost, "/api/v2/sales-orders", owner.AccessToken, id(), map[string]any{})
	restore()
	if w.Code != http.StatusServiceUnavailable || decodeMap(t, w)["code"] != "persistence_failed" {
		t.Fatalf("database fault: %d %s", w.Code, w.Body.String())
	}
}
