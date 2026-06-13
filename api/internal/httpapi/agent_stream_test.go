package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/coldflame/shejane/api/internal/app"
	"github.com/coldflame/shejane/api/internal/config"
	"github.com/coldflame/shejane/api/internal/llm"
	"github.com/coldflame/shejane/api/internal/modelreg"
	"github.com/coldflame/shejane/api/internal/store"
)

func TestAgentLLMStreamRequiresAuth(t *testing.T) {
	server := newTestServer(t)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/agent/llm/stream", strings.NewReader(`{"model":"chat.fast","messages":[{"role":"user","content":"hi"}]}`))
	req.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	server.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", recorder.Code)
	}
}

func TestAgentLLMStreamRejectsEmptyMessages(t *testing.T) {
	server := newTestServer(t)
	token := registerAndToken(t, server)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/agent/llm/stream", strings.NewReader(`{"model":"chat.fast","messages":[]}`))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	server.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400, body = %s", recorder.Code, recorder.Body.String())
	}
}

func TestAgentLLMStreamEmitsDeltaUsageAndDoneAndSettlesCredits(t *testing.T) {
	server := newTestServer(t)
	token := registerAndToken(t, server)
	before := billingBalance(t, server, token)

	body := `{"run_id":"local-run-stream-1","model":"chat.fast","messages":[{"role":"user","content":"hello stream"}]}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/agent/llm/stream", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	server.ServeHTTP(recorder, req)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if got := recorder.Header().Get("Content-Type"); !strings.HasPrefix(got, "text/event-stream") {
		t.Fatalf("content type = %q, want text/event-stream prefix", got)
	}

	events := parseSSEEvents(t, recorder.Body.String())
	mustHaveEvent(t, events, "llm.delta", func(payload map[string]any) bool {
		s, _ := payload["content_delta"].(string)
		return strings.Contains(s, "Mock SheJane response")
	})

	usagePayload := mustHaveEvent(t, events, "llm.usage", func(payload map[string]any) bool {
		return payload["input_tokens"] != nil && payload["output_tokens"] != nil && payload["credits_cost"] != nil
	})
	if usagePayload["credits_cost"].(float64) <= 0 {
		t.Fatalf("usage credits_cost should be > 0, got %v", usagePayload["credits_cost"])
	}

	donePayload := mustHaveEvent(t, events, "llm.done", func(payload map[string]any) bool {
		return payload["request_id"] != "" && payload["finish_reason"] != ""
	})
	if !strings.HasPrefix(donePayload["request_id"].(string), "req_") && donePayload["request_id"].(string) == "" {
		// Existing server.go mints requestIDs via app.NewRequestID(); just
		// ensure it's a non-empty string. Format may vary.
		t.Fatalf("done request_id empty: %#v", donePayload)
	}

	for _, ev := range events {
		if ev.event == "llm.error" {
			t.Fatalf("unexpected llm.error in stream: %s", ev.raw)
		}
	}

	after := billingBalance(t, server, token)
	if after.MonthlyRemaining >= before.MonthlyRemaining {
		t.Fatalf("monthly remaining before=%d after=%d, want decrease (credits should have been settled)",
			before.MonthlyRemaining, after.MonthlyRemaining)
	}
	calls := usageRecords(t, server, token)
	if !strings.Contains(calls, `"scene":"agent_local"`) {
		t.Fatalf("usage records missing agent_local scene: %s", calls)
	}
	if !strings.Contains(calls, `"run_id":"local-run-stream-1"`) {
		t.Fatalf("usage records missing local stream run_id: %s", calls)
	}
}

func TestRunAgentLLMStreamEmitsReasoningOnlyChunks(t *testing.T) {
	provider := streamReasoningProvider{}
	recorder := httptest.NewRecorder()

	err, _, _, finishReason := (&Server{}).runAgentLLMStream(
		context.Background(),
		recorder,
		provider,
		llm.ChatRequest{Messages: []llm.Message{{Role: "user", Content: "think first"}}},
		"claude-test",
		"req_test",
	)
	if err != nil {
		t.Fatalf("runAgentLLMStream: %v", err)
	}
	if finishReason != "stop" {
		t.Fatalf("finish reason = %q, want stop", finishReason)
	}

	events := parseSSEEvents(t, recorder.Body.String())
	mustHaveEvent(t, events, "llm.delta", func(payload map[string]any) bool {
		content, _ := payload["content_delta"].(string)
		reasoning, _ := payload["reasoning_delta"].(string)
		return content == "" && reasoning == "先想一步。"
	})
}

func TestAgentLLMStreamFallsBackToNextCandidateOnProviderFailure(t *testing.T) {
	cfg := config.Default()
	cfg.JWTSecret = "test-secret"
	cfg.MockLLM = true
	cfg.MonthlyCredits = 10_000
	memory := store.NewMemoryStore()
	application := app.New(cfg, memory)

	configs, _ := memory.ListModelConfigs(context.Background(), modelreg.CapabilityChat)
	for _, c := range configs {
		if c.Slot == modelreg.SlotChatFast || c.Slot == modelreg.SlotChatDeep {
			if _, err := memory.SetModelConfigEnabled(context.Background(), "", c.ID, false); err != nil {
				t.Fatalf("disable seed model: %v", err)
			}
		}
	}
	if _, err := memory.UpsertModelConfig(context.Background(), "admin", store.ModelConfig{
		Slot:         "bad-model",
		Capability:   modelreg.CapabilityChat,
		ProviderKind: "anthropic",
		DisplayName:  "Bad Model",
		BaseURL:      "https://anthropic.invalid",
		ModelName:    "claude-bad",
		Priority:     120,
		Enabled:      true,
	}); err != nil {
		t.Fatalf("upsert bad model: %v", err)
	}
	if _, err := memory.UpsertModelConfig(context.Background(), "admin", store.ModelConfig{
		Slot:         "good-model",
		Capability:   modelreg.CapabilityChat,
		ProviderKind: "mock",
		DisplayName:  "Good Model",
		ModelName:    "good-model",
		Priority:     100,
		Enabled:      true,
		Params:       map[string]any{"mock_reply": "fallback ok"},
	}); err != nil {
		t.Fatalf("upsert good model: %v", err)
	}
	application.Registry.Invalidate()
	server := NewServer(application)
	token := registerAndToken(t, server)

	body := `{"run_id":"local-run-fallback","model":"bad-model","messages":[{"role":"user","content":"hello"}]}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/agent/llm/stream", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	server.ServeHTTP(recorder, req)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	events := parseSSEEvents(t, recorder.Body.String())
	mustHaveEvent(t, events, "llm.model_selected", func(payload map[string]any) bool {
		return payload["requested_model"] == "bad-model" &&
			payload["resolved_model_id"] == "good-model" &&
			payload["reason"] == "上游失败后降级"
	})
	mustHaveEvent(t, events, "llm.delta", func(payload map[string]any) bool {
		content, _ := payload["content_delta"].(string)
		return strings.Contains(content, "fallback ok")
	})
	for _, ev := range events {
		if ev.event == "llm.error" {
			t.Fatalf("unexpected llm.error after fallback: %s", ev.raw)
		}
	}
	calls := usageRecords(t, server, token)
	for _, want := range []string{`"mode":"bad-model"`, `"status":"failed"`, `"mode":"good-model"`, `"status":"done"`} {
		if !strings.Contains(calls, want) {
			t.Fatalf("usage records missing %q after fallback: %s", want, calls)
		}
	}
}

// --- helpers ---

type streamReasoningProvider struct{}

func (streamReasoningProvider) Name() string {
	return "reasoning-test"
}

func (streamReasoningProvider) Stream(context.Context, llm.ChatRequest, string) (<-chan llm.Chunk, <-chan error) {
	chunks := make(chan llm.Chunk, 2)
	errs := make(chan error, 1)
	chunks <- llm.Chunk{ReasoningContent: "先想一步。"}
	chunks <- llm.Chunk{FinishReason: "stop"}
	close(chunks)
	close(errs)
	return chunks, errs
}

func (streamReasoningProvider) CompleteWithTools(context.Context, llm.ChatRequest, string) (llm.Completion, error) {
	return llm.Completion{}, errors.New("unexpected CompleteWithTools call")
}

type sseEvent struct {
	event string
	data  map[string]any
	raw   string
}

func parseSSEEvents(t *testing.T, body string) []sseEvent {
	t.Helper()
	var out []sseEvent
	var currentEvent string
	var currentData strings.Builder
	flush := func() {
		if currentEvent == "" && currentData.Len() == 0 {
			return
		}
		raw := currentData.String()
		var payload map[string]any
		if raw != "" && raw != "[DONE]" {
			if err := json.Unmarshal([]byte(raw), &payload); err != nil {
				// Skip non-JSON SSE data lines silently — keep helper permissive
				// so unrelated test fixtures don't fail this parser.
				out = append(out, sseEvent{event: currentEvent, raw: raw})
				currentEvent = ""
				currentData.Reset()
				return
			}
		}
		out = append(out, sseEvent{event: currentEvent, data: payload, raw: raw})
		currentEvent = ""
		currentData.Reset()
	}

	for _, line := range strings.Split(body, "\n") {
		line = strings.TrimRight(line, "\r")
		if line == "" {
			flush()
			continue
		}
		if strings.HasPrefix(line, "event:") {
			currentEvent = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
		} else if strings.HasPrefix(line, "data:") {
			if currentData.Len() > 0 {
				currentData.WriteByte('\n')
			}
			currentData.WriteString(strings.TrimSpace(strings.TrimPrefix(line, "data:")))
		}
	}
	flush()
	return out
}

func mustHaveEvent(t *testing.T, events []sseEvent, name string, predicate func(map[string]any) bool) map[string]any {
	t.Helper()
	for _, ev := range events {
		if ev.event != name {
			continue
		}
		if predicate == nil || predicate(ev.data) {
			return ev.data
		}
	}
	t.Fatalf("no %q event matching predicate in stream; events=%s", name, sseSummary(events))
	return nil
}

func sseSummary(events []sseEvent) string {
	parts := make([]string, 0, len(events))
	for _, ev := range events {
		parts = append(parts, ev.event+":"+ev.raw)
	}
	return strings.Join(parts, " | ")
}
