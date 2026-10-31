package app

import (
	"bufio"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

// 这里的客户端按 RFC 6455 直接读写字节，核对的是线上的帧，不经任何 WebSocket 库。

// openWebSocket 用 Authorization 头（小程序的做法）完成握手，返回可读的连接。
func openWebSocket(t *testing.T, server *httptest.Server, bearer string) (net.Conn, *bufio.Reader) {
	t.Helper()
	conn, reader, _ := handshake(t, server, "Authorization: Bearer "+bearer+"\r\n")
	return conn, reader
}

// handshake 发升级请求（extra 是附加的请求头，每行以 \r\n 结尾），要求回 101，返回连接和响应头。
func handshake(t *testing.T, server *httptest.Server, extra string) (net.Conn, *bufio.Reader, http.Header) {
	t.Helper()
	conn, err := net.Dial("tcp", strings.TrimPrefix(server.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	request := "GET /api/v2/event-streams HTTP/1.1\r\nHost: test\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
		"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n" + extra + "\r\n"
	if _, err := io.WriteString(conn, request); err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(conn)
	response, err := http.ReadResponse(reader, nil)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("websocket upgrade failed: %d", response.StatusCode)
	}
	if response.Header.Get("Sec-WebSocket-Accept") != "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=" {
		t.Fatalf("Sec-WebSocket-Accept=%q", response.Header.Get("Sec-WebSocket-Accept"))
	}
	return conn, reader, response.Header
}

// readFrame 读下一帧（2 秒内），返回首字节（FIN + opcode）和内容。
func readFrame(t *testing.T, conn net.Conn, reader *bufio.Reader) (byte, []byte, error) {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	var header [2]byte
	if _, err := io.ReadFull(reader, header[:]); err != nil {
		return 0, nil, err
	}
	if header[1]&0x80 != 0 {
		t.Fatal("server frames must not be masked")
	}
	length := int64(header[1] & 0x7f)
	switch length {
	case 126:
		var ext [2]byte
		if _, err := io.ReadFull(reader, ext[:]); err != nil {
			return 0, nil, err
		}
		length = int64(binary.BigEndian.Uint16(ext[:]))
	case 127:
		t.Fatal("unexpected 64-bit frame length")
	}
	payload := make([]byte, length)
	_, err := io.ReadFull(reader, payload)
	return header[0], payload, err
}

// readFrameHeader 读出下一帧的首字节（FIN + opcode），跳过帧内容。
func readFrameHeader(t *testing.T, conn net.Conn, reader *bufio.Reader) (byte, error) {
	t.Helper()
	first, _, err := readFrame(t, conn, reader)
	return first, err
}

// writeClientFrame 发一帧客户端消息（客户端发的帧必须加掩码）。
func writeClientFrame(t *testing.T, conn net.Conn, first byte, payload []byte) {
	t.Helper()
	mask := [4]byte{1, 2, 3, 4}
	frame := []byte{first, 0x80 | byte(len(payload))}
	frame = append(frame, mask[:]...)
	for i, b := range payload {
		frame = append(frame, b^mask[i%4])
	}
	if _, err := conn.Write(frame); err != nil {
		t.Fatal(err)
	}
}

// expectClosed 读到服务端的关闭帧（状态码 code）或连接被关为止；2 秒内什么都没有就失败。
func expectClosed(t *testing.T, conn net.Conn, reader *bufio.Reader, code uint16, why string) {
	t.Helper()
	for {
		first, payload, err := readFrame(t, conn, reader)
		if errors.Is(err, os.ErrDeadlineExceeded) {
			t.Fatal(why)
		}
		if err != nil {
			return
		}
		if first == 0x88 {
			if len(payload) < 2 || binary.BigEndian.Uint16(payload) != code {
				t.Fatalf("close frame %v, want status %d", payload, code)
			}
			return
		}
	}
}

// 关停时事件流必须自己退出：WebSocket 已被接管，Shutdown 管不到；SSE 一直在推送，
// Shutdown 会一直等到超时。WebSocket 收到 1001（going away），客户端重连到别的副本。
func TestCloseEventsEndsStreams(t *testing.T) {
	s := newTestServer(t)
	owner := register(t, s, "close-events-owner", "Owner")
	if err := s.BootstrapOwner(owner.User.ID); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(s)
	defer server.Close()

	request, _ := http.NewRequest(http.MethodGet, server.URL+"/api/v2/event-streams", nil)
	request.Header.Set("Authorization", "Bearer "+owner.AccessToken)
	sse, err := http.DefaultClient.Do(request) //nolint:bodyclose // 由下面的 defer stream.Close() 关闭；body 交给 goroutine 读，linter 认不出
	if err != nil {
		t.Fatal(err)
	}
	stream := sse.Body
	defer stream.Close()
	if sse.StatusCode != http.StatusOK {
		t.Fatalf("event stream status=%d", sse.StatusCode)
	}
	if _, err := bufio.NewReader(stream).ReadString('\n'); err != nil {
		t.Fatal(err)
	}
	ws, wsReader := openWebSocket(t, server, owner.AccessToken)
	waitForSubscribers(t, s, 2)

	s.CloseEvents()
	ended := make(chan struct{})
	go func() { _, _ = io.Copy(io.Discard, stream); close(ended) }()
	expectClosed(t, ws, wsReader, 1001, "websocket kept running after CloseEvents")
	select {
	case <-ended:
	case <-time.After(3 * time.Second):
		t.Fatal("SSE stream kept running after CloseEvents")
	}
}

// 店里安静时代理会切断空闲连接；心跳（Ping）让连接保持活着，并借机复查员工身份。
// 客户端回的 Pong 由服务端正常应答，连接照旧（以前手写的实现读到客户端的任何字节就断开）。
func TestWebSocketHeartbeatAndRevocation(t *testing.T) {
	s := newTestServer(t)
	s.heartbeat = 20 * time.Millisecond
	owner := register(t, s, "heartbeat-owner", "Owner")
	if err := s.BootstrapOwner(owner.User.ID); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(s)
	defer server.Close()
	conn, reader := openWebSocket(t, server, owner.AccessToken)

	first, ping, err := readFrame(t, conn, reader)
	if err != nil || first != 0x89 {
		t.Fatalf("first frame=%#x err=%v, want a heartbeat ping", first, err)
	}
	writeClientFrame(t, conn, 0x8A, ping) // FIN + pong
	if next, err := readFrameHeader(t, conn, reader); err != nil || next != 0x89 {
		t.Fatalf("after the pong: frame=%#x err=%v, want the next heartbeat", next, err)
	}

	setRoles(t, s, owner.User.ID)
	expectClosed(t, conn, reader, 1008, "connection stayed open after the staff role was revoked")
}

// 客户端只收不发：发来数据消息就断开连接。
func TestWebSocketClosesOnClientDataMessages(t *testing.T) {
	s := newTestServer(t)
	owner := ownerFixture(t, s)
	server := httptest.NewServer(s)
	defer server.Close()
	conn, reader := openWebSocket(t, server, owner.AccessToken)
	writeClientFrame(t, conn, 0x81, []byte("hello"))
	expectClosed(t, conn, reader, 1008, "connection stayed open after a client data message")
}

// 长连接不受 http.Server 的读写超时影响：接管连接前要清掉它们设的截止时间（生产写超时 60 秒），
// 否则连接到点就断。网页后台用子协议带令牌，服务端只回显 pindou.v1；带别的 Origin（小程序没有浏览器的
// Origin 语义）照样能连。
func TestWebSocketOutlivesServerTimeouts(t *testing.T) {
	s := newTestServer(t)
	s.heartbeat = 30 * time.Millisecond
	owner := ownerFixture(t, s)
	web := webSessionFor(t, s, owner)
	server := httptest.NewUnstartedServer(s)
	server.Config.ReadTimeout = 150 * time.Millisecond
	server.Config.WriteTimeout = 150 * time.Millisecond
	server.Start()
	defer server.Close()

	conn, reader, header := handshake(t, server, "Origin: https://servicewechat.com\r\nSec-WebSocket-Protocol: pindou.v1, bearer."+web+"\r\n")
	if got := header.Values("Sec-WebSocket-Protocol"); len(got) != 1 || got[0] != webSocketProtocol {
		t.Fatalf("Sec-WebSocket-Protocol=%q, want only %q", got, webSocketProtocol)
	}
	waitForSubscribers(t, s, 1)
	for deadline := time.Now().Add(600 * time.Millisecond); time.Now().Before(deadline); {
		if first, err := readFrameHeader(t, conn, reader); err != nil || first != 0x89 {
			t.Fatalf("heartbeat after the server timeouts: frame=%#x err=%v", first, err)
		}
	}
	s.hub.publish(map[string]string{"type": "resource.updated", "resource": "tables"}, nil, false)
	for {
		first, payload, err := readFrame(t, conn, reader)
		if err != nil {
			t.Fatalf("event after the server timeouts: %v", err)
		}
		if first == 0x81 {
			if string(payload) != `{"resource":"tables","type":"resource.updated"}` {
				t.Fatalf("event payload %s", payload)
			}
			return
		}
	}
}
