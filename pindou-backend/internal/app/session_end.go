package app

import (
	"errors"
	"fmt"
	"time"

	ordersdomain "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/orders/domain"
	"github.com/yreidev/pindou-studio/pindou-backend/internal/storetime"
)

// 结束计时并放座（2026-10-10 业主定）：门店的钱都在美团、大众点评收，系统内收费关着时没有结账，店员点「结束」就结束
// 这一台、放出座位，会话状态是 ended（已结束，没经过收款）。按座会话走 /loyalty/actions 的 end，整桌会话走
// PATCH /venue-sessions/{id} 的 end: true，都要带幂等键、单独提交，所有员工都能点。

var (
	errBillingOn = loyaltyRefusal{409, "billing_enabled", errors.New("系统内收费开着，请去结账：收款或免单后自动放座")}
	errEnded     = errors.New("这一台已经结束了")
)

// endSession 结束一台进行中的会话：暂停中的先结束暂停（按座会话的暂停只算到套餐上限），计时停在这一刻（已停止计时的
// 保留原来的停止时刻），状态改成 ended；座位和预约占用随之放开（只有 active、paused、companion 算进行中）。
// 开关打开之前建的草稿单一并作废；收过一部分钱的单不能结束，先在结账页收齐或免单。系统内收费开着时不能用。
func (s *Server) endSession(q *txn, u *User, reqID string, x *TableSession) error {
	if !liveSession(x) {
		return errEnded
	}
	if q.billingEnabled() {
		return errBillingOn
	}
	orders := q.ordersOfSession(x.ID)
	for _, o := range orders {
		if o.Status == ordersdomain.StatusPartiallyPaid {
			return loyaltyRefusal{409, "partially_paid", fmt.Errorf("这一台的订单已经收了 ¥%s，不能直接结束；请在结账页把剩下的收齐或对剩余免单", yuanText(o.PaidCents))}
		}
	}
	now := q.now()
	s.endPause(q, x, now)
	if x.StoppedAt == nil {
		x.StoppedAt = &now
	}
	x.Status = "ended"
	used := x.StoppedAt.Sub(x.StartedAt) - time.Duration(x.PausedSeconds)*time.Second
	q.audit(u.ID, "venue_session.ended", x.ID, fmt.Sprintf("开始于 %s，%s，结束时已用 %d 分钟（不含暂停）",
		x.StartedAt.In(storetime.Location).Format("01-02 15:04"), sessionTimingText(*x), max(0, int64(used/time.Minute))), reqID)
	for _, o := range orders {
		if o.Status == ordersdomain.StatusDraft {
			o.Status = ordersdomain.StatusVoided
			q.audit(u.ID, "order.voided", o.ID, "结束计时，作废草稿（应收 ¥"+yuanText(o.ReceivableCents)+"）", reqID)
		}
	}
	return nil
}
