package app

import (
	"net/http"
	"strings"
	"testing"
	"time"
)

// 整桌开台也能停止计时（2026-10-06 业主定，同按座会话）：停在这一刻、计价冻结（草稿按停止时刻算并存下），
// 座位保留到结账；之后不能再暂停、继续、续时或改计时，换桌、撤销开台、去结账照旧。写法同续时：幂等键必带。
func TestWholeTableStopFreezesTiming(t *testing.T) {
	p := newPolicyShop(t)
	p.renewalPackage(t)
	session := p.open(t, "S1", map[string]any{"timingMode": "timed", "durationMinutes": 60})
	patch := func(key string, body map[string]any) (int, map[string]any) {
		t.Helper()
		w := call(t, p.s, http.MethodPatch, "/api/v2/venue-sessions/"+session, p.owner.AccessToken, key, body)
		return w.Code, decodeMap(t, w)
	}
	p.at(5 * time.Minute)
	draft := p.checkout(t, session)
	orderID := draft["id"].(string)

	p.at(80 * time.Minute)
	if code, out := patch(id(), map[string]any{"status": "paused"}); code != 200 {
		t.Fatalf("暂停：%d %v", code, out)
	}
	p.at(95 * time.Minute) // 暂停中停止：先结束暂停（15 分钟不计），用了 80 分钟、超时 20 分钟，加收 1 块

	// 停止计时要带幂等键、单独提交
	if code, out := patch("", map[string]any{"stop": true}); code != 400 || out["code"] != "idempotency_required" {
		t.Fatalf("停止计时没带幂等键：%d %v", code, out)
	}
	if code, out := patch(id(), map[string]any{"stop": true, "status": "active"}); code != 400 || out["code"] != "invalid_session" {
		t.Fatalf("停止计时和别的修改一起提交：%d %v", code, out)
	}
	if code, out := patch(id(), map[string]any{"stop": false}); code != 400 {
		t.Fatalf("stop 只能为 true：%d %v", code, out)
	}

	code, stopped := patch("stop-s1", map[string]any{"stop": true})
	if code != 200 || stopped["stoppedAt"] == nil || stopped["status"] != "active" || stopped["pausedAt"] != nil {
		t.Fatalf("停止计时：%d %v", code, stopped)
	}
	if x := sessionOf(t, p.s, session); x.StoppedAt == nil || !x.StoppedAt.Equal(p.t0.Add(95*time.Minute)) || x.PausedSeconds != int64(15*60) {
		t.Fatalf("停在这一刻，暂停的 15 分钟照旧不计：%v %d", x.StoppedAt, x.PausedSeconds)
	}
	// 同键重放上次结果，不重复记审计
	if again, replay := patch("stop-s1", map[string]any{"stop": true}); again != 200 || replay["stoppedAt"] != stopped["stoppedAt"] {
		t.Fatalf("同键重放：%d %v", again, replay)
	}
	audits := 0
	for _, a := range auditsOf(t, p.s) {
		if a.Action == "venue_session.stopped" && a.ObjectID == session && strings.Contains(a.Reason, "停止时已用 80 分钟") {
			audits++
		}
	}
	if audits != 1 {
		t.Fatalf("停止计时记一条审计：%d", audits)
	}

	// 计价冻结在停止那一刻，并且已经存下
	frozen := p.order(t, orderID)
	if receivable(frozen) != 4490 || frozen["timing"].(map[string]any)["frozenAt"] == nil {
		t.Fatalf("停止时超时 20 分钟加收 1 块并冻结：%v %v", receivable(frozen), frozen["timing"])
	}
	// 直接读库（读订单会按此刻重算，证明不了存下了）
	if stored := view(t, p.s, func(q *txn) int64 {
		var cents int64
		q.fail(q.tx.QueryRow(q.ctx, `SELECT receivable_cents FROM sales_orders WHERE id = $1`, orderID).Scan(&cents))
		return cents
	}); stored != 4490 {
		t.Fatalf("停止计时时就把冻结的金额存下：%d", stored)
	}
	table := tableViewOf(t, p.s, sessionOf(t, p.s, session).TableID)
	if table["stopped"] != true || table["estimatedCents"] != int64(4490) {
		t.Fatalf("桌位标出待结账，报价是冻结的金额：%v %v", table["stopped"], table["estimatedCents"])
	}

	// 停止后：不能再停、暂停、继续、续时、改时长、改开始时间、标陪客
	if code, out := patch(id(), map[string]any{"stop": true}); code != 409 || out["code"] != "invalid_session_state" {
		t.Fatalf("已停止的不能再停：%d %v", code, out)
	}
	for _, body := range []map[string]any{
		{"status": "paused"},
		{"status": "active"},
		{"status": "companion"},
		{"extendMinutes": 30, "expectedDurationMinutes": 60},
		{"durationMinutes": 90},
		{"timingMode": "free"},
		{"startedAt": p.t0.Add(10 * time.Minute).Format(time.RFC3339)},
	} {
		if code, out := patch(id(), body); code != 409 || out["code"] != "invalid_session_state" {
			t.Fatalf("停止后不能再改计时 %v：%d %v", body, code, out)
		}
	}
	// 换桌照旧
	other := seedTable(t, p.s, "S9", "A", 99, 2, false)
	if code, out := patch(id(), map[string]any{"serviceTableId": other.ID}); code != 200 || out["stoppedAt"] == nil {
		t.Fatalf("停止计时的也能换桌：%d %v", code, out)
	}

	// 时间再走，金额和版本都不变；按冻结的金额收款，会话结清
	p.at(4 * time.Hour)
	later := p.order(t, orderID)
	if receivable(later) != 4490 || later["version"] != frozen["version"] {
		t.Fatalf("停止计时后计价冻结：%v", receivable(later))
	}
	paid := call(t, p.s, http.MethodPost, "/api/v2/sales-orders/"+orderID+"/payments", p.owner.AccessToken, id(),
		map[string]any{"expectedVersion": later["version"], "method": "cash", "amountCents": 4490})
	if paid.Code != 201 {
		t.Fatalf("按冻结的金额收款：%d %s", paid.Code, paid.Body.String())
	}
	if x := sessionOf(t, p.s, session); x.Status != "settled" {
		t.Fatalf("收款结清会话：%s", x.Status)
	}
}

func TestWholeTableStopEdgeCases(t *testing.T) {
	p := newPolicyShop(t)
	p.renewalPackage(t)
	patch := func(session, key string, body map[string]any) (int, map[string]any) {
		t.Helper()
		w := call(t, p.s, http.MethodPatch, "/api/v2/venue-sessions/"+session, p.owner.AccessToken, key, body)
		return w.Code, decodeMap(t, w)
	}

	// 陪客不计时，不用停止
	companion := p.open(t, "S2", map[string]any{"timingMode": "timed", "durationMinutes": 60})
	if code, out := patch(companion, id(), map[string]any{"status": "companion"}); code != 200 {
		t.Fatalf("标记陪客：%d %v", code, out)
	}
	if code, out := patch(companion, id(), map[string]any{"stop": true}); code != 409 || out["code"] != "invalid_session_state" {
		t.Fatalf("陪客不能停止计时：%d %v", code, out)
	}

	// 自由计时停止后块数冻结；没建单的停止后再去结账，按停止那一刻建单
	free := p.open(t, "S3", map[string]any{"timingMode": "free"})
	p.at(45 * time.Minute)
	if code, out := patch(free, id(), map[string]any{"stop": true}); code != 200 {
		t.Fatalf("自由计时停止：%d %v", code, out)
	}
	p.at(3 * time.Hour)
	draft := p.checkout(t, free)
	if names := lineNames(draft); len(names) != 1 || names[0] != "自由计时 · 已用 45 分钟" {
		t.Fatalf("没发布自由计时价：0 元占位写停止时已用的 45 分钟：%v", names)
	}

	// 停止计时、等结账的整桌会话照样能撤销开台，草稿作废
	cancelled := p.open(t, "S4", map[string]any{"timingMode": "timed", "durationMinutes": 60})
	if code, out := patch(cancelled, id(), map[string]any{"stop": true}); code != 200 {
		t.Fatalf("停止：%d %v", code, out)
	}
	order := p.checkout(t, cancelled)
	if w := call(t, p.s, http.MethodDelete, "/api/v2/venue-sessions/"+cancelled, p.owner.AccessToken, "", nil); w.Code != 204 {
		t.Fatalf("停止计时的也能撤销开台：%d %s", w.Code, w.Body.String())
	}
	if got := orderOf(t, p.s, order["id"].(string)); got.Status != "voided" {
		t.Fatalf("撤销开台作废草稿：%s", got.Status)
	}

	// 已结束的会话不能停止
	if code, out := patch(cancelled, id(), map[string]any{"stop": true}); code != 409 || out["code"] != "invalid_session_state" {
		t.Fatalf("已撤销的不能停止：%d %v", code, out)
	}
}
