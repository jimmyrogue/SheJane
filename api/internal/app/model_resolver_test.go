package app

import (
	"context"
	"testing"

	"github.com/coldflame/shejane/api/internal/config"
	"github.com/coldflame/shejane/api/internal/modelreg"
	"github.com/coldflame/shejane/api/internal/store"
)

func TestParseAutoResolveOutput(t *testing.T) {
	candidates := []modelreg.ChatModelInfo{
		{ID: "gpt-4o", Label: "GPT-4o"},
		{ID: "claude-sonnet", Label: "Claude Sonnet"},
	}
	cases := []struct {
		name       string
		content    string
		wantID     string
		wantReason string
	}{
		{"strict json", `{"model":"claude-sonnet","reason":"复杂推理"}`, "claude-sonnet", "复杂推理"},
		{"json wrapped in prose", "选择如下:\n{\"model\":\"gpt-4o\",\"reason\":\"简单问答\"} 完毕", "gpt-4o", "简单问答"},
		{"json with unknown id falls through to scan", `{"model":"chat.nope","reason":"x"} 但其实 claude-sonnet 更合适`, "claude-sonnet", ""},
		{"bare id no json", "我选 claude-sonnet", "claude-sonnet", ""},
		{"garbage", "今天天气不错", "", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			id, reason := parseAutoResolveOutput(tc.content, candidates)
			if id != tc.wantID || reason != tc.wantReason {
				t.Fatalf("parse(%q) = (%q,%q), want (%q,%q)", tc.content, id, reason, tc.wantID, tc.wantReason)
			}
		})
	}
}

func TestResolveAutoModelCanChooseArbitraryCatalogID(t *testing.T) {
	ctx := context.Background()
	cfg := config.Default()
	cfg.JWTSecret = "test-secret"
	st := store.NewMemoryStore()
	application := New(cfg, st)

	for _, c := range []store.ModelConfig{
		{
			Slot:             "gpt-4o",
			Capability:       modelreg.CapabilityChat,
			ProviderKind:     "mock",
			DisplayName:      "GPT-4o",
			Description:      "通用强模型",
			ModelName:        "gpt-4o",
			CreditMultiplier: 2,
			Priority:         110,
			Enabled:          true,
			Params:           map[string]any{"mock_reply": `{"model":"claude-sonnet","reason":"长文更稳"}`},
		},
		{
			Slot:             "claude-sonnet",
			Capability:       modelreg.CapabilityChat,
			ProviderKind:     "mock",
			DisplayName:      "Claude Sonnet",
			Description:      "复杂推理和长文",
			ModelName:        "claude-sonnet",
			CreditMultiplier: 2,
			Priority:         105,
			Enabled:          true,
		},
		{
			Slot:             "deepseek-v4",
			Capability:       modelreg.CapabilityChat,
			ProviderKind:     "mock",
			DisplayName:      "DeepSeek",
			Description:      "速度快、成本低",
			ModelName:        "deepseek-v4",
			CreditMultiplier: 1,
			Priority:         80,
			Enabled:          true,
		},
	} {
		if _, err := st.UpsertModelConfig(ctx, "admin", c); err != nil {
			t.Fatalf("upsert %s: %v", c.Slot, err)
		}
	}
	application.Registry.Invalidate()

	resolved, reason := application.ResolveAutoModel(ctx, "请写一份包含策略推演的长报告")
	if resolved.ID != "claude-sonnet" || resolved.Label != "Claude Sonnet" || reason != "长文更稳" {
		t.Fatalf("resolved = (%q,%q,%q), want (claude-sonnet,Claude Sonnet,长文更稳)", resolved.ID, resolved.Label, reason)
	}
}

func TestResolveAutoModelClassifiesAndFallsBack(t *testing.T) {
	ctx := context.Background()
	cfg := config.Default() // MockLLM=true → seeds chat.fast(快速,100) + chat.deep(深度,90)
	cfg.JWTSecret = "test-secret"
	st := store.NewMemoryStore()
	application := New(cfg, st)

	// Default mock reply has no JSON and no candidate id → classifier output is
	// unusable → falls back to the default (highest-priority) model, no reason.
	resolved, reason := application.ResolveAutoModel(ctx, "写一封邮件")
	if resolved.ID != "chat.fast" || reason != "" {
		t.Fatalf("fallback resolve = (%q,%q), want (chat.fast,\"\")", resolved.ID, reason)
	}

	// Point the default model's mock reply at a real classifier answer — the
	// classifier runs on the default model, so its canned output now picks
	// chat.deep with a reason.
	configs, _ := st.ListModelConfigs(ctx, modelreg.CapabilityChat)
	for _, c := range configs {
		if c.Slot == "chat.fast" {
			c.Params["mock_reply"] = `{"model":"chat.deep","reason":"复杂推理"}`
			if _, err := st.UpsertModelConfig(ctx, "", c); err != nil {
				t.Fatalf("upsert: %v", err)
			}
		}
	}
	application.Registry.Invalidate()
	resolved, reason = application.ResolveAutoModel(ctx, "重构整个认证模块并写测试")
	if resolved.ID != "chat.deep" || resolved.Label != "深度" || reason != "复杂推理" {
		t.Fatalf("classified resolve = (%q,%q,%q), want (chat.deep,深度,复杂推理)", resolved.ID, resolved.Label, reason)
	}

	// Empty goal skips the classifier call entirely → default.
	if resolved, _ := application.ResolveAutoModel(ctx, "   "); resolved.ID != "chat.fast" {
		t.Fatalf("empty-goal resolve = %q, want chat.fast", resolved.ID)
	}
}

func TestResolveAutoModelSingleCandidateSkipsClassifier(t *testing.T) {
	ctx := context.Background()
	cfg := config.Default()
	cfg.JWTSecret = "test-secret"
	st := store.NewMemoryStore()
	application := New(cfg, st)

	// Disable chat.deep → one candidate left; the classifier must be skipped
	// (its mock reply would still be unusable anyway, but the point is the
	// single-candidate short-circuit).
	configs, _ := st.ListModelConfigs(ctx, modelreg.CapabilityChat)
	for _, c := range configs {
		if c.Slot == "chat.deep" {
			if _, err := st.SetModelConfigEnabled(ctx, "", c.ID, false); err != nil {
				t.Fatalf("disable: %v", err)
			}
		}
	}
	application.Registry.Invalidate()
	resolved, reason := application.ResolveAutoModel(ctx, "复杂任务")
	if resolved.ID != "chat.fast" || reason != "" {
		t.Fatalf("single-candidate resolve = (%q,%q), want (chat.fast,\"\")", resolved.ID, reason)
	}
}
