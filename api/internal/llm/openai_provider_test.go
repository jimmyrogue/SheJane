package llm

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestOpenAICompatibleProviderRequestsUsageInStream(t *testing.T) {
	var payload map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/chat/completions" {
			t.Fatalf("path = %q, want /chat/completions", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer test-key" {
			t.Fatalf("authorization header = %q", r.Header.Get("Authorization"))
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatalf("decode request body: %v", err)
		}

		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
	}))
	defer server.Close()

	provider := NewOpenAICompatibleProvider("deepseek-fast", server.URL, "test-key")
	chunks, errs := provider.Stream(context.Background(), ChatRequest{
		Messages: []Message{{Role: "user", Content: "hello"}},
	}, "deepseek-chat")

	for range chunks {
	}
	if err := <-errs; err != nil {
		t.Fatalf("Stream returned error: %v", err)
	}

	streamOptions, ok := payload["stream_options"].(map[string]any)
	if !ok {
		t.Fatalf("stream_options missing from request payload: %#v", payload)
	}
	if streamOptions["include_usage"] != true {
		t.Fatalf("stream_options.include_usage = %#v, want true", streamOptions["include_usage"])
	}
}

func TestOpenAICompatibleProviderStreamsContentAndUsageOnlyEvent(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		events := []string{
			`data: {"choices":[{"delta":{"content":"你"},"finish_reason":""}]}`,
			`data: {"choices":[{"delta":{"content":"好"},"finish_reason":"stop"}]}`,
			`data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":11}}`,
			`data: [DONE]`,
		}
		_, _ = w.Write([]byte(strings.Join(events, "\n\n") + "\n\n"))
	}))
	defer server.Close()

	provider := NewOpenAICompatibleProvider("deepseek-fast", server.URL, "test-key")
	chunks, errs := provider.Stream(context.Background(), ChatRequest{
		Messages: []Message{{Role: "user", Content: "hello"}},
	}, "deepseek-chat")

	text := ""
	inputTokens := 0
	outputTokens := 0
	for chunk := range chunks {
		text += chunk.Text
		if chunk.InputTokens > 0 {
			inputTokens = chunk.InputTokens
		}
		if chunk.OutputTokens > 0 {
			outputTokens = chunk.OutputTokens
		}
	}
	if err := <-errs; err != nil {
		t.Fatalf("Stream returned error: %v", err)
	}
	if text != "你好" {
		t.Fatalf("streamed text = %q, want 你好", text)
	}
	if inputTokens != 7 {
		t.Fatalf("input tokens = %d, want 7", inputTokens)
	}
	if outputTokens != 11 {
		t.Fatalf("output tokens = %d, want 11", outputTokens)
	}
}
