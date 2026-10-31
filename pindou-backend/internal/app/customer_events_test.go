package app

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	member "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/membership/application"
)

// 顾客端实时：顾客也连事件流，但只收自己名下数据变动的事件（订单、预约、会员资产、入座……），
// 看不到别人的动静；员工照旧收全店事件。

// readTextFrame 在 wait 内读下一帧文本，返回内容（跳过心跳 Ping）；超时返回 os.ErrDeadlineExceeded，
// 读到别的帧（比如关闭帧）返回错误。
func readTextFrame(t *testing.T, conn net.Conn, reader *bufio.Reader, wait time.Duration) (string, error) {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(wait))
	for {
		var header [2]byte
		if _, err := io.ReadFull(reader, header[:]); err != nil {
			return "", err
		}
		length := int(header[1] & 0x7f)
		if length == 126 {
			var ext [2]byte
			if _, err := io.ReadFull(reader, ext[:]); err != nil {
				return "", err
			}
			length = int(ext[0])<<8 | int(ext[1])
		}
		payload := make([]byte, length)
		if _, err := io.ReadFull(reader, payload); err != nil {
			return "", err
		}
		switch header[0] {
		case 0x81:
			return string(payload), nil
		case 0x89: // 心跳
			continue
		}
		return "", errors.New("not a text frame")
	}
}

// waitForSubscribers 等事件中心登记到 n 条连接：握手回 101 之后服务端才订阅，不等的话事件可能先发出去。
func waitForSubscribers(t *testing.T, s *Server, n int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		s.hub.mu.Lock()
		got := len(s.hub.clients)
		s.hub.mu.Unlock()
		if got >= n {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("only %d of %d event streams subscribed", got, n)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestCustomersOnlyReceiveEventsAboutTheirOwnRecords(t *testing.T) {
	s := newTestServer(t)
	owner := ownerFixture(t, s)
	alice := register(t, s, "events-alice", "Alice")
	bob := register(t, s, "events-bob", "Bob")
	server := httptest.NewServer(s)
	defer server.Close()
	staffConn, staffReader := openWebSocket(t, server, owner.AccessToken)
	aliceConn, aliceReader := openWebSocket(t, server, alice.AccessToken)
	bobConn, bobReader := openWebSocket(t, server, bob.AccessToken)
	waitForSubscribers(t, s, 3)

	// 给 Alice 开一张订单：Alice 和员工收到，Bob 收不到
	if w := call(t, s, http.MethodPost, "/api/v2/sales-orders", owner.AccessToken, "order-for-alice", map[string]any{"accountId": alice.User.ID}); w.Code != http.StatusCreated {
		t.Fatalf("create order: %d %s", w.Code, w.Body.String())
	}
	for name, stream := range map[string]struct {
		conn   net.Conn
		reader *bufio.Reader
	}{"staff": {staffConn, staffReader}, "alice": {aliceConn, aliceReader}} {
		if text, err := readTextFrame(t, stream.conn, stream.reader, 2*time.Second); err != nil || !strings.Contains(text, `"resource":"sales-orders"`) {
			t.Fatalf("%s: %q %v", name, text, err)
		}
	}
	if text, err := readTextFrame(t, bobConn, bobReader, 300*time.Millisecond); !errors.Is(err, os.ErrDeadlineExceeded) {
		t.Fatalf("bob saw someone else's order: %q %v", text, err)
	}

	// 散客订单不属于任何顾客：只有员工收到
	if w := call(t, s, http.MethodPost, "/api/v2/sales-orders", owner.AccessToken, "walk-in-order", map[string]any{}); w.Code != http.StatusCreated {
		t.Fatalf("walk-in order: %d %s", w.Code, w.Body.String())
	}
	if text, err := readTextFrame(t, staffConn, staffReader, 2*time.Second); err != nil || !strings.Contains(text, "sales-orders") {
		t.Fatalf("staff: %q %v", text, err)
	}
	if text, err := readTextFrame(t, aliceConn, aliceReader, 300*time.Millisecond); !errors.Is(err, os.ErrDeadlineExceeded) {
		t.Fatalf("alice saw a walk-in order: %q %v", text, err)
	}
}

// 顾客被任命为员工后，原来那条「只收自己」的连接要断开，客户端重连后改收全店事件。
func TestAStreamClosesWhenTheViewerBecomesStaff(t *testing.T) {
	s := newTestServer(t)
	owner := ownerFixture(t, s)
	alice := register(t, s, "events-promoted", "Alice")
	server := httptest.NewServer(s)
	defer server.Close()
	conn, reader := openWebSocket(t, server, alice.AccessToken)
	waitForSubscribers(t, s, 1)

	if w := call(t, s, http.MethodPost, "/api/v2/staff-role-assignments", owner.AccessToken, "", map[string]any{"accountId": alice.User.ID, "role": "clerk"}); w.Code != http.StatusCreated {
		t.Fatalf("assign clerk: %d %s", w.Code, w.Body.String())
	}
	for {
		if _, err := readTextFrame(t, conn, reader, 2*time.Second); err != nil {
			if errors.Is(err, os.ErrDeadlineExceeded) {
				t.Fatal("the customer-scoped stream stayed open after the promotion")
			}
			return
		}
	}
}

// 写回记录时自动收集受影响的顾客：新建、改动的记录归谁，记录换了主人时新旧两位都算。
// 推送据此挑接收者，不靠各个接口自己登记（接口几十个，漏登一个顾客就收不到更新）。
func TestWritesCollectTheAffectedAccounts(t *testing.T) {
	s := newTestServer(t)
	accounts := map[string]string{}
	for _, name := range []string{"a", "b", "c", "d", "e", "f", "g", "h", "i", "z"} {
		accounts[name] = register(t, s, "owners-"+name, name).User.ID
	}
	table := seedTable(t, s, "O1", "测试区", 1, 2, false)
	now := s.now()
	reservationID, orderID := id(), id()
	edit(t, s, func(q *txn) {
		q.addReservation(&Reservation{ID: reservationID, AccountID: accounts["d"], TableID: table.ID, SeatNumber: 1, StartAt: now.Add(time.Hour), DurationMinutes: 60, Status: "pending", CreatedAt: now})
		q.addOrder(&Order{ID: orderID, UserID: accounts["e"], Status: "draft", CreatedAt: now})
	})
	var got map[string]bool
	if err := s.writeTx(context.Background(), func(q *txn) error {
		m := q.memberAccount(accounts["a"], accounts["b"], accounts["f"])
		admission := member.Admission{ID: id(), AccountID: accounts["a"], TableID: table.ID, SeatNumber: 1, Status: "pending", CreatedAt: now}
		m.Admissions[admission.ID] = admission
		m.Profiles[accounts["b"]] = member.Profile{Birthday: "03-04", BirthdayYear: 2026}
		entry := member.Entry{ID: id(), AccountID: accounts["f"], Kind: "adjust", PrincipalCents: 100, CreatedAt: now, Points: []member.PointChange{}}
		m.Entries[entry.ID] = entry
		q.user(accounts["c"]).Nickname = "C2"
		q.addRole(&roleAssignment{ID: id(), UserID: accounts["g"], Role: Clerk, AssignedAt: now})
		q.reservation(reservationID).AccountID = accounts["h"]
		q.order(orderID).Status = "voided"
		q.addSession(&TableSession{ID: id(), TableID: table.ID, UserID: accounts["i"], SeatNumber: 2, Status: "active", StartedAt: now})
		q.flush()
		got = map[string]bool{}
		for account := range q.owners {
			got[account] = true
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	// a 入座申请、b 会员资料、c 账户资料、d/h 预约换了主人、e 订单、f 会员流水、g 员工任命、i 计时会话
	for _, name := range []string{"a", "b", "c", "d", "e", "f", "g", "h", "i"} {
		if !got[accounts[name]] {
			t.Errorf("%s should be notified: %v", name, got)
		}
	}
	if got[accounts["z"]] || got[""] || len(got) != 9 {
		t.Fatalf("unexpected accounts: %v", got)
	}
}
