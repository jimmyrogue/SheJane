package llm

import "testing"

func TestRouterSelectsProviderByMode(t *testing.T) {
	fast := NewMockProvider("deepseek-fast", "fast reply")
	deep := NewMockProvider("claude-deep", "deep reply")
	router := NewRouter(fast, deep)

	tests := []struct {
		mode      Mode
		wantName  string
		wantModel string
	}{
		{ModeFast, "deepseek-fast", "deepseek-chat"},
		{ModeDeep, "claude-deep", "claude-3-5-sonnet-latest"},
		{"", "deepseek-fast", "deepseek-chat"},
		{"unknown", "deepseek-fast", "deepseek-chat"},
	}

	for _, tt := range tests {
		provider, model := router.Select(tt.mode)
		if provider.Name() != tt.wantName {
			t.Fatalf("Select(%q) provider = %q, want %q", tt.mode, provider.Name(), tt.wantName)
		}
		if model != tt.wantModel {
			t.Fatalf("Select(%q) model = %q, want %q", tt.mode, model, tt.wantModel)
		}
	}
}

func TestInjectScenePromptPrependsSystemMessage(t *testing.T) {
	messages := []Message{{Role: "user", Content: "帮我写一封客户跟进邮件"}}

	result := InjectScenePrompt("write", messages)
	if len(result) != 2 {
		t.Fatalf("message count = %d, want 2", len(result))
	}
	if result[0].Role != "system" {
		t.Fatalf("first role = %q, want system", result[0].Role)
	}
	if result[1].Content != messages[0].Content {
		t.Fatalf("user message content changed = %q", result[1].Content)
	}
}
