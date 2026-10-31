package app

import (
	"encoding/json"
	"time"

	member "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/membership/application"
	"github.com/yreidev/pindou-studio/pindou-backend/internal/storage/queries"
)

type messageRecord struct {
	id, kind    string
	at          time.Time
	unread      bool
	entry       *member.Entry
	reservation *Reservation
}

// messagesOf 只读本人在时间范围内的消息，窗口统计保留 limit 截取之前的未读总数。
func (q *txn) messagesOf(account string, since, now time.Time, limit int) ([]messageRecord, int64) {
	rows := must(q.db().MyMessages(q.ctx, queries.MyMessagesParams{AccountID: account, Since: since, Now: now, MaxItems: int32(limit)})) //nolint:gosec // handler 已核对 1～200
	out := make([]messageRecord, 0, len(rows))
	var unread int64
	for _, row := range rows {
		x := messageRecord{id: row.ID, kind: row.Kind, at: row.At, unread: row.Unread}
		if row.Kind == "loyalty" {
			x.entry = new(member.Entry)
			q.fail(json.Unmarshal(row.State, x.entry))
			if x.entry.Points == nil {
				x.entry.Points = []member.PointChange{}
			}
		} else {
			x.reservation = new(Reservation)
			q.fail(json.Unmarshal(row.State, x.reservation))
		}
		out = append(out, x)
		unread = row.UnreadCount
	}
	return out, unread
}

func (q *txn) markMessagesRead(account string, at time.Time) {
	q.fail(q.dbWrite().MarkMessagesRead(q.ctx, queries.MarkMessagesReadParams{AccountID: account, ReadAt: at}))
}
