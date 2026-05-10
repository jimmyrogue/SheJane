package httpapi

import (
	"bufio"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/coldflame/jiandanly/api/internal/app"
	"github.com/coldflame/jiandanly/api/internal/config"
	"github.com/coldflame/jiandanly/api/internal/store"
)

func TestRegisterLoginAndMe(t *testing.T) {
	server := newTestServer(t)

	register := httptest.NewRequest(http.MethodPost, "/api/v1/auth/register", strings.NewReader(`{"email":"ada@example.com","password":"secret123","name":"Ada"}`))
	register.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	server.ServeHTTP(recorder, register)

	if recorder.Code != http.StatusCreated {
		t.Fatalf("register status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if len(recorder.Result().Cookies()) == 0 {
		t.Fatal("register did not set refresh cookie")
	}

	var registerBody apiResponse[authPayload]
	if err := json.Unmarshal(recorder.Body.Bytes(), &registerBody); err != nil {
		t.Fatalf("decode register response: %v", err)
	}
	if registerBody.Data.AccessToken == "" {
		t.Fatal("register access token is empty")
	}

	me := httptest.NewRequest(http.MethodGet, "/api/v1/user/me", nil)
	me.Header.Set("Authorization", "Bearer "+registerBody.Data.AccessToken)
	meRecorder := httptest.NewRecorder()
	server.ServeHTTP(meRecorder, me)

	if meRecorder.Code != http.StatusOK {
		t.Fatalf("me status = %d, body = %s", meRecorder.Code, meRecorder.Body.String())
	}
	if !strings.Contains(meRecorder.Body.String(), "ada@example.com") {
		t.Fatalf("me response missing user email: %s", meRecorder.Body.String())
	}
}

func TestChatStreamsAndSettlesUsage(t *testing.T) {
	server := newTestServer(t)
	token := registerAndToken(t, server)

	body := `{"model":"fast","stream":true,"client_conversation_id":"conv-local","client_message_id":"msg-local","scene":"write","messages":[{"role":"user","content":"写一封客户跟进邮件"}]}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/chat/completions", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()

	server.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusOK {
		t.Fatalf("chat status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if got := recorder.Header().Get("Content-Type"); !strings.HasPrefix(got, "text/event-stream") {
		t.Fatalf("content type = %q, want text/event-stream", got)
	}

	scanner := bufio.NewScanner(strings.NewReader(recorder.Body.String()))
	var sawDelta bool
	var sawDone bool
	for scanner.Scan() {
		line := scanner.Text()
		if strings.Contains(line, "Mock Jiandan response") {
			sawDelta = true
		}
		if line == "data: [DONE]" {
			sawDone = true
		}
	}
	if !sawDelta || !sawDone {
		t.Fatalf("stream delta=%t done=%t body=%s", sawDelta, sawDone, recorder.Body.String())
	}
}

func TestBillingBalanceRequiresAuth(t *testing.T) {
	server := newTestServer(t)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/billing/balance", nil)
	recorder := httptest.NewRecorder()

	server.ServeHTTP(recorder, req)

	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("billing status = %d, want 401", recorder.Code)
	}
}

func newTestServer(t *testing.T) http.Handler {
	t.Helper()
	cfg := config.Default()
	cfg.JWTSecret = "test-secret"
	cfg.MockLLM = true
	cfg.MonthlyCredits = 10_000
	service := app.New(cfg, store.NewMemoryStore())
	return NewServer(service)
}

func registerAndToken(t *testing.T, server http.Handler) string {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/register", strings.NewReader(`{"email":"grace@example.com","password":"secret123","name":"Grace"}`))
	req.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	server.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("register status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var body apiResponse[authPayload]
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode register response: %v", err)
	}
	return body.Data.AccessToken
}
