package domain

import (
	"errors"
	"testing"
	"time"
)

func TestPauseResumePreservesPurchasedTime(t *testing.T) {
	start := time.Date(2026, 9, 8, 8, 0, 0, 0, time.UTC)
	s := Session{Status: "active", StartedAt: start, DurationMinutes: 60, TimingMode: "timed"}
	s.Transition("paused", start.Add(10*time.Minute))
	s.Transition("paused", start.Add(15*time.Minute))
	if s.PausedAt == nil || !s.PausedAt.Equal(start.Add(10*time.Minute)) {
		t.Fatal("duplicate pause reset its starting time")
	}
	if got := s.Deadline(start.Add(25 * time.Minute)); !got.Equal(start.Add(75 * time.Minute)) {
		t.Fatalf("paused deadline: %s", got)
	}
	s.Transition("active", start.Add(30*time.Minute))
	if s.PausedSeconds != 1200 || s.PausedAt != nil {
		t.Fatal("resume did not retain exactly twenty paused minutes")
	}
	s.Transition("active", start.Add(35*time.Minute))
	s.Transition("paused", start.Add(40*time.Minute))
	s.Transition("active", start.Add(45*time.Minute))
	if s.PausedSeconds != 1500 || !s.Deadline(start.Add(50*time.Minute)).Equal(start.Add(85*time.Minute)) {
		t.Fatal("multiple pauses lost or counted time twice")
	}
}

func TestPauseClockDoesNotSubtractTimeWhenClockMovesBack(t *testing.T) {
	now := time.Date(2026, 9, 8, 8, 0, 0, 0, time.UTC)
	s := Session{Status: "active", StartedAt: now, DurationMinutes: 30, PausedSeconds: 60}
	s.Transition("paused", now.Add(10*time.Minute))
	if !s.Deadline(now.Add(9 * time.Minute)).Equal(now.Add(31 * time.Minute)) {
		t.Fatal("clock reversal shortened deadline")
	}
	s.Transition("active", now.Add(9*time.Minute))
	if s.PausedSeconds != 60 || s.PausedAt != nil {
		t.Fatal("clock reversal changed accrued pause duration")
	}
}

func TestLeavingPausedSessionClosesPauseExactlyOnce(t *testing.T) {
	for _, target := range []string{"companion", "cancelled", "settled"} {
		t.Run(target, func(t *testing.T) {
			now := time.Date(2026, 9, 8, 8, 0, 0, 0, time.UTC)
			s := Session{Status: "paused", PausedAt: &now}
			s.Transition(target, now.Add(90*time.Second))
			s.Transition(target, now.Add(120*time.Second))
			if s.Status != target || s.PausedAt != nil || s.PausedSeconds != 90 {
				t.Fatalf("unexpected transition: %+v", s)
			}
		})
	}
}

// 陪客标记只记在 status 上：陪客 → 暂停 → 继续会把它弄丢，建单就按套餐价收了。
func TestCompanionStaysCompanion(t *testing.T) {
	now := time.Date(2026, 9, 8, 8, 0, 0, 0, time.UTC)
	s := Session{Status: "active", StartedAt: now, DurationMinutes: 60, TimingMode: "timed"}
	if err := s.ChangeStatus("companion", now); err != nil || s.Status != "companion" {
		t.Fatalf("marking companion: %v %+v", err, s)
	}
	for _, target := range []string{"paused", "active"} {
		if err := s.ChangeStatus(target, now.Add(time.Minute)); !errors.Is(err, ErrCompanionTiming) {
			t.Fatalf("%s: want ErrCompanionTiming, got %v", target, err)
		}
		if s.Status != "companion" || s.PausedAt != nil {
			t.Fatalf("%s changed a companion session: %+v", target, s)
		}
	}
	paused := Session{Status: "paused", PausedAt: &now}
	if err := paused.ChangeStatus("companion", now.Add(30*time.Second)); err != nil || paused.Status != "companion" || paused.PausedSeconds != 30 {
		t.Fatalf("a paused session can still be marked companion: %v %+v", err, paused)
	}
}
