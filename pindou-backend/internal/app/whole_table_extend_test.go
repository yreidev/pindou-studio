package app

import (
	"net/http"
	"testing"
	"time"

	member "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/membership/application"
)

// 整桌开台的续时。
//
// 门店发布「1小时 ¥29.90，续时 30 分钟 ¥15.00」。开 60 分钟、点「去收款」建出草稿 ¥29.90；
// 顾客说再坐半小时，回会话页续时 30 分钟，再点「去收款」—— 以前还是 ¥29.90：会话已有草稿时
// 建单原样返回，自动明细只在第一次建单时算，改时长又不碰订单。少收了一笔续时费。

type extendShop struct {
	s       *Server
	bearer  string
	session string
}

func newExtendShop(t *testing.T) extendShop {
	t.Helper()
	now := time.Date(2026, 9, 20, 10, 0, 0, 0, time.UTC)
	s := newTestServer(t)
	s.now = func() time.Time { return now }
	o := register(t, s, "extend-owner", "老板")
	if err := s.BootstrapOwner(o.User.ID); err != nil {
		t.Fatal(err)
	}
	enableBilling(t, s, o.User.ID)
	publishRule(t, s, o.AccessToken, member.Rule{Kind: "package", Name: "1小时", AmountCents: 2990,
		DurationMinutes: 60, RenewalMinutes: 30, RenewalCents: 1500, Overtime: "manual"})
	table := seedTable(t, s, "A1", "A", 1, 2, true)
	w := call(t, s, http.MethodPost, "/api/v2/venue-sessions", o.AccessToken, "",
		map[string]any{"serviceTableId": table.ID, "timingMode": "timed", "durationMinutes": 60, "startedAt": now.Format(time.RFC3339)})
	if w.Code != 201 {
		t.Fatalf("开台失败：%d %s", w.Code, w.Body.String())
	}
	return extendShop{s: s, bearer: o.AccessToken, session: decodeMap(t, w)["id"].(string)}
}

// checkout 是会话页「去收款」：建单（已有草稿时返回那张草稿）。
func (x extendShop) checkout(t *testing.T, key string) map[string]any {
	t.Helper()
	w := call(t, x.s, http.MethodPost, "/api/v2/sales-orders", x.bearer, key, map[string]any{"venueSessionId": x.session})
	if w.Code != 200 && w.Code != 201 {
		t.Fatalf("建单失败：%d %s", w.Code, w.Body.String())
	}
	return decodeMap(t, w)
}

func (x extendShop) patch(t *testing.T, key string, body map[string]any) (int, map[string]any) {
	t.Helper()
	w := call(t, x.s, http.MethodPatch, "/api/v2/venue-sessions/"+x.session, x.bearer, key, body)
	return w.Code, decodeMap(t, w)
}

func lineNames(order map[string]any) []string {
	out := []string{}
	for _, l := range order["lines"].([]any) {
		out = append(out, l.(map[string]any)["name"].(string))
	}
	return out
}

func TestWholeTableExtensionCarriesIntoTheDraft(t *testing.T) {
	t.Run("0.0.12 小程序的写法（读到的时长 + 30）：草稿按新时长重算", func(t *testing.T) {
		x := newExtendShop(t)
		first := x.checkout(t, "extend-first")
		if first["receivableCents"].(float64) != 2990 {
			t.Fatalf("前置条件：60 分钟 ¥29.90，实际 %v", first["receivableCents"])
		}
		if code, out := x.patch(t, "extend-legacy", map[string]any{"durationMinutes": 90}); code != 200 {
			t.Fatalf("续时失败：%d %v", code, out)
		}
		again := x.checkout(t, "extend-second")
		if again["id"] != first["id"] {
			t.Fatal("同一会话不该建出第二张单")
		}
		if again["receivableCents"].(float64) != 4490 || len(again["lines"].([]any)) != 2 {
			t.Fatalf("续时 30 分钟后应收应为 ¥29.90 + ¥15.00，实际 %v %v", again["receivableCents"], lineNames(again))
		}
		if again["version"] == first["version"] {
			t.Fatal("草稿改了价，版本要变：手里拿着旧版本的结账页收款时才会被拦下来重读")
		}
	})

	t.Run("追加分钟数：响应说明草稿已改价", func(t *testing.T) {
		x := newExtendShop(t)
		first := x.checkout(t, "extend-first")
		code, out := x.patch(t, "extend-new", map[string]any{"extendMinutes": 30, "expectedDurationMinutes": 60})
		if code != 200 || out["durationMinutes"].(float64) != 90 {
			t.Fatalf("续时失败：%d %v", code, out)
		}
		draft, _ := out["draftOrder"].(map[string]any)
		if draft == nil || draft["id"] != first["id"] || draft["repriced"] != true || draft["receivableCents"].(float64) != 4490 {
			t.Fatalf("响应要说明草稿已按新时长改价：%v", out["draftOrder"])
		}
		order := orderOf(t, x.s, first["id"].(string))
		if order.ReceivableCents != 4490 {
			t.Fatalf("草稿应收应为 ¥44.90，实际 %d", order.ReceivableCents)
		}
		repriced := 0
		for _, a := range auditsOf(t, x.s) {
			if a.Action == "order.lines.repriced" && a.ObjectID == order.ID {
				repriced++
			}
		}
		if repriced != 1 {
			t.Fatalf("续时自动改价要留审计，实际 %d 条", repriced)
		}
	})

	t.Run("加了商品的草稿：只换计时行，商品照留", func(t *testing.T) {
		x := newExtendShop(t)
		first := x.checkout(t, "extend-first")
		lines := append([]any{}, first["lines"].([]any)...)
		lines = append(lines, map[string]any{"name": "矿泉水", "quantity": 1, "unitPriceCents": 300})
		if w := call(t, x.s, http.MethodPatch, "/api/v2/sales-orders/"+first["id"].(string), x.bearer, "extend-goods",
			map[string]any{"expectedVersion": first["version"], "lines": lines}); w.Code != 200 {
			t.Fatalf("加商品失败：%d %s", w.Code, w.Body.String())
		}
		if code, out := x.patch(t, "extend-goods-30", map[string]any{"extendMinutes": 30, "expectedDurationMinutes": 60}); code != 200 || out["draftOrder"].(map[string]any)["repriced"] != true {
			t.Fatalf("续时应改价：%d %v", code, out)
		}
		again := x.checkout(t, "extend-goods-again")
		names := lineNames(again)
		if again["receivableCents"].(float64) != 4790 || len(names) != 3 || names[2] != "矿泉水" {
			t.Fatalf("应为套餐 + 续时 + 矿泉水 ¥47.90，实际 %v %v", again["receivableCents"], names)
		}
	})

	t.Run("员工改过计时价的草稿：不动，提示核对", func(t *testing.T) {
		x := newExtendShop(t)
		first := x.checkout(t, "extend-first")
		edited := []any{map[string]any{"name": "1小时（熟客价）", "quantity": 1, "unitPriceCents": 2500}}
		w := call(t, x.s, http.MethodPatch, "/api/v2/sales-orders/"+first["id"].(string), x.bearer, "extend-edit",
			map[string]any{"expectedVersion": first["version"], "lines": edited})
		if w.Code != 200 {
			t.Fatalf("改价失败：%d %s", w.Code, w.Body.String())
		}
		editedVersion := decodeMap(t, w)["version"]
		code, out := x.patch(t, "extend-edited-30", map[string]any{"extendMinutes": 30, "expectedDurationMinutes": 60})
		if code != 200 {
			t.Fatalf("续时本身照常：%d %v", code, out)
		}
		draft, _ := out["draftOrder"].(map[string]any)
		if draft == nil || draft["repriced"] != false || draft["receivableCents"].(float64) != 2500 {
			t.Fatalf("改过的草稿不自动改价，要告诉员工去核对：%v", out["draftOrder"])
		}
		if again := x.checkout(t, "extend-edited-again"); again["version"] != editedVersion {
			t.Fatal("员工改过的草稿不能被自动改写")
		}
	})

	t.Run("没有草稿：续时不带 draftOrder", func(t *testing.T) {
		x := newExtendShop(t)
		code, out := x.patch(t, "extend-nodraft", map[string]any{"extendMinutes": 30, "expectedDurationMinutes": 60})
		if code != 200 {
			t.Fatalf("续时失败：%d %v", code, out)
		}
		if _, present := out["draftOrder"]; present {
			t.Fatalf("没有草稿时不该带 draftOrder：%v", out)
		}
		if got := x.checkout(t, "extend-nodraft-order"); got["receivableCents"].(float64) != 4490 {
			t.Fatalf("续时后再建单按 90 分钟算：%v", got["receivableCents"])
		}
	})
}

// 整桌续时以前发的是「读到的时长 + N」的绝对值，没有前置条件也没有幂等：两人同时续、
// 或者页面过期了再续，后一个会把前一个覆盖掉，时长甚至变短。现在可以只说「追加 N 分钟，
// 我看到的是 M 分钟」，看到的不对就 409，同一个键重发只算一次。
func TestWholeTableExtensionAppendsAgainstTheDurationStaffSaw(t *testing.T) {
	x := newExtendShop(t)
	body := map[string]any{"extendMinutes": 30, "expectedDurationMinutes": 60}
	if code, out := x.patch(t, "append-a", body); code != 200 || out["durationMinutes"].(float64) != 90 {
		t.Fatalf("第一个人续时：%d %v", code, out)
	}
	// 另一个人也看着 60 分钟续 30：已经不是 60 了，拒绝，不叠加也不覆盖
	if code, out := x.patch(t, "append-b", body); code != 409 || out["code"] != "session_conflict" {
		t.Fatalf("看到的时长已过期，应 409 session_conflict：%d %v", code, out)
	}
	if got := sessionOf(t, x.s, x.session); got.DurationMinutes != 90 {
		t.Fatalf("时长应仍为 90，实际 %d", got.DurationMinutes)
	}
	// 结果没收到，原样重发同一个键：重放上次的结果，不再加
	if code, out := x.patch(t, "append-a", body); code != 200 || out["durationMinutes"].(float64) != 90 {
		t.Fatalf("同键同内容应重放：%d %v", code, out)
	}
	if got := sessionOf(t, x.s, x.session); got.DurationMinutes != 90 {
		t.Fatalf("重放不能再追加，实际 %d", got.DurationMinutes)
	}
	if code, out := x.patch(t, "append-a", map[string]any{"extendMinutes": 60, "expectedDurationMinutes": 60}); code != 409 || out["code"] != "idempotency_conflict" {
		t.Fatalf("同键不同内容应 409 idempotency_conflict：%d %v", code, out)
	}
	// 追加必须带看到的时长和幂等键
	if code, out := x.patch(t, "append-c", map[string]any{"extendMinutes": 30}); code != 400 {
		t.Fatalf("追加不带 expectedDurationMinutes 应 400：%d %v", code, out)
	}
	if w := call(t, x.s, http.MethodPatch, "/api/v2/venue-sessions/"+x.session, x.bearer, "", map[string]any{"extendMinutes": 30, "expectedDurationMinutes": 90}); w.Code != 400 {
		t.Fatalf("追加不带幂等键应 400：%d %s", w.Code, w.Body.String())
	}
	if code, out := x.patch(t, "append-d", map[string]any{"extendMinutes": 30, "durationMinutes": 120, "expectedDurationMinutes": 90}); code != 400 {
		t.Fatalf("追加和绝对时长不能同时给：%d %v", code, out)
	}
	// 旧写法（0.0.12 小程序）照样收
	if code, out := x.patch(t, "append-legacy", map[string]any{"durationMinutes": 120}); code != 200 || out["durationMinutes"].(float64) != 120 {
		t.Fatalf("旧写法应照样可用：%d %v", code, out)
	}
	// 自由计时没有时长可追加
	if code, out := x.patch(t, "append-free", map[string]any{"timingMode": "free"}); code != 200 {
		t.Fatalf("改自由计时：%d %v", code, out)
	}
	if code, out := x.patch(t, "append-free-extend", map[string]any{"extendMinutes": 30, "expectedDurationMinutes": 120}); code != 400 && code != 409 {
		t.Fatalf("自由计时不能追加：%d %v", code, out)
	}
}
