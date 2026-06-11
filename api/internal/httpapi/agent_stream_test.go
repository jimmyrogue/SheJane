package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
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

// --- helpers ---

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
