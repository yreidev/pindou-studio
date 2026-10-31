package app

import (
	"net/http"
	"testing"
)

// 无权和不存在要用各自的状态码和中文说明，不能混进 409 loyalty_conflict 显示英文原文。
func TestLoyaltyActionsReportForbiddenAndMissing(t *testing.T) {
	s := newTestServer(t)
	owner := register(t, s, "loyalty-errors-owner", "Owner")
	if err := s.BootstrapOwner(owner.User.ID); err != nil {
		t.Fatal(err)
	}
	customer := register(t, s, "loyalty-errors-customer", "Customer")
	for _, c := range []struct {
		name, bearer string
		in           loyaltyInput
		status       int
		code         string
	}{
		{"birthday for someone else", customer.AccessToken, loyaltyInput{Action: "birthday", AccountID: owner.User.ID, Birthday: "01-02"}, http.StatusForbidden, "forbidden"},
		{"unknown account", owner.AccessToken, loyaltyInput{Action: "adjust", AccountID: id(), Reason: "测试", Points: 1}, http.StatusNotFound, "not_found"},
	} {
		t.Run(c.name, func(t *testing.T) {
			w := loyaltyCall(t, s, c.bearer, c.in)
			body := decodeMap(t, w)
			if w.Code != c.status || body["code"] != c.code {
				t.Fatalf("status=%d body=%v, want %d %s", w.Code, body, c.status, c.code)
			}
			if message, _ := body["message"].(string); message == c.code {
				t.Fatalf("message is the bare code %q", message)
			}
		})
	}
}
