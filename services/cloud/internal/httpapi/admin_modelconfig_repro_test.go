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
	createReq := httptest.NewRequest(http.MethodPost, "/api/v1/admin/model-configs", strings.NewReader(`{"slot":"chat.deep","capability":"chat","provider_kind":"mock","display_name":"深度","model_name":"deep-test","credit_multiplier":1,"enabled":false}`))
	createReq.Header.Set("Authorization", "Bearer "+token)
	createReq.Header.Set("Content-Type", "application/json")
	createRec := httptest.NewRecorder()
	server.ServeHTTP(createRec, createReq)
	if createRec.Code != http.StatusOK {
		t.Fatalf("create status = %d body = %s", createRec.Code, createRec.Body.String())
	}

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
// not wipe the seeded catalog fields.
func TestAdminModelConfigCatalogValidation(t *testing.T) {
	server, st := newTestServerAndStore(t, func(cfg *config.Config) {
		cfg.AdminEmails = []string{"admin@example.com"}
	})
	token := registerAndTokenWithEmail(t, server, "admin@example.com")
	if _, err := st.UpsertModelConfig(context.Background(), "admin", store.ModelConfig{
		Slot: "chat.fast", Capability: "chat", ProviderKind: "mock", DisplayName: "快速",
		Vendor: "DeepSeek", VendorInfo: "DeepSeek 模型", CapabilityTier: "fast",
		Description: "快速模型", Priority: 100, Enabled: true,
	}); err != nil {
		t.Fatalf("create chat.fast: %v", err)
	}

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

	// PATCH must carry stored description/priority through (regression guard:
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
	if fast.ID == "" || fast.Priority != 100 || fast.Description == "" || fast.VendorInfo == "" {
		t.Fatalf("stored chat.fast = %+v, want priority 100 + non-empty description/vendor_info", fast)
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
	if reloaded.Priority != 100 || reloaded.Description != fast.Description || reloaded.Vendor != fast.Vendor || reloaded.VendorInfo != fast.VendorInfo || reloaded.CapabilityTier != fast.CapabilityTier {
		t.Fatalf("after PATCH catalog fields were wiped: priority=%d description=%q vendor=%q vendor_info=%q tier=%q", reloaded.Priority, reloaded.Description, reloaded.Vendor, reloaded.VendorInfo, reloaded.CapabilityTier)
	}
}

func TestAdminModelConfigModelIDValidation(t *testing.T) {
	server, _ := newTestServerAndStore(t, func(cfg *config.Config) {
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

	valid := post(`{"slot":"gpt-4o","capability":"chat","provider_kind":"openai-compatible","display_name":"GPT-4o","vendor":"ChatGPT","vendor_info":"OpenAI 出品，通用能力全面。","capability_tier":"max","description":"通用强模型","priority":80,"base_url":"https://api.openai.com/v1","model_name":"gpt-4o","api_key":"sk-test","credit_multiplier":2.5,"input_price_per_million_cny":20,"output_price_per_million_cny":80,"cached_input_price_per_million_cny":2,"cache_write_price_per_million_cny":25,"enabled":true}`)
	if valid.Code != http.StatusOK {
		t.Fatalf("valid arbitrary chat model id status = %d, want 200; body = %s", valid.Code, valid.Body.String())
	}
	var validBody apiResponse[adminModelConfigView]
	if err := json.Unmarshal(valid.Body.Bytes(), &validBody); err != nil {
		t.Fatalf("decode valid response: %v", err)
	}
	if validBody.Data.Slot != "gpt-4o" || validBody.Data.DisplayName != "GPT-4o" || validBody.Data.Vendor != "ChatGPT" || validBody.Data.VendorInfo != "OpenAI 出品，通用能力全面。" || validBody.Data.CapabilityTier != "max" {
		t.Fatalf("saved model config = %+v, want slot gpt-4o + ChatGPT/max metadata", validBody.Data)
	}
	modelsReq := httptest.NewRequest(http.MethodGet, "/api/v1/models", nil)
	modelsReq.Header.Set("Authorization", "Bearer "+token)
	modelsRec := httptest.NewRecorder()
	server.ServeHTTP(modelsRec, modelsReq)
	if modelsRec.Code != http.StatusOK {
		t.Fatalf("list models status = %d body = %s", modelsRec.Code, modelsRec.Body.String())
	}
	var modelsBody apiResponse[modelsPayload]
	if err := json.Unmarshal(modelsRec.Body.Bytes(), &modelsBody); err != nil {
		t.Fatalf("decode models: %v", err)
	}
	found := false
	for _, model := range modelsBody.Data.Models {
		if model.ID == "gpt-4o" && model.Label == "GPT-4o" && model.Vendor == "ChatGPT" && model.VendorInfo == "OpenAI 出品，通用能力全面。" && model.CapabilityTier == "max" &&
			model.InputPricePerMillionCNY == 20 && model.OutputPricePerMillionCNY == 80 && model.CachedInputPricePerMillionCNY == 2 && model.CacheWritePricePerMillionCNY == 25 {
			found = true
		}
	}
	if !found {
		t.Fatalf("GET /models missing gpt-4o/GPT-4o catalog metadata and token prices; body = %s", modelsRec.Body.String())
	}

	for _, tc := range []struct {
		name    string
		payload string
	}{
		{
			name:    "auto is reserved",
			payload: `{"slot":"auto","capability":"chat","provider_kind":"mock","credit_multiplier":1}`,
		},
		{
			name:    "auto prefix is reserved",
			payload: `{"slot":"auto.fast","capability":"chat","provider_kind":"mock","credit_multiplier":1}`,
		},
		{
			name:    "blank model id",
			payload: `{"slot":"   ","capability":"chat","provider_kind":"mock","credit_multiplier":1}`,
		},
		{
			name:    "model id cannot contain whitespace",
			payload: `{"slot":"gpt 4o","capability":"chat","provider_kind":"mock","credit_multiplier":1}`,
		},
		{
			name:    "model id cannot exceed database limit",
			payload: `{"slot":"12345678901234567890123456789012345678901","capability":"chat","provider_kind":"mock","credit_multiplier":1}`,
		},
		{
			name:    "image slot is fixed",
			payload: `{"slot":"image.alt","capability":"image","provider_kind":"openai-compatible","base_url":"https://api.example.com/v1","model_name":"gpt-image-1","api_key":"sk-test","price_per_call_cny":0.1,"credit_multiplier":1}`,
		},
		{
			name:    "unknown capability tier",
			payload: `{"slot":"tier-bad","capability":"chat","provider_kind":"mock","capability_tier":"ultra","credit_multiplier":1}`,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if rec := post(tc.payload); rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400; body = %s", rec.Code, rec.Body.String())
			}
		})
	}
}

func TestAdminModelConfigPersistsTokenPricingFields(t *testing.T) {
	server, _ := newTestServerAndStore(t, func(cfg *config.Config) {
		cfg.AdminEmails = []string{"admin@example.com"}
	})
	token := registerAndTokenWithEmail(t, server, "admin@example.com")

	payload := `{
		"slot":"deepseek-pro-compatible",
		"capability":"chat",
		"provider_kind":"mock",
		"display_name":"DeepSeek Pro Compatible",
		"model_name":"deepseek-v4-pro",
		"credit_multiplier":1,
		"input_credit_multiplier":0.5,
		"output_credit_multiplier":2,
		"cached_input_credit_multiplier":0.1,
		"cache_write_credit_multiplier":1.25,
		"input_price_per_million_cny":20,
		"output_price_per_million_cny":80,
		"cached_input_price_per_million_cny":2,
		"cache_write_price_per_million_cny":25,
		"enabled":true
	}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/model-configs", strings.NewReader(payload))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("create status = %d, want 200; body = %s", rec.Code, rec.Body.String())
	}

	var body apiResponse[adminModelConfigView]
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode create response: %v", err)
	}
	if body.Data.InputCreditMultiplier != 0.5 || body.Data.OutputCreditMultiplier != 2 ||
		body.Data.CachedInputCreditMultiplier != 0.1 || body.Data.CacheWriteCreditMultiplier != 1.25 {
		t.Fatalf("pricing fields = %+v, want input/output/cache fields persisted", body.Data)
	}
	if body.Data.InputPricePerMillionCNY != 20 || body.Data.OutputPricePerMillionCNY != 80 ||
		body.Data.CachedInputPricePerMillionCNY != 2 || body.Data.CacheWritePricePerMillionCNY != 25 {
		t.Fatalf("CNY token prices = %+v, want per-million prices persisted", body.Data)
	}
}

func TestAdminModelConfigRejectsNegativeCNYTokenPrices(t *testing.T) {
	server, _ := newTestServerAndStore(t, func(cfg *config.Config) {
		cfg.AdminEmails = []string{"admin@example.com"}
	})
	token := registerAndTokenWithEmail(t, server, "admin@example.com")

	payload := `{
		"slot":"bad-price",
		"capability":"chat",
		"provider_kind":"mock",
		"model_name":"bad-price",
		"credit_multiplier":1,
		"input_price_per_million_cny":-0.01,
		"output_price_per_million_cny":80,
		"enabled":true
	}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/model-configs", strings.NewReader(payload))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body = %s", rec.Code, rec.Body.String())
	}
}
