package app

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/yreidev/pindou-studio/pindou-backend/internal/storage"
)

// 会话落库（迁移 009）：发版、Pod 重启不再把所有人踢下线。

func openSessionServer(t *testing.T) (dsn string, db *storage.Postgres, s *Server) {
	t.Helper()
	dsn, db = newTestDatabaseAt(t)
	return dsn, db, serverOn(t, db)
}

// restartServer 是同一个库上新起的一个进程。
func restartServer(t *testing.T, db *storage.Postgres) *Server {
	t.Helper()
	return serverOn(t, db)
}

func loginWith(t *testing.T, s *Server, code string) string {
	t.Helper()
	w := call(t, s, http.MethodPost, "/api/v2/auth/wechat-sessions", "", "", map[string]any{"wechatLoginCode": code})
	if w.Code != http.StatusCreated {
		t.Fatalf("login %s: %d %s", code, w.Code, w.Body.String())
	}
	return decodeMap(t, w)["accessToken"].(string)
}

func accountStatus(t *testing.T, s *Server, userID, token string) int {
	t.Helper()
	return call(t, s, http.MethodGet, "/api/v2/accounts/"+userID, token, "", nil).Code
}

func TestPostgresSessionsSurviveRestart(t *testing.T) {
	dsn, db, s := openSessionServer(t)
	registered := register(t, s, "session-restart", "Survivor")
	loggedIn := loginWith(t, s, "session-restart")

	restarted := restartServer(t, db)
	if got := accountStatus(t, restarted, registered.User.ID, registered.AccessToken); got != http.StatusOK {
		t.Fatalf("token issued at registration after restart: %d", got)
	}
	if got := accountStatus(t, restarted, registered.User.ID, loggedIn); got != http.StatusOK {
		t.Fatalf("token issued at login after restart: %d", got)
	}

	// 库里只有令牌的哈希，没有令牌本身。
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	var raw, hashed int
	if err := conn.QueryRow(ctx, `SELECT count(*) FILTER (WHERE token_hash = $1), count(*) FILTER (WHERE token_hash = $2) FROM auth_sessions`, loggedIn, identityKey(loggedIn)).Scan(&raw, &hashed); err != nil {
		t.Fatal(err)
	}
	if raw != 0 || hashed != 1 {
		t.Fatalf("stored raw=%d hashed=%d, want only the hash", raw, hashed)
	}
}

func TestPostgresReplacedDeveloperSessionStaysInvalidAfterRestart(t *testing.T) {
	_, db, s := openSessionServer(t)
	dev := register(t, s, "session-developer", "Developer")
	if err := s.ConfigureDeveloperAccounts(dev.User.ID); err != nil {
		t.Fatal(err)
	}
	// 切到顾客身份即可（体验身份不能高于真实任命，这个开发者没有任命）
	switched := switchMode(t, s, dev, "customer")

	restarted := restartServer(t, db)
	if err := restarted.ConfigureDeveloperAccounts(dev.User.ID); err != nil {
		t.Fatal(err)
	}
	if got := accountStatus(t, restarted, dev.User.ID, dev.AccessToken); got != http.StatusUnauthorized {
		t.Fatalf("replaced token came back after restart: %d", got)
	}
	if got := accountStatus(t, restarted, dev.User.ID, switched.AccessToken); got != http.StatusOK {
		t.Fatalf("switched token after restart: %d", got)
	}
}

func TestPostgresExpiredSessionsAreNotRestoredAndGetPurged(t *testing.T) {
	dsn, db, s := openSessionServer(t)
	user := register(t, s, "session-expired", "Expired")
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	// 进程停着的时候过期的会话：直接写进库里。
	stale := token()
	if _, err := conn.Exec(ctx, `INSERT INTO auth_sessions(token_hash,account_id,expires_at) VALUES ($1,$2,$3)`, identityKey(stale), user.User.ID, time.Now().Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}

	restarted := restartServer(t, db)
	if got := accountStatus(t, restarted, user.User.ID, stale); got != http.StatusUnauthorized {
		t.Fatalf("expired session restored: %d", got)
	}
	loginWith(t, restarted, "session-expired")
	var expired int
	if err := conn.QueryRow(ctx, `SELECT count(*) FROM auth_sessions WHERE expires_at <= now()`).Scan(&expired); err != nil {
		t.Fatal(err)
	}
	if expired != 0 {
		t.Fatalf("%d expired sessions were not purged", expired)
	}
}

func TestPostgresLoginIssuesNoTokenWhenSessionCannotBeSaved(t *testing.T) {
	_, _, s := openSessionServer(t)
	register(t, s, "session-unsaved", "Unsaved")
	before := sessionCount(t, s)
	restore := failWrites(t, s, "auth_sessions")
	w := call(t, s, http.MethodPost, "/api/v2/auth/wechat-sessions", "", "", map[string]any{"wechatLoginCode": "session-unsaved"})
	restore()
	if w.Code != http.StatusServiceUnavailable || strings.Contains(w.Body.String(), "accessToken") {
		t.Fatalf("login without a durable session: %d %s", w.Code, w.Body.String())
	}
	if sessionCount(t, s) != before {
		t.Fatal("an unsaved session was kept")
	}
}

// 迁移 010：网页后台会话标记 client=web 落库，重启后仍有效；一键注销后重启也回不来。
func TestPostgresWebSessionsPersistWithTheirClient(t *testing.T) {
	dsn, db, s := openSessionServer(t)
	owner := ownerFixture(t, s)
	webToken := webSessionFor(t, s, owner)
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	var client string
	if err := conn.QueryRow(ctx, `SELECT client FROM auth_sessions WHERE token_hash = $1`, identityKey(webToken)).Scan(&client); err != nil || client != "web" {
		t.Fatalf("web session client=%q err=%v", client, err)
	}
	var mini string
	if err := conn.QueryRow(ctx, `SELECT client FROM auth_sessions WHERE token_hash = $1`, identityKey(owner.AccessToken)).Scan(&mini); err != nil || mini != "miniapp" {
		t.Fatalf("mini program session client=%q err=%v", mini, err)
	}
	var approvals int
	if err := conn.QueryRow(ctx, `SELECT count(*) FROM audit_events WHERE action = 'web_login.approved'`).Scan(&approvals); err != nil || approvals != 1 {
		t.Fatalf("approval audits=%d err=%v", approvals, err)
	}

	restarted := restartServer(t, db)
	if got := accountStatus(t, restarted, owner.User.ID, webToken); got != http.StatusOK {
		t.Fatalf("web session after restart: %d", got)
	}
	restoredClient := sessionClient(t, restarted, webToken)
	if restoredClient != clientWeb {
		t.Fatalf("restored client=%q", restoredClient)
	}
	if w := call(t, restarted, http.MethodDelete, "/api/v2/auth/web-sessions", owner.AccessToken, "", nil); w.Code != http.StatusOK {
		t.Fatalf("revoke: %d %s", w.Code, w.Body.String())
	}
	again := restartServer(t, db)
	if got := accountStatus(t, again, owner.User.ID, webToken); got != http.StatusUnauthorized {
		t.Fatalf("revoked web session came back after restart: %d", got)
	}
	if got := accountStatus(t, again, owner.User.ID, owner.AccessToken); got != http.StatusOK {
		t.Fatalf("mini program session lost: %d", got)
	}
}

// 迁移 010 之前就有的会话没有 client 列的值，按小程序算。
func TestPostgresSessionsFromBeforeMigration010AreMiniProgramSessions(t *testing.T) {
	dsn, db, s := openSessionServer(t)
	user := register(t, s, "legacy-session", "Legacy")
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	legacy := token()
	if _, err := conn.Exec(ctx, `INSERT INTO auth_sessions(token_hash,account_id,expires_at) VALUES ($1,$2,now()+interval '1 hour')`, identityKey(legacy), user.User.ID); err != nil {
		t.Fatal(err)
	}
	restarted := restartServer(t, db)
	client := sessionClient(t, restarted, legacy)
	if client != clientMiniapp {
		t.Fatalf("legacy session client=%q", client)
	}
}

// 批准和审计在同一个事务里：写库失败时审计不落库，挑战也还是待批准。
func TestPostgresFailedApprovalLeavesTheChallengePending(t *testing.T) {
	_, _, s := openSessionServer(t)
	owner := ownerFixture(t, s)
	c := createChallenge(t, s, "ua")
	restore := failWrites(t, s, "audit_events")
	if w := decide(t, s, owner.AccessToken, c, true); w.Code != http.StatusServiceUnavailable {
		t.Fatalf("approve with the database failing: %d %s", w.Code, w.Body.String())
	}
	restore()
	status := view(t, s, func(q *txn) string { return q.webLogin(c.ID).Status })
	if status != webLoginPending {
		t.Fatalf("challenge after a failed approval: %s", status)
	}
}
