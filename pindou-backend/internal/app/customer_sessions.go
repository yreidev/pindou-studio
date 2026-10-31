package app

import (
	"net/http"
	"sort"
	"time"
)

// 顾客自己的整桌计时（GET /venue-sessions/me）。
//
// 员工从桌位「开台」时可以绑定一位顾客的账户：这种整桌会话没有入座申请，不在 /loyalty/me 的 admissions 里，
// 顾客的「本次手作」页原先就看不到它，也就叫不了店员（2026-10-06 业主真机发现）。这里把它单独给顾客：
// 只列本人名下、还在进行中（计时中、暂停、陪客，含停止计时等结账）的整桌会话；扫码入座、到店开台的按座会话
// 已经在 admissions 里，不重复列。计时数字和桌位接口同一套算法（sessionClock），按读取时刻算好；
// 不带金额估算（会员价、积分、另加的商品都会让它和实际应收对不上），也不带员工或别的顾客的信息。
// 会话的增改都写回 venue_sessions，归属账户就是顾客自己，实时事件按归属自动推给本人（见 txn.owners）。

// mySessionView 是顾客看的一次整桌计时。定时的才有结束时间、剩余与超时，自由计时省略这几项。
type mySessionView struct {
	ID              string    `json:"id"`
	TableID         string    `json:"serviceTableId"`
	TableCode       string    `json:"tableCode"`
	StartedAt       time.Time `json:"startedAt"`
	TimingMode      string    `json:"timingMode"`
	DurationMinutes int       `json:"durationMinutes,omitempty"`
	// DisplayStatus：running 计时中、paused 暂停中（时间不走）、companion 陪客、stopped 已停止计时等结账。
	DisplayStatus    string     `json:"displayStatus"`
	ElapsedSeconds   int64      `json:"elapsedSeconds"`
	EndsAt           *time.Time `json:"endsAt,omitempty"`
	RemainingSeconds *int64     `json:"remainingSeconds,omitempty"`
	OverdueSeconds   *int64     `json:"overdueSeconds,omitempty"`
	TimingStatus     string     `json:"timingStatus,omitempty"`
	// CanCallStaff 是此刻能不能为这次计时呼叫店员，和 POST /service-calls 用同一条规则（callableSession）。
	CanCallStaff bool `json:"canCallStaff"`
}

// mySessions 是登录者本人名下、进行中的整桌计时，先开的在前。
func (s *Server) mySessions(w http.ResponseWriter, r *http.Request) {
	u, ok := s.signedIn(w, r)
	if !ok {
		return
	}
	q := s.tx(r)
	var mine []*TableSession
	for _, x := range q.liveSessionsOf(u.ID) {
		// 按座会话（扫码入座、到店开台）都挂着入座申请，在 /loyalty/me 的 admissions 里
		if x.AdmissionID == "" {
			mine = append(mine, x)
		}
	}
	sort.Slice(mine, func(i, j int) bool {
		if !mine[i].StartedAt.Equal(mine[j].StartedAt) {
			return mine[i].StartedAt.Before(mine[j].StartedAt)
		}
		return mine[i].ID < mine[j].ID
	})
	out := make([]mySessionView, 0, len(mine))
	for _, x := range mine {
		out = append(out, s.mySessionView(q, x))
	}
	writeJSON(w, 200, out)
}

func (s *Server) mySessionView(q *txn, x *TableSession) mySessionView {
	v := mySessionView{
		ID: x.ID, TableID: x.TableID, StartedAt: x.StartedAt,
		TimingMode: x.TimingMode, DurationMinutes: x.DurationMinutes,
		DisplayStatus: sessionDisplayStatus(x), CanCallStaff: callableSession(x),
	}
	// 会话有外键，桌一定在；桌位编码是布局里的（A1、B3…），桌上贴的就是它
	if t := q.table(x.TableID); t != nil {
		v.TableCode = t.Code
	}
	_, endsAt, remaining := s.sessionClock(q, x)
	// 已用 = 约定时长 − 剩余：两者出自同一个结束时间，加起来正好是约定时长；自由计时约定时长为 0，剩余就是负的已用
	v.ElapsedSeconds = max(int64(0), int64(x.DurationMinutes)*60-remaining)
	if x.TimingMode == "free" {
		return v
	}
	left, over := max(int64(0), remaining), max(int64(0), -remaining)
	v.EndsAt, v.RemainingSeconds, v.OverdueSeconds = &endsAt, &left, &over
	v.TimingStatus = timingStatusOf(remaining)
	return v
}

// sessionDisplayStatus 是会话此刻在顾客页上的状态。停止计时的会话已存状态仍是计时中，单看 stoppedAt。
func sessionDisplayStatus(x *TableSession) string {
	switch {
	case x.StoppedAt != nil:
		return "stopped"
	case x.Status == "paused":
		return "paused"
	case x.Status == "companion":
		return "companion"
	}
	return "running"
}

// sessionClock 是一次计时此刻的钟面，桌位接口（tableView）和顾客的整桌计时共用，两边的数字一致：
//   - at：按哪一刻算——现在；停止计时的停在停止那一刻。
//   - endsAt：结束时间，暂停的时间顺延；按座会话只顺延套餐允许的免费暂停，超出的部分照常计时。
//     自由计时没有约定时长，endsAt 就是「开始 + 暂停」。
//   - remaining：从 at 到 endsAt 还剩的秒数，负数是超时了多久。
func (s *Server) sessionClock(q *txn, x *TableSession) (at, endsAt time.Time, remaining int64) {
	at = q.now()
	if x.StoppedAt != nil {
		at = *x.StoppedAt
	}
	// 定时的结束时间与预约占用用同一个算法（sessionEndsAt）；自由计时没有结束时间，按开始加暂停算，剩余就是负的已用
	endsAt, timed := sessionEndsAt(q, x, at)
	if !timed {
		endsAt = x.Deadline(at)
	}
	return at, endsAt, int64(endsAt.Sub(at) / time.Second)
}

// timingStatusOf 是定时计时的提醒档：剩余 10 分钟以内快到点（expiring），过了结束时间已超时（overdue）。
func timingStatusOf(remaining int64) string {
	switch {
	case remaining < 0:
		return "overdue"
	case remaining <= 600:
		return "expiring"
	}
	return "running"
}
