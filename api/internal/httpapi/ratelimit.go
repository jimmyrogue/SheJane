package httpapi

import (
	"math"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// rateLimiter is a small in-memory token-bucket limiter keyed by an
// arbitrary string (client IP or user id). It is intentionally
// process-local: the production API runs as a single instance behind
// Caddy, so a shared store (Redis) would be premature. Each key's bucket
// refills continuously at ratePerSec up to burst; idle, fully-refilled
// buckets are swept lazily so the map can't grow without bound.
type rateLimiter struct {
	mu         sync.Mutex
	buckets    map[string]*tokenBucket
	ratePerSec float64
	burst      float64
}

type tokenBucket struct {
	tokens float64
	last   time.Time
}

// newRateLimiter builds a limiter that allows up to perMinute requests per
// key per minute, with a burst capacity equal to perMinute.
func newRateLimiter(perMinute int) *rateLimiter {
	return &rateLimiter{
		buckets:    make(map[string]*tokenBucket),
		ratePerSec: float64(perMinute) / 60.0,
		burst:      float64(perMinute),
	}
}

// rateLimiterSweepThreshold caps the bucket map: once it grows past this,
// allow() drops idle (fully-refilled, untouched for a minute) buckets.
const rateLimiterSweepThreshold = 4096

// allow consumes one token for key, returning false when the bucket is
// empty (the caller should respond 429).
func (rl *rateLimiter) allow(key string) bool {
	now := time.Now()
	rl.mu.Lock()
	defer rl.mu.Unlock()

	if len(rl.buckets) > rateLimiterSweepThreshold {
		for k, b := range rl.buckets {
			if now.Sub(b.last) > time.Minute && b.tokens >= rl.burst {
				delete(rl.buckets, k)
			}
		}
	}

	b := rl.buckets[key]
	if b == nil {
		b = &tokenBucket{tokens: rl.burst, last: now}
		rl.buckets[key] = b
	} else {
		elapsed := now.Sub(b.last).Seconds()
		b.tokens = math.Min(rl.burst, b.tokens+elapsed*rl.ratePerSec)
		b.last = now
	}
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// clientIP extracts the originating client IP. Forwarded headers are trusted
// only when the immediate peer is a local/private reverse proxy; direct public
// clients cannot rotate limiter keys by spoofing X-Forwarded-For.
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	if isTrustedProxyRemote(host) {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			// The left-most entry is the original client; the rest are proxies.
			if first := strings.TrimSpace(strings.SplitN(xff, ",", 2)[0]); first != "" {
				return first
			}
		}
		if xr := strings.TrimSpace(r.Header.Get("X-Real-IP")); xr != "" {
			return xr
		}
	}
	return host
}

func isTrustedProxyRemote(host string) bool {
	ip := net.ParseIP(strings.TrimSpace(host))
	if ip == nil {
		return false
	}
	return ip.IsLoopback() || ip.IsPrivate()
}
