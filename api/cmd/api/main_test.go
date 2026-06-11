package main

import (
	"net/http"
	"testing"
	"time"

	"github.com/coldflame/shejane/api/internal/config"
)

func TestNewHTTPServerConfiguresProductionTimeouts(t *testing.T) {
	cfg := config.Default()
	cfg.HTTPAddr = "127.0.0.1:0"
	handler := http.NewServeMux()

	server := newHTTPServer(cfg, handler)

	if server.Addr != cfg.HTTPAddr {
		t.Fatalf("Addr = %q, want %q", server.Addr, cfg.HTTPAddr)
	}
	if server.Handler != handler {
		t.Fatal("Handler was not preserved")
	}
	if server.ReadHeaderTimeout != 5*time.Second {
		t.Fatalf("ReadHeaderTimeout = %s, want 5s", server.ReadHeaderTimeout)
	}
	if server.ReadTimeout != 30*time.Second {
		t.Fatalf("ReadTimeout = %s, want 30s", server.ReadTimeout)
	}
	if server.IdleTimeout != 120*time.Second {
		t.Fatalf("IdleTimeout = %s, want 120s", server.IdleTimeout)
	}
	if server.WriteTimeout != 0 {
		t.Fatalf("WriteTimeout = %s, want 0 so SSE streams are not force-closed", server.WriteTimeout)
	}
}
