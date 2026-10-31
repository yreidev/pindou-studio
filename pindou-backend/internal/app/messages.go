package app

import (
	"errors"
	"net/http"
	"strconv"
	"time"

	member "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/membership/application"
	"github.com/yreidev/pindou-studio/pindou-backend/internal/storetime"
)

type message struct {
	ID          string         `json:"id"`
	Kind        string         `json:"kind"`
	At          time.Time      `json:"at"`
	Unread      bool           `json:"unread"`
	Entry       *member.Entry  `json:"entry,omitempty"`
	Reservation map[string]any `json:"reservation,omitempty"`
}

type messageFeed struct {
	Items       []message `json:"items"`
	UnreadCount int64     `json:"unreadCount"`
}

// myMessages 始终按当前会话的账户读，员工身份也不扩大范围。
func (s *Server) myMessages(w http.ResponseWriter, r *http.Request) {
	u, ok := s.signedIn(w, r)
	if !ok {
		return
	}
	limit := 200
	if values, present := r.URL.Query()["limit"]; present {
		var err error
		if len(values) != 1 {
			err = errors.New("最多只能填一个 limit")
		} else {
			limit, err = strconv.Atoi(values[0])
		}
		if err != nil || limit < 1 || limit > 200 {
			s.writeError(w, r, 400, "invalid_request", errors.New("limit 须为 1～200 的整数"))
			return
		}
	}
	writeJSON(w, 200, s.messagesFor(s.tx(r), u.ID, limit))
}

// messagesFor 在同一个请求快照里取消息与未读数，预约复用顾客本人的展示条目。
func (s *Server) messagesFor(q *txn, account string, limit int) messageFeed {
	now := q.now()
	records, unread := q.messagesOf(account, now.In(storetime.Location).AddDate(0, 0, -90), now, limit)
	out := messageFeed{Items: make([]message, 0, len(records)), UnreadCount: unread}
	reservations := []map[string]any{}
	var tables map[string]*Table
	grace := 0
	for _, record := range records {
		item := message{ID: record.id, Kind: record.kind, At: record.at, Unread: record.unread, Entry: record.entry}
		if record.reservation != nil {
			if tables == nil {
				tables = map[string]*Table{}
				for _, table := range q.allTables() {
					tables[table.ID] = table
				}
				grace = q.reservationSettings().GraceMinutes
			}
			item.Reservation = reservationEntry(*record.reservation, false, now, grace, tables, nil)
			reservations = append(reservations, item.Reservation)
		}
		out.Items = append(out.Items, item)
	}
	// 和 /reservations/me 一样，门店开了微信通知时附上本人已经允许过的通知种类。
	if len(reservations) > 0 {
		s.addNoticeView(q, map[string]any{"reservations": reservations})
	}
	return out
}

func (s *Server) markMyMessagesRead(w http.ResponseWriter, r *http.Request) {
	u, ok := s.signedIn(w, r)
	if !ok {
		return
	}
	q := s.tx(r)
	q.markMessagesRead(u.ID, q.now())
	w.WriteHeader(http.StatusNoContent)
}
