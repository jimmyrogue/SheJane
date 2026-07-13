package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/coldflame/shejane/api/internal/app"
	"github.com/coldflame/shejane/api/internal/config"
	"github.com/coldflame/shejane/api/internal/store"
)

func TestHealthzAlwaysOK(t *testing.T) {
	server := newTestServer(t)
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("/healthz = %d, want 200", rec.Code)
	}
}

func TestSecurityHeaders(t *testing.T) {
	server := newTestServer(t)
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/healthz", nil))

	expected := map[string]string{
		"Strict-Transport-Security": "max-age=31536000; includeSubDomains",
		"X-Frame-Options":           "DENY",
		"X-Content-Type-Options":    "nosniff",
		"Referrer-Policy":           "no-referrer",
		"Permissions-Policy":        "camera=(), geolocation=(), microphone=()",
	}
	for header, want := range expected {
		if got := rec.Header().Get(header); got != want {
			t.Fatalf("%s = %q, want %q", header, got, want)
		}
	}
	csp := rec.Header().Get("Content-Security-Policy")
	if csp == "" {
		t.Fatal("Content-Security-Policy is empty")
	}
	for _, part := range []string{"default-src 'none'", "frame-ancestors 'none'", "base-uri 'none'"} {
		if !strings.Contains(csp, part) {
			t.Fatalf("Content-Security-Policy = %q, want it to contain %q", csp, part)
		}
	}
}

func TestReadyzReflectsStorePing(t *testing.T) {
	// Healthy store → ready.
	server := newTestServer(t)
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("/readyz (healthy) = %d, want 200", rec.Code)
	}

	// Unreachable store → 503 so monitoring/orchestration sees it.
	cfg := config.Default()
	cfg.JWTSecret = "test-secret"
	down := NewServer(app.New(cfg, pingFailStore{store.NewMemoryStore()}))
	rec = httptest.NewRecorder()
	down.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("/readyz (store down) = %d, want 503", rec.Code)
	}
}

// pingFailStore is a MemoryStore whose readiness ping always fails.
type pingFailStore struct {
	*store.MemoryStore
}

func (pingFailStore) Ping(context.Context) error { return errors.New("store unreachable") }
