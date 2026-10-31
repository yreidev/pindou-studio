package app

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

type hub struct {
	mu      sync.Mutex
	clients map[chan event]streamViewer
	// closed 在进程关停时关闭，事件流据此退出，不让长连接拖住关停。
	closed    chan struct{}
	closeOnce sync.Once
}

// event 是推给事件流的一条消息。accounts 是这次写入改动了哪些账户名下的记录（写回时自动收集，见 txn.owners）：
// 员工连接收全部事件，顾客连接只收 accounts 里有自己的——顾客只关心自己的订单、预约、会员资产和入座。
type event struct {
	payload  []byte
	accounts map[string]bool
	// customers 是发给全部顾客（受影响的人太多，或推送监听断开重连后让大家整体重读）。
	customers bool
	// to 不为空时这是一条扫码接力（scanrelay.go）：只给这位员工自己的网页连接，别人、小程序都不给。
	to string
}

// streamViewer 是一条事件流在建立连接时的身份。
type streamViewer struct {
	accountID string
	staff     bool
	// web 是网页后台的会话（client=web）连的：只有它收扫码接力。
	web bool
}

func (v streamViewer) wants(e event) bool {
	if e.to != "" {
		return v.web && v.accountID == e.to
	}
	return v.staff || e.customers || e.accounts[v.accountID]
}

func newHub() *hub {
	return &hub{clients: map[chan event]streamViewer{}, closed: make(chan struct{})}
}

func (h *hub) close() { h.closeOnce.Do(func() { close(h.closed) }) }

// CloseEvents 结束所有 SSE 与 WebSocket 事件流，供 http.Server.RegisterOnShutdown 调用。
func (s *Server) CloseEvents() { s.hub.close() }

func (h *hub) subscribe(viewer streamViewer) chan event {
	h.mu.Lock()
	defer h.mu.Unlock()
	ch := make(chan event, 32)
	h.clients[ch] = viewer
	return ch
}

func (h *hub) unsubscribe(ch chan event) {
	h.mu.Lock()
	delete(h.clients, ch)
	close(ch)
	h.mu.Unlock()
}

func (h *hub) publish(v any, accounts map[string]bool, customers bool) {
	b, _ := json.Marshal(v)
	h.deliver(event{payload: b, accounts: accounts, customers: customers})
}

// relay 把一条扫码接力只推给 account 的网页连接（见 scanrelay.go）。
func (h *hub) relay(account string, v any) {
	b, _ := json.Marshal(v)
	h.deliver(event{payload: b, to: account})
}

func (h *hub) deliver(e event) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch, viewer := range h.clients {
		if !viewer.wants(e) {
			continue
		}
		select {
		case ch <- e:
		default:
			// Events carry an invalidation hint; clients always re-read the
			// affected resource. If a slow client is full, discard its oldest
			// hint and retain the newest one instead of silently losing the
			// current update.
			select {
			case <-ch:
			default:
			}
			select {
			case ch <- e:
			default:
			}
		}
	}
}

// viewerFor 认出事件流的连接者。游客（没登录）不能连；员工收全店事件，顾客只收自己的；
// 网页后台的会话另收本人的扫码接力。
func (s *Server) viewerFor(r *http.Request) (streamViewer, error) {
	credential := bearerCredential(r)
	if credential == "" {
		return streamViewer{}, errUnauthorized
	}
	var viewer streamViewer
	var authErr error
	if err := s.read(r.Context(), func(q *txn) {
		u, err := s.userIn(q, r, credential)
		if err != nil {
			authErr = err
			return
		}
		sess, _ := q.authSession(identityKey(credential))
		viewer = streamViewer{accountID: u.ID, staff: hasRole(u, Clerk, Manager, Owner), web: sess.Client == clientWeb}
	}); err != nil {
		return streamViewer{}, err
	}
	return viewer, authErr
}

// stillViewing 在每次推送前复查身份：会话失效、换了账户或员工身份有变时连接要断开，
// 客户端按新身份重连——员工被撤后不能再收全店事件，顾客被任命后要改收全店事件。
func (s *Server) stillViewing(r *http.Request, viewer streamViewer) bool {
	current, err := s.viewerFor(r)
	return err == nil && current == viewer
}

// events 是 GET /event-streams：带 Upgrade: websocket 的握手升级成 WebSocket（小程序、网页后台），
// 否则回 SSE（诊断用）。两者推送的都是同样的 {type, resource}。
func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	viewer, e := s.viewerFor(r)
	if e != nil {
		s.writeError(w, r, 401, "unauthorized", e)
		return
	}
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") || r.Header.Get("Sec-WebSocket-Key") == "" {
		s.serveSSE(w, r, viewer)
		return
	}
	s.serveWebSocket(w, r, viewer)
}

// serveWebSocket 把连接升级成 WebSocket（github.com/coder/websocket），之后只由服务端推送：
// 有事件就发一条文本消息，空闲时按 s.heartbeat 发心跳。每次发之前重新核对身份：登录过期、员工被撤销或
// 身份有变后断开，客户端按新身份重连（员工被撤后不能再收全店事件，顾客被任命后要改收全店事件）。
func (s *Server) serveWebSocket(w http.ResponseWriter, r *http.Request, viewer streamViewer) {
	// http.Server 的 ReadTimeout、WriteTimeout 给这条连接设的截止时间，被接管后仍然有效，
	// 库也不会清：不清掉的话长连接到点（写 60 秒）就断。之后每次写各自带超时（见下面的 send）。
	controller := http.NewResponseController(w)
	_ = controller.SetReadDeadline(time.Time{})
	_ = controller.SetWriteDeadline(time.Time{})
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// 浏览器（网页后台）用子协议带令牌（pindou.v1, bearer.<令牌>），必须回显选中的子协议，否则浏览器会断开；
		// 只回显 pindou.v1，令牌不回显。小程序用 Authorization 头，不带子协议，也就不回显。
		Subprotocols: []string{webSocketProtocol},
		// 不核对 Origin（库默认拒绝跨源）：小程序的 WebSocket 没有浏览器的 Origin 语义，网页后台本来就同源；
		// 身份只认令牌（Authorization 头或子协议，不接受 Cookie），跨站页面拿不到令牌，伪造不了别人的连接。
		InsecureSkipVerify: true,
		// 事件很短，不协商 permessage-deflate（和以前一样）。
		CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		return // Accept 已经回了错误响应
	}
	defer func() { _ = conn.CloseNow() }()
	ch := s.hub.subscribe(viewer)
	defer s.hub.unsubscribe(ch)
	// 网页员工的连接报到：手机「扫码给电脑」据此知道电脑在线（scanrelay.go），断开时删掉
	presence := s.enterPresence(viewer)
	defer s.leavePresence(presence)
	// 客户端不发消息：CloseRead 只应答 Ping、Pong 和关闭帧，收到数据消息就断开连接（以前读到任何字节就断开）。
	// 连接断开时 ctx 结束。
	ctx := conn.CloseRead(context.Background())
	heartbeat := time.NewTicker(s.heartbeat)
	defer heartbeat.Stop()
	for {
		select {
		case e := <-ch:
			if !s.stillViewing(r, viewer) {
				_ = conn.Close(websocket.StatusPolicyViolation, "session changed")
				return
			}
			writeCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
			err := conn.Write(writeCtx, websocket.MessageText, e.payload)
			cancel()
			if err != nil {
				return
			}
		case <-heartbeat.C:
			if !s.stillViewing(r, viewer) {
				_ = conn.Close(websocket.StatusPolicyViolation, "session changed")
				return
			}
			s.renewPresence(presence, viewer.accountID)
			go heartbeatPing(ctx, conn, s.heartbeat)
		case <-ctx.Done():
			return
		case <-s.hub.closed:
			// 关停：发关闭帧（1001 going away），客户端重连到别的副本。
			_ = conn.Close(websocket.StatusGoingAway, "server shutting down")
			return
		}
	}
}

// heartbeatPing 发一次心跳 Ping，最多等 wait 收 Pong。
//
// ★ 收不到 Pong 不断开：心跳是为了让代理别把安静的连接当空闲切掉（服务端往外发就够了），
// 不拿它判断客户端死活——死连接靠写超时发现，和以前一样。微信真机会不会回 Pong 还没验证过，
// 万一不回，也不能让小程序每个心跳周期断一次、整页重读。
func heartbeatPing(ctx context.Context, conn *websocket.Conn, wait time.Duration) {
	ctx, cancel := context.WithTimeout(ctx, wait)
	defer cancel()
	_ = conn.Ping(ctx)
}

// webSocketHeartbeat 要短于代理的空闲超时（以前 Nginx 的 proxy_read_timeout 是 75 秒），否则店里安静时
// 代理会切断空闲连接，员工端每隔一分多钟就「重连中」一次并整页重读。
//
// ★ 心跳用 Ping，不用文本消息：小程序收到任何文本消息都会重读资源；Ping、Pong 是控制帧，
// 由客户端的 WebSocket 实现自己应答，页面收不到。（以前手写的实现读到客户端的任何字节就断开，
// 收不了 Pong，只好发单向的 Pong 当心跳；换成 coder/websocket 后读端会正常应答控制帧。）
const webSocketHeartbeat = 30 * time.Second
