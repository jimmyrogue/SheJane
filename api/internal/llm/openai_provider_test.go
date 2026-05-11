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

func TestOpenAICompatibleProviderCompletesWithToolCalls(t *testing.T) {
	var payload map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatalf("decode request body: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"choices": [{
				"message": {
					"content": "",
					"tool_calls": [{
						"id": "call-1",
						"type": "function",
						"function": {
							"name": "file.read",
							"arguments": "{\"path\":\"README.md\"}"
						}
					}]
				},
				"finish_reason": "tool_calls"
			}],
			"usage": {"prompt_tokens": 12, "completion_tokens": 4}
		}`))
	}))
	defer server.Close()

	provider := NewOpenAICompatibleProvider("deepseek-fast", server.URL, "test-key")
	response, err := provider.CompleteWithTools(context.Background(), ChatRequest{
		Messages: []Message{
			{Role: "user", Content: "read file"},
			{Role: "assistant", ToolCalls: []ToolCall{{ID: "call-prev", Name: "file.read", Arguments: map[string]any{"path": "README.md"}}}},
			{Role: "tool", ToolCallID: "call-prev", Name: "file.read", Content: "file contents"},
		},
		Tools: []ToolDefinition{{
			Name:        "file.read",
			Description: "read a file",
			InputSchema: map[string]any{
				"type": "object",
			},
		}},
	}, "deepseek-chat")
	if err != nil {
		t.Fatalf("CompleteWithTools returned error: %v", err)
	}
	tools, ok := payload["tools"].([]any)
	if !ok || len(tools) != 1 {
		t.Fatalf("request payload missing tools: %#v", payload)
	}
	messages := payload["messages"].([]any)
	assistant := messages[1].(map[string]any)
	toolCalls := assistant["tool_calls"].([]any)
	function := toolCalls[0].(map[string]any)["function"].(map[string]any)
	if function["name"] != "file.read" || !strings.Contains(function["arguments"].(string), "README.md") {
		t.Fatalf("assistant tool_calls were not converted to OpenAI shape: %#v", assistant)
	}
	if response.InputTokens != 12 || response.OutputTokens != 4 {
		t.Fatalf("usage = %d/%d, want 12/4", response.InputTokens, response.OutputTokens)
	}
	if len(response.ToolCalls) != 1 || response.ToolCalls[0].Name != "file.read" || response.ToolCalls[0].Arguments["path"] != "README.md" {
		t.Fatalf("tool calls = %#v", response.ToolCalls)
	}
}
