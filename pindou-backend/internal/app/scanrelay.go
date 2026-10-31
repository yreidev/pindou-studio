package app

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/yreidev/pindou-studio/pindou-backend/internal/storage/queries"
)

// 手机当扫码枪（2026-10-06 业主决定）：员工在小程序「扫码给电脑」扫一维条码或会员码，结果经后端实时转给
// 同一员工账号此刻开着的网页后台（网页是这位员工用手机扫码登录的）。
//
//   - 只到本人的网页：经数据库 NOTIFY 送到各副本，每个副本只推给「网页会话、账户正是扫码的这位员工」的事件流连接，
//     不推给别人，也不推给小程序（见 hub.relay）。
//   - 码不落库：只在 NOTIFY 里走一次，不进业务表、不记审计；网页那一刻没连着就收不到，不补发——它本来就是
//     「当场扫、当场用」的输入，补发几分钟前扫的码反而会在网页上冒出一个过时的选择。
//   - 电脑在不在线：网页员工的事件流连接连上时在 web_presences 报到、每次心跳（30 秒）续期、断开时删掉
//     （UNLOGGED，同限流计数）。转码时这位员工有没过期的报到就算在线，否则回 409 computer_offline，什么也不发，
//     手机上说「电脑没在线」。进程崩了没删掉的报到最多再算 75 秒在线。
//   - 只有员工能用（网页后台本来就只给员工）。
const (
	scanRelayedType = "scan.relayed"
	// maxRelayedCode 是转码内容的上限（字符）：条码最多 64 位，会员码 20 位，二维码给足余量；NOTIFY 的内容上限是 8000 字节。
	maxRelayedCode = 256
)

var (
	errRelayCode       = errors.New("扫到的内容是空的、太长或含换行等控制字符，不能转给电脑")
	errComputerOffline = errors.New("电脑没在线：请先在电脑上打开网页后台（用这个账号扫码登录），再扫一次")
)

// scanRelayInput 是转码请求；omitzero 的用意同 loyaltyInput。
type scanRelayInput struct {
	Code string `json:"code,omitzero"`
}

// validRelayCode 报告扫到的内容能不能转：去掉首尾空白后不为空、不超长、是合法 UTF-8、不含控制字符。
func validRelayCode(code string) bool {
	if code == "" || !utf8.ValidString(code) || utf8.RuneCountInString(code) > maxRelayedCode {
		return false
	}
	return !strings.ContainsFunc(code, unicode.IsControl)
}

// relayScan 是 POST /scan-relays：把员工手机扫到的码转给本人开着的网页后台。
func (s *Server) relayScan(w http.ResponseWriter, r *http.Request) {
	u, ok := s.staffMember(w, r)
	if !ok {
		return
	}
	var in scanRelayInput
	if err := decode(r, &in); err != nil {
		s.writeError(w, r, 400, "invalid_request", err)
		return
	}
	code := strings.TrimSpace(in.Code)
	if !validRelayCode(code) {
		s.writeError(w, r, 400, "invalid_request", errRelayCode)
		return
	}
	q := s.tx(r)
	computers := must(q.db().CountWebPresences(q.ctx, queries.CountWebPresencesParams{AccountID: u.ID, ExpiresAt: q.now()}))
	if computers == 0 {
		s.writeError(w, r, 409, "computer_offline", errComputerOffline)
		return
	}
	q.relay(u.ID, code)
	writeJSON(w, 200, map[string]any{"computers": computers})
}

// relay 在事务里登记一条转码：提交后才经 NOTIFY 送到各副本，回滚了就不发。
func (q *txn) relay(account, code string) {
	payload, err := json.Marshal(notification{Type: scanRelayedType, To: account, Code: code})
	q.fail(err)
	q.fail(q.dbWrite().Notify(q.ctx, queries.NotifyParams{Channel: eventChannel, Payload: string(payload)}))
}

// presenceTTL 是一次报到管多久：两次心跳加 15 秒余量（心跳 30 秒时是 75 秒），心跳晚一点也不掉线。
func (s *Server) presenceTTL() time.Duration { return 2*s.heartbeat + 15*time.Second }

// enterPresence 给网页员工的事件流连接报到，返回这条连接的报到编号；别的连接（小程序、顾客）不报到，返回空串。
// 顺手清掉过期一小时以上的报到（进程崩了没来得及删的）。
func (s *Server) enterPresence(viewer streamViewer) string {
	if !viewer.web || !viewer.staff {
		return ""
	}
	connection := id()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = queries.New(s.postgres.Pool()).PurgeWebPresences(ctx, s.now().Add(-time.Hour))
	s.renewPresence(connection, viewer.accountID)
	return connection
}

// renewPresence 续一次报到（连上和每次心跳时）。写不进去（数据库一时不可用）只记日志：
// 转码会说电脑没在线，下次心跳再补上。不走请求事务：只是一行 UNLOGGED 的报到，同限流计数。
func (s *Server) renewPresence(connection, account string) {
	if connection == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err := queries.New(s.postgres.Pool()).PutWebPresence(ctx, queries.PutWebPresenceParams{
		ConnectionID: connection, AccountID: account, ExpiresAt: s.now().Add(s.presenceTTL()),
	})
	if err != nil {
		slog.Warn("web presence not recorded", "error", err.Error())
	}
}

// leavePresence 在连接断开时删掉报到。请求的 ctx 这时已经结束，另起一个。
func (s *Server) leavePresence(connection string) {
	if connection == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := queries.New(s.postgres.Pool()).DeleteWebPresence(ctx, connection); err != nil {
		slog.Warn("web presence not removed", "error", err.Error())
	}
}
