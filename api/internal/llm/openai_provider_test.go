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
	}, "deepseek-v4-flash")

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

func TestOpenAICompatibleProviderStreamErrorIncludesResponseBody(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"error":{"message":"messages.2.reasoning_content is not allowed"}}`, http.StatusBadRequest)
	}))
	defer server.Close()

	provider := NewOpenAICompatibleProvider("deepseek-fast", server.URL, "test-key")
	chunks, errs := provider.Stream(context.Background(), ChatRequest{
		Messages: []Message{{Role: "user", Content: "hello"}},
	}, "deepseek-chat")

	for range chunks {
	}
	err := <-errs
	if err == nil {
		t.Fatal("Stream returned nil error, want provider status error")
	}
	if !strings.Contains(err.Error(), "deepseek-fast returned status 400") ||
		!strings.Contains(err.Error(), "reasoning_content is not allowed") {
		t.Fatalf("Stream error = %q, want status and response body", err.Error())
	}
}

func TestDeepSeekV4ProviderCompletesWithToolCalls(t *testing.T) {
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
					"reasoning_content": "I need the README.md file contents before answering.",
					"tool_calls": [{
						"id": "call-1",
						"type": "function",
						"function": {
							"name": "file__read",
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

	provider := NewOpenAICompatibleProviderWithProfile("deepseek-fast", server.URL, "test-key", DeepSeekV4Profile())
	response, err := provider.CompleteWithTools(context.Background(), ChatRequest{
		Messages: []Message{
			{Role: "user", Content: "read file"},
			{Role: "assistant", ReasoningContent: "I should inspect README.md first.", ToolCalls: []ToolCall{{ID: "call-prev", Name: "file.read", Arguments: map[string]any{"path": "README.md"}}}},
			{Role: "tool", ToolCallID: "call-prev", Name: "file.read", Content: "file contents"},
		},
		Tools: []ToolDefinition{{
			Name:        "file.read",
			Description: "read a file",
			InputSchema: map[string]any{
				"type": "object",
			},
		}},
	}, "deepseek-v4-flash")
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
	if function["name"] != "file__read" || !strings.Contains(function["arguments"].(string), "README.md") {
		t.Fatalf("assistant tool_calls were not converted to OpenAI shape: %#v", assistant)
	}
	if assistant["reasoning_content"] != "I should inspect README.md first." {
		t.Fatalf("assistant reasoning_content = %#v", assistant["reasoning_content"])
	}
	thinking, ok := payload["thinking"].(map[string]any)
	if !ok {
		t.Fatalf("thinking missing from request payload: %#v", payload)
	}
	if thinking["type"] != "enabled" {
		t.Fatalf("thinking.type = %#v, want enabled", thinking["type"])
	}
	if payload["reasoning_effort"] != "max" {
		t.Fatalf("reasoning_effort = %#v, want max", payload["reasoning_effort"])
	}
	toolMessage := messages[2].(map[string]any)
	if _, ok := toolMessage["name"]; ok {
		t.Fatalf("tool message should not include name for DeepSeek/OpenAI-compatible schema: %#v", toolMessage)
	}
	requestToolName := tools[0].(map[string]any)["function"].(map[string]any)["name"]
	if requestToolName != "file__read" {
		t.Fatalf("request tool name = %#v, want provider-safe file__read", requestToolName)
	}
	if response.ReasoningContent != "I need the README.md file contents before answering." {
		t.Fatalf("reasoning content = %q", response.ReasoningContent)
	}
	if response.InputTokens != 12 || response.OutputTokens != 4 {
		t.Fatalf("usage = %d/%d, want 12/4", response.InputTokens, response.OutputTokens)
	}
	if len(response.ToolCalls) != 1 || response.ToolCalls[0].Name != "file.read" || response.ToolCalls[0].Arguments["path"] != "README.md" {
		t.Fatalf("tool calls = %#v", response.ToolCalls)
	}
}

func TestOpenAICompatibleProviderDoesNotSendDeepSeekOnlyFields(t *testing.T) {
	var payload map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatalf("decode request body: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"choices": [{
				"message": {
					"content": "done",
					"tool_calls": []
				},
				"finish_reason": "stop"
			}],
			"usage": {"prompt_tokens": 8, "completion_tokens": 2}
		}`))
	}))
	defer server.Close()

	provider := NewOpenAICompatibleProviderWithProfile("openai-compatible", server.URL, "test-key", OpenAICompatibleProfile())
	_, err := provider.CompleteWithTools(context.Background(), ChatRequest{
		Messages: []Message{
			{Role: "user", Content: "read file"},
			{Role: "assistant", ReasoningContent: "provider-specific reasoning", ToolCalls: []ToolCall{{ID: "call-prev", Name: "browser.search", Arguments: map[string]any{"query": "Jiandanly"}}}},
			{Role: "tool", ToolCallID: "call-prev", Name: "browser.search", Content: "search result"},
		},
		Tools: []ToolDefinition{{
			Name:        "browser.search",
			Description: "search the web",
			InputSchema: map[string]any{"type": "object"},
		}},
	}, "gpt-4o-mini")
	if err != nil {
		t.Fatalf("CompleteWithTools returned error: %v", err)
	}
	if _, ok := payload["thinking"]; ok {
		t.Fatalf("openai-compatible payload should not include DeepSeek thinking: %#v", payload)
	}
	if _, ok := payload["reasoning_effort"]; ok {
		t.Fatalf("openai-compatible payload should not include DeepSeek reasoning_effort: %#v", payload)
	}
	messages := payload["messages"].([]any)
	toolMessage := messages[2].(map[string]any)
	if _, ok := toolMessage["name"]; ok {
		t.Fatalf("tool message should omit name unless profile allows it: %#v", toolMessage)
	}
	assistant := messages[1].(map[string]any)
	if _, ok := assistant["reasoning_content"]; ok {
		t.Fatalf("openai-compatible assistant message should not include DeepSeek reasoning_content: %#v", assistant)
	}
	toolCalls := assistant["tool_calls"].([]any)
	function := toolCalls[0].(map[string]any)["function"].(map[string]any)
	if function["name"] != "browser__search" {
		t.Fatalf("request tool name = %#v, want browser__search", function["name"])
	}
}

func TestOpenAICompatibleProviderCompleteWithToolsErrorIncludesResponseBody(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":{"message":"tool messages must follow assistant tool_calls"}}`))
	}))
	defer server.Close()

	provider := NewOpenAICompatibleProvider("deepseek-fast", server.URL, "test-key")
	_, err := provider.CompleteWithTools(context.Background(), ChatRequest{
		Messages: []Message{{Role: "user", Content: "hello"}},
	}, "deepseek-chat")
	if err == nil {
		t.Fatal("CompleteWithTools returned nil error, want provider status error")
	}
	if !strings.Contains(err.Error(), "deepseek-fast returned status 400") ||
		!strings.Contains(err.Error(), "tool messages must follow assistant tool_calls") {
		t.Fatalf("CompleteWithTools error = %q, want status and response body", err.Error())
	}
}
