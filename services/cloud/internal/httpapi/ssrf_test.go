package httpapi

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestIsPublicIP(t *testing.T) {
	cases := []struct {
		ip     string
		public bool
	}{
		{"8.8.8.8", true},
		{"2606:4700:4700::1111", true},
		{"127.0.0.1", false},
		{"10.0.0.5", false},
		{"192.168.1.1", false},
		{"172.16.0.1", false},
		{"169.254.169.254", false}, // cloud metadata endpoint
		{"::1", false},
		{"fd00::1", false}, // IPv6 ULA (private)
	}
	for _, c := range cases {
		if got := isPublicIP(net.ParseIP(c.ip)); got != c.public {
			t.Errorf("isPublicIP(%s) = %v, want %v", c.ip, got, c.public)
		}
	}
	if isPublicIP(nil) {
		t.Error("a nil IP must be treated as non-public")
	}
}

// A user/agent-supplied image URL pointing at a loopback (or any internal)
// address must be refused — the safe client rejects the dial.
func TestFetchURLBytesBlocksLoopback(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("internal secret"))
	}))
	defer srv.Close()
	if _, _, err := fetchURLBytes(context.Background(), srv.URL); err == nil {
		t.Fatal("fetchURLBytes must refuse to connect to a loopback address")
	}
}

func TestFetchURLBytesRejectsNonHTTPScheme(t *testing.T) {
	if _, _, err := fetchURLBytes(context.Background(), "file:///etc/passwd"); err == nil {
		t.Fatal("fetchURLBytes must reject non-http(s) schemes")
	}
}
