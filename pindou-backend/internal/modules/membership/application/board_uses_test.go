package application

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestRechargeBoardUsesValidation(t *testing.T) {
	for _, c := range []struct {
		kind  string
		uses  int64
		valid bool
	}{
		{"recharge", 0, true}, {"recharge", 1, true}, {"recharge", 1000, true},
		{"recharge", -1, false}, {"recharge", 1001, false}, {"companion", 1, false}, {"companion", 0, true},
	} {
		t.Run(fmt.Sprintf("%s_%d", c.kind, c.uses), func(t *testing.T) {
			err := Validate(Rule{Kind: c.kind, Name: "测试", AmountCents: 100, BoardUses: c.uses})
			if c.valid && c.uses > 0 {
				preview, _ := Preview(Rule{Kind: c.kind, Name: "测试", AmountCents: 100, BoardUses: c.uses})
				if !strings.Contains(preview, fmt.Sprintf("智能豆板 %d 次，不过期", c.uses)) {
					t.Fatalf("预览没说明赠送次数：%s", preview)
				}
			}
			if (err == nil) != c.valid {
				t.Fatalf("次数校验 = %v", err)
			}
		})
	}
}

func TestBoardUsesLedgerAndBalanceSnapshots(t *testing.T) {
	s := New()
	now := time.Date(2026, 10, 27, 0, 0, 0, 0, time.UTC)
	charge := Entry{ID: "充值", AccountID: "顾客", PrincipalCents: 88800, GiftCents: 12000, BoardUses: 2, CreatedAt: now}
	if err := s.Append(charge, now); err != nil {
		t.Fatal(err)
	}
	debit := Entry{ID: "消费", AccountID: "顾客", PrincipalCents: -7990, BoardUses: -1, CreatedAt: now.Add(time.Second), Consumption: &Consumption{PackageName: "三小时"}}
	if err := s.Append(debit, now); err != nil {
		t.Fatal(err)
	}
	debit.Consumption.PackageName = "后来改了"
	if b := s.Entries["消费"].BalanceAfter; b == nil || b.PrincipalCents != 80810 || b.GiftCents != 12000 || b.BoardUses != 1 {
		t.Fatalf("记账后快照 = %+v", b)
	}
	if s.Entries["消费"].Consumption.PackageName != "三小时" {
		t.Fatal("流水没有保存独立的消费快照")
	}
	before := Version(s)
	for _, uses := range []int64{-2, Limit} {
		if err := s.Append(Entry{ID: "不合法", AccountID: "顾客", BoardUses: uses}, now); !errors.Is(err, ErrBalance) {
			t.Fatalf("越界次数未拒绝：%v", err)
		}
		if Version(s) != before {
			t.Fatal("拒绝后流水被改了")
		}
	}
	if err := s.CanReverse("顾客", []Entry{charge}, now); !errors.Is(err, ErrBalance) {
		t.Fatalf("次数不足不能收回充值：%v", err)
	}
	reversal := Reverse(s.Entries["消费"])
	reversal.ID, reversal.CreatedAt = "撤销", now.Add(2*time.Second)
	if err := s.Append(reversal, now); err != nil {
		t.Fatal(err)
	}
	if b := s.Balance("顾客", now.AddDate(10, 0, 0)); b.BoardUses != 2 || s.Balances(now)["顾客"].BoardUses != 2 {
		t.Fatalf("次数不应过期：%+v", b)
	}
	if s.Entries["消费"].BalanceAfter.BoardUses != 1 || s.Entries["充值"].BalanceAfter.BoardUses != 2 {
		t.Fatal("后续记账改了已有快照")
	}
	cap := New()
	if err := cap.Append(Entry{ID: "上限", AccountID: "顾客", BoardUses: Limit}, now); err != nil {
		t.Fatal(err)
	}
	if err := cap.Append(Entry{ID: "溢出", AccountID: "顾客", BoardUses: 1}, now); !errors.Is(err, ErrBalance) {
		t.Fatalf("次数超过上限：%v", err)
	}
}

// 老规则和老流水的字段顺序、编码都不能变，否则滚动更新时顾客的确认版本会互相不认。
func TestLegacyMembershipJSONUnchanged(t *testing.T) {
	oldRule := `{"id":"充值规则","kind":"recharge","name":"充五百","enabled":true,"amountCents":50000,"giftCents":8800,"points":0,"rateBasisPoints":0,"maxBasisPoints":0,"minimumPoints":0,"validDays":0,"mode":"","scope":"","stack":false,"productId":"","quantity":0,"perUserLimit":0,"durationMinutes":0,"renewalMinutes":0,"renewalCents":0,"pauseLimitMinutes":0,"overtime":""}`
	oldEntry := `{"id":"充值流水","accountId":"顾客","kind":"recharge","sourceId":"充值规则","reason":"","principalCents":50000,"giftCents":8800,"points":[],"rule":` + oldRule + `,"createdAt":"2026-10-20T00:00:00Z"}`
	for _, c := range []struct {
		name, old string
		value     any
	}{
		{"旧规则", oldRule, &Rule{}}, {"旧流水", oldEntry, &Entry{}},
	} {
		t.Run(c.name, func(t *testing.T) {
			if err := json.Unmarshal([]byte(c.old), c.value); err != nil {
				t.Fatal(err)
			}
			got, err := json.Marshal(c.value)
			if err != nil || string(got) != c.old {
				t.Fatalf("旧编码变了：%s，%v", got, err)
			}
			var old any
			_ = json.Unmarshal([]byte(c.old), &old)
			var current any
			_ = json.Unmarshal(got, &current)
			if Version(old) != Version(current) {
				t.Fatal("旧版本变了")
			}
		})
	}
}
