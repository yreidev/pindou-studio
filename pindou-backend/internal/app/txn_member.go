package app

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sort"
	"time"

	memberapp "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/membership/application"
	records "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/persistence/infrastructure/postgres"
	"github.com/yreidev/pindou-studio/pindou-backend/internal/storage/queries"
	"github.com/yreidev/pindou-studio/pindou-backend/internal/storetime"
)

// memberWorkset 是会员数据的工作集。会员模块的计算（余额、积分批次、记账核对）都在一个 State 上做，
// 所以这里按需往同一个 State 里装：规则草稿与发布记录（不多）整份装；顾客的资料、流水、入座申请按账户
// 整份装——余额要用到这位顾客的全部流水，只装一部分算出来就是错的。
type memberWorkset struct {
	state    *memberapp.State
	rules    bool
	accounts map[string]bool
	clean    map[string]map[string][]byte
	owners   map[string]map[string]string
}

func newMemberWorkset() *memberWorkset {
	m := &memberWorkset{state: memberapp.New(), accounts: map[string]bool{}, clean: map[string]map[string][]byte{}, owners: map[string]map[string]string{}}
	for _, sub := range []string{"drafts", "publications", "profiles", "entries", "admissions"} {
		m.clean[sub] = map[string][]byte{}
		m.owners[sub] = map[string]string{}
	}
	return m
}

func (m *memberWorkset) remember(q *txn, sub, key string, v any, owner string) {
	if !q.write {
		return
	}
	b, err := json.Marshal(v)
	q.fail(err)
	m.clean[sub][key] = b
	m.owners[sub][key] = owner
}

// membership 返回装好了规则草稿与发布记录的会员状态。
func (q *txn) membership() *memberapp.State {
	m := q.member
	if m.rules {
		return m.state
	}
	m.rules = true
	for _, r := range stateRows(must(q.db().MembershipDrafts(q.ctx))) {
		var rule memberapp.Rule
		q.fail(json.Unmarshal(r.state, &rule))
		m.state.Drafts[r.id] = rule
		m.remember(q, "drafts", r.id, rule, "")
	}
	for _, r := range stateRows(must(q.db().MembershipPublications(q.ctx))) {
		var pub memberapp.Publication
		q.fail(json.Unmarshal(r.state, &pub))
		m.state.Publications[r.id] = pub
		m.remember(q, "publications", r.id, pub, "")
	}
	return m.state
}

// memberAccount 返回装好了这位顾客全部资料、流水和入座申请的会员状态（也带规则）。
func (q *txn) memberAccount(accounts ...string) *memberapp.State {
	st := q.membership()
	m := q.member
	for _, account := range accounts {
		if account == "" || m.accounts[account] || !validID(account) {
			continue
		}
		m.accounts[account] = true
		for _, r := range stateRows(must(q.db().MembershipProfilesOf(q.ctx, account))) {
			var p memberapp.Profile
			q.fail(json.Unmarshal(r.state, &p))
			st.Profiles[r.id] = p
			m.remember(q, "profiles", r.id, p, r.id)
		}
		for _, r := range stateRows(must(q.db().MembershipEntriesOf(q.ctx, account))) {
			var e memberapp.Entry
			q.fail(json.Unmarshal(r.state, &e))
			st.Entries[r.id] = e
			m.remember(q, "entries", r.id, e, e.AccountID)
		}
		for _, r := range stateRows(must(q.db().MembershipAdmissionsOf(q.ctx, account))) {
			var a memberapp.Admission
			q.fail(json.Unmarshal(r.state, &a))
			st.Admissions[r.id] = a
			m.remember(q, "admissions", r.id, a, a.AccountID)
		}
	}
	return st
}

// admission 按编号找入座申请，连同申请人的全部会员数据一起装进来；没有返回 false。
func (q *txn) admission(id string) (memberapp.Admission, bool) {
	st := q.membership()
	if a, ok := st.Admissions[id]; ok {
		return a, true
	}
	if !validID(id) {
		return memberapp.Admission{}, false
	}
	accounts := must(q.db().AdmissionAccount(q.ctx, id))
	if len(accounts) == 0 {
		return memberapp.Admission{}, false
	}
	st = q.memberAccount(accounts[0])
	a, ok := st.Admissions[id]
	return a, ok
}

// checkouts 是这些订单的会员结账汇总。只读出指向这些订单的结账与送分流水算，不装进工作集
// （那只是顾客流水的一部分，拿来算余额会算错）。
func (q *txn) checkouts(orderIDs []string) map[string]memberapp.CheckoutSummary {
	if len(orderIDs) == 0 {
		return map[string]memberapp.CheckoutSummary{}
	}
	st := memberapp.New()
	for _, r := range stateRows(must(q.db().CheckoutEntries(q.ctx, orderIDs))) {
		var e memberapp.Entry
		q.fail(json.Unmarshal(r.state, &e))
		st.Entries[r.id] = e
	}
	return st.Checkouts()
}

// flush 写回会员数据里改过和新建的记录。顾客名下的记录只能属于已整份装进来的顾客，
// 否则说明代码没先装数据就记了账（余额核对会算错），直接报错。
func (m *memberWorkset) flush(q *txn) {
	st := m.state
	flushMember(q, m, "profiles", st.Profiles, func(key string, _ memberapp.Profile) string { return key })
	flushMember(q, m, "entries", st.Entries, func(_ string, e memberapp.Entry) string { return e.AccountID })
	flushMember(q, m, "admissions", st.Admissions, func(_ string, a memberapp.Admission) string { return a.AccountID })
	flushMember(q, m, "drafts", st.Drafts, nil)
	flushMember(q, m, "publications", st.Publications, nil)
}

func flushMember[V any](q *txn, m *memberWorkset, sub string, items map[string]V, owner func(string, V) string) {
	if len(items) == 0 {
		return
	}
	changed := map[string]V{}
	prints := map[string][]byte{}
	keys := make([]string, 0, len(items))
	for key := range items {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		v := items[key]
		b, err := json.Marshal(v)
		q.fail(err)
		if old, ok := m.clean[sub][key]; ok && bytes.Equal(old, b) {
			continue
		}
		if owner != nil {
			if account := owner(key, v); account != "" && !m.accounts[account] {
				panic(fmt.Sprintf("membership %s %s belongs to account %s, which was not loaded", sub, key, account))
			}
		}
		changed[key] = v
		prints[key] = b
	}
	if len(changed) == 0 {
		return
	}
	doc, err := json.Marshal(map[string]any{"Membership": map[string]any{sub: changed}})
	q.fail(err)
	q.fail(records.SaveMembership(q.ctx, q.tx, sub, doc))
	for key, v := range changed {
		if old := m.owners[sub][key]; old != "" {
			q.owners[old] = true
		}
		account := ""
		if owner != nil {
			account = owner(key, v)
		}
		if account != "" {
			q.owners[account] = true
		}
		m.clean[sub][key] = prints[key]
		m.owners[sub][key] = account
	}
}

// balancesOf 是一组顾客的余额（只读这些人的流水）。没有流水的顾客不在结果里。
func (q *txn) balancesOf(accounts []string, now time.Time) map[string]memberapp.Balance {
	st := memberapp.New()
	if len(accounts) == 0 {
		return st.Balances(now)
	}
	for _, r := range stateRows(must(q.db().MembershipEntriesOfAccounts(q.ctx, accounts))) {
		var e memberapp.Entry
		q.fail(json.Unmarshal(r.state, &e))
		st.Entries[r.id] = e
	}
	return st.Balances(now)
}

// shiftAdmissions 是员工总览可能要看的入座申请（只读展示用，不进工作集）：最近 30 分钟内的待确认申请、
// 今天（门店日期）申请的、计时还在进行或今天结束的。准确的取舍由 onShift 再判一遍。
func (q *txn) shiftAdmissions(now time.Time) []memberapp.Admission {
	local := now.In(storetime.Location)
	today := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, storetime.Location)
	rows := stateRows(must(q.db().ShiftAdmissions(q.ctx, queries.ShiftAdmissionsParams{Today: today, Since: now.Add(-memberapp.AdmissionWindow)})))
	out := make([]memberapp.Admission, 0, len(rows))
	for _, r := range rows {
		var a memberapp.Admission
		q.fail(json.Unmarshal(r.state, &a))
		out = append(out, a)
	}
	return out
}
