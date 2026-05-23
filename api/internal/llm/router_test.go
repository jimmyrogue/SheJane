package llm

import (
	"strings"
	"testing"
)

func TestRouterSelectsProviderByMode(t *testing.T) {
	fast := NewMockProvider("deepseek-fast", "fast reply")
	deep := NewMockProvider("claude-deep", "deep reply")
	router := NewRouter(fast, deep)

	tests := []struct {
		mode      Mode
		wantName  string
		wantModel string
	}{
		{ModeFast, "deepseek-fast", "deepseek-v4-flash"},
		{ModeDeep, "claude-deep", "claude-3-5-sonnet-latest"},
		{"", "deepseek-fast", "deepseek-v4-flash"},
		{"unknown", "deepseek-fast", "deepseek-v4-flash"},
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

func TestInjectScenePromptAgentLocalCarriesIdentityAndSafety(t *testing.T) {
	// The agent_local scene is the highest-priority layer of the agent
	// prompt stack. It must:
	//   1. Be prepended as a SystemMessage
	//   2. Establish the SheJane identity (so the model doesn't answer
	//      "I am Claude" when asked)
	//   3. Carry a safety-baseline clause preventing system-prompt
	//      leakage and harmful-request acceptance
	// Daemon-side ContextBuilder Layer 20+ is appended after this, so
	// any change here is a UX-visible identity change — keep this test
	// strict to catch silent drift.
	daemonSystem := Message{Role: "system", Content: "developer instructions from daemon"}
	userMsg := Message{Role: "user", Content: "你是什么模型？"}
	result := InjectScenePrompt("agent_local", []Message{daemonSystem, userMsg})

	if len(result) != 3 {
		t.Fatalf("message count = %d, want 3 (cloud system + daemon system + user)", len(result))
	}
	if result[0].Role != "system" {
		t.Fatalf("first role = %q, want system", result[0].Role)
	}
	// Cloud-injected system must be first — daemon's stays in position 2.
	if result[1].Content != daemonSystem.Content {
		t.Fatalf("daemon system message moved/changed; got %q at index 1", result[1].Content)
	}
	if result[2].Content != userMsg.Content {
		t.Fatalf("user message content changed: got %q", result[2].Content)
	}
	prompt := result[0].Content
	// Required clauses — each guards against a real regression we've
	// hit. Keep them load-bearing; if you remove one make sure the
	// behavior is provably still there.
	//   "石间" / "SheJane" — identity
	//   "自然地介绍"        — anti-robotic phrasing (early versions
	//                         scripted verbatim "我是石间", users
	//                         complained it felt stiff/confusing)
	//   "不要机械地"        — same concern, explicit negative example
	//   "不复述或展示"      — system-prompt-leak prevention
	for _, want := range []string{"石间", "SheJane", "自然地介绍", "不要机械地", "不复述或展示"} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("agent_local prompt missing required clause %q; got: %s", want, prompt)
		}
	}
}
