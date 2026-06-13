package llm

import (
	"strings"
	"testing"
)

func TestSelectModelFallsBackToStaticFastWithoutCatalog(t *testing.T) {
	// With no model resolver installed (empty catalog), SelectModel falls back
	// to the static fast provider for any requested model — the safety net.
	fast := NewMockProvider("deepseek-fast", "fast reply")
	deep := NewMockProvider("claude-deep", "deep reply")
	router := NewRouter(fast, deep)

	for _, requested := range []string{"auto", "", "chat.deepseek-v4", "unknown"} {
		provider, model, id := router.SelectModel(requested)
		if provider.Name() != "deepseek-fast" || model != "deepseek-v4-flash" {
			t.Fatalf("SelectModel(%q) = (%q,%q), want static fast fallback", requested, provider.Name(), model)
		}
		if id != requested {
			t.Fatalf("SelectModel(%q) id = %q, want passthrough %q (no resolver)", requested, id, requested)
		}
	}
}

func TestSelectModelUsesResolverAndDefault(t *testing.T) {
	fast := NewMockProvider("static-fast", "")
	router := NewRouter(fast, fast)
	deepseek := NewMockProvider("deepseek", "")
	claude := NewMockProvider("claude", "")
	catalog := map[string]Provider{"chat.deepseek": deepseek, "chat.claude": claude}
	router.SetModelResolver(
		func(id string) (Provider, string, float64, bool) {
			p, ok := catalog[id]
			if !ok {
				return nil, "", 1, false
			}
			return p, id + "-model", 1, true
		},
		func() string { return "chat.deepseek" }, // default
	)

	// A concrete id resolves to its provider.
	if p, _, id := router.SelectModel("chat.claude"); p.Name() != "claude" || id != "chat.claude" {
		t.Fatalf("SelectModel(chat.claude) = (%q,%q), want claude", p.Name(), id)
	}
	// "auto" / unknown resolve to the default model.
	for _, requested := range []string{"auto", "auto.smart", "", "chat.removed"} {
		p, _, id := router.SelectModel(requested)
		if p.Name() != "deepseek" || id != "chat.deepseek" {
			t.Fatalf("SelectModel(%q) = (%q,%q), want default chat.deepseek", requested, p.Name(), id)
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
