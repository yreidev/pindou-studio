// Package domain 是呼叫店员的规则（docs/plan-live-board.md 第 2 节）：一条呼叫此刻是什么状态、
// 谁说了「我去处理」、店员处理之后要隔多久才能再叫。不依赖 HTTP 和数据库。
package domain

import (
	"errors"
	"time"
)

const (
	// Window 是一条呼叫等店员处理的时限：过了还没人处理，显示为已过期，顾客可以再叫。
	Window = 30 * time.Minute
	// Cooldown 是店员处理之后，同一个会话要隔多久才能再叫。
	Cooldown = time.Minute
	// ClaimHold 是「我去处理」管多久：认领满这么久还没点「已处理」，认领失效（ClaimLapsed），
	// 这条呼叫重新提醒所有员工，谁都能再认领。人可能被别的事绊住了，顾客还在等。
	ClaimHold = 10 * time.Minute
)

// 呼叫的状态。Expired 只是读的时候按时间算出来的展示状态，不存。
const (
	Pending = "pending"
	Handled = "handled"
	Expired = "expired"
)

// 认领的状态，读的时候按时间算，不存。只在呼叫还在等（Open）时有意义。
const (
	// Unclaimed 是还没有员工说「我去处理」。
	Unclaimed = "none"
	// Claimed 是有员工认领着（认领了不到 ClaimHold）：员工端不再为它振动、响铃。
	Claimed = "claimed"
	// ClaimLapsed 是认领满 ClaimHold 还没处理：重新提醒所有员工。
	ClaimLapsed = "lapsed"
)

// 认领不了的原因。
var (
	// ErrClosed 是这条呼叫已经不用去了：已处理或已过期。
	ErrClosed = errors.New("这条呼叫已经处理或已过期，不用再去了")
	// ErrClaimedByOther 是别的员工认领着（还没满 ClaimHold）：谁先认领算谁。
	ErrClaimedByOther = errors.New("别的店员已在处理这条呼叫")
)

// Call 是顾客在一次计时（会话）里的一次呼叫。叫的人、哪个会话在创建时定下，之后只有店员处理会改它。
type Call struct {
	ID        string    `json:"id"`
	SessionID string    `json:"venueSessionId"`
	AccountID string    `json:"accountId"`
	Status    string    `json:"status"`
	CreatedAt time.Time `json:"createdAt"`
	// HandledAt、HandledBy 是哪位员工什么时候处理的，没处理时为空。
	HandledAt *time.Time `json:"handledAt,omitempty"`
	HandledBy string     `json:"handledByAccountId,omitempty"`
	// ClaimedAt、ClaimedBy 是最近一次哪位员工什么时候说了「我去处理」，没人认领时为空。
	// 处理之后照旧留着（谁说了去、谁最后点的已处理可能不是同一人）。
	ClaimedAt *time.Time `json:"claimedAt,omitempty"`
	ClaimedBy string     `json:"claimedByAccountId,omitempty"`
}

// Display 是这条呼叫**此刻**对人的状态。
//
// ★ Status 只有店员点了「已处理」才会变；过期是时间到了自然发生的，没人点，所以没处理的呼叫 Status 一直是
// pending。前端一律看 Display，不然店员的手机会一直挂着一条半小时前、顾客早已不在等的呼叫（同入座申请的
// Admission.Display、预约的 Reservation.Display）。
func (c Call) Display(now time.Time) string {
	if c.Status == Pending && !now.Before(c.CreatedAt.Add(Window)) {
		return Expired
	}
	return c.Status
}

// Open 报告这条呼叫还在等店员：没处理，也没过期。
func (c Call) Open(now time.Time) bool { return c.Display(now) == Pending }

// CooldownLeft 是店员处理之后，这个会话还要等多久才能再叫；没处理过或已经过了冷却为 0。
func (c Call) CooldownLeft(now time.Time) time.Duration {
	if c.Status != Handled || c.HandledAt == nil {
		return 0
	}
	return max(0, c.HandledAt.Add(Cooldown).Sub(now))
}

// Handle 记下哪位员工什么时候处理了这条呼叫。已经处理过的不改（返回 false）：先点的那位算数，
// 后点的看到的是已处理。过期的也能处理（店员事后补点一下，顾客页随之显示已处理）。
func (c *Call) Handle(staff string, now time.Time) bool {
	if c.Status == Handled {
		return false
	}
	c.Status, c.HandledAt, c.HandledBy = Handled, &now, staff
	return true
}

// ClaimState 是此刻的认领状态：没人认领、认领着（不到 ClaimHold）、认领满 ClaimHold 了。只按时间算，
// 呼叫已处理、已过期时也照算，调用方只在 Open 时看它。
func (c Call) ClaimState(now time.Time) string {
	switch {
	case c.ClaimedAt == nil:
		return Unclaimed
	case now.Before(c.ClaimedAt.Add(ClaimHold)):
		return Claimed
	default:
		return ClaimLapsed
	}
}

// Claim 记下哪位员工说了「我去处理」，返回是否有改动（要不要记审计）。
//
//   - 谁先认领算谁：别人认领着（不到 ClaimHold）时返回 ErrClaimedByOther，什么都不改；
//   - 同一人认领着再点：不改、不报错（重复点、重发都无害，所以不用幂等键）；
//   - 认领满 ClaimHold 还没处理的：认领失效，谁都能再认领（原来那位再点就是「我还在处理」，从现在重新计时）；
//   - 已处理、已过期的不用去了：ErrClosed。
func (c *Call) Claim(staff string, now time.Time) (bool, error) {
	if !c.Open(now) {
		return false, ErrClosed
	}
	if c.ClaimState(now) == Claimed {
		if c.ClaimedBy == staff {
			return false, nil
		}
		return false, ErrClaimedByOther
	}
	c.ClaimedAt, c.ClaimedBy = &now, staff
	return true, nil
}
