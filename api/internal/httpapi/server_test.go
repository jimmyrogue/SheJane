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

func TestAdminOriginAllowedByCORS(t *testing.T) {
	server := newTestServerWithConfig(t, func(cfg *config.Config) {
		cfg.ClientBaseURL = "https://app.example.com"
		cfg.AdminBaseURL = "https://admin.example.com"
	})

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	req.Header.Set("Origin", "https://admin.example.com")
	recorder := httptest.NewRecorder()

	server.ServeHTTP(recorder, req)

	if got := recorder.Header().Get("Access-Control-Allow-Origin"); got != "https://admin.example.com" {
		t.Fatalf("admin cors origin = %q, want admin origin", got)
	}
}

func TestAdminOverviewRequiresAdminRole(t *testing.T) {
	server := newTestServer(t)
	token := registerAndToken(t, server)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/admin/overview", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	recorder := httptest.NewRecorder()

	server.ServeHTTP(recorder, req)

	if recorder.Code != http.StatusForbidden {
		t.Fatalf("admin overview status = %d, want 403, body = %s", recorder.Code, recorder.Body.String())
	}
}

func TestAdminEmailCanAccessOverviewAndProviderStatusDoesNotExposeSecrets(t *testing.T) {
	server := newTestServerWithConfig(t, func(cfg *config.Config) {
		cfg.AdminEmails = []string{"admin@example.com"}
		cfg.MockLLM = false
		cfg.FastProviderAPIKey = "secret-fast-key"
		cfg.DeepProviderBaseURL = "https://api.deepseek.com"
		cfg.DeepProviderAPIKey = "secret-deep-key"
		cfg.DeepModel = "deepseek-v4-pro"
	})
	token := registerAndTokenWithEmail(t, server, "admin@example.com")

	overview := httptest.NewRequest(http.MethodGet, "/api/v1/admin/overview", nil)
	overview.Header.Set("Authorization", "Bearer "+token)
	overviewRecorder := httptest.NewRecorder()
	server.ServeHTTP(overviewRecorder, overview)
	if overviewRecorder.Code != http.StatusOK {
		t.Fatalf("admin overview status = %d, body = %s", overviewRecorder.Code, overviewRecorder.Body.String())
	}

	providers := httptest.NewRequest(http.MethodGet, "/api/v1/admin/providers", nil)
	providers.Header.Set("Authorization", "Bearer "+token)
	providersRecorder := httptest.NewRecorder()
	server.ServeHTTP(providersRecorder, providers)
	if providersRecorder.Code != http.StatusOK {
		t.Fatalf("admin providers status = %d, body = %s", providersRecorder.Code, providersRecorder.Body.String())
	}
	body := providersRecorder.Body.String()
	if strings.Contains(body, "secret-fast-key") || strings.Contains(body, "secret-deep-key") {
		t.Fatalf("provider status leaked API key: %s", body)
	}
	if !strings.Contains(body, `"api_key_configured":true`) {
		t.Fatalf("provider status missing key configured flag: %s", body)
	}
}

func TestExistingAdminEmailPromotesOnLoginAndRefresh(t *testing.T) {
	cfg := config.Default()
	cfg.JWTSecret = "test-secret"
	cfg.MockLLM = true
	cfg.MonthlyCredits = 10_000
	memory := store.NewMemoryStore()
	server := NewServer(app.New(cfg, memory))

	registerCookie := func(email string) *http.Cookie {
		t.Helper()
		register := httptest.NewRequest(http.MethodPost, "/api/v1/auth/register", strings.NewReader(`{"email":"`+email+`","password":"secret123","name":"Ops"}`))
		register.Header.Set("Content-Type", "application/json")
		registerRecorder := httptest.NewRecorder()
		server.ServeHTTP(registerRecorder, register)
		if registerRecorder.Code != http.StatusCreated {
			t.Fatalf("register %s status = %d, body = %s", email, registerRecorder.Code, registerRecorder.Body.String())
		}
		for _, cookie := range registerRecorder.Result().Cookies() {
			if cookie.Name == refreshCookieName {
				return cookie
			}
		}
		t.Fatalf("register %s did not set refresh cookie", email)
		return nil
	}
	refreshCookie := registerCookie("ops-refresh@example.com")
	registerCookie("ops-login@example.com")

	cfg.AdminEmails = []string{"ops-login@example.com", "ops-refresh@example.com"}
	server = NewServer(app.New(cfg, memory))

	login := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", strings.NewReader(`{"email":"ops-login@example.com","password":"secret123"}`))
	login.Header.Set("Content-Type", "application/json")
	loginRecorder := httptest.NewRecorder()
	server.ServeHTTP(loginRecorder, login)
	if loginRecorder.Code != http.StatusOK {
		t.Fatalf("login status = %d, body = %s", loginRecorder.Code, loginRecorder.Body.String())
	}
	var loginBody apiResponse[authPayload]
	if err := json.Unmarshal(loginRecorder.Body.Bytes(), &loginBody); err != nil {
		t.Fatalf("decode login response: %v", err)
	}
	if loginBody.Data.User.Role != "admin" {
		t.Fatalf("login role = %q, want admin", loginBody.Data.User.Role)
	}

	refresh := httptest.NewRequest(http.MethodPost, "/api/v1/auth/refresh", nil)
	refresh.AddCookie(refreshCookie)
	refreshRecorder := httptest.NewRecorder()
	server.ServeHTTP(refreshRecorder, refresh)
	if refreshRecorder.Code != http.StatusOK {
		t.Fatalf("refresh status = %d, body = %s", refreshRecorder.Code, refreshRecorder.Body.String())
	}
	var refreshBody apiResponse[authPayload]
	if err := json.Unmarshal(refreshRecorder.Body.Bytes(), &refreshBody); err != nil {
		t.Fatalf("decode refresh response: %v", err)
	}
	if refreshBody.Data.User.Role != "admin" {
		t.Fatalf("refresh role = %q, want admin", refreshBody.Data.User.Role)
	}
}

func TestAdminCanDisableUserAndDisabledTokenIsRejected(t *testing.T) {
	server := newTestServerWithConfig(t, func(cfg *config.Config) {
		cfg.AdminEmails = []string{"admin@example.com"}
	})
	adminToken := registerAndTokenWithEmail(t, server, "admin@example.com")
	userToken := registerAndTokenWithEmail(t, server, "disabled@example.com")
	user := currentUser(t, server, userToken)

	disable := httptest.NewRequest(http.MethodPatch, "/api/v1/admin/users/"+user.ID+"/status", strings.NewReader(`{"status":"disabled","reason":"abuse report"}`))
	disable.Header.Set("Authorization", "Bearer "+adminToken)
	disable.Header.Set("Content-Type", "application/json")
	disableRecorder := httptest.NewRecorder()
	server.ServeHTTP(disableRecorder, disable)
	if disableRecorder.Code != http.StatusOK {
		t.Fatalf("disable user status = %d, body = %s", disableRecorder.Code, disableRecorder.Body.String())
	}

	me := httptest.NewRequest(http.MethodGet, "/api/v1/user/me", nil)
	me.Header.Set("Authorization", "Bearer "+userToken)
	meRecorder := httptest.NewRecorder()
	server.ServeHTTP(meRecorder, me)
	if meRecorder.Code != http.StatusUnauthorized {
		t.Fatalf("disabled user me status = %d, want 401, body = %s", meRecorder.Code, meRecorder.Body.String())
	}

	login := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", strings.NewReader(`{"email":"disabled@example.com","password":"secret123"}`))
	login.Header.Set("Content-Type", "application/json")
	loginRecorder := httptest.NewRecorder()
	server.ServeHTTP(loginRecorder, login)
	if loginRecorder.Code != http.StatusUnauthorized {
		t.Fatalf("disabled user login status = %d, want 401, body = %s", loginRecorder.Code, loginRecorder.Body.String())
	}
}

func TestAdminCannotDisableSelf(t *testing.T) {
	server := newTestServerWithConfig(t, func(cfg *config.Config) {
		cfg.AdminEmails = []string{"admin@example.com"}
	})
	adminToken := registerAndTokenWithEmail(t, server, "admin@example.com")
	admin := currentUser(t, server, adminToken)

	req := httptest.NewRequest(http.MethodPatch, "/api/v1/admin/users/"+admin.ID+"/status", strings.NewReader(`{"status":"disabled","reason":"mistake"}`))
	req.Header.Set("Authorization", "Bearer "+adminToken)
	req.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	server.ServeHTTP(recorder, req)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("disable self status = %d, want 400, body = %s", recorder.Code, recorder.Body.String())
	}
}

func TestAdminAdjustsExtraCreditsWithTransactionAndAudit(t *testing.T) {
	server, memory := newTestServerAndStore(t, func(cfg *config.Config) {
		cfg.AdminEmails = []string{"admin@example.com"}
	})
	adminToken := registerAndTokenWithEmail(t, server, "admin@example.com")
	userToken := registerAndTokenWithEmail(t, server, "credits@example.com")
	user := currentUser(t, server, userToken)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/users/"+user.ID+"/credits/adjust", strings.NewReader(`{"delta":1500,"reason":"customer support credit"}`))
	req.Header.Set("Authorization", "Bearer "+adminToken)
	req.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	server.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusOK {
		t.Fatalf("adjust credits status = %d, body = %s", recorder.Code, recorder.Body.String())
	}

	detail := adminUserDetail(t, server, adminToken, user.ID)
	if detail.Wallet.ExtraCreditsBalance != 1500 {
		t.Fatalf("extra credits = %d, want 1500", detail.Wallet.ExtraCreditsBalance)
	}
	if len(detail.Transactions) == 0 || detail.Transactions[0].Type != "admin_adjust" {
		t.Fatalf("missing admin_adjust transaction: %#v", detail.Transactions)
	}
	if !memory.HasAuditLog("admin.extra_credit_adjust", user.ID) {
		t.Fatal("missing admin.extra_credit_adjust audit log")
	}

	negative := httptest.NewRequest(http.MethodPost, "/api/v1/admin/users/"+user.ID+"/credits/adjust", strings.NewReader(`{"delta":-2000,"reason":"correction"}`))
	negative.Header.Set("Authorization", "Bearer "+adminToken)
	negative.Header.Set("Content-Type", "application/json")
	negativeRecorder := httptest.NewRecorder()
	server.ServeHTTP(negativeRecorder, negative)
	if negativeRecorder.Code != http.StatusBadRequest {
		t.Fatalf("negative adjust status = %d, want 400, body = %s", negativeRecorder.Code, negativeRecorder.Body.String())
	}
	unchanged := adminUserDetail(t, server, adminToken, user.ID)
	if unchanged.Wallet.ExtraCreditsBalance != 1500 {
		t.Fatalf("extra credits after rejected adjust = %d, want 1500", unchanged.Wallet.ExtraCreditsBalance)
	}
}

func newTestServer(t *testing.T) http.Handler {
	t.Helper()
	server, _ := newTestServerAndStore(t, nil)
	return server
}

func newTestServerWithConfig(t *testing.T, mutate func(*config.Config)) http.Handler {
	t.Helper()
	server, _ := newTestServerAndStore(t, mutate)
	return server
}

func newTestServerAndStore(t *testing.T, mutate func(*config.Config)) (http.Handler, *store.MemoryStore) {
	t.Helper()
	cfg := config.Default()
	cfg.JWTSecret = "test-secret"
	cfg.MockLLM = true
	cfg.MonthlyCredits = 10_000
	if mutate != nil {
		mutate(&cfg)
	}
	memory := store.NewMemoryStore()
	service := app.New(cfg, memory)
	return NewServer(service), memory
}

func registerAndToken(t *testing.T, server http.Handler) string {
	t.Helper()
	return registerAndTokenWithEmail(t, server, "grace@example.com")
}

func registerAndTokenWithEmail(t *testing.T, server http.Handler, email string) string {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/register", strings.NewReader(`{"email":"`+email+`","password":"secret123","name":"Test User"}`))
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

func currentUser(t *testing.T, server http.Handler, token string) store.User {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/user/me", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	recorder := httptest.NewRecorder()
	server.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusOK {
		t.Fatalf("me status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var body apiResponse[store.User]
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode me response: %v", err)
	}
	return body.Data
}

func adminUserDetail(t *testing.T, server http.Handler, token string, userID string) store.AdminUserDetail {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/admin/users/"+userID, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	recorder := httptest.NewRecorder()
	server.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusOK {
		t.Fatalf("admin user detail status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var body apiResponse[store.AdminUserDetail]
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode admin user detail response: %v", err)
	}
	return body.Data
}
