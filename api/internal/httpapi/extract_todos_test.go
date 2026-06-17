package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/coldflame/shejane/api/internal/config"
)

func TestExtractTodosRequiresAuthAndRejectsUnsafePayload(t *testing.T) {
	server := newTestServer(t)

	unauth := httptest.NewRequest(http.MethodPost, "/api/v1/agent/extract-todos", strings.NewReader(`{"candidates":[]}`))
	unauth.Header.Set("Content-Type", "application/json")
	unauthRecorder := httptest.NewRecorder()
	server.ServeHTTP(unauthRecorder, unauth)
	if unauthRecorder.Code != http.StatusUnauthorized {
		t.Fatalf("unauth extract todos status = %d, want 401", unauthRecorder.Code)
	}

	token := registerAndToken(t, server)
	unsafeBody := `{
		"provider":"cloud_redacted",
		"model":"chat.fast",
		"candidates":[{
			"id":"msg-1",
			"text":"请今天联系 alice@example.com 确认合同",
			"redacted":true,
			"priority_hint":"today",
			"suggested_action":"reply"
		}]
	}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/agent/extract-todos", strings.NewReader(unsafeBody))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	server.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("unsafe extract todos status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), "脱敏") {
		t.Fatalf("unsafe rejection should mention redaction: %s", recorder.Body.String())
	}

	unsafeMetadataBody := `{
		"provider":"cloud_redacted",
		"model":"chat.fast",
		"source":"lark",
		"timezone":"Asia/Shanghai",
		"locale":"zh-CN",
		"schema_version":"lark_todo_extract.v1",
		"candidates":[{
			"id":"msg-1",
			"text":"请今天确认 [user] 的方案",
			"evidence_preview":"请今天确认 [user] 的方案",
			"redacted":true,
			"source_label":"chat_1",
			"source_type":"group",
			"created_at":"alice@example.com",
			"priority_hint":"today",
			"suggested_action":"reply"
		}]
	}`
	metadataReq := httptest.NewRequest(http.MethodPost, "/api/v1/agent/extract-todos", strings.NewReader(unsafeMetadataBody))
	metadataReq.Header.Set("Authorization", "Bearer "+token)
	metadataReq.Header.Set("Content-Type", "application/json")
	metadataRecorder := httptest.NewRecorder()
	server.ServeHTTP(metadataRecorder, metadataReq)
	if metadataRecorder.Code != http.StatusBadRequest {
		t.Fatalf("unsafe metadata extract todos status = %d, body = %s", metadataRecorder.Code, metadataRecorder.Body.String())
	}
}

func TestExtractTodosSettlesUsageAndReturnsStructuredTodos(t *testing.T) {
	server := newTestServer(t)
	token := registerAndToken(t, server)
	before := billingBalance(t, server, token)

	body := `{
		"provider":"cloud_redacted",
		"model":"chat.fast",
		"source":"lark",
		"candidates":[{
			"id":"msg-1",
			"text":"请今天确认 [user] 的方案，并在群里回复结论",
			"redacted":true,
			"source_label":"产品群",
			"source_type":"group",
			"due_at_hint":"2026-06-16T18:00:00+08:00",
			"priority_hint":"today",
			"suggested_action":"reply",
			"confidence":0.78
		}]
	}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/agent/extract-todos", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	server.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusOK {
		t.Fatalf("extract todos status = %d, body = %s", recorder.Code, recorder.Body.String())
	}

	var response apiResponse[struct {
		RequestID string `json:"requestId"`
		Provider  string `json:"provider"`
		Todos     []struct {
			CandidateID     string  `json:"candidateId"`
			Title           string  `json:"title"`
			Priority        string  `json:"priority"`
			DueAt           string  `json:"dueAt"`
			SuggestedAction string  `json:"suggestedAction"`
			Confidence      float64 `json:"confidence"`
		} `json:"todos"`
		Usage struct {
			CreditsCost int64 `json:"credits_cost"`
		} `json:"usage"`
	}]
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode extract todos response: %v", err)
	}
	if response.Data.RequestID == "" || response.Data.Provider != "cloud_redacted" {
		t.Fatalf("unexpected extract response metadata: %#v", response.Data)
	}
	if len(response.Data.Todos) != 1 {
		t.Fatalf("todos len = %d, body = %s", len(response.Data.Todos), recorder.Body.String())
	}
	if response.Data.Todos[0].CandidateID != "msg-1" || response.Data.Todos[0].Priority == "" || response.Data.Todos[0].SuggestedAction == "" {
		t.Fatalf("unexpected todo: %#v", response.Data.Todos[0])
	}
	if response.Data.Todos[0].DueAt != "2026-06-16T18:00:00+08:00" {
		t.Fatalf("dueAt = %q, want candidate deadline hint", response.Data.Todos[0].DueAt)
	}
	if response.Data.Usage.CreditsCost <= 0 {
		t.Fatalf("credits cost = %d, want positive", response.Data.Usage.CreditsCost)
	}

	after := billingBalance(t, server, token)
	if after.MonthlyRemaining >= before.MonthlyRemaining {
		t.Fatalf("monthly remaining before=%d after=%d, want decrease", before.MonthlyRemaining, after.MonthlyRemaining)
	}
	calls := usageRecords(t, server, token)
	if !strings.Contains(calls, `"scene":"todo_extract"`) {
		t.Fatalf("usage records missing todo_extract scene: %s", calls)
	}
}

func TestTodoExtractUserPayloadIncludesMetadataAndCoarseTimestamp(t *testing.T) {
	payload := todoExtractUserPayload(
		"lark",
		"Asia/Shanghai",
		"zh-CN",
		"lark_todo_extract.v1",
		[]extractTodoCandidate{
			{
				ID:              "msg-1",
				Text:            "请今天确认 [user] 的方案",
				EvidencePreview: "请今天确认 [user] 的方案",
				Redacted:        true,
				SourceLabel:     "chat_1",
				SourceType:      "group",
				CreatedAt:       "2026-06-15T09:34:00+08:00",
				DueAtHint:       "2026-06-16T18:00:00+08:00",
				PriorityHint:    "today",
				SuggestedAction: "reply",
				Confidence:      0.78,
			},
		},
	)

	var decoded struct {
		Source        string `json:"source"`
		Timezone      string `json:"timezone"`
		Locale        string `json:"locale"`
		SchemaVersion string `json:"schema_version"`
		Candidates    []struct {
			ID        string `json:"id"`
			CreatedAt string `json:"created_at"`
			DueAtHint string `json:"due_at_hint"`
		} `json:"candidates"`
	}
	if err := json.Unmarshal([]byte(payload), &decoded); err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	if decoded.Source != "lark" || decoded.Timezone != "Asia/Shanghai" || decoded.Locale != "zh-CN" || decoded.SchemaVersion != "lark_todo_extract.v1" {
		t.Fatalf("metadata missing from payload: %s", payload)
	}
	if len(decoded.Candidates) != 1 || decoded.Candidates[0].ID != "msg-1" || decoded.Candidates[0].CreatedAt != "2026-06-15T09:34:00+08:00" {
		t.Fatalf("candidate timestamp missing from payload: %s", payload)
	}
	if decoded.Candidates[0].DueAtHint != "2026-06-16T18:00:00+08:00" {
		t.Fatalf("candidate deadline hint missing from payload: %s", payload)
	}
}

func TestTodoExtractSystemPromptRequiresAbsoluteTimeAndRewriting(t *testing.T) {
	prompt := todoExtractSystemPrompt()

	required := []string{
		"Core principle",
		"You are NOT copying or summarizing the message",
		"id (return it as candidateId)",
		"Redaction safety (hard rules)",
		"NEVER restore, guess, or invent hidden names, IDs, URLs, emails, phone numbers, amounts, or secrets",
		"Resolve all relative time expressions into absolute local dates/times",
		"Never leave 今天/明天/后天/下周/这周/周五/tomorrow/next week/EOD in title or summary",
		"bare weekday",
		"lower confidence rather than fabricate",
		"summary: ONE sentence stating the concrete deliverable or next step",
		"Only split into multiple todos if the message clearly contains 2+ distinct",
		"Before returning — self-check",
		"No relative time words remain in title/summary",
		"下午前 / 下班前 / EOD / today = 18:00",
		"需要在 2026年6月16日 18:00 前提交一份 Lark CLI 连接优化方案。",
	}
	for _, want := range required {
		if !strings.Contains(prompt, want) {
			t.Fatalf("prompt missing %q:\n%s", want, prompt)
		}
	}
	if strings.Contains(prompt, "需要在明天下午前") {
		t.Fatalf("prompt should not model relative-time summaries:\n%s", prompt)
	}
}

func TestExtractTodosReleasesUsageOnModelFailure(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "model unavailable", http.StatusInternalServerError)
	}))
	defer upstream.Close()
	server := newTestServerWithConfig(t, func(cfg *config.Config) {
		cfg.MockLLM = false
		cfg.FastProviderBaseURL = upstream.URL
		cfg.FastProviderAPIKey = "test-key"
		cfg.FastProviderKind = "openai-compatible"
		cfg.FastModel = "test-model"
	})
	token := registerAndToken(t, server)
	before := billingBalance(t, server, token)

	body := `{
		"provider":"cloud_redacted",
		"model":"chat.fast",
		"candidates":[{
			"id":"msg-1",
			"text":"请今天确认 [user] 的方案",
			"redacted":true,
			"priority_hint":"today",
			"suggested_action":"reply"
		}]
	}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/agent/extract-todos", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	server.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusBadGateway {
		t.Fatalf("extract todos failure status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	after := billingBalance(t, server, token)
	if after.MonthlyRemaining != before.MonthlyRemaining {
		t.Fatalf("monthly remaining before=%d after=%d, want release", before.MonthlyRemaining, after.MonthlyRemaining)
	}
	transactions := walletTransactions(t, server, token)
	foundRelease := false
	for _, tx := range transactions {
		if tx.Type == "usage_release" {
			foundRelease = true
			break
		}
	}
	if !foundRelease {
		t.Fatalf("expected usage_release transaction, got %#v", transactions)
	}
}
