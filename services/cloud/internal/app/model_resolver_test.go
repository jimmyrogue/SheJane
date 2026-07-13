package app

import (
	"context"
	"testing"
	"time"

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
	seedAutoTestModels(t, st)
	application.Registry.Invalidate()

	// Simple tasks are routed to the fast tier before the classifier. The
	// default mock reply is irrelevant because there is one easy-tier candidate.
	resolved, reason := application.ResolveAutoModel(ctx, "写一封邮件")
	if resolved.ID != "chat.fast" || reason != "简单任务" {
		t.Fatalf("fallback resolve = (%q,%q), want (chat.fast,简单任务)", resolved.ID, reason)
	}

	// Hard tasks are routed into reasoning/max candidates before classifier
	// choice, so the seeded deep model wins even if the fast mock has a reply.
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
	if resolved.ID != "chat.deep" || resolved.Label != "深度" || reason != "复杂任务" {
		t.Fatalf("classified resolve = (%q,%q,%q), want (chat.deep,深度,复杂任务)", resolved.ID, resolved.Label, reason)
	}

	// Empty goal skips the classifier call entirely → default.
	if resolved, _ := application.ResolveAutoModel(ctx, "   "); resolved.ID != "chat.fast" {
		t.Fatalf("empty-goal resolve = %q, want chat.fast", resolved.ID)
	}
}

func TestResolveAutoModelWithIntentFiltersCandidatePool(t *testing.T) {
	ctx := context.Background()
	cfg := config.Default()
	cfg.JWTSecret = "test-secret"
	st := store.NewMemoryStore()
	application := New(cfg, st)
	seedAutoTestModels(t, st)

	configs, _ := st.ListModelConfigs(ctx, modelreg.CapabilityChat)
	for _, c := range configs {
		switch c.Slot {
		case "chat.fast":
			c.Priority = 50
			c.CapabilityTier = modelreg.CapabilityTierFast
		case "chat.deep":
			c.Priority = 10
			c.CapabilityTier = modelreg.CapabilityTierReasoning
		}
		if _, err := st.UpsertModelConfig(ctx, "", c); err != nil {
			t.Fatalf("upsert %s: %v", c.Slot, err)
		}
	}
	if _, err := st.UpsertModelConfig(ctx, "admin", store.ModelConfig{
		Slot:             "balanced-top",
		Capability:       modelreg.CapabilityChat,
		ProviderKind:     "mock",
		DisplayName:      "Balanced Top",
		CapabilityTier:   modelreg.CapabilityTierBalanced,
		ModelName:        "balanced-top",
		CreditMultiplier: 1,
		Priority:         200,
		Enabled:          true,
	}); err != nil {
		t.Fatalf("upsert balanced-top: %v", err)
	}
	if _, err := st.UpsertModelConfig(ctx, "admin", store.ModelConfig{
		Slot:             "max-low",
		Capability:       modelreg.CapabilityChat,
		ProviderKind:     "mock",
		DisplayName:      "Max Low",
		CapabilityTier:   modelreg.CapabilityTierMax,
		ModelName:        "max-low",
		CreditMultiplier: 1,
		Priority:         5,
		Enabled:          true,
	}); err != nil {
		t.Fatalf("upsert max-low: %v", err)
	}
	application.Registry.Invalidate()

	fast, fastReason := application.ResolveAutoModelWithIntent(ctx, "   ", "fast")
	if fast.ID != "balanced-top" || fastReason != "速度优先" {
		t.Fatalf("fast intent = (%q,%q), want (balanced-top,速度优先)", fast.ID, fastReason)
	}

	smart, smartReason := application.ResolveAutoModelWithIntent(ctx, "   ", "smart")
	if smart.ID != "chat.deep" || smartReason != "能力优先" {
		t.Fatalf("smart intent = (%q,%q), want (chat.deep,能力优先)", smart.ID, smartReason)
	}

	configs, _ = st.ListModelConfigs(ctx, modelreg.CapabilityChat)
	for _, c := range configs {
		c.CapabilityTier = modelreg.CapabilityTierMax
		if _, err := st.UpsertModelConfig(ctx, "", c); err != nil {
			t.Fatalf("upsert fallback %s: %v", c.Slot, err)
		}
	}
	application.Registry.Invalidate()
	fast, fastReason = application.ResolveAutoModelWithIntent(ctx, "   ", "fast")
	if fast.ID != "balanced-top" || fastReason != "速度优先" {
		t.Fatalf("fast intent fallback = (%q,%q), want (balanced-top,速度优先)", fast.ID, fastReason)
	}
}

func TestResolveAutoModelSingleCandidateSkipsClassifier(t *testing.T) {
	ctx := context.Background()
	cfg := config.Default()
	cfg.JWTSecret = "test-secret"
	st := store.NewMemoryStore()
	application := New(cfg, st)
	seedAutoTestModels(t, st)

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

func seedAutoTestModels(t *testing.T, st store.Store) {
	t.Helper()
	for _, c := range []store.ModelConfig{
		{Slot: "chat.fast", Capability: modelreg.CapabilityChat, ProviderKind: "mock", DisplayName: "快速", ModelName: "fast-test", CapabilityTier: modelreg.CapabilityTierFast, Priority: 100, CreditMultiplier: 0.1, Enabled: true, Params: map[string]any{}},
		{Slot: "chat.deep", Capability: modelreg.CapabilityChat, ProviderKind: "mock", DisplayName: "深度", ModelName: "deep-test", CapabilityTier: modelreg.CapabilityTierReasoning, Priority: 90, CreditMultiplier: 1, Enabled: true, Params: map[string]any{}},
	} {
		if _, err := st.UpsertModelConfig(context.Background(), "test", c); err != nil {
			t.Fatalf("seed test model %s: %v", c.Slot, err)
		}
	}
}

func TestResolveAutoModelRanksByRecentHealthAndCost(t *testing.T) {
	ctx := context.Background()
	cfg := config.Default()
	cfg.JWTSecret = "test-secret"
	st := store.NewMemoryStore()
	application := New(cfg, st)

	for _, c := range []store.ModelConfig{
		{
			Slot:                   "expensive-flaky",
			Capability:             modelreg.CapabilityChat,
			ProviderKind:           "mock",
			DisplayName:            "Expensive Flaky",
			Description:            "高优先级但近期不稳定",
			ModelName:              "expensive-flaky",
			InputCreditMultiplier:  8,
			OutputCreditMultiplier: 8,
			Priority:               120,
			Enabled:                true,
		},
		{
			Slot:                   "cheap-healthy",
			Capability:             modelreg.CapabilityChat,
			ProviderKind:           "mock",
			DisplayName:            "Cheap Healthy",
			Description:            "稳定且便宜",
			ModelName:              "cheap-healthy",
			InputCreditMultiplier:  1,
			OutputCreditMultiplier: 1,
			Priority:               105,
			Enabled:                true,
		},
	} {
		if _, err := st.UpsertModelConfig(ctx, "admin", c); err != nil {
			t.Fatalf("upsert %s: %v", c.Slot, err)
		}
	}
	started := time.Now().Add(-2 * time.Minute)
	for i := 0; i < 4; i += 1 {
		requestID := "req-flaky-" + string(rune('a'+i))
		if err := st.CreateLLMCall(ctx, store.LLMCallRecord{
			RequestID: requestID,
			UserID:    "user-1",
			Mode:      "expensive-flaky",
			Model:     "expensive-flaky",
			Provider:  "flaky",
			Status:    "streaming",
			StartedAt: started.Add(time.Duration(i) * time.Second),
		}); err != nil {
			t.Fatalf("create llm call: %v", err)
		}
		if err := st.FinishLLMCall(ctx, requestID, "failed", 0, 0, 0, "upstream failed"); err != nil {
			t.Fatalf("finish llm call: %v", err)
		}
	}
	application.Registry.Invalidate()

	resolved, reason := application.ResolveAutoModel(ctx, "   ")
	if resolved.ID != "cheap-healthy" || reason != "" {
		t.Fatalf("health-ranked resolve = (%q,%q), want (cheap-healthy,\"\")", resolved.ID, reason)
	}
}
