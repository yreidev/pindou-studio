package app

import (
	"errors"
	"net/http"
	"time"

	identityapp "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/identity/application"
	"github.com/yreidev/pindou-studio/pindou-backend/internal/storage/queries"
)

// 员工给顾客发的临时密码与小程序认领（迁移 022 的 account_passwords）：员工代开的会员、以前在顾客网页注册过的账户，
// 顾客在小程序登录页用手机号加员工发的临时密码（以前在网页设过密码的，填那个也行）把这个微信绑到那个账户上
// （member_accounts.go 的 createMemberClaim）。顾客网页 2026-10-31 下线（docs/plan-split-release.md）：网页注册、
// 手机号加密码登录、改密码的接口和顾客网页会话（client h5）都去掉了。
//
// ★ 员工功能只认微信身份（小程序会话和小程序扫码批准的网页后台会话），临时密码只能拿来认领，所以员工给顾客
//   发临时密码不会变成提权。
// ★ 密码的哈希与校验（argon2id，几十毫秒、19 MiB）都在事务外做：事务冲突会整个重来，不能每次重算，
//   也不能占着数据库连接算。事务里只核对「校验时读到的哈希」还是库里那一个（期间改过密码就拒绝）。

const (
	temporaryPasswordTTL = 24 * time.Hour
	// 每个手机号每 15 分钟至多试 5 次认领（不论成败），挡对单个号猜密码；按来源的限流另算。
	passwordPhoneLimit  = 5
	passwordPhoneWindow = 15 * time.Minute
)

var (
	errInvalidCredentials        = errors.New("手机号或密码不对")
	errTemporaryPasswordExpired  = errors.New("临时密码已过期，请到店里找店员重新领取")
	errInvalidPhone              = errors.New("请填写正确的手机号")
	errPasswordChangedMeanwhile  = errors.New("店员刚重新发了临时密码，请用新的那个")
	errPasswordAccountMissing    = errors.New("账户不存在")
	errResetPhoneMissing         = errors.New("这位顾客的资料里没有可用的手机号，请先在资料里填好")
	errResetPhoneRegisteredOther = errors.New("这个手机号已被别的账户用来认领，请先核对顾客资料")
)

// passwordLogin 是一个账户的认领密码（account_passwords 的一行）：员工发的临时密码，或以前在顾客网页设的密码。
type passwordLogin struct {
	AccountID          string
	Phone              string
	PasswordHash       string
	MustChange         bool
	TemporaryExpiresAt *time.Time
}

func (q *txn) passwordLoginByPhone(phone string) (passwordLogin, bool) {
	r, err := q.db().PasswordLoginByPhone(q.ctx, phone)
	if isNoRows(err) {
		return passwordLogin{}, false
	}
	q.fail(err)
	return passwordLogin{AccountID: r.AccountID, Phone: phone, PasswordHash: r.PasswordHash, MustChange: r.MustChange, TemporaryExpiresAt: r.TemporaryExpiresAt}, true
}

func (q *txn) passwordLoginOf(account string) (passwordLogin, bool) {
	r, err := q.db().PasswordLoginOf(q.ctx, account)
	if isNoRows(err) {
		return passwordLogin{}, false
	}
	q.fail(err)
	return passwordLogin{AccountID: account, Phone: r.Phone, PasswordHash: r.PasswordHash, MustChange: r.MustChange, TemporaryExpiresAt: r.TemporaryExpiresAt}, true
}

func (q *txn) putPasswordLogin(p passwordLogin) {
	q.fail(q.dbWrite().PutPasswordLogin(q.ctx, queries.PutPasswordLoginParams{
		AccountID: p.AccountID, Phone: p.Phone, PasswordHash: p.PasswordHash, MustChange: p.MustChange, TemporaryExpiresAt: p.TemporaryExpiresAt, UpdatedAt: q.now(),
	}))
}

// phoneTaken 是这个手机号有没有被 other 以外的账户用过（资料里的号或认领用的号）。
func (q *txn) phoneTaken(phone, other string) bool {
	return must(q.db().PhoneTaken(q.ctx, queries.PhoneTakenParams{OtherThan: other, Phone: phone}))
}

// checkedPassword 是事务外核对过密码的登录：之后的事务里要确认库里还是这一个哈希。
type checkedPassword struct {
	login passwordLogin
	phone string
}

// checkPassword 按手机号与密码认出要认领的账户：先按手机号限流，再在只读事务里取出哈希，在事务外校验。
// 没有这个号的也陪跑一次校验，不让人靠回得快慢探出哪些号开过。临时密码过期了不能用。写了错误响应时返回 false。
func (s *Server) checkPassword(w http.ResponseWriter, r *http.Request, rawPhone, password string) (checkedPassword, bool) {
	phone, ok := identityapp.NormalizePhone(rawPhone)
	if !ok {
		s.writeError(w, r, 400, "invalid_request", errInvalidPhone)
		return checkedPassword{}, false
	}
	if allowed, retryAfter := s.hitRate(r, "password:"+phone, passwordPhoneLimit, passwordPhoneWindow); !allowed {
		s.tooManyRequests(w, r, retryAfter)
		return checkedPassword{}, false
	}
	var login passwordLogin
	found := false
	if err := s.read(r.Context(), func(q *txn) { login, found = q.passwordLoginByPhone(phone) }); err != nil {
		s.writeError(w, r, 503, "persistence_failed", errors.New("数据暂时读不出来，请重试"))
		return checkedPassword{}, false
	}
	if !found {
		identityapp.VerifyAbsent(password)
		s.writeError(w, r, 401, "invalid_credentials", errInvalidCredentials)
		return checkedPassword{}, false
	}
	if !identityapp.VerifyPassword(login.PasswordHash, password) {
		s.writeError(w, r, 401, "invalid_credentials", errInvalidCredentials)
		return checkedPassword{}, false
	}
	if login.MustChange && (login.TemporaryExpiresAt == nil || !s.now().Before(*login.TemporaryExpiresAt)) {
		s.writeError(w, r, 401, "temporary_password_expired", errTemporaryPasswordExpired)
		return checkedPassword{}, false
	}
	return checkedPassword{login: login, phone: phone}, true
}

// stillCurrent 在写事务里认出核对过的登录对应的账户：期间密码被改过、重置过，或账户没了，写错误响应、返回 nil。
func (s *Server) stillCurrent(w http.ResponseWriter, r *http.Request, q *txn, checked checkedPassword) *User {
	now, ok := q.passwordLoginOf(checked.login.AccountID)
	if !ok || now.PasswordHash != checked.login.PasswordHash || now.Phone != checked.phone {
		s.writeError(w, r, 401, "invalid_credentials", errPasswordChangedMeanwhile)
		return nil
	}
	u := q.user(checked.login.AccountID)
	if u == nil {
		s.writeError(w, r, 401, "invalid_credentials", errPasswordAccountMissing)
		return nil
	}
	return u
}

// createPasswordReset 是员工给顾客发一次性临时密码（24 小时有效）：顾客拿它和手机号在小程序里认领员工代开的会员。
// 店员只能给顾客发；给员工发要能管理对方的角色（同任命规则：店长不能管老板）。还没有认领密码的账户按资料里的手机号开一条。
func (s *Server) createPasswordReset(w http.ResponseWriter, r *http.Request) {
	temporary, err := identityapp.TemporaryPassword()
	if err != nil {
		s.writeError(w, r, 500, "internal_error", err)
		return
	}
	hash, err := identityapp.HashPassword(temporary)
	if err != nil {
		s.writeError(w, r, 500, "internal_error", err)
		return
	}
	s.serveTx(w, r, true, "accounts", func(w http.ResponseWriter, r *http.Request) {
		u, ok := s.staffMember(w, r)
		if !ok {
			return
		}
		q := s.tx(r)
		uid := r.PathValue("id")
		target := q.user(uid)
		if !validID(uid) || target == nil {
			s.writeError(w, r, 404, "not_found", errNotFound)
			return
		}
		for _, role := range target.Roles {
			if !canManage(u, role) {
				s.writeError(w, r, 403, "forbidden", errors.New("无权给这位员工发临时密码"))
				return
			}
		}
		login, exists := q.passwordLoginOf(uid)
		if !exists {
			phone, ok := identityapp.NormalizePhone(target.Phone)
			if !ok {
				s.writeError(w, r, 409, "phone_missing", errResetPhoneMissing)
				return
			}
			if other, taken := q.passwordLoginByPhone(phone); taken && other.AccountID != uid {
				s.writeError(w, r, 409, "phone_registered", errResetPhoneRegisteredOther)
				return
			}
			login = passwordLogin{AccountID: uid, Phone: phone}
		}
		expires := q.now().Add(temporaryPasswordTTL)
		login.PasswordHash, login.MustChange, login.TemporaryExpiresAt = hash, true, &expires
		q.putPasswordLogin(login)
		q.audit(u.ID, "password.reset", uid, "", requestID(r))
		writeJSON(w, 201, map[string]any{"temporaryPassword": temporary, "expiresAt": expires, "phoneMasked": maskPhone(login.Phone)})
	})
}

// syncLoginPhone 是改资料换手机号时的认领密码处理：账户有认领密码，就把认领用的号一起换成新号
// （须合格式、没被别的账户用过），返回整理后的号；没有的原样返回。写了错误响应时返回 false。
func (s *Server) syncLoginPhone(w http.ResponseWriter, r *http.Request, q *txn, account, phone string) (string, bool) {
	login, exists := q.passwordLoginOf(account)
	if !exists {
		return phone, true
	}
	normalized, ok := identityapp.NormalizePhone(phone)
	if !ok {
		s.writeError(w, r, 400, "invalid_request", errInvalidPhone)
		return "", false
	}
	if normalized == login.Phone {
		return normalized, true
	}
	if q.phoneTaken(normalized, account) {
		s.writeError(w, r, 409, "phone_registered", errors.New("这个手机号已被别的账户用过，不能换成它"))
		return "", false
	}
	q.fail(q.dbWrite().SetPasswordLoginPhone(q.ctx, queries.SetPasswordLoginPhoneParams{AccountID: account, Phone: normalized, UpdatedAt: q.now()}))
	return normalized, true
}
