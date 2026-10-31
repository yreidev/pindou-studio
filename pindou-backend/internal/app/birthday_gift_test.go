package app

import (
	"bytes"
	"net/http"
	"testing"
	"time"

	member "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/membership/application"
	"github.com/yreidev/pindou-studio/pindou-backend/internal/storetime"
)

// 生日礼物核销（/loyalty/actions 的 fulfill_gift）被拒时要说清原因。以前除「礼物已核销」外一律回笼统的
// 「请检查规则、金额、积分及有效期设置」：两端页面不按日期预先拦过期的礼物（以后端为准），员工点了核销
// 看不出是过期了。现在过期、已核销各有错误码，不在这位顾客名下、不是礼物也写明白；被拒的什么都不改。
func TestBirthdayGiftFulfillRefusalsSayWhy(t *testing.T) {
	s := newTestServer(t)
	clock := time.Date(2026, 10, 6, 4, 0, 0, 0, time.UTC) // 门店 10 月 6 日 12:00
	s.now = func() time.Time { return clock }
	owner := register(t, s, "gift-why-owner", "老板")
	if err := s.BootstrapOwner(owner.User.ID); err != nil {
		t.Fatal(err)
	}
	clerk := register(t, s, "gift-why-clerk", "店员")
	setRoles(t, s, clerk.User.ID, Clerk)
	first := register(t, s, "gift-why-first", "小林")
	second := register(t, s, "gift-why-second", "小周")
	keepSignedIn(t, s, &owner, &clerk, &first, &second)

	created := call(t, s, "POST", "/api/v2/catalog-items", owner.AccessToken, id(), map[string]any{"name": "生日小熊", "unitPriceCents": 100})
	product := decodeMap(t, created)["id"].(string)
	stock := &inventoryItem{ID: id(), ProductID: product, Quantity: 5}
	edit(t, s, func(q *txn) { q.addStockItem(stock) })
	gift := publishRule(t, s, owner.AccessToken, member.Rule{Kind: "birthday", Name: "生日小熊", Mode: "month", Scope: "gift", ProductID: product, PerUserLimit: 1, ValidDays: 7})
	points := publishRule(t, s, owner.AccessToken, member.Rule{Kind: "birthday", Name: "生日积分", Mode: "month", Scope: "points", Points: 20, PerUserLimit: 1, ValidDays: 30})

	birthday := clock.In(storetime.Location).Format("01-02")
	claimed := func(customer sessionResponse, rule member.Rule) string {
		t.Helper()
		loyaltyOK(t, s, customer.AccessToken, loyaltyInput{Action: "birthday", Birthday: birthday})
		loyaltyOK(t, s, customer.AccessToken, loyaltyInput{Action: "claim", TargetID: rule.ID})
		for _, e := range memberOf(t, s, customer.User.ID).History(customer.User.ID) {
			if e.Kind == "birthday" && e.Rule != nil && e.Rule.ID == rule.ID {
				return e.ID
			}
		}
		t.Fatal("没找到领取的生日福利")
		return ""
	}
	firstGift := claimed(first, gift)
	secondGift := claimed(second, gift)
	loyaltyOK(t, s, first.AccessToken, loyaltyInput{Action: "claim", TargetID: points.ID})
	var firstPoints string
	for _, e := range memberOf(t, s, first.User.ID).History(first.User.ID) {
		if e.Kind == "birthday" && e.Rule != nil && e.Rule.ID == points.ID {
			firstPoints = e.ID
		}
	}

	refused := func(name string, in loyaltyInput, status int, code, message string) {
		t.Helper()
		before := s.snapshotData()
		w := loyaltyCall(t, s, clerk.AccessToken, in)
		body := decodeMap(t, w)
		if w.Code != status || body["code"] != code || body["message"] != message {
			t.Fatalf("%s：%d %v，应为 %d %s「%s」", name, w.Code, body, status, code, message)
		}
		if !bytes.Equal(before, s.snapshotData()) {
			t.Fatalf("%s：被拒了却改了数据", name)
		}
	}

	// 指的不是礼物、不在这位顾客名下：说清楚，不再是笼统的规则设置提示
	refused("积分类生日福利", loyaltyInput{Action: "fulfill_gift", AccountID: first.User.ID, TargetID: firstPoints},
		http.StatusBadRequest, "invalid_request", "这条记录不是生日礼物，不用核销")
	refused("别的顾客领的礼物", loyaltyInput{Action: "fulfill_gift", AccountID: first.User.ID, TargetID: secondGift},
		http.StatusNotFound, "not_found", "这位顾客名下没有这份生日礼物，请刷新后重新选择")
	refused("没有这份礼物", loyaltyInput{Action: "fulfill_gift", AccountID: first.User.ID, TargetID: id()},
		http.StatusNotFound, "not_found", "这位顾客名下没有这份生日礼物，请刷新后重新选择")

	// 有效期内核销：出库一件；再点一次是「已经核销过」
	loyaltyOK(t, s, clerk.AccessToken, loyaltyInput{Action: "fulfill_gift", AccountID: first.User.ID, TargetID: firstGift})
	if stockOf(t, s, stock.ID).Quantity != 4 {
		t.Fatal("核销没有出库")
	}
	refused("重复核销", loyaltyInput{Action: "fulfill_gift", AccountID: first.User.ID, TargetID: firstGift},
		http.StatusConflict, "birthday_gift_fulfilled", "这份生日礼物已经核销过了，不能重复核销")

	// 有效期 7 天：领取满 7 天就过期，不能再核销；已经核销过的仍报已核销
	clock = clock.AddDate(0, 0, 7)
	refused("过期", loyaltyInput{Action: "fulfill_gift", AccountID: second.User.ID, TargetID: secondGift},
		http.StatusConflict, "birthday_gift_expired", "这份生日礼物已过期，不能再核销")
	refused("核销过又过期", loyaltyInput{Action: "fulfill_gift", AccountID: first.User.ID, TargetID: firstGift},
		http.StatusConflict, "birthday_gift_fulfilled", "这份生日礼物已经核销过了，不能重复核销")
	if stockOf(t, s, stock.ID).Quantity != 4 {
		t.Fatal("被拒的核销动了库存")
	}
}

// 领取后老板停用了生日礼物规则：礼物领取时已归顾客，有效期内照样能核销。
func TestBirthdayGiftFulfillsAfterRuleDisabled(t *testing.T) {
	s := newTestServer(t)
	owner := register(t, s, "gift-disabled-owner", "老板")
	if err := s.BootstrapOwner(owner.User.ID); err != nil {
		t.Fatal(err)
	}
	customer := register(t, s, "gift-disabled-customer", "小林")
	created := call(t, s, "POST", "/api/v2/catalog-items", owner.AccessToken, id(), map[string]any{"name": "生日徽章", "unitPriceCents": 100})
	product := decodeMap(t, created)["id"].(string)
	stock := &inventoryItem{ID: id(), ProductID: product, Quantity: 1}
	edit(t, s, func(q *txn) { q.addStockItem(stock) })
	gift := publishRule(t, s, owner.AccessToken, member.Rule{Kind: "birthday", Name: "生日徽章", Mode: "month", Scope: "gift", ProductID: product, PerUserLimit: 1, ValidDays: 7})
	loyaltyOK(t, s, customer.AccessToken, loyaltyInput{Action: "birthday", Birthday: s.now().In(storetime.Location).Format("01-02")})
	view := loyaltyOK(t, s, customer.AccessToken, loyaltyInput{Action: "claim", TargetID: gift.ID})
	var claimed string
	for _, raw := range view["entries"].([]any) {
		if e := raw.(map[string]any); e["kind"] == "birthday" {
			claimed = e["id"].(string)
		}
	}
	loyaltyOK(t, s, owner.AccessToken, loyaltyInput{Action: "disable", TargetID: gift.ID, Reason: "活动结束"})
	loyaltyOK(t, s, owner.AccessToken, loyaltyInput{Action: "fulfill_gift", AccountID: customer.User.ID, TargetID: claimed})
	if stockOf(t, s, stock.ID).Quantity != 0 {
		t.Fatal("核销没有出库")
	}
}
