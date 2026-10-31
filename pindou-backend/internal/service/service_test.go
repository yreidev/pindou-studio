package service

import (
	"context"
	"net"
	"net/http"
	"testing"
	"time"
)

// 关停必须等进行中的请求处理完：以前 Shutdown 一开始 main 就退出，正在落库的写请求被切断。
func TestServeWaitsForInFlightRequests(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		close(entered)
		<-release
		w.WriteHeader(http.StatusCreated)
	})}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	stopped := make(chan error, 1)
	go func() { stopped <- serve(ctx, srv, listener, func() {}, 5*time.Second) }()
	status := make(chan int, 1)
	go func() {
		res, err := http.Post("http://"+listener.Addr().String(), "application/json", nil)
		if err != nil {
			status <- 0
			return
		}
		_ = res.Body.Close()
		status <- res.StatusCode
	}()
	<-entered
	cancel()
	select {
	case <-stopped:
		t.Fatal("serve returned while a request was still running")
	case <-time.After(100 * time.Millisecond):
	}
	close(release)
	if got := <-status; got != http.StatusCreated {
		t.Fatalf("in-flight request status=%d", got)
	}
	if err := <-stopped; err != nil {
		t.Fatal(err)
	}
}
