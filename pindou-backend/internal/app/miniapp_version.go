package app

import (
	"errors"
	"net/http"
	"regexp"
	"time"

	"github.com/yreidev/pindou-studio/pindou-backend/internal/storage/queries"
)

var miniappVersionPattern = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+$`)

type miniappVersionObservation struct {
	Version    string    `json:"version"`
	ReportedAt time.Time `json:"reportedAt"`
}

func (s *Server) getMiniappVersion(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.staffMember(w, r); !ok {
		return
	}
	var release *miniappVersionObservation
	rows := must(s.tx(r).db().MiniappVersionObservation(r.Context()))
	if len(rows) != 0 {
		release = &miniappVersionObservation{Version: rows[0].Version, ReportedAt: rows[0].ReportedAt}
	}
	writeJSON(w, 200, map[string]any{"release": release})
}

func (s *Server) reportMiniappVersion(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.staffMember(w, r); !ok {
		return
	}
	q := s.tx(r)
	if q.currentSession(r).Client != clientMiniapp {
		s.writeError(w, r, 403, "forbidden", errors.New("只能从员工小程序上报运行版本"))
		return
	}
	var in struct {
		EnvVersion string `json:"envVersion"`
		Version    string `json:"version"`
	}
	if err := decode(r, &in); err != nil {
		s.writeError(w, r, 400, "invalid_request", err)
		return
	}
	if in.EnvVersion != "release" || len(in.Version) > 32 || !miniappVersionPattern.MatchString(in.Version) {
		s.writeError(w, r, 400, "invalid_request", errors.New("只接收正式版的小程序版本号（如 0.0.39）"))
		return
	}
	at := q.now()
	q.fail(q.dbWrite().SaveMiniappVersionObservation(q.ctx, queries.SaveMiniappVersionObservationParams{
		Version: in.Version, ReportedAt: at,
	}))
	writeJSON(w, 200, map[string]any{"release": miniappVersionObservation{Version: in.Version, ReportedAt: at}})
}
