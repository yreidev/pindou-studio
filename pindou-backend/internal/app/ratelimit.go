package app

import (
	"context"
	"log/slog"
	"math/rand/v2"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/yreidev/pindou-studio/pindou-backend/internal/storage/queries"
)

// The unauthenticated identity endpoints are the only ones a stranger can reach,
// and each one spends a WeChat API call. A fixed window per client keeps a
// scripted flood from exhausting that quota or filling the account table, while
// staying far above what a real shop's phones produce.
const (
	identityRateLimit  = 30
	identityRateWindow = time.Minute
)

// allowRate 给 key 记一次（登录类接口的预算：每 rateWindow 至多 rateLimit 次），见 hitRate。
func (s *Server) allowRate(r *http.Request, key string) (bool, time.Duration) {
	return s.hitRate(r, key, s.rateLimit, s.rateWindow)
}

// hitRate 给 key 记一次，报告这次是否放行（每 window 至多 limit 次）、不放行时还要等多久。计数在
// rate_limit_windows 里，几个副本共用同一个窗口。数据库出错时放行（限流只是挡脚本刷接口，不能因为它让人
// 登录不了、叫不了店员）。
func (s *Server) hitRate(r *http.Request, key string, limit int, window time.Duration) (bool, time.Duration) {
	now := s.now()
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 5*time.Second)
	defer cancel()
	hit, err := queries.New(s.postgres.Pool()).HitRateLimit(ctx, queries.HitRateLimitParams{Key: key, ResetAt: now.Add(window), Now: now})
	if err != nil {
		slog.Error("rate limit check failed", "error", err.Error())
		return true, 0
	}
	// 过期的窗口没有用了，偶尔顺手清掉，表不会一直长。
	if rand.IntN(100) == 0 { //nolint:gosec // 抽样清理过期窗口，不涉及安全
		s.purgeRateWindows(ctx, now)
	}
	if int(hit.Count) > limit {
		return false, hit.ResetAt.Sub(now)
	}
	return true, 0
}

// purgeRateWindows 删掉一小时前就过期的限流窗口。
func (s *Server) purgeRateWindows(ctx context.Context, now time.Time) {
	_ = queries.New(s.postgres.Pool()).PurgeRateLimitWindows(ctx, now.Add(-time.Hour))
}

// clientKey 取限流用的访客地址。生产在 k3s 的 Traefik 后面（Service 的 externalTrafficPolicy 为 Local，
// 保留访客地址）：Traefik 丢掉不受信来源自带的 X-Real-Ip、X-Forwarded-For，再按真实来源设置 X-Real-Ip，
// 所以这里信它。换代理或改信任列表时要核对这一点，否则任何人都能伪造头绕开限流。
// 直连（开发）时退回 RemoteAddr。
func clientKey(r *http.Request) string {
	if real := strings.TrimSpace(r.Header.Get("X-Real-IP")); real != "" {
		return real
	}
	if forwarded := r.Header.Get("X-Forwarded-For"); forwarded != "" {
		if first := strings.TrimSpace(strings.Split(forwarded, ",")[0]); first != "" {
			return first
		}
	}
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return host
	}
	return r.RemoteAddr
}

// throttled writes the 429 response and reports whether the request was
// rejected. A rejected request never reaches a handler, so it changes no state.
// 只有登记时包了 rateLimited 的接口（routes.go）才走这里：未登录就能调的注册、微信登录、发扫码登录挑战，
// 以及每次都会调一次微信的网页登录码（不能让人拿着一张 pollToken 刷微信的额度）。其余接口都要先登录，
// 而令牌只能经这几个接口拿到。
func (s *Server) throttled(w http.ResponseWriter, r *http.Request) bool {
	if s.rateLimit <= 0 {
		return false
	}
	allowed, retryAfter := s.allowRate(r, clientKey(r))
	if allowed {
		return false
	}
	s.tooManyRequests(w, r, retryAfter)
	return true
}

// tooManyRequests 回 429 rate_limited，Retry-After 是还要等的秒数。
func (s *Server) tooManyRequests(w http.ResponseWriter, r *http.Request, retryAfter time.Duration) {
	seconds := int(retryAfter/time.Second) + 1
	w.Header().Set("Retry-After", strconv.Itoa(seconds))
	s.writeError(w, r, http.StatusTooManyRequests, "rate_limited", errTooManyRequests)
}

// accountLimited 先按登录账户限流（name 区分各自的预算：每 window 至多 limit 次）再执行 h，被拦下的请求
// 碰不到处理函数、事务和业务数据。给登录后顾客自己就能反复点的写操作用（呼叫店员）：按账户计、不按来源，
// 店里的顾客连同一个 Wi-Fi，出口地址是同一个。没登录或认不出人的直接交给 h（它回 401）。
func (s *Server) accountLimited(name string, limit int, window time.Duration, h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if u, err := s.userFor(r); err == nil {
			if allowed, retryAfter := s.hitRate(r, name+":"+u.ID, limit, window); !allowed {
				s.tooManyRequests(w, r, retryAfter)
				return
			}
		}
		h(w, r)
	}
}
