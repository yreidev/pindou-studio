package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"runtime/debug"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/yreidev/pindou-studio/pindou-backend/internal/storage"
	"github.com/yreidev/pindou-studio/pindou-backend/internal/storetime"
	"github.com/yreidev/pindou-studio/pindou-backend/internal/webui"
)

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	defer s.recoverPanic(w, r)
	// Keep API responses safe when the service is exposed directly or through a
	// proxy that does not add these headers itself. These headers also apply to
	// error responses and the SSE diagnostics stream.
	setSecurityHeaders(w)
	if s.serveProbe(w, r) {
		return
	}
	// 响应不在这里压缩：由前面的 Traefik 做（deploy/k3s/pindou.yaml 的 compress 中间件）。
	// 每个请求只分配一次编号：错误响应、审计和日志里是同一个，客户端也能从响应头拿到
	if !validRequestID(r.Header.Get("X-Request-ID")) {
		r.Header.Set("X-Request-ID", id())
	}
	w.Header().Set("X-Request-ID", r.Header.Get("X-Request-ID"))
	// 接口以外的路径：顾客域名下只有微信校验文件和「请用微信扫码」那一页（customer_host.go）；别的域名交给
	// 员工网页后台的页面，只有配了页面（ServePages，本机开发和端到端）才有，生产的网页后台是单独的服务。
	// 不开事务、不限流。
	if !isAPIPath(r.URL.Path) {
		switch {
		case s.onCustomerHost(r):
			s.serveCustomerHost(w, r)
		case s.pages != nil:
			s.pages.ServeHTTP(w, r)
		default:
			http.NotFound(w, r)
		}
		return
	}
	// 接口只用这四种方法。
	switch r.Method {
	case http.MethodGet, http.MethodPost, http.MethodPatch, http.MethodDelete:
	default:
		w.Header().Set("Allow", "GET, POST, PATCH, DELETE")
		s.writeError(w, r, 405, "method_not_allowed", errMethodNotAllowed)
		return
	}
	// 按方法与路径分派（routes.go）。每条接口登记时写明了事务方式和限流。
	s.serveAPI(w, r)
}

// serveTx 在一个数据库事务里执行 next：写请求 SERIALIZABLE，冲突（串行化失败、死锁、唯一键冲突）时丢掉
// 这次的结果、整个请求重来；读请求是只读快照。响应先写进缓冲，提交成功才发给客户端——客户端看到成功，
// 数据就一定落了库。处理函数回 4xx/5xx 时回滚，什么都不留下。
//
// 写请求提交成功后经 LISTEN/NOTIFY 推送「publish 这个资源变了」，各副本再推给自己的事件流（publish 为空不推送：
// 登录、发挑战、网页轮询领会话这类只发凭证、不改业务数据的写入）。读请求不推送。
func (s *Server) serveTx(w http.ResponseWriter, r *http.Request, write bool, publish string, next http.HandlerFunc) {
	if !write {
		publish = ""
	}
	// 请求体先整个读出来：冲突重来时处理函数要从头再读一遍（上限与 decode 一致，超出的部分 decode 会报错）。
	body, err := io.ReadAll(io.LimitReader(r.Body, maxRequestBody+1))
	if err != nil {
		s.writeError(w, r, 400, "invalid_request", errors.New("请求内容读取失败，请重试"))
		return
	}
	for attempt := 1; ; attempt++ {
		buffer := newBufferedResponse()
		r.Body = io.NopCloser(bytes.NewReader(body))
		err := s.attempt(buffer, r, write, publish, next)
		if err == nil {
			buffer.flush(w)
			return
		}
		if storage.Retryable(err) && attempt < maxAttempts {
			sleepBeforeRetry(attempt)
			continue
		}
		slog.Error("request transaction failed", "requestId", requestID(r), "method", r.Method, "path", r.URL.Path, "attempts", attempt, "error", err.Error())
		if storage.Rejected(err) {
			// 数据库按约束拒收：重试不会好，不能让人「再试一次」
			s.writeError(w, r, 500, "persistence_rejected", errors.New("这次操作没有生效：数据没通过数据库的校验，请联系技术支持"))
			return
		}
		s.writeError(w, r, 503, "persistence_failed", errors.New("数据没能保存，请重试；若反复出现请联系技术支持"))
		return
	}
}

// maxAttempts 是一个写请求遇到冲突时最多执行几次。
const maxAttempts = 10

// sleepBeforeRetry 在第 attempt 次冲突后等一会儿再重来：等待随次数增长，再加一段随机，
// 同时冲突的几个请求不会又一起撞上。
func sleepBeforeRetry(attempt int) {
	base := time.Duration(attempt*attempt) * 5 * time.Millisecond
	time.Sleep(base + rand.N(base+time.Millisecond)) //nolint:gosec // 重试前等待的随机抖动，不涉及安全
}

// attempt 执行一次：返回 nil 表示 buffer 里就是要发给客户端的响应（成功已提交，失败已回滚）。
// 返回错误表示数据库出了问题，这次的响应作废。
func (s *Server) attempt(buffer *bufferedResponse, r *http.Request, write bool, publish string, next http.HandlerFunc) (err error) {
	// 客户端断开不能打断事务：提交途中被取消，库里可能已经提交而客户端只看到失败。
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), transactionTimeout)
	defer cancel()
	var tx pgx.Tx
	if write {
		tx, err = s.postgres.BeginWrite(ctx)
	} else {
		tx, err = s.postgres.BeginRead(ctx)
	}
	if err != nil {
		return err
	}
	q := newTxn(ctx, s, tx, write)
	defer q.rollback()
	defer func() {
		v := recover()
		if v == nil {
			return
		}
		if f, ok := v.(dbFailure); ok {
			err = f.err
			return
		}
		if isAbort(v) {
			panic(v)
		}
		// 处理函数自己出错：事务回滚，什么都不留下，回 500。没有全局锁可漏，进程照常服务。
		logPanic(r, v)
		*buffer = *newBufferedResponse()
		s.writeError(buffer, r, 500, "internal_error", errors.New("服务出错，这次操作没有生效，请重试"))
		err = nil
	}()
	next(buffer, r.WithContext(withTxn(r.Context(), q)))
	if buffer.status >= 300 {
		return nil
	}
	if !write {
		if q.dirty() {
			slog.Error("read request tried to change data", "requestId", requestID(r), "path", r.URL.Path)
		}
		return nil
	}
	q.commit(publish)
	s.runAfter(q.after)
	return nil
}

// transactionTimeout 是一个请求的事务最长能跑多久。
const transactionTimeout = 30 * time.Second

// read 在一个只读事务里执行 fn（事件流核对身份、先调微信的处理函数这类不在 serveTx 里的读取）。
func (s *Server) read(ctx context.Context, fn func(q *txn)) (err error) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), transactionTimeout)
	defer cancel()
	tx, err := s.postgres.BeginRead(ctx)
	if err != nil {
		return err
	}
	q := newTxn(ctx, s, tx, false)
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
	fn(q)
	return nil
}

// recoverPanic 兜住事务以外的 panic（网页后台的页面、事件流）：记日志，回 500。
func (s *Server) recoverPanic(w http.ResponseWriter, r *http.Request) {
	v := recover()
	if v == nil {
		return
	}
	if isAbort(v) {
		panic(v)
	}
	logPanic(r, v)
	s.writeError(w, r, 500, "internal_error", errors.New("服务出错，请稍后重试"))
}

// isAbort 是处理函数故意中止响应（http.ErrAbortHandler），交给 net/http 照常处理。
func isAbort(v any) bool {
	err, ok := v.(error)
	return ok && errors.Is(err, http.ErrAbortHandler)
}

func logPanic(r *http.Request, v any) {
	slog.Error("handler panic", "requestId", requestID(r), "method", r.Method, "path", r.URL.Path, "panic", fmt.Sprint(v), "stack", string(debug.Stack()))
}

func isAPIPath(path string) bool {
	return strings.HasPrefix(path, "/api/") || path == "/healthz" || path == "/readyz" || path == "/statusz"
}

// setSecurityHeaders 是接口和页面共用的安全响应头（webui.SetSecurityHeaders）：接口只回 JSON、事件流，
// CSP 什么都不放行；页面由各自的处理换成自己的 CSP。
func setSecurityHeaders(w http.ResponseWriter) { webui.SetSecurityHeaders(w) }

type bufferedResponse struct {
	header http.Header
	status int
	body   bytes.Buffer
}

func newBufferedResponse() *bufferedResponse {
	return &bufferedResponse{header: make(http.Header), status: 200}
}

func (w *bufferedResponse) Header() http.Header { return w.header }

func (w *bufferedResponse) WriteHeader(status int) { w.status = status }

func (w *bufferedResponse) Write(p []byte) (int, error) { return w.body.Write(p) }

func (w *bufferedResponse) flush(dst http.ResponseWriter) {
	for k, v := range w.header {
		dst.Header()[k] = append([]string(nil), v...)
	}
	dst.WriteHeader(w.status)
	_, _ = dst.Write(w.body.Bytes())
}

var (
	errUnauthorized    = errors.New("unauthorized")
	errTooManyRequests = errors.New("操作太频繁，请稍后再试")
	errForbidden       = errors.New("forbidden")
	errNotFound        = errors.New("not_found")
)

type apiError struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	RequestID string `json:"requestId"`
}

func (s *Server) writeError(w http.ResponseWriter, r *http.Request, status int, code string, err error) {
	rid := requestID(r)
	if status >= 500 {
		// 服务端错误都留日志，按 requestId 能和客户端看到的报错对上。路径不带查询参数（可能有手机尾号等）。
		slog.Error("request failed", "requestId", rid, "status", status, "code", code, "method", r.Method, "path", r.URL.Path, "error", err.Error())
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(apiError{Code: code, Message: err.Error(), RequestID: rid})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// maxRequestBody 是请求体的上限。
const maxRequestBody = 2 << 20

func decode(r *http.Request, v any) error {
	r.Body = http.MaxBytesReader(nil, r.Body, maxRequestBody)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return fmt.Errorf("invalid request: %w", err)
	}
	return nil
}

// validID 检查是不是 8-4-4-4-12 位十六进制的 UUID。这些值落库时要转成 uuid 列，
// 格式不对会让整次保存失败，所以进门就拒。
func validID(v string) bool {
	if len(v) != 36 {
		return false
	}
	for i, c := range v {
		if i == 8 || i == 13 || i == 18 || i == 23 {
			if c != '-' {
				return false
			}
		} else if (c < '0' || c > '9') && (c < 'a' || c > 'f') && (c < 'A' || c > 'F') {
			return false
		}
	}
	return true
}

func parseTime(v string) (time.Time, error) {
	t, e := time.Parse(time.RFC3339, v)
	if e != nil {
		return time.Time{}, fmt.Errorf("invalid time")
	}
	return t, nil
}

// startClockSkew 是员工设备时钟比服务器快时的容忍量。员工选「现在」开台时，旧版客户端带的是设备的当前时间，
// 设备只要比服务器快一两秒就成了「晚于当前时间」被拒——2026-10-06 生产服务器没开对时、慢了 2.2 秒，
// 网页上「现在」开台全被拒。晚于服务器时间但不超过这个量的按服务器的「现在」算；新客户端选「现在」时不传开始时间。
const startClockSkew = 2 * time.Minute

// sessionStart 校验员工给的开始时间并归一：比服务器时间晚 startClockSkew 以内的取服务器时间，其余照 validateStartedAt。
func sessionStart(now, started time.Time, u *User) (time.Time, error) {
	if started.After(now) && !started.After(now.Add(startClockSkew)) {
		started = now
	}
	return started, validateStartedAt(now, started, u)
}

func validateStartedAt(now, started time.Time, u *User) error {
	if started.After(now) {
		return errors.New("开始时间不能晚于当前时间")
	}
	if started.Before(now.Add(-60*time.Minute)) && !hasRole(u, Manager, Owner) {
		return errors.New("店员最多只能回填 60 分钟内的开始时间")
	}
	// 「今天」按门店时区算，两边都换算到门店时区再比第几天。
	//   2026-09-19 真机验收：曾按服务器时区算，客户端传 2026-09-19T10:46+08:00，服务器在美国、同一时刻
	//   还是 09-18，店长、老板在中国时间上午永远开不了台。后来改成按客户端传来的时区偏移算，
	//   又让人能用伪造的偏移（比如 -12:00）把「今天」往前挪出一天，回填超出范围的开始时间。
	day, today := started.In(storetime.Location), now.In(storetime.Location)
	if hasRole(u, Manager, Owner) && (day.Year() != today.Year() || day.YearDay() != today.YearDay()) {
		return errors.New("开始时间必须是今天")
	}
	return nil
}

// requestID 返回客户端给的请求号，没有或不合格时新生成一个。这个值会原样写进
// 永久保存、不可改写的审计，所以只接受不超过 64 个字符的字母、数字和 -_.:。
func requestID(r *http.Request) string {
	if x := r.Header.Get("X-Request-ID"); validRequestID(x) {
		return x
	}
	return id()
}

func validRequestID(v string) bool {
	if v == "" || len(v) > 64 {
		return false
	}
	for _, c := range v {
		if (c < 'a' || c > 'z') && (c < 'A' || c > 'Z') && (c < '0' || c > '9') && !strings.ContainsRune("-_.:", c) {
			return false
		}
	}
	return true
}

// readOnlyLoyaltyAction 认出 POST /loyalty/actions 里只算不写的动作（结账报价、规则计算示例）。它们不改任何数据，
// 走只读事务、不推送：推送会让各端重读，网页开着的计算示例又随重读再请求一次，循环不止。
// 读完请求体后原样放回，handler 照常解析与校验。
func readOnlyLoyaltyAction(r *http.Request) bool {
	body, err := io.ReadAll(io.LimitReader(r.Body, 2<<20+1))
	r.Body = io.NopCloser(bytes.NewReader(body))
	if err != nil {
		return false
	}
	var probe struct {
		Action string `json:"action"`
	}
	if json.Unmarshal(body, &probe) != nil {
		return false
	}
	return readOnlyLoyaltyActions[probe.Action]
}

var readOnlyLoyaltyActions = map[string]bool{"quote": true, "preview_rule": true, "refund_quote": true}
