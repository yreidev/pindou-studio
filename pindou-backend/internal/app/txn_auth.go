package app

import (
	"errors"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/yreidev/pindou-studio/pindou-backend/internal/storage/queries"
)

// 登录会话存在 auth_sessions（只存令牌的 SHA-256），任何一个副本都能核对。

// authSession 按令牌哈希找登录会话；没有或已过期返回 false。
func (q *txn) authSession(hash string) (authSession, bool) {
	r, err := q.db().AuthSession(q.ctx, hash)
	if isNoRows(err) {
		return authSession{}, false
	}
	q.fail(err)
	// 已下线的顾客网页会话当没有：不能把它当成小程序会话、按真实任命给权限（滚动发布时旧版本还会发）
	if r.Client == retiredClientH5 {
		return authSession{}, false
	}
	sess := authSession{UserID: r.AccountID, DeveloperMode: r.DeveloperMode, ExpiresAt: r.ExpiresAt, Client: r.Client}
	if !q.now().Before(sess.ExpiresAt) {
		return authSession{}, false
	}
	return sess, true
}

// putAuthSession 发一张会话（与这次请求的其他写入同一事务）。
func (q *txn) putAuthSession(hash string, sess authSession) {
	client := sess.Client
	if client == "" {
		client = clientMiniapp
	}
	q.fail(q.dbWrite().PutAuthSession(q.ctx, queries.PutAuthSessionParams{
		TokenHash: hash, AccountID: sess.UserID, DeveloperMode: sess.DeveloperMode, ExpiresAt: sess.ExpiresAt, Client: client,
	}))
	q.owners[sess.UserID] = true
}

func (q *txn) deleteAuthSession(hash string) {
	q.fail(q.dbWrite().DeleteAuthSession(q.ctx, hash))
}

// deleteWebSessions 作废这位员工的全部网页会话，返回作废了几张。
func (q *txn) deleteWebSessions(account string) int64 {
	return must(q.db().DeleteSessionsOfClient(q.ctx, queries.DeleteSessionsOfClientParams{AccountID: account, Client: clientWeb}))
}

// purgeExpiredSessions 清掉过期的会话：它们再也用不上，表不会一直长。
func (q *txn) purgeExpiredSessions() {
	q.fail(q.dbWrite().PurgeExpiredSessions(q.ctx, q.now()))
}

// userFor 认出请求的登录者（含开发者的体验身份）。在请求事务里就用它，事件流这类不在事务里的另开只读事务。
func (s *Server) userFor(r *http.Request) (*User, error) {
	credential := bearerCredential(r)
	if credential == "" {
		return nil, errUnauthorized
	}
	if q := txnOf(r); q != nil {
		return s.userIn(q, r, credential)
	}
	var u *User
	var authErr error
	if err := s.read(r.Context(), func(q *txn) { u, authErr = s.userIn(q, r, credential) }); err != nil {
		return nil, err
	}
	return u, authErr
}

func (s *Server) userIn(q *txn, r *http.Request, credential string) (*User, error) {
	sess, ok := q.authSession(identityKey(credential))
	if !ok {
		return nil, errUnauthorized
	}
	u := q.user(sess.UserID)
	if u == nil {
		return nil, errUnauthorized
	}
	v := s.sessionUser(u, sess)
	if v.DeveloperMode == "guest" && !(r.Method == "POST" && r.URL.Path == "/api/v2/auth/developer-sessions") && !(r.Method == "GET" && r.URL.Path == "/api/v2/accounts/"+u.ID) {
		return nil, errUnauthorized
	}
	return &v, nil
}

// currentSession 是这个请求所用的会话（找不到时是零值）。
func (q *txn) currentSession(r *http.Request) authSession {
	sess, _ := q.authSession(identityKey(bearerCredential(r)))
	return sess
}

// sessionTTL 是小程序会话的有效期。
const sessionTTL = 24 * time.Hour

func isNoRows(err error) bool { return errors.Is(err, pgx.ErrNoRows) }
