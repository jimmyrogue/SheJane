package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/coldflame/shejane/api/internal/config"
	"github.com/coldflame/shejane/api/internal/store"
)

func TestAdminUpdateModelConfigReproUserPayload(t *testing.T) {
	server, _ := newTestServerAndStore(t, func(cfg *config.Config) {
		cfg.AdminEmails = []string{"admin@example.com"}
	})
	token := registerAndTokenWithEmail(t, server, "admin@example.com")

	listReq := httptest.NewRequest(http.MethodGet, "/api/v1/admin/model-configs", nil)
	listReq.Header.Set("Authorization", "Bearer "+token)
	listRec := httptest.NewRecorder()
	server.ServeHTTP(listRec, listReq)
	if listRec.Code != http.StatusOK {
		t.Fatalf("list status = %d body = %s", listRec.Code, listRec.Body.String())
	}
	var listBody apiResponse[[]adminModelConfigView]
	if err := json.Unmarshal(listRec.Body.Bytes(), &listBody); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	var deepID string
	for _, c := range listBody.Data {
		if c.Slot == "chat.deep" {
			deepID = c.ID
		}
	}
	if deepID == "" {
		t.Fatalf("no chat.deep row seeded; list = %s", listRec.Body.String())
	}

	payload := `{"slot":"chat.deep","capability":"chat","provider_kind":"deepseek-v4","display_name":"deep-compatible","base_url":"https://api.deepseek.com","model_name":"deepseek-v4-pro","credit_multiplier":1,"price_per_call_cny":0,"enabled":true}`
	patchReq := httptest.NewRequest(http.MethodPatch, "/api/v1/admin/model-configs/"+deepID, strings.NewReader(payload))
	patchReq.Header.Set("Authorization", "Bearer "+token)
	patchReq.Header.Set("Content-Type", "application/json")
	patchRec := httptest.NewRecorder()
	server.ServeHTTP(patchRec, patchReq)

	t.Logf("PATCH status=%d body=%s", patchRec.Code, patchRec.Body.String())
	if patchRec.Code != http.StatusOK {
		t.Fatalf("PATCH failed: status=%d body=%s", patchRec.Code, patchRec.Body.String())
	}
	var patchBody apiResponse[adminModelConfigView]
	if err := json.Unmarshal(patchRec.Body.Bytes(), &patchBody); err != nil {
		t.Fatalf("decode patch: %v", err)
	}
	if patchBody.Data.CreditMultiplier != 1 {
		t.Fatalf("multiplier after update = %v, want 1", patchBody.Data.CreditMultiplier)
	}
}

// Catalog admission rules: unknown provider kinds are rejected outright (typo
// guard — they would silently run as openai-compatible), anthropic is accepted
// into the chat catalog now that it does tool calls, and an admin PATCH must
// not wipe the seeded catalog fields (description/priority aren't admin input
// yet — Phase 4).
func TestAdminModelConfigCatalogValidation(t *testing.T) {
	server, st := newTestServerAndStore(t, func(cfg *config.Config) {
		cfg.AdminEmails = []string{"admin@example.com"}
	})
	token := registerAndTokenWithEmail(t, server, "admin@example.com")

	post := func(payload string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/model-configs", strings.NewReader(payload))
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		server.ServeHTTP(rec, req)
		return rec
	}

	// Unknown kind → 400.
	if rec := post(`{"slot":"chat.gemini","capability":"chat","provider_kind":"gemini","model_name":"gemini-pro"}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("unknown kind status = %d, want 400; body = %s", rec.Code, rec.Body.String())
	}

	// Anthropic is tool-capable now → accepted into the chat catalog.
	if rec := post(`{"slot":"chat.claude","capability":"chat","provider_kind":"anthropic","model_name":"claude-sonnet-4-5","api_key":"sk-ant-test","credit_multiplier":1.2}`); rec.Code != http.StatusOK {
		t.Fatalf("anthropic chat status = %d, want 200; body = %s", rec.Code, rec.Body.String())
	}

	// PATCH must carry seeded description/priority through (regression guard:
	// the input struct has no such fields yet, so they must come from the
	// existing row, not zero out).
	ctx := context.Background()
	configs, err := st.ListModelConfigs(ctx, "chat")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	var fast store.ModelConfig
	for _, c := range configs {
		if c.Slot == "chat.fast" {
			fast = c
		}
	}
	if fast.ID == "" || fast.Priority != 100 || fast.Description == "" {
		t.Fatalf("seeded chat.fast = %+v, want priority 100 + non-empty description", fast)
	}
	payload := `{"slot":"chat.fast","capability":"chat","provider_kind":"mock","display_name":"快速","credit_multiplier":0.2,"enabled":true}`
	patchReq := httptest.NewRequest(http.MethodPatch, "/api/v1/admin/model-configs/"+fast.ID, strings.NewReader(payload))
	patchReq.Header.Set("Authorization", "Bearer "+token)
	patchReq.Header.Set("Content-Type", "application/json")
	patchRec := httptest.NewRecorder()
	server.ServeHTTP(patchRec, patchReq)
	if patchRec.Code != http.StatusOK {
		t.Fatalf("patch status = %d body = %s", patchRec.Code, patchRec.Body.String())
	}
	reloaded, err := st.GetModelConfig(ctx, fast.ID)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if reloaded.Priority != 100 || reloaded.Description != fast.Description {
		t.Fatalf("after PATCH priority=%d description=%q — seeded catalog fields were wiped", reloaded.Priority, reloaded.Description)
	}
}
