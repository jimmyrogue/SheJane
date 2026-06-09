package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/coldflame/shejane/api/internal/config"
)

func TestRateLimiterBurstThenDeny(t *testing.T) {
	rl := newRateLimiter(3)
	for i := 0; i < 3; i++ {
		if !rl.allow("k") {
			t.Fatalf("request %d should be allowed within the burst", i)
		}
	}
	if rl.allow("k") {
		t.Fatal("request past the burst should be denied")
	}
	if !rl.allow("other-key") {
		t.Fatal("a different key must have its own independent bucket")
	}
}

func TestClientIP(t *testing.T) {
	cases := []struct {
		name, xff, xreal, remote, want string
	}{
		{"x-forwarded-for first hop", "203.0.113.7, 70.0.0.1", "", "10.0.0.1:5", "203.0.113.7"},
		{"x-real-ip fallback", "", "203.0.113.9", "10.0.0.1:5", "203.0.113.9"},
		{"remote addr fallback", "", "", "203.0.113.5:4321", "203.0.113.5"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodGet, "/", nil)
			r.RemoteAddr = c.remote
			if c.xff != "" {
				r.Header.Set("X-Forwarded-For", c.xff)
			}
			if c.xreal != "" {
				r.Header.Set("X-Real-IP", c.xreal)
			}
			if got := clientIP(r); got != c.want {
				t.Fatalf("clientIP = %q, want %q", got, c.want)
			}
		})
	}
}

// The auth endpoints must brute-force-throttle per IP: after the limit
// (30/min) the next attempt is rejected with 429 rather than reaching the
// credential check.
func TestAuthEndpointRateLimited(t *testing.T) {
	server := newTestServer(t)
	var last int
	for i := 0; i < 32; i++ {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login",
			strings.NewReader(`{"email":"x@y.z","password":"wrong"}`))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		server.ServeHTTP(rec, req)
		last = rec.Code
	}
	if last != http.StatusTooManyRequests {
		t.Fatalf("after exceeding the auth rate limit, status = %d, want 429", last)
	}
}

// The spend-heavy agent endpoints carry a tighter, dedicated per-user ceiling
// (agentSpendLimiter) on top of the general per-user limit. Once it's exhausted
// the next call is rejected with 429 BEFORE the handler runs — this is the
// server-side backstop for the browser-driven tool loop, whose client-side
// maxSteps cap can't be trusted. The limit is shared across the spend
// endpoints, so spreading calls across them doesn't bypass it.
func TestAgentSpendEndpointsRateLimitedPerUser(t *testing.T) {
	server := newTestServerWithConfig(t, func(cfg *config.Config) {
		cfg.AgentSpendRateLimitPerMinute = 3 // tiny burst so the test is fast + deterministic
	})
	token := registerAndToken(t, server)

	call := func(path, body string) int {
		req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		server.ServeHTTP(rec, req)
		return rec.Code
	}

	// Drain the 3-token bucket across DIFFERENT spend endpoints to prove the
	// ceiling is shared, not per-endpoint. Bodies can be invalid — the limiter
	// runs before the handler, so the only status we care about is 429-or-not.
	_ = call("/api/v1/agent/tools/execute", `{"tool":"web.search","arguments":{"query":"x"}}`)
	_ = call("/api/v1/agent/llm/stream", `{"messages":[{"role":"user","content":"hi"}]}`)
	_ = call("/api/v1/images/generations", `{"prompt":"a cat"}`)

	// 4th spend call (any endpoint) must be throttled.
	if code := call("/api/v1/agent/tools/execute", `{"tool":"web.search","arguments":{"query":"x"}}`); code != http.StatusTooManyRequests {
		t.Fatalf("4th spend call status = %d, want 429 (shared per-user spend limit)", code)
	}

	// A different user has an independent bucket and is not throttled.
	otherToken := registerAndTokenWithEmail(t, server, "other-spender@example.com")
	otherReq := httptest.NewRequest(http.MethodPost, "/api/v1/agent/tools/execute",
		strings.NewReader(`{"tool":"web.search","arguments":{"query":"x"}}`))
	otherReq.Header.Set("Authorization", "Bearer "+otherToken)
	otherReq.Header.Set("Content-Type", "application/json")
	otherRec := httptest.NewRecorder()
	server.ServeHTTP(otherRec, otherReq)
	if otherRec.Code == http.StatusTooManyRequests {
		t.Fatal("a different user must have an independent spend bucket")
	}
}
