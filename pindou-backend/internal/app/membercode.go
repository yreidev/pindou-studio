package app

import (
	"crypto/rand"
	"errors"
	"math/big"
	"net/http"
	"regexp"
	"strings"
	"time"

	member "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/membership/application"
	"github.com/yreidev/pindou-studio/pindou-backend/internal/storage/queries"
)

// 会员码（2026-10-06 业主决定）：顾客在小程序会员中心亮出二维码，店员用手机「扫会员码」、柜台 USB 扫码枪，
// 或手机「扫码给电脑」转到网页，凭码调出这位顾客。
//
//   - 码里只有一个随机令牌，不含手机号、微信标识或账户编号；90 秒有效，小程序每分钟换一个，截图转给别人很快就失效。
//   - 令牌是 20 位数字（首位 9 + 19 位随机，约 63 位熵）：柜台扫码枪等于键盘输入，字母会被开着的中文输入法截走，
//     数字不会；数字的二维码也最稀疏、最好扫。首位固定是为了和商品条码（EAN-13、UPC）、手机号一眼分开。
//   - 记在库里（member_codes，只存令牌的 SHA-256，同登录会话），不用签名令牌：签名要一把各副本共用的密钥，
//     码里还得带账户编号再加密；库里的记录随机、不可猜，任何一个副本都能查。新码不作废还没到期的旧码——
//     店员扫的那一下正好赶上页面换码时，旧码照样能用。
//   - 只有员工能凭码查人，查到的记审计（谁、何时、查了哪位）；顾客查谁的码都是 403。
//   - 不推送事件：签发、查人都不改业务数据。
const (
	memberCodeTTL = 90 * time.Second
	// 过期一小时以上的码签发时顺手清掉；一小时内过期的查到时说「过期了」，再早的只说「不是本店的会员码」。
	memberCodeRetention  = time.Hour
	memberCodeRateLimit  = 20
	memberCodeRateWindow = time.Minute
)

// memberCodePattern 是会员码的样子：首位 9，共 20 位数字。
var memberCodePattern = regexp.MustCompile(`^9[0-9]{19}$`)

var (
	errMemberCodeNotFound = errors.New("这不是本店的会员码，请让顾客在小程序里亮出会员码再扫")
	errMemberCodeExpired  = errors.New("会员码已过期，请顾客刷新会员码后再扫")
	errMemberCodeMissing  = errors.New("请提供扫到的会员码")
)

// memberCodeSpace 是随机部分的取值个数：19 位数字。
var memberCodeSpace = new(big.Int).Exp(big.NewInt(10), big.NewInt(19), nil)

// newMemberCode 生成一个会员码：9 加 19 位均匀随机的数字（crypto/rand）。
func newMemberCode() string {
	n, err := rand.Int(rand.Reader, memberCodeSpace)
	if err != nil {
		panic(err)
	}
	digits := n.String()
	return "9" + strings.Repeat("0", 19-len(digits)) + digits
}

// issueMemberCode 是 POST /member-codes：已登录的人给自己签发一个会员码。
func (s *Server) issueMemberCode(w http.ResponseWriter, r *http.Request) {
	u, ok := s.signedIn(w, r)
	if !ok {
		return
	}
	q := s.tx(r)
	now := q.now()
	q.fail(q.dbWrite().PurgeMemberCodes(q.ctx, now.Add(-memberCodeRetention)))
	code := newMemberCode()
	expires := now.Add(memberCodeTTL)
	// 两次碰上同一个码（约 10^-19）时主键冲突，整个请求按冲突重来、换一个码
	q.fail(q.dbWrite().InsertMemberCode(q.ctx, queries.InsertMemberCodeParams{
		TokenHash: identityKey(code), AccountID: u.ID, CreatedAt: now, ExpiresAt: expires,
	}))
	writeJSON(w, 201, map[string]any{"code": code, "expiresAt": expires, "validSeconds": int(memberCodeTTL / time.Second)})
}

// memberCodeInput 是凭码查人的请求；omitzero 的用意同 loyaltyInput。
type memberCodeInput struct {
	Code string `json:"code,omitzero"`
}

// lookupMemberCode 是 POST /member-codes/lookups：员工凭会员码查出是哪位顾客，查到的记审计。
func (s *Server) lookupMemberCode(w http.ResponseWriter, r *http.Request) {
	u, ok := s.staffMember(w, r)
	if !ok {
		return
	}
	var in memberCodeInput
	if err := decode(r, &in); err != nil {
		s.writeError(w, r, 400, "invalid_request", err)
		return
	}
	code := strings.TrimSpace(in.Code)
	if code == "" {
		s.writeError(w, r, 400, "invalid_request", errMemberCodeMissing)
		return
	}
	if !memberCodePattern.MatchString(code) {
		s.writeError(w, r, 404, "member_code_not_found", errMemberCodeNotFound)
		return
	}
	q := s.tx(r)
	now := q.now()
	row, err := q.db().MemberCode(q.ctx, identityKey(code))
	if isNoRows(err) {
		s.writeError(w, r, 404, "member_code_not_found", errMemberCodeNotFound)
		return
	}
	q.fail(err)
	if !now.Before(row.ExpiresAt) {
		s.writeError(w, r, 410, "member_code_expired", errMemberCodeExpired)
		return
	}
	target := q.user(row.AccountID)
	if target == nil {
		s.writeError(w, r, 404, "member_code_not_found", errMemberCodeNotFound)
		return
	}
	balance, found := q.balancesOf([]string{target.ID}, now)[target.ID]
	if !found {
		balance = member.EmptyBalance()
	}
	q.audit(u.ID, "member_code.scanned", target.ID, "", requestID(r))
	account := cloneUser(target)
	writeJSON(w, 200, map[string]any{
		"id": account.ID, "nickname": account.Nickname, "phoneMasked": account.PhoneMasked,
		"phoneVerificationStatus": account.PhoneVerificationStatus, "roles": account.Roles, "balance": balance,
	})
}
