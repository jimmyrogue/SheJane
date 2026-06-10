package llm

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// Full tool-calling round trip against a fake Messages API: tool names are
// sanitized outbound (web.search → web__search) and restored inbound, history
// converts to tool_use / tool_result blocks, stop_reason maps to the
// OpenAI-style finish_reason vocabulary, and per-row base_url/max_tokens apply.
func TestAnthropicCompleteWithToolsRoundTrip(t *testing.T) {
	var captured map[string]any
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/messages" {
			t.Errorf("path = %s, want /v1/messages", r.URL.Path)
		}
		if r.Header.Get("x-api-key") != "sk-test" {
			t.Errorf("missing x-api-key")
		}
		if err := json.NewDecoder(r.Body).Decode(&captured); err != nil {
			t.Errorf("decode request: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"content": [
				{"type":"text","text":"我再搜一次。"},
				{"type":"tool_use","id":"toolu_abc","name":"web__search","input":{"query":"今日新闻"}}
			],
			"stop_reason":"tool_use",
			"usage":{"input_tokens":120,"output_tokens":45}
		}`))
	}))
	defer fake.Close()

	provider := NewAnthropicProviderWithConfig("sk-test", "2023-06-01", fake.URL, 4096)
	completion, err := provider.CompleteWithTools(context.Background(), ChatRequest{
		Messages: []Message{
			{Role: "system", Content: "你是石间"},
			{Role: "user", Content: "搜索今天的新闻"},
			{Role: "assistant", Content: "我来搜索。", ToolCalls: []ToolCall{
				{ID: "toolu_prev", Name: "web.search", Arguments: map[string]any{"query": "新闻"}},
			}},
			{Role: "tool", ToolCallID: "toolu_prev", Name: "web.search", Content: "三条搜索结果……"},
		},
		Tools: []ToolDefinition{{
			Name:        "web.search",
			Description: "搜索互联网",
			InputSchema: map[string]any{"type": "object"},
		}},
	}, "claude-sonnet-test")
	if err != nil {
		t.Fatalf("CompleteWithTools: %v", err)
	}

	// --- outbound payload ---
	if captured["system"] != "你是石间" {
		t.Errorf("system = %v, want 你是石间", captured["system"])
	}
	if got := captured["max_tokens"].(float64); got != 4096 {
		t.Errorf("max_tokens = %v, want 4096 (per-row override)", got)
	}
	tools := captured["tools"].([]any)
	tool0 := tools[0].(map[string]any)
	if tool0["name"] != "web__search" {
		t.Errorf("outbound tool name = %v, want sanitized web__search", tool0["name"])
	}
	if _, ok := tool0["input_schema"]; !ok {
		t.Error("outbound tool missing input_schema")
	}
	messages := captured["messages"].([]any)
	// user → assistant(text+tool_use) → user(tool_result)
	if len(messages) != 3 {
		t.Fatalf("converted messages = %d, want 3 (merged)", len(messages))
	}
	assistant := messages[1].(map[string]any)
	blocks := assistant["content"].([]any)
	if len(blocks) != 2 {
		t.Fatalf("assistant blocks = %d, want text+tool_use", len(blocks))
	}
	toolUse := blocks[1].(map[string]any)
	if toolUse["type"] != "tool_use" || toolUse["name"] != "web__search" || toolUse["id"] != "toolu_prev" {
		t.Errorf("tool_use block = %v", toolUse)
	}
	resultMsg := messages[2].(map[string]any)
	resultBlock := resultMsg["content"].([]any)[0].(map[string]any)
	if resultMsg["role"] != "user" || resultBlock["type"] != "tool_result" || resultBlock["tool_use_id"] != "toolu_prev" {
		t.Errorf("tool_result message = %v", resultMsg)
	}

	// --- inbound parse ---
	if completion.Content != "我再搜一次。" {
		t.Errorf("content = %q", completion.Content)
	}
	if completion.FinishReason != "tool_calls" {
		t.Errorf("finish reason = %q, want tool_calls (mapped from tool_use)", completion.FinishReason)
	}
	if len(completion.ToolCalls) != 1 {
		t.Fatalf("tool calls = %d, want 1", len(completion.ToolCalls))
	}
	call := completion.ToolCalls[0]
	if call.ID != "toolu_abc" || call.Name != "web.search" || call.Arguments["query"] != "今日新闻" {
		t.Errorf("tool call = %+v (name must be reverse-mapped to web.search)", call)
	}
	if completion.InputTokens != 120 || completion.OutputTokens != 45 {
		t.Errorf("usage = (%d,%d), want (120,45)", completion.InputTokens, completion.OutputTokens)
	}
}

func TestAnthropicCompleteWithToolsPlainAnswerMapsEndTurn(t *testing.T) {
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"content": [{"type":"text","text":"答案。"}],
			"stop_reason":"end_turn",
			"usage":{"input_tokens":10,"output_tokens":3}
		}`))
	}))
	defer fake.Close()

	provider := NewAnthropicProviderWithConfig("sk-test", "", fake.URL, 0)
	completion, err := provider.CompleteWithTools(context.Background(), ChatRequest{
		Messages: []Message{{Role: "user", Content: "你好"}},
	}, "claude-sonnet-test")
	if err != nil {
		t.Fatalf("CompleteWithTools: %v", err)
	}
	if completion.FinishReason != "stop" {
		t.Errorf("finish reason = %q, want stop (mapped from end_turn)", completion.FinishReason)
	}
	if len(completion.ToolCalls) != 0 || completion.Content != "答案。" {
		t.Errorf("completion = %+v", completion)
	}
}

// The streaming path must surface Anthropic's up-front input_tokens
// (message_start) so billing settles on real usage, use the configured
// max_tokens, and map stop_reason on the way out.
func TestAnthropicStreamReportsInputTokensAndMaxTokens(t *testing.T) {
	var captured map[string]any
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&captured)
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte(
			"event: message_start\n" +
				`data: {"type":"message_start","message":{"usage":{"input_tokens":77}}}` + "\n\n" +
				"event: content_block_delta\n" +
				`data: {"type":"content_block_delta","delta":{"text":"你好"}}` + "\n\n" +
				"event: message_delta\n" +
				`data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}` + "\n\n"))
	}))
	defer fake.Close()

	provider := NewAnthropicProviderWithConfig("sk-test", "", fake.URL, 1234)
	chunks, errs := provider.Stream(context.Background(), ChatRequest{
		Messages: []Message{{Role: "user", Content: "hi"}},
	}, "claude-sonnet-test")

	inputTokens, outputTokens := 0, 0
	text, finish := "", ""
	for chunk := range chunks {
		if chunk.InputTokens > 0 {
			inputTokens = chunk.InputTokens
		}
		if chunk.OutputTokens > outputTokens {
			outputTokens = chunk.OutputTokens
		}
		text += chunk.Text
		if chunk.FinishReason != "" {
			finish = chunk.FinishReason
		}
	}
	if err := <-errs; err != nil {
		t.Fatalf("stream error: %v", err)
	}
	if got := captured["max_tokens"].(float64); got != 1234 {
		t.Errorf("max_tokens = %v, want 1234", got)
	}
	if inputTokens != 77 {
		t.Errorf("input tokens = %d, want 77 (from message_start)", inputTokens)
	}
	if text != "你好" || outputTokens != 5 || finish != "stop" {
		t.Errorf("stream result = (%q,%d,%q), want (你好,5,stop)", text, outputTokens, finish)
	}
}

// The provider must satisfy the tool-completer contract the agent endpoints
// type-assert for — a compile-time regression guard.
var _ interface {
	CompleteWithTools(context.Context, ChatRequest, string) (Completion, error)
} = (*AnthropicProvider)(nil)

var _ interface {
	CompleteWithTools(context.Context, ChatRequest, string) (Completion, error)
} = (*MockProvider)(nil)
