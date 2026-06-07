package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
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
