package app

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"time"

	records "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/persistence/infrastructure/postgres"
)

// persistedUserPrivate 是账户 state 之外的私密字段（手机号另存一列）：隐私同意的版本与时间、注册时间。
type persistedUserPrivate struct {
	PrivacyContractVersion string
	PrivacyAcceptedAt      time.Time
	CreatedAt              time.Time
}

// snapshotOf 是这个事务里看到的全部业务数据（快照形状的 JSON，见 records.Load）：数据导出与测试核对「什么都没变」用。
func snapshotOf(q *txn) []byte {
	q.flush()
	data, err := records.Load(q.ctx, q.tx)
	q.fail(err)
	return data
}

// Snapshot 是库里当前的全部业务数据（快照形状的 JSON）。
func (s *Server) Snapshot() []byte {
	var data []byte
	if err := s.read(context.Background(), func(q *txn) { data = snapshotOf(q) }); err != nil {
		panic(err)
	}
	return data
}

// exportData 给老板下载当前全部数据的 JSON 存档（留底和技术排查用，后台不能导回）。
// 以前的「应用内备份」把整份数据存进内存和数据库，每份都让之后的每次写变慢、几份就能撑爆内存，
// 而且业务历史只增不减，备份之后只要有一笔新业务就恢复不了；灾难恢复改用数据库备份（见部署说明）。
// 导出含完整手机号，所以只给老板、并且留审计。
func (s *Server) exportData(w http.ResponseWriter, r *http.Request) {
	u, e := s.userFor(r)
	if e != nil {
		s.writeError(w, r, 401, "unauthorized", e)
		return
	}
	if !hasRole(u, Owner) {
		s.writeError(w, r, 403, "forbidden", errForbidden)
		return
	}
	q := s.tx(r)
	var doc map[string]json.RawMessage
	q.fail(json.Unmarshal(snapshotOf(q), &doc))
	doc["Idem"] = json.RawMessage("null") // 重放缓存不是业务数据
	body, err := json.Marshal(doc)
	q.fail(err)
	q.audit(u.ID, "data.exported", "", "", requestID(r))
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Disposition", `attachment; filename="pindou-data.json"`)
	w.WriteHeader(200)
	_, _ = w.Write(body)
}

func (s *Server) listAudit(w http.ResponseWriter, r *http.Request) {
	u, e := s.userFor(r)
	if e != nil {
		s.writeError(w, r, 401, "unauthorized", e)
		return
	}
	if !hasRole(u, Manager, Owner) {
		s.writeError(w, r, 403, "forbidden", errForbidden)
		return
	}
	query := r.URL.Query()
	page, pageSize, err := pageParams(query)
	if err != nil {
		s.writeError(w, r, 400, "invalid_request", err)
		return
	}
	// q 匹配动作代码、对象编号、请求编号、原因、操作人编号与昵称；actions 是网页按中文动作名对上的动作代码
	// （中文名只在网页端），命中其一即算。都不带时不筛。新的在前。
	needle := strings.ToLower(strings.TrimSpace(query.Get("q")))
	actions := []string{}
	for _, action := range strings.Split(query.Get("actions"), ",") {
		if action = strings.TrimSpace(action); action != "" {
			actions = append(actions, action)
		}
	}
	q := s.tx(r)
	audits, total := q.auditPage(needle, actions, page, pageSize)
	if pageSize > 0 {
		setPageHeaders(w, page, pageSize, total)
	}
	actors := make([]string, 0, len(audits))
	for _, a := range audits {
		actors = append(actors, a.ActorID)
	}
	labels := q.accountLabels(actors)
	out := make([]map[string]any, 0, len(audits))
	for _, a := range audits {
		// actor 是操作人的称呼，系统操作（accountId 为 system）为 null
		out = append(out, map[string]any{"id": a.ID, "action": a.Action, "objectId": a.ObjectID, "reason": a.Reason, "accountId": a.ActorID,
			"actor": labelOf(labels, a.ActorID), "requestId": a.RequestID, "createdAt": a.CreatedAt})
	}
	writeJSON(w, 200, out)
}

// LogScale 在启动时记一行数据规模，规模涨上来能从日志里看出来。
func (s *Server) LogScale() {
	_ = s.read(context.Background(), func(q *txn) {
		n := must(q.db().DataScale(q.ctx))
		slog.Info("state loaded", "accounts", n.Accounts, "orders", n.Orders, "movements", n.Movements, "loyaltyEntries", n.LoyaltyEntries, "audits", n.Audits)
	})
}
