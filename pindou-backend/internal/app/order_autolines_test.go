package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	member "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/membership/application"
)

func decodeList(t *testing.T, w *httptest.ResponseRecorder) []map[string]any {
	t.Helper()
	var out []map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode %q: %v", w.Body.String(), err)
	}
	return out
}

// 店员从桌位开台，建单时账单不该是空的。
//
// 2026-09-20 之前它就是空的：店员进结账页看到一张白单，要在「自定义服务」里手打
// 「计时收费 29.90」—— 而系统明知道计了 60 分钟、也明知道门店发布了「1 小时 ¥29.90」。
// 顾客扫码那条路反倒会自动带套餐行。同一件事两条路，一条自动一条手打。
func TestSessionOrderCarriesTimingLines(t *testing.T) {
	now := time.Date(2026, 9, 20, 10, 0, 0, 0, time.UTC)
	newShop := func() (*Server, sessionResponse, member.Rule, *Table) {
		s := newTestServer(t)
		s.now = func() time.Time { return now }
		o := register(t, s, "autoline-owner", "老板")
		if err := s.BootstrapOwner(o.User.ID); err != nil {
			t.Fatal(err)
		}
		enableBilling(t, s, o.User.ID)
		// 门店真实配置：只发布了一个「1 小时 ¥29.90」，续时 30 分钟 ¥15.00
		pack := publishRule(t, s, o.AccessToken, member.Rule{
			Kind: "package", Name: "1小时", AmountCents: 2990,
			DurationMinutes: 60, RenewalMinutes: 30, RenewalCents: 1500, Overtime: "manual",
		})
		return s, o, pack, seedTable(t, s, "A1", "A", 1, 2, true)
	}
	// 开一张台，建单，把明细读回来
	billFor := func(s *Server, bearer string, table *Table, mode string, minutes int) []map[string]any {
		t.Helper()
		body := map[string]any{"serviceTableId": table.ID, "timingMode": mode, "startedAt": s.now().Format(time.RFC3339)}
		if mode == "timed" {
			body["durationMinutes"] = minutes
		}
		w := call(t, s, http.MethodPost, "/api/v2/venue-sessions", bearer, "", body)
		if w.Code != 201 {
			t.Fatalf("开台失败：%d %s", w.Code, w.Body.String())
		}
		session := decodeMap(t, w)
		w = call(t, s, http.MethodPost, "/api/v2/sales-orders", bearer, "idem-"+session["id"].(string),
			map[string]any{"venueSessionId": session["id"]})
		if w.Code != 201 {
			t.Fatalf("建单失败：%d %s", w.Code, w.Body.String())
		}
		order := decodeMap(t, w)
		out := []map[string]any{}
		for _, l := range order["lines"].([]any) {
			out = append(out, l.(map[string]any))
		}
		return out
	}

	t.Run("时长正好等于已发布套餐：带套餐行和套餐价", func(t *testing.T) {
		s, o, pack, table := newShop()
		lines := billFor(s, o.AccessToken, table, "timed", 60)
		if len(lines) != 1 || lines[0]["name"] != pack.Name || lines[0]["unitPriceCents"].(float64) != 2990 {
			t.Fatalf("60 分钟应当带「%s ¥29.90」，实际 %v", pack.Name, lines)
		}
	})

	t.Run("时长等于套餐加续时：拆成套餐行加续时行", func(t *testing.T) {
		s, o, _, table := newShop()
		lines := billFor(s, o.AccessToken, table, "timed", 120) // 60 + 2×30
		if len(lines) != 2 {
			t.Fatalf("120 分钟应当拆成两行，实际 %v", lines)
		}
		if lines[0]["unitPriceCents"].(float64) != 2990 {
			t.Fatalf("第一行应是套餐价：%v", lines[0])
		}
		if lines[1]["quantity"].(float64) != 2 || lines[1]["unitPriceCents"].(float64) != 1500 {
			t.Fatalf("第二行应是 2 次续时 ¥15.00：%v", lines[1])
		}
	})

	// ★ 这一条是「不编价」那个决定的守门人。45 分钟对不上任何套餐，
	//   代码**不许**按分钟折算出一个价来 —— 那等于替业主定了收费政策。
	t.Run("对不上套餐：留 0 价占位行，把时长写进名字", func(t *testing.T) {
		s, o, _, table := newShop()
		lines := billFor(s, o.AccessToken, table, "timed", 45)
		if len(lines) != 1 || lines[0]["unitPriceCents"].(float64) != 0 {
			t.Fatalf("45 分钟不该被编出价来：%v", lines)
		}
		if lines[0]["name"] != "计时 45 分钟" {
			t.Fatalf("占位行要写清时长，店员才知道填多少：%v", lines[0])
		}
	})

	t.Run("自由计时：按实际已用分钟占位，同样不编价", func(t *testing.T) {
		s, o, _, table := newShop()
		w := call(t, s, http.MethodPost, "/api/v2/venue-sessions", o.AccessToken, "",
			map[string]any{"serviceTableId": table.ID, "timingMode": "free", "startedAt": now.Format(time.RFC3339)})
		if w.Code != 201 {
			t.Fatalf("开台失败：%d %s", w.Code, w.Body.String())
		}
		session := decodeMap(t, w)
		s.now = func() time.Time { return now.Add(25 * time.Minute) }
		w = call(t, s, http.MethodPost, "/api/v2/sales-orders", o.AccessToken, "idem-free",
			map[string]any{"venueSessionId": session["id"]})
		lines := decodeMap(t, w)["lines"].([]any)
		line := lines[0].(map[string]any)
		if line["name"] != "自由计时 · 已用 25 分钟" || line["unitPriceCents"].(float64) != 0 {
			t.Fatalf("自由计时应当占位并写明已用时长：%v", line)
		}
	})

	t.Run("已有草稿不重生明细", func(t *testing.T) {
		s, o, _, table := newShop()
		first := billFor(s, o.AccessToken, table, "timed", 60)
		w := call(t, s, http.MethodGet, "/api/v2/sales-orders", o.AccessToken, "", nil)
		orders := decodeList(t, w)
		if len(orders) != 1 {
			t.Fatalf("同一会话不该建出第二张单：%d", len(orders))
		}
		if len(first) != 1 {
			t.Fatal("前置条件坏了")
		}
	})

	// 套餐停用之后再开台，就不该再按它计价 —— 停用的规则不参与交易。
	t.Run("套餐停用后不再命中", func(t *testing.T) {
		s, o, pack, table := newShop()
		loyaltyOK(t, s, o.AccessToken, loyaltyInput{
			Action: "disable", TargetID: pack.ID, Reason: "停售",
		})
		lines := billFor(s, o.AccessToken, table, "timed", 60)
		if lines[0]["unitPriceCents"].(float64) != 0 {
			t.Fatalf("停用的套餐不该再给价：%v", lines)
		}
	})
}

// 会话页上那句「应收 ¥X」。算不出来时必须**不下发**这个字段，
// 而不是下发 0 —— 0 会让店员以为这单不要钱。
func TestTableViewEstimateOnlyWhenKnown(t *testing.T) {
	now := time.Date(2026, 9, 20, 10, 0, 0, 0, time.UTC)
	s := newTestServer(t)
	s.now = func() time.Time { return now }
	o := register(t, s, "estimate-owner", "老板")
	if err := s.BootstrapOwner(o.User.ID); err != nil {
		t.Fatal(err)
	}
	enableBilling(t, s, o.User.ID)
	publishRule(t, s, o.AccessToken, member.Rule{
		Kind: "package", Name: "1小时", AmountCents: 2990, DurationMinutes: 60, Overtime: "manual",
	})
	priced := seedTable(t, s, "B1", "B", 1, 1, false)
	unpriced := seedTable(t, s, "B2", "B", 2, 1, false)

	open := func(table *Table, minutes int) {
		t.Helper()
		w := call(t, s, http.MethodPost, "/api/v2/venue-sessions", o.AccessToken, "",
			map[string]any{"serviceTableId": table.ID, "timingMode": "timed", "durationMinutes": minutes, "startedAt": now.Format(time.RFC3339)})
		if w.Code != 201 {
			t.Fatalf("开台失败：%d %s", w.Code, w.Body.String())
		}
	}
	open(priced, 60)
	open(unpriced, 45)

	views := map[string]map[string]any{}
	for _, item := range decodeList(t, call(t, s, http.MethodGet, "/api/v2/service-tables", o.AccessToken, "", nil)) {
		views[item["code"].(string)] = item
	}
	if views["B1"]["estimatedCents"] != float64(2990) {
		t.Fatalf("对得上套餐的桌要给出应收：%v", views["B1"]["estimatedCents"])
	}
	if _, present := views["B2"]["estimatedCents"]; present {
		t.Fatalf("算不出来时不能下发 0，要缺字段：%v", views["B2"]["estimatedCents"])
	}
	if _, present := views["A1"]; present {
		t.Fatal("夹具串了")
	}
}
