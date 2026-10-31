// Package application implements configurable loyalty rules and append-only assets.
package application

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/yreidev/pindou-studio/pindou-backend/internal/storetime"
)

const Limit int64 = 1_000_000_000

var ErrInvalid = errors.New("请检查规则、金额、积分及有效期设置")
var ErrBalance = errors.New("余额、可用积分或智能豆板次数不足，或超过上限")

// ErrUntilClose 是「到打烊」的套餐填了时长、续时或暂停。
var ErrUntilClose = errors.New("「到打烊」的套餐用到当天打烊：不填时长，不能续时，也不能暂停")

// ErrNoRenewal 是没有续时方案的套餐选了「按续时方案自动加收」。
var ErrNoRenewal = errors.New("按续时方案自动加收要先填续时分钟和续时价格")

type Rule struct {
	ID                string `json:"id"`
	Kind              string `json:"kind"`
	Name              string `json:"name"`
	Enabled           bool   `json:"enabled"`
	AmountCents       int64  `json:"amountCents"`
	GiftCents         int64  `json:"giftCents"`
	Points            int64  `json:"points"`
	RateBasisPoints   int64  `json:"rateBasisPoints"`
	MaxBasisPoints    int64  `json:"maxBasisPoints"`
	MinimumPoints     int64  `json:"minimumPoints"`
	ValidDays         int    `json:"validDays"`
	Mode              string `json:"mode"`
	Scope             string `json:"scope"`
	Stack             bool   `json:"stack"`
	ProductID         string `json:"productId"`
	Quantity          int    `json:"quantity"`
	PerUserLimit      int    `json:"perUserLimit"`
	DurationMinutes   int    `json:"durationMinutes"`
	RenewalMinutes    int    `json:"renewalMinutes"`
	RenewalCents      int64  `json:"renewalCents"`
	PauseLimitMinutes int    `json:"pauseLimitMinutes"`
	// Overtime 是套餐的超时处理：free 不加钱，manual 提示员工处理，renewal 按续时方案自动加收（2026-10-06 起）。
	Overtime string `json:"overtime"`
	// OvertimeGraceMinutes 是 renewal 的宽限：超出不超过这么多分钟不收（界面默认 10）。只有 renewal 用，其余为 0。
	// omitzero：没有宽限的规则（全部旧规则）编码和加字段之前一模一样，发布记录、入座申请里的套餐快照、
	// 设置与会员资产的版本都不变，滚动发布时新旧两版对同一份规则算出的版本一致。
	OvertimeGraceMinutes int `json:"overtimeGraceMinutes,omitzero"`
	// UntilClose 是「到打烊」的套餐（全天不限时，2026-10-10 业主定）：不填时长，开始时按到当天打烊（「营业与预约」的
	// 每天结束时间）算出时长，预约从所选开始时间约到打烊。不能续时、不能暂停（暂停不往后延）。omitzero 的用意同上。
	UntilClose bool  `json:"untilClose,omitzero"`
	BoardUses  int64 `json:"boardUses,omitzero"`
}

// FreeTimingBlockMinutes 是自由计时价的一块：每 30 分钟一个价（2026-10-06 业主定）。写进每条自由计时价的
// durationMinutes，已发布的价自带块长，以后改块长也不会悄悄改变旧发布记录的含义。
const FreeTimingBlockMinutes = 30

// MaxOvertimeGraceMinutes 是超时宽限的上限。
const MaxOvertimeGraceMinutes = 1440

// SingleKinds 是全店同时最多启用一项的规则种类：消费积分、积分抵扣、自由计时价、陪客费。
var SingleKinds = map[string]string{"earn": "消费积分", "redeem": "积分抵扣", "free_timing": "自由计时价", "companion": "陪客费"}

type Publication struct {
	ID        string    `json:"id"`
	Rule      Rule      `json:"rule"`
	ActorID   string    `json:"actorId"`
	CreatedAt time.Time `json:"createdAt"`
	Impact    string    `json:"impact"`
}
type Profile struct {
	Birthday     string `json:"birthday"`
	BirthdayYear int    `json:"birthdayYear"`
}
type PointChange struct {
	LotID     string     `json:"lotId"`
	Delta     int64      `json:"delta"`
	ExpiresAt *time.Time `json:"expiresAt,omitempty"`
}
type Entry struct {
	ID             string        `json:"id"`
	AccountID      string        `json:"accountId"`
	Kind           string        `json:"kind"`
	SourceID       string        `json:"sourceId"`
	Reason         string        `json:"reason"`
	Method         string        `json:"method,omitempty"`
	PrincipalCents int64         `json:"principalCents"`
	GiftCents      int64         `json:"giftCents"`
	Points         []PointChange `json:"points"`
	Rule           *Rule         `json:"rule,omitempty"`
	CreatedAt      time.Time     `json:"createdAt"`
	ServiceDate    string        `json:"serviceDate,omitzero"`
	BoardUses      int64         `json:"boardUses,omitzero"`
	Consumption    *Consumption  `json:"consumption,omitempty"`
	BalanceAfter   *BalanceAfter `json:"balanceAfter,omitempty"`
}
type Consumption struct {
	PackageID   string `json:"packageId"`
	PackageName string `json:"packageName"`
	Headcount   int    `json:"headcount"`
	DayType     string `json:"dayType"`
	AmountCents int64  `json:"amountCents"`
	ExtraCents  int64  `json:"extraCents"`
}

type BalanceAfter struct {
	PrincipalCents int64 `json:"principalCents"`
	GiftCents      int64 `json:"giftCents"`
	BoardUses      int64 `json:"boardUses"`
}

type Balance struct {
	PrincipalCents  int64  `json:"principalCents"`
	GiftCents       int64  `json:"giftCents"`
	Points          int64  `json:"points"`
	ExpiringPoints  int64  `json:"expiringPoints"`
	TierName        string `json:"tierName"`
	RateBasisPoints int64  `json:"rateBasisPoints"`
	// BoardUses 是剩余的智能豆板次数（充值方案赠送、手动加减得来，消费登记用掉），不过期。
	BoardUses int64 `json:"boardUses"`
}
type State struct {
	Admissions   map[string]Admission   `json:"admissions"`
	Drafts       map[string]Rule        `json:"drafts"`
	Publications map[string]Publication `json:"publications"`
	Profiles     map[string]Profile     `json:"profiles"`
	Entries      map[string]Entry       `json:"entries"`
}

func New() *State {
	return &State{map[string]Admission{}, map[string]Rule{}, map[string]Publication{}, map[string]Profile{}, map[string]Entry{}}
}
func Version(v any) string { b, _ := json.Marshal(v); return fmt.Sprintf("%x", sha256.Sum256(b)) }
func Validate(r Rule) error {
	if r.BoardUses < 0 || r.BoardUses > 1000 || r.Kind != "recharge" && r.BoardUses != 0 {
		return ErrInvalid
	}
	if strings.TrimSpace(r.Name) == "" || len([]rune(r.Name)) > 60 {
		return ErrInvalid
	}
	for _, v := range []int64{r.AmountCents, r.GiftCents, r.Points, r.MinimumPoints, r.RenewalCents} {
		if v < 0 || v > Limit {
			return ErrInvalid
		}
	}
	if r.RateBasisPoints < 0 || r.RateBasisPoints > 10000 || r.MaxBasisPoints < 0 || r.MaxBasisPoints > 10000 || r.ValidDays < 0 || r.ValidDays > 3650 || r.Quantity < 0 || r.Quantity > 100000 || r.PerUserLimit < 0 || r.PerUserLimit > 100000 {
		return ErrInvalid
	}
	switch r.Kind {
	case "tier":
		if r.AmountCents < 1 || r.RateBasisPoints < 1 || (r.Mode != "single" && r.Mode != "cumulative") {
			return ErrInvalid
		}
	case "recharge":
		if r.AmountCents < 1 {
			return ErrInvalid
		}
	case "earn":
		if r.AmountCents < 1 || r.Points < 1 || (r.Scope != "all" && r.Scope != "service" && r.Scope != "goods") {
			return ErrInvalid
		}
	case "redeem":
		if r.AmountCents < 1 || r.Points < 1 || r.MaxBasisPoints < 1 {
			return ErrInvalid
		}
	case "exchange":
		if r.Points < 1 || r.ProductID == "" || r.Quantity < 1 || r.PerUserLimit < 1 {
			return ErrInvalid
		}
	case "birthday":
		if (r.Mode != "day" && r.Mode != "month") || r.PerUserLimit < 1 || r.PerUserLimit > 12 || r.ValidDays < 1 {
			return ErrInvalid
		}
		if r.Scope != "points" && r.Scope != "gift" && r.Scope != "discount" {
			return ErrInvalid
		}
		if r.Scope == "points" && r.Points < 1 || r.Scope == "gift" && r.ProductID == "" || r.Scope == "discount" && (r.RateBasisPoints < 1 || r.RateBasisPoints >= 10000) {
			return ErrInvalid
		}
	case "package":
		// 价格可以不填（0）：系统内收费关着时套餐只管时长；开着时没填价的套餐不能用来开台、预约（见 app 的 packageUsable）
		if r.RenewalMinutes < 0 || r.RenewalMinutes > 1440 || r.PauseLimitMinutes < 0 || r.PauseLimitMinutes > 1440 {
			return ErrInvalid
		}
		if r.UntilClose {
			if r.DurationMinutes != 0 || r.RenewalMinutes != 0 || r.PauseLimitMinutes != 0 {
				return ErrUntilClose
			}
		} else if r.DurationMinutes < 1 || r.DurationMinutes > 1440 {
			return ErrInvalid
		}
		if (r.RenewalMinutes == 0) != (r.RenewalCents == 0) || (r.Overtime != "manual" && r.Overtime != "free" && r.Overtime != "renewal") {
			return ErrInvalid
		}
		// 按续时方案自动加收要有续时方案；宽限只给它用
		if r.Overtime == "renewal" && r.RenewalMinutes < 1 {
			return ErrNoRenewal
		}
		if r.OvertimeGraceMinutes < 0 || r.OvertimeGraceMinutes > MaxOvertimeGraceMinutes || (r.Overtime != "renewal" && r.OvertimeGraceMinutes != 0) {
			return ErrInvalid
		}
	case "free_timing":
		if r.AmountCents < 1 || r.DurationMinutes != FreeTimingBlockMinutes {
			return ErrInvalid
		}
	case "companion":
		if r.AmountCents < 1 {
			return ErrInvalid
		}
	default:
		return ErrInvalid
	}
	return nil
}
func (s *State) Rules() []Rule {
	latest := map[string]Publication{}
	for _, p := range s.Publications {
		old, ok := latest[p.Rule.ID]
		if !ok || p.CreatedAt.After(old.CreatedAt) || (p.CreatedAt.Equal(old.CreatedAt) && p.ID > old.ID) {
			latest[p.Rule.ID] = p
		}
	}
	out := []Rule{}
	for _, p := range latest {
		if p.Rule.Enabled {
			out = append(out, p.Rule)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}
func (s *State) Rule(id string) (Rule, bool) {
	for _, r := range s.Rules() {
		if r.ID == id {
			return r, true
		}
	}
	return Rule{}, false
}
func (s *State) Kind(kind string) (Rule, bool) {
	for _, r := range s.Rules() {
		if r.Kind == kind {
			return r, true
		}
	}
	return Rule{}, false
}
func (s *State) History(user string) []Entry {
	out := []Entry{}
	for _, e := range s.Entries {
		if e.AccountID == user {
			if e.Points == nil {
				e.Points = []PointChange{}
			}
			out = append(out, e)
		}
	}
	sortHistory(out)
	return out
}

// sortHistory 按记账顺序排：时间先后，同一时刻按编号。
func sortHistory(history []Entry) {
	sort.Slice(history, func(i, j int) bool {
		if history[i].CreatedAt.Equal(history[j].CreatedAt) {
			return history[i].ID < history[j].ID
		}
		return history[i].CreatedAt.Before(history[j].CreatedAt)
	})
}
func (s *State) Lots(user string) map[string]PointChange {
	return lotsOf(s.History(user))
}

// lotsOf 是一位顾客（按记账顺序的流水）各积分批次的余量。
func lotsOf(history []Entry) map[string]PointChange {
	out := map[string]PointChange{}
	for _, e := range history {
		for _, p := range e.Points {
			x := out[p.LotID]
			x.LotID = p.LotID
			x.Delta += p.Delta
			if p.ExpiresAt != nil {
				x.ExpiresAt = p.ExpiresAt
			}
			out[p.LotID] = x
		}
	}
	return out
}

func (s *State) Balance(user string, now time.Time) Balance {
	return balanceOf(s.History(user), now)
}

// Balances 一次算出所有有流水的顾客的余额：只扫一遍全部流水再按顾客分组。员工总览要列出全部账户的余额，
// 逐个调 Balance 会让每位顾客都把全部流水扫一遍（账户数 × 流水数）。没有流水的顾客不在结果里，取零值余额即可。
func (s *State) Balances(now time.Time) map[string]Balance {
	byAccount := map[string][]Entry{}
	for _, e := range s.Entries {
		byAccount[e.AccountID] = append(byAccount[e.AccountID], e)
	}
	out := make(map[string]Balance, len(byAccount))
	for account, history := range byAccount {
		sortHistory(history)
		out[account] = balanceOf(history, now)
	}
	return out
}

// EmptyBalance 是没有任何流水的顾客的余额。
func EmptyBalance() Balance {
	return Balance{TierName: "普通会员", RateBasisPoints: 10000}
}

// balanceOf 由一位顾客按记账顺序的流水算出余额、可用与即将到期的积分和当前等级。
func balanceOf(history []Entry, now time.Time) Balance {
	b := EmptyBalance()
	total := int64(0)
	single := int64(0)
	reversed := map[string]bool{}
	for _, e := range history {
		if e.Kind == "recharge_refund" {
			reversed[e.SourceID] = true
		}
	}
	for _, e := range history {
		b.PrincipalCents += e.PrincipalCents
		b.GiftCents += e.GiftCents
		b.BoardUses += e.BoardUses
		if e.Kind == "recharge" && !reversed[e.ID] {
			total += e.PrincipalCents
			if e.PrincipalCents > single {
				single = e.PrincipalCents
			}
		}
	}
	for _, lot := range lotsOf(history) {
		if lot.ExpiresAt == nil || now.Before(*lot.ExpiresAt) {
			b.Points += lot.Delta
			if lot.ExpiresAt != nil && lot.ExpiresAt.Before(now.AddDate(0, 0, 30)) {
				b.ExpiringPoints += lot.Delta
			}
		}
	}
	// Tier snapshots protect an earned tier from later policy edits. Refunds revoke only their own grant.
	best := int64(0)
	for _, e := range history {
		if e.Kind != "tier" || e.Rule == nil || reversed[e.SourceID] {
			continue
		}
		r := *e.Rule
		if r.ValidDays > 0 && !now.Before(e.CreatedAt.AddDate(0, 0, r.ValidDays)) {
			continue
		}
		basis := total
		if r.Mode == "single" {
			basis = single
		}
		if basis >= r.AmountCents && r.AmountCents >= best {
			best = r.AmountCents
			b.TierName = r.Name
			b.RateBasisPoints = r.RateBasisPoints
		}
	}
	return b
}
func (s *State) SpendPoints(user string, n int64, now time.Time) ([]PointChange, error) {
	if n < 0 || n > Limit || s.Balance(user, now).Points < n {
		return nil, ErrBalance
	}
	lots := []PointChange{}
	for _, p := range s.Lots(user) {
		if p.Delta > 0 && (p.ExpiresAt == nil || now.Before(*p.ExpiresAt)) {
			lots = append(lots, p)
		}
	}
	sort.Slice(lots, func(i, j int) bool {
		a, b := lots[i], lots[j]
		if a.ExpiresAt == nil && b.ExpiresAt != nil {
			return false
		}
		if a.ExpiresAt != nil && b.ExpiresAt == nil {
			return true
		}
		if a.ExpiresAt != nil && b.ExpiresAt != nil && !a.ExpiresAt.Equal(*b.ExpiresAt) {
			return a.ExpiresAt.Before(*b.ExpiresAt)
		}
		return a.LotID < b.LotID
	})
	out := []PointChange{}
	for _, p := range lots {
		if n == 0 {
			break
		}
		v := p.Delta
		if v > n {
			v = n
		}
		p.Delta = -v
		out = append(out, p)
		n -= v
	}
	return out, nil
}
func Grant(id string, n int64, days int, now time.Time) []PointChange {
	if n == 0 {
		return []PointChange{}
	}
	p := PointChange{LotID: id, Delta: n}
	if days > 0 {
		t := now.AddDate(0, 0, days)
		p.ExpiresAt = &t
	}
	return []PointChange{p}
}

// ledger 是一位顾客当前的余额、智能豆板次数与积分批次，记账前在它上面核对流水能不能记。
type ledger struct {
	principal, gift, boardUses int64
	lots                       map[string]PointChange
}

func (s *State) ledger(user string, now time.Time) ledger {
	history := s.History(user)
	b := balanceOf(history, now)
	return ledger{principal: b.PrincipalCents, gift: b.GiftCents, boardUses: b.BoardUses, lots: lotsOf(history)}
}

// apply 把一条流水记到 l 上：本金、赠送余额、智能豆板次数或任一积分批次变负、超上限，返回 ErrBalance。
func (l *ledger) apply(e Entry, now time.Time) error {
	l.principal += e.PrincipalCents
	l.gift += e.GiftCents
	l.boardUses += e.BoardUses
	if l.principal < 0 || l.gift < 0 || l.principal > Limit || l.gift > Limit || l.boardUses < 0 || l.boardUses > Limit {
		return ErrBalance
	}
	for _, p := range e.Points {
		lot := l.lots[p.LotID]
		lot.Delta += p.Delta
		if lot.Delta < 0 || lot.Delta > Limit {
			return ErrBalance
		}
		l.lots[p.LotID] = lot
	}
	total := int64(0)
	for _, lot := range l.lots {
		if lot.ExpiresAt == nil || now.Before(*lot.ExpiresAt) {
			total += lot.Delta
		}
	}
	if total > Limit {
		return ErrBalance
	}
	return nil
}

func (s *State) Append(e Entry, now time.Time) error {
	l := s.ledger(e.AccountID, now)
	if err := l.apply(e, now); err != nil {
		return err
	}
	if _, ok := s.Entries[e.ID]; ok {
		return ErrInvalid
	}
	e.BalanceAfter = &BalanceAfter{PrincipalCents: l.principal, GiftCents: l.gift, BoardUses: l.boardUses}
	encoded, _ := json.Marshal(e)
	var immutable Entry
	_ = json.Unmarshal(encoded, &immutable)
	s.Entries[e.ID] = immutable
	return nil
}

// Reverse 是冲正 original 的流水：本金、赠送余额、智能豆板次数和每个积分批次都取反，记在原批次上（保留原到期时间）。
// SourceID 指向原流水；ID、种类、原因、时间由调用方填。
func Reverse(original Entry) Entry {
	e := Entry{AccountID: original.AccountID, SourceID: original.ID, PrincipalCents: -original.PrincipalCents, GiftCents: -original.GiftCents, BoardUses: -original.BoardUses}
	for _, p := range original.Points {
		p.Delta = -p.Delta
		e.Points = append(e.Points, p)
	}
	return e
}

// PointSpend 是一条流水从指定积分批次里用掉的积分。
type PointSpend struct {
	// Kind 是用掉积分的流水种类：checkout（会员结账抵扣，SourceID 是那张订单）、exchange（积分兑换）、adjust（老板纠错扣减）。
	Kind      string    `json:"kind"`
	SourceID  string    `json:"sourceId"`
	Points    int64     `json:"points"`
	CreatedAt time.Time `json:"createdAt"`
}

// SpentFrom 列出从 lots 这些积分批次里用掉积分、且还没退回的流水，按记账先后。
// 会员结账单退款收不回本单所送积分时，用它说明积分去了哪里。用掉积分的结账单退过款（整单或部分）的，
// 扣掉退回到这些批次的分数，退完的不再列出。
func (s *State) SpentFrom(user string, lots map[string]bool) []PointSpend {
	history := s.History(user)
	restored := map[string]int64{}
	for _, e := range history {
		if e.Kind != "refund" {
			continue
		}
		for _, p := range e.Points {
			if lots[p.LotID] && p.Delta > 0 {
				restored[e.SourceID] += p.Delta
			}
		}
	}
	out := []PointSpend{}
	for _, e := range history {
		if e.Kind == "refund" {
			continue
		}
		n := -restored[e.ID]
		for _, p := range e.Points {
			if lots[p.LotID] && p.Delta < 0 {
				n -= p.Delta
			}
		}
		if n > 0 {
			out = append(out, PointSpend{Kind: e.Kind, SourceID: e.SourceID, Points: n, CreatedAt: e.CreatedAt})
		}
	}
	return out
}

// CanReverse 核对按顺序整条冲正 originals（同一位顾客的流水）现在能不能记账，不改任何状态。
func (s *State) CanReverse(user string, originals []Entry, now time.Time) error {
	reversals := make([]Entry, 0, len(originals))
	for _, original := range originals {
		reversals = append(reversals, Reverse(original))
	}
	return s.CanApply(user, reversals, now)
}
func (s *State) Count(user, kind, rule string, year int) int {
	n := 0
	for _, e := range s.Entries {
		if e.AccountID == user && e.Kind == kind && e.Rule != nil && e.Rule.ID == rule && (year == 0 || e.CreatedAt.In(storetime.Location).Year() == year) {
			n++
		}
	}
	return n
}
func (s *State) BirthdayEligible(user string, r Rule, now time.Time) bool {
	p := s.Profiles[user]
	if len(p.Birthday) != 5 {
		return false
	}
	local := now.In(storetime.Location)
	if s.Count(user, "birthday", r.ID, local.Year()) >= r.PerUserLimit {
		return false
	}
	if r.Mode == "month" {
		return p.Birthday[:2] == local.Format("01")
	}
	return p.Birthday == local.Format("01-02")
}
