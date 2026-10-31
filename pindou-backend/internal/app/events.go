package app

import (
	"fmt"
	"net/http"
	"time"
)

func (s *Server) serveSSE(w http.ResponseWriter, r *http.Request, viewer streamViewer) {
	ch := s.hub.subscribe(viewer)
	defer s.hub.unsubscribe(ch)
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	controller := http.NewResponseController(w)
	// Clear the server-wide request deadline for this long-lived stream. Each
	// individual write below installs its own short deadline instead.
	if err := controller.SetWriteDeadline(time.Time{}); err != nil {
		return
	}
	if _, err := fmt.Fprint(w, "retry: 1000\n: connected\n\n"); err != nil {
		return
	}
	if controller.Flush() != nil {
		return
	}
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-s.hub.closed:
			return
		case e := <-ch:
			if !s.stillViewing(r, viewer) {
				return
			}
			_ = controller.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if _, err := fmt.Fprintf(w, "data: %s\n\n", e.payload); err != nil {
				return
			}
		case <-ticker.C:
			if !s.stillViewing(r, viewer) {
				return
			}
			_ = controller.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if _, err := fmt.Fprint(w, ": heartbeat\n\n"); err != nil {
				return
			}
		}
		if controller.Flush() != nil {
			return
		}
	}
}
