package domain

import (
	"errors"
	"testing"
	"time"
)

var called = time.Date(2026, 10, 5, 14, 0, 0, 0, time.UTC)

func TestPendingCallExpiresWhenNobodyCameWithinTheWindow(t *testing.T) {
	c := Call{Status: Pending, CreatedAt: called}
	if got := c.Display(called.Add(Window - time.Second)); got != Pending || !c.Open(called.Add(Window-time.Second)) {
		t.Fatalf("还在 30 分钟内应当是 pending：%s", got)
	}
	if got := c.Display(called.Add(Window)); got != Expired || c.Open(called.Add(Window)) {
		t.Fatalf("满 30 分钟没人处理应当显示为 expired：%s", got)
	}
	if c.Status != Pending {
		t.Fatal("过期只是展示状态，不改已存的 Status")
	}
}

func TestHandledCallCoolsDownForAMinute(t *testing.T) {
	c := Call{Status: Pending, CreatedAt: called}
	if c.CooldownLeft(called) != 0 {
		t.Fatal("没处理的呼叫没有冷却")
	}
	handled := called.Add(5 * time.Minute)
	if !c.Handle("staff-a", handled) {
		t.Fatal("没处理的呼叫应当能处理")
	}
	if c.HandledBy != "staff-a" || c.HandledAt == nil || !c.HandledAt.Equal(handled) || c.Display(handled.Add(time.Hour)) != Handled {
		t.Fatalf("处理要记下谁、何时，之后一直是 handled：%+v", c)
	}
	if got := c.CooldownLeft(handled.Add(20 * time.Second)); got != 40*time.Second {
		t.Fatalf("处理后 20 秒还要等 40 秒：%s", got)
	}
	if got := c.CooldownLeft(handled.Add(Cooldown)); got != 0 {
		t.Fatalf("满 1 分钟就能再叫：%s", got)
	}
	if c.Handle("staff-b", handled.Add(time.Second)) || c.HandledBy != "staff-a" {
		t.Fatal("已处理的呼叫不再改：先点的那位算数")
	}
}

func TestExpiredCallCanStillBeMarkedHandled(t *testing.T) {
	c := Call{Status: Pending, CreatedAt: called}
	late := called.Add(Window + time.Minute)
	if !c.Handle("staff-a", late) || c.Display(late) != Handled {
		t.Fatalf("过期的呼叫店员补点一下也算处理：%+v", c)
	}
}

func TestFirstClaimWinsAndTheSameStaffCanClickAgain(t *testing.T) {
	c := Call{Status: Pending, CreatedAt: called}
	if got := c.ClaimState(called); got != Unclaimed {
		t.Fatalf("没人认领：%s", got)
	}
	at := called.Add(time.Minute)
	if changed, err := c.Claim("staff-a", at); !changed || err != nil {
		t.Fatalf("没人认领的应当能认领：%v %v", changed, err)
	}
	if c.ClaimedBy != "staff-a" || c.ClaimedAt == nil || !c.ClaimedAt.Equal(at) || c.ClaimState(at) != Claimed {
		t.Fatalf("要记下谁、何时认领：%+v", c)
	}
	if c.Status != Pending || c.Display(at) != Pending {
		t.Fatal("认领不改呼叫本身的状态：还要有人点已处理")
	}
	// 同一人再点：不改、不报错
	if changed, err := c.Claim("staff-a", at.Add(2*time.Minute)); changed || err != nil || !c.ClaimedAt.Equal(at) {
		t.Fatalf("同一人重复认领应当无害：%v %v %+v", changed, err, c)
	}
	// 别人再点：先认领的算数
	if changed, err := c.Claim("staff-b", at.Add(3*time.Minute)); changed || !errors.Is(err, ErrClaimedByOther) || c.ClaimedBy != "staff-a" {
		t.Fatalf("别人认领着时应当拒绝：%v %v %+v", changed, err, c)
	}
}

func TestClaimLapsesAfterTenMinutesWithoutHandling(t *testing.T) {
	c := Call{Status: Pending, CreatedAt: called}
	at := called.Add(time.Minute)
	if _, err := c.Claim("staff-a", at); err != nil {
		t.Fatal(err)
	}
	if got := c.ClaimState(at.Add(ClaimHold - time.Second)); got != Claimed {
		t.Fatalf("不到 10 分钟还认领着：%s", got)
	}
	if got := c.ClaimState(at.Add(ClaimHold)); got != ClaimLapsed {
		t.Fatalf("满 10 分钟没处理，认领失效：%s", got)
	}
	// 失效后别人能接手，从现在重新计时
	takeOver := at.Add(ClaimHold + time.Minute)
	if changed, err := c.Claim("staff-b", takeOver); !changed || err != nil || c.ClaimedBy != "staff-b" || !c.ClaimedAt.Equal(takeOver) {
		t.Fatalf("认领失效后别人能接手：%v %v %+v", changed, err, c)
	}
	// 原来那位在失效后再点也算重新认领（「我还在处理」）
	again := takeOver.Add(ClaimHold)
	if changed, err := c.Claim("staff-b", again); !changed || err != nil || !c.ClaimedAt.Equal(again) || c.ClaimState(again) != Claimed {
		t.Fatalf("认领失效后原来那位再点应当重新计时：%v %v %+v", changed, err, c)
	}
}

func TestHandledOrExpiredCallCannotBeClaimedButClaimedCallCanBeHandledByAnyone(t *testing.T) {
	c := Call{Status: Pending, CreatedAt: called}
	if _, err := c.Claim("staff-a", called); err != nil {
		t.Fatal(err)
	}
	// 认领后谁都能点已处理：处理人记实际点的那位，认领记录照旧留着
	if !c.Handle("staff-b", called.Add(time.Minute)) || c.HandledBy != "staff-b" || c.ClaimedBy != "staff-a" {
		t.Fatalf("认领后别人也能处理：%+v", c)
	}
	if changed, err := c.Claim("staff-c", called.Add(2*time.Minute)); changed || !errors.Is(err, ErrClosed) {
		t.Fatalf("已处理的不用再去：%v %v", changed, err)
	}
	expired := Call{Status: Pending, CreatedAt: called}
	if changed, err := expired.Claim("staff-a", called.Add(Window)); changed || !errors.Is(err, ErrClosed) || expired.ClaimedAt != nil {
		t.Fatalf("过期的不用再去：%v %v %+v", changed, err, expired)
	}
}
