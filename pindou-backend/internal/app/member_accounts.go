package app

import (
	"errors"
	"net/http"
	"unicode/utf8"

	identityapp "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/identity/application"
	member "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/membership/application"
)

func (q *txn) accountByPhone(phone string) *User {
	ids := must(q.db().AccountByPhone(q.ctx, phone))
	if len(ids) == 0 {
		return nil
	}
	return q.user(ids[0])
}

func (q *txn) accountHasWechat(account string) bool {
	return must(q.db().AccountHasWechat(q.ctx, account))
}

func (q *txn) unclaimedMembers(ids []string) map[string]bool {
	out := map[string]bool{}
	if len(ids) > 0 {
		for _, id := range must(q.db().UnclaimedMemberAccounts(q.ctx, ids)) {
			out[id] = true
		}
	}
	return out
}

func loyaltyMemberSummary(u *User, balance member.Balance, unclaimed bool) map[string]any {
	out := map[string]any{"id": u.ID, "nickname": u.Nickname, "phoneMasked": maskPhone(u.Phone), "balance": balance}
	if unclaimed {
		out["unclaimed"] = true
	}
	return out
}

// createMemberAccount 是柜台代开：口头同意只记代开来源，本人的隐私同意留到首次登录时补。
func (s *Server) createMemberAccount(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.staffMember(w, r)
	if !ok {
		return
	}
	var in struct {
		Nickname string `json:"nickname"`
		Phone    string `json:"phone"`
		Consent  bool   `json:"consent"`
	}
	if err := decode(r, &in); err != nil {
		s.writeError(w, r, 400, "invalid_request", err)
		return
	}
	if n := utf8.RuneCountInString(in.Nickname); n < 1 || n > 50 || !in.Consent {
		s.writeError(w, r, 400, "invalid_request", errors.New("称呼请填 1～50 个字，并确认顾客已同意门店记下称呼和手机号"))
		return
	}
	phone, ok := identityapp.NormalizePhone(in.Phone)
	if !ok || utf8.RuneCountInString(in.Phone) > 30 {
		s.writeError(w, r, 400, "invalid_request", errInvalidPhone)
		return
	}
	q := s.tx(r)
	u := q.accountByPhone(phone)
	existing, status := u != nil, http.StatusOK
	if !existing {
		now := q.now()
		u = &User{ID: id(), Nickname: in.Nickname, Phone: phone, PhoneVerificationStatus: "unverified", Roles: []Role{}, CreatedAt: now, MemberOpening: &memberOpening{ActorID: actor.ID, CreatedAt: now}}
		q.addUser(u)
		q.audit(actor.ID, "account.opened_member", u.ID, u.Nickname, requestID(r))
		status = http.StatusCreated
	}
	balance, found := q.balancesOf([]string{u.ID}, q.now())[u.ID]
	if !found {
		balance = member.EmptyBalance()
	}
	writeJSON(w, status, map[string]any{"existing": existing, "account": loyaltyMemberSummary(u, balance, q.unclaimedMembers([]string{u.ID})[u.ID])})
}

// createMemberClaim 先在事务外核对密码、换微信身份，再原子绑定原账户并发小程序会话。
func (s *Server) createMemberClaim(w http.ResponseWriter, r *http.Request) {
	var in struct {
		WechatLoginCode        string `json:"wechatLoginCode"`
		Phone                  string `json:"phone"`
		Password               string `json:"password"`
		PrivacyContractVersion string `json:"privacyContractVersion"`
	}
	if err := decode(r, &in); err != nil || in.WechatLoginCode == "" || utf8.RuneCountInString(in.WechatLoginCode) > 2048 || in.Phone == "" || utf8.RuneCountInString(in.Phone) > 30 || in.Password == "" || utf8.RuneCountInString(in.Password) > identityapp.MaxPasswordLength || utf8.RuneCountInString(in.PrivacyContractVersion) < 1 || utf8.RuneCountInString(in.PrivacyContractVersion) > 100 {
		s.writeError(w, r, 400, "invalid_request", errors.New("请填写微信登录凭证、手机号和密码，并同意隐私协议"))
		return
	}
	checked, ok := s.checkPassword(w, r, in.Phone, in.Password)
	if !ok {
		return
	}
	wechatID := in.WechatLoginCode
	if s.wechat != nil {
		var err error
		wechatID, err = s.wechat.ExchangeLogin(r.Context(), in.WechatLoginCode)
		if err != nil {
			s.writeError(w, r, 502, "wechat_unavailable", errors.New("微信登录失败，请重试"))
			return
		}
	}
	key := identityKey(wechatID)
	s.serveTx(w, r, true, "accounts", func(w http.ResponseWriter, r *http.Request) {
		q := s.tx(r)
		u := s.stillCurrent(w, r, q, checked)
		if u == nil {
			return
		}
		if checked.login.MustChange && (checked.login.TemporaryExpiresAt == nil || !q.now().Before(*checked.login.TemporaryExpiresAt)) {
			s.writeError(w, r, 401, "temporary_password_expired", errTemporaryPasswordExpired)
			return
		}
		if q.accountHasWechat(u.ID) {
			s.writeError(w, r, 409, "already_claimed", errors.New("这个账户已经绑定微信，请直接登录"))
			return
		}
		if q.userByWechat(key) != nil {
			s.writeError(w, r, 409, "already_registered", errors.New("这个微信已注册过别的账户，不能认领"))
			return
		}
		q.addWechatIdentity(key, u.ID)
		if u.PrivacyContractVersion == "" {
			u.PrivacyContractVersion, u.PrivacyAcceptedAt = in.PrivacyContractVersion, q.now()
		}
		if checked.login.MustChange {
			q.fail(q.dbWrite().DeletePasswordLogin(q.ctx, u.ID))
		}
		q.purgeExpiredSessions()
		accessToken := token()
		sess := authSession{UserID: u.ID, ExpiresAt: q.now().Add(sessionTTL)}
		q.putAuthSession(identityKey(accessToken), sess)
		q.audit(u.ID, "account.claimed_member", u.ID, "", requestID(r))
		writeJSON(w, 201, map[string]any{"accessToken": accessToken, "expiresAt": sess.ExpiresAt, "user": s.sessionUser(u, sess)})
	})
}
