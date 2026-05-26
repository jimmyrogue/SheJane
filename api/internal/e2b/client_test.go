package e2b

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestNewRejectsEmptyAPIKey(t *testing.T) {
	if _, err := New(Options{APIKey: ""}); err != ErrConfigMissing {
		t.Fatalf("expected ErrConfigMissing, got %v", err)
	}
}

func TestNewDefaultsBaseURL(t *testing.T) {
	c, err := New(Options{APIKey: "tk"})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if c.baseURL != "https://api.e2b.dev" {
		t.Fatalf("baseURL=%q", c.baseURL)
	}
}

func TestCreateSandboxParsesResponse(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/sandboxes" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		if got := r.Header.Get("X-API-Key"); got != "tk" {
			t.Errorf("X-API-Key=%q (expected %q)", got, "tk")
		}
		if r.Header.Get("Authorization") != "" {
			t.Errorf("Authorization header should be empty; E2B uses X-API-Key")
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["templateID"] != "code-interpreter-v1" {
			t.Errorf("templateID=%v", body["templateID"])
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"sandboxID":  "sbx-1",
			"clientID":   "cli-1",
			"templateID": "code-interpreter-v1",
			"startedAt":  time.Now().UTC().Format(time.RFC3339),
		})
	}))
	defer srv.Close()

	c, err := New(Options{APIKey: "tk", BaseURL: srv.URL})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	info, err := c.CreateSandbox(context.Background(), "", map[string]string{"k": "v"})
	if err != nil {
		t.Fatalf("CreateSandbox: %v", err)
	}
	if info.SandboxID != "sbx-1" {
		t.Fatalf("sandboxID=%q", info.SandboxID)
	}
}

func TestKillSandboxIdempotentOn404(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()
	c, _ := New(Options{APIKey: "tk", BaseURL: srv.URL})
	if err := c.KillSandbox(context.Background(), "missing-sbx"); err != nil {
		t.Fatalf("expected nil for 404 kill, got %v", err)
	}
}

// routingClient builds an http.Client whose Transport always dials
// the given test server, regardless of the request URL's host. This
// lets us test the per-sandbox URL pattern without DNS plumbing.
func routingClient(t *testing.T, target string) *http.Client {
	t.Helper()
	u, err := url.Parse(target)
	if err != nil {
		t.Fatalf("parse target: %v", err)
	}
	return &http.Client{
		Timeout: 10 * time.Second,
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, network, _addr string) (net.Conn, error) {
				return (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, network, u.Host)
			},
		},
	}
}

func TestRunCodeReturnsResultViaPerSandboxURL(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Must hit /execute on the per-sandbox host (host starts with
		// "49999-{sandboxID}-{clientID}").
		if r.URL.Path != "/execute" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		if !strings.HasPrefix(r.Host, "49999-sbx-1-cli-1.") {
			t.Errorf("unexpected host %s", r.Host)
		}
		w.Header().Set("Content-Type", "application/x-ndjson")
		_, _ = w.Write([]byte(`{"type":"stdout","text":"ok\n"}` + "\n" + `{"type":"end_of_execution"}` + "\n"))
	}))
	defer srv.Close()

	c, _ := New(Options{
		APIKey:     "tk",
		BaseURL:    srv.URL,
		HTTPClient: routingClient(t, srv.URL),
		HostSuffix: "localhost", // triggers http (not https) scheme
	})
	result, err := c.RunCode(context.Background(), "sbx-1", "cli-1", "print('ok')", "python", 5*time.Second)
	if err != nil {
		t.Fatalf("RunCode: %v", err)
	}
	if result.Stdout != "ok\n" {
		t.Fatalf("stdout=%q", result.Stdout)
	}
	if result.ExecutionMs < 0 {
		t.Fatalf("expected ExecutionMs >= 0, got %d", result.ExecutionMs)
	}
}

func TestRunCodeMissingSandboxSurfaced(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()
	c, _ := New(Options{
		APIKey:     "tk",
		BaseURL:    srv.URL,
		HTTPClient: routingClient(t, srv.URL),
		HostSuffix: "localhost",
	})
	_, err := c.RunCode(context.Background(), "sbx-gone", "cli", "print(1)", "python", time.Second)
	if err != ErrSandboxNotFound {
		t.Fatalf("expected ErrSandboxNotFound, got %v", err)
	}
}
