package domain

import (
	"errors"
	"time"
)

// ErrCompanionTiming 是给陪客会话暂停或继续：陪客标记只记在 status 上，一暂停再继续就丢了，
// 建单会按套餐价收陪客的钱。陪客不计费，暂停没有意义；收费政策定下来之前不许改。
var ErrCompanionTiming = errors.New("陪客不计时，不能暂停或继续；标错了请撤销开台后重新开台")

// ChangeStatus 是员工改计时状态（计时中、暂停、陪客）：陪客会话不能再改成暂停或计时中。
func (s *Session) ChangeStatus(status string, now time.Time) error {
	if s.Status == "companion" && status != "companion" {
		return ErrCompanionTiming
	}
	s.Transition(status, now)
	return nil
}

// Session tracks elapsed service time independently from wall-clock pauses.
type Session struct {
	SeatNumber      int        `json:"seatNumber,omitempty"`
	AdmissionID     string     `json:"admissionId,omitempty"`
	StoppedAt       *time.Time `json:"stoppedAt,omitempty"`
	ID              string     `json:"id"`
	TableID         string     `json:"serviceTableId"`
	UserID          string     `json:"accountId,omitempty"`
	Status          string     `json:"status"`
	StartedAt       time.Time  `json:"startedAt"`
	TimingMode      string     `json:"timingMode"`
	DurationMinutes int        `json:"durationMinutes,omitempty"`
	PausedAt        *time.Time `json:"pausedAt,omitempty"`
	PausedSeconds   int64      `json:"pausedSeconds"`
	// UntilClose 是开到当天打烊的一台（整桌「开到打烊」或按座「到打烊」的套餐，2026-10-10 业主定）：时长是开台时算到打烊的
	// 分钟数，结束时间固定在打烊，不能暂停、续时、改时长或计时方式。
	UntilClose bool `json:"untilClose,omitempty"`
	// Tariff 是整桌会话开台那一刻生效的计时价（2026-10-06 业主定：按开台时的价算，之后老板改价发布不影响这一台；
	// 续时、改时长或计时方式、标记陪客也都按它算）。只存在会话的 state 里，不进接口响应。
	// 按座会话的价在入座申请的套餐快照里，这里为空；更早开的整桌会话没有它（nil），按当时生效的规则算。
	Tariff *Tariff `json:"tariff,omitempty"`
}

func (s *Session) Transition(status string, now time.Time) {
	if s.Status == "paused" && status != "paused" && s.PausedAt != nil {
		seconds := int64(now.Sub(*s.PausedAt) / time.Second)
		if seconds > 0 {
			s.PausedSeconds += seconds
		}
		s.PausedAt = nil
	}
	if s.Status != "paused" && status == "paused" {
		s.PausedAt = &now
	}
	s.Status = status
}

func (s Session) Deadline(now time.Time) time.Time {
	pause := time.Duration(s.PausedSeconds) * time.Second
	if s.Status == "paused" && s.PausedAt != nil && now.After(*s.PausedAt) {
		pause += now.Sub(*s.PausedAt)
	}
	return s.StartedAt.Add(time.Duration(s.DurationMinutes)*time.Minute + pause)
}
