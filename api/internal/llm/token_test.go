package llm

import (
	"strings"
	"testing"
)

func TestEstimateTokensIncludesReasoningAndToolCalls(t *testing.T) {
	base := EstimateTokens([]Message{{Role: "assistant", Content: "done"}})
	withToolContext := EstimateTokens([]Message{{
		Role:             "assistant",
		Content:          "done",
		ReasoningContent: strings.Repeat("reasoning ", 40),
		ToolCalls: []ToolCall{{
			ID:   "call-1",
			Name: "web.search",
			Arguments: map[string]any{
				"query":       strings.Repeat("agent architecture ", 20),
				"max_results": 5,
			},
		}},
	}})

	if withToolContext <= base {
		t.Fatalf("EstimateTokens with reasoning/tool calls = %d, want > base %d", withToolContext, base)
	}
}

func TestEstimateRequestTokensIncludesToolDefinitions(t *testing.T) {
	withoutTools := EstimateRequestTokens(ChatRequest{
		Messages: []Message{{Role: "user", Content: "search and summarize"}},
	})
	withTools := EstimateRequestTokens(ChatRequest{
		Messages: []Message{{Role: "user", Content: "search and summarize"}},
		Tools: []ToolDefinition{{
			Name:        "web.search",
			Description: strings.Repeat("Search the public web and return grounded sources. ", 20),
			InputSchema: map[string]any{
				"type":     "object",
				"required": []any{"query"},
				"properties": map[string]any{
					"query":       map[string]any{"type": "string", "description": "Search query"},
					"max_results": map[string]any{"type": "integer", "minimum": 1, "maximum": 5},
				},
			},
		}},
	})

	if withTools <= withoutTools {
		t.Fatalf("EstimateRequestTokens with tools = %d, want > no tools %d", withTools, withoutTools)
	}
}
