package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/coldflame/shejane/api/internal/config"
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
