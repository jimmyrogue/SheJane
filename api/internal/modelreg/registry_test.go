package modelreg

import (
	"context"
	"testing"

	"github.com/coldflame/shejane/api/internal/config"
	"github.com/coldflame/shejane/api/internal/llm"
	"github.com/coldflame/shejane/api/internal/store"
)

func TestEnsureSeedAppliesDeepSeekCostRatios(t *testing.T) {
	cfg := config.Default() // MockLLM = true
	st := store.NewMemoryStore()
	reg := New(st, cfg)

	if err := reg.EnsureSeed(context.Background()); err != nil {
		t.Fatalf("EnsureSeed: %v", err)
	}
	configs, _ := st.ListModelConfigs(context.Background(), CapabilityChat)
	wantConfigs := 2 + len(recommendedChatModelTemplates())
	if len(configs) != wantConfigs {
		t.Fatalf("seeded configs = %d, want %d", len(configs), wantConfigs)
	}

	fastP, fastModel, fastMult, ok := reg.ResolveModel(SlotChatFast)
	if !ok || fastP.Name() != "快速" || fastModel != cfg.FastModel || fastMult != 0.1 {
		t.Fatalf("fast resolve = (%v,%q,%v,%v) want fast cost ratio 0.1", fastP, fastModel, fastMult, ok)
	}
	deepP, deepModel, deepMult, ok := reg.ResolveModel(SlotChatDeep)
	if !ok || deepP.Name() != "深度" || deepModel != cfg.DeepModel || deepMult != 1 {
		t.Fatalf("deep resolve = (%v,%q,%v,%v) want deep cost ratio 1", deepP, deepModel, deepMult, ok)
	}
	catalog := reg.ListChatModels()
	if len(catalog) != 2 {
		t.Fatalf("user catalog len = %d, want 2 enabled legacy rows only", len(catalog))
	}
	if catalog[0].Vendor != "DeepSeek" || catalog[0].CapabilityTier != CapabilityTierFast {
		t.Fatalf("fast catalog metadata = %+v, want DeepSeek/fast", catalog[0])
	}
	var foundTemplate bool
	for _, c := range configs {
		if c.Slot == "minimax-m3" && c.Vendor == "Minimax" && c.CapabilityTier == CapabilityTierReasoning && !c.Enabled {
			foundTemplate = true
		}
	}
	if !foundTemplate {
		t.Fatalf("recommended templates missing disabled MiniMax row: %+v", configs)
	}

	// EnsureSeed also seeds the billing defaults (markup 1.15, baseline cost).
	if got := reg.Markup(); got != DefaultMarkupFactor {
		t.Fatalf("seeded markup = %v, want %v", got, DefaultMarkupFactor)
	}
	rate, ok := reg.CurrencyPerCredit()
	if !ok || rate != 0.00002 {
		t.Fatalf("seeded currency-per-credit = (%v,%v), want 0.00002/true", rate, ok)
	}
}

func TestBuildProviderUnconfiguredOnMissingKey(t *testing.T) {
	reg := New(store.NewMemoryStore(), config.Default())
	ctx := context.Background()

	// A real chat provider with no API key must NOT become a billable mock
	// that emits a fake reply — it must be an erroring "unconfigured"
	// provider so the LLM billing path releases the reservation.
	chat := reg.buildProvider(store.ModelConfig{Slot: SlotChatFast, ProviderKind: "deepseek-v4", BaseURL: "https://api.deepseek.com"})
	if _, ok := chat.(*llm.UnconfiguredProvider); !ok {
		t.Fatalf("missing-key chat provider = %T, want *llm.UnconfiguredProvider", chat)
	}
	chunks, errs := chat.Stream(ctx, llm.ChatRequest{}, "m")
	for range chunks {
		t.Fatal("unconfigured provider must not emit any chunks")
	}
	if err := <-errs; err == nil {
		t.Fatal("unconfigured provider Stream must return an error")
	}

	// Anthropic with no key is the same.
	if _, ok := reg.buildProvider(store.ModelConfig{Slot: SlotChatDeep, ProviderKind: "anthropic"}).(*llm.UnconfiguredProvider); !ok {
		t.Fatal("missing-key anthropic provider must be *llm.UnconfiguredProvider")
	}

	// Image slot with no key must also be unconfigured, not a placeholder
	// image that still settles credits.
	img := reg.buildImageProvider(store.ModelConfig{Slot: SlotImageDefault, ProviderKind: "openai-compatible", BaseURL: "https://api.example.com"})
	if _, ok := img.(*llm.UnconfiguredImageProvider); !ok {
		t.Fatalf("missing-key image provider = %T, want *llm.UnconfiguredImageProvider", img)
	}
	if _, err := img.GenerateImage(ctx, llm.ImageRequest{}, "m"); err == nil {
		t.Fatal("unconfigured image provider must return an error")
	}

	// An explicit mock kind stays a usable mock (dev/tests rely on it).
	if _, ok := reg.buildProvider(store.ModelConfig{Slot: SlotChatFast, ProviderKind: "mock"}).(*llm.MockProvider); !ok {
		t.Fatal("explicit mock-kind provider must remain *llm.MockProvider")
	}
}

func TestMarkupDefaultsAndOverrides(t *testing.T) {
	cfg := config.Default()
	st := store.NewMemoryStore()
	reg := New(st, cfg)

	// Without any configured setting (no EnsureSeed) the defaults apply.
	if got := reg.Markup(); got != DefaultMarkupFactor {
		t.Fatalf("default markup = %v, want %v", got, DefaultMarkupFactor)
	}
	if _, ok := reg.CurrencyPerCredit(); ok {
		t.Fatalf("currency-per-credit should be unset by default")
	}

	if _, err := st.SetAppSetting(context.Background(), "admin", BillingSettingsKey, `{"markup_factor":1.2,"currency_per_credit":0.001}`); err != nil {
		t.Fatalf("set setting: %v", err)
	}
	reg.Invalidate()
	if got := reg.Markup(); got != 1.2 {
		t.Fatalf("markup after override = %v, want 1.2", got)
	}
	rate, ok := reg.CurrencyPerCredit()
	if !ok || rate != 0.001 {
		t.Fatalf("currency-per-credit = (%v,%v), want 0.001/true", rate, ok)
	}

	// Out-of-range markup falls back to the default.
	if _, err := st.SetAppSetting(context.Background(), "admin", BillingSettingsKey, `{"markup_factor":99}`); err != nil {
		t.Fatalf("set setting: %v", err)
	}
	reg.Invalidate()
	if got := reg.Markup(); got != DefaultMarkupFactor {
		t.Fatalf("out-of-range markup = %v, want default %v", got, DefaultMarkupFactor)
	}
}

func TestEnsureSeedIsIdempotent(t *testing.T) {
	cfg := config.Default()
	st := store.NewMemoryStore()
	reg := New(st, cfg)
	_ = reg.EnsureSeed(context.Background())
	_ = reg.EnsureSeed(context.Background())
	configs, _ := st.ListModelConfigs(context.Background(), "")
	wantConfigs := 2 + len(recommendedChatModelTemplates())
	if len(configs) != wantConfigs {
		t.Fatalf("configs after double seed = %d, want %d", len(configs), wantConfigs)
	}
}

func TestResolveHotReloadsAfterInvalidate(t *testing.T) {
	cfg := config.Default()
	st := store.NewMemoryStore()
	reg := New(st, cfg)
	_ = reg.EnsureSeed(context.Background())

	configs, _ := st.ListModelConfigs(context.Background(), CapabilityChat)
	var fast store.ModelConfig
	for _, c := range configs {
		if c.Slot == SlotChatFast {
			fast = c
		}
	}
	fast.ModelName = "rotated-model"
	fast.CreditMultiplier = 0.5
	if _, err := st.UpsertModelConfig(context.Background(), "admin", fast); err != nil {
		t.Fatalf("upsert: %v", err)
	}

	reg.Invalidate()
	_, model, mult, ok := reg.ResolveModel(SlotChatFast)
	if !ok || model != "rotated-model" || mult != 0.5 {
		t.Fatalf("after invalidate resolve = (%q,%v,%v), want rotated-model/0.5", model, mult, ok)
	}
}

func TestChatCatalogOrdersByPriorityAndResolvesByID(t *testing.T) {
	ctx := context.Background()
	st := store.NewMemoryStore()
	reg := New(st, config.Default())

	// Three enabled chat models with distinct priorities + arbitrary catalog ids.
	for _, m := range []store.ModelConfig{
		{Slot: "deepseek-v4", Capability: CapabilityChat, ProviderKind: "mock", DisplayName: "DeepSeek", Vendor: "DeepSeek", CapabilityTier: CapabilityTierFast, Priority: 10, Enabled: true},
		{Slot: "gpt-4o", Capability: CapabilityChat, ProviderKind: "mock", DisplayName: "GPT-4o", Vendor: "ChatGPT", CapabilityTier: CapabilityTierMax, Description: "首选", Priority: 99, Enabled: true},
		{Slot: "claude-sonnet", Capability: CapabilityChat, ProviderKind: "mock", DisplayName: "Claude Sonnet", Vendor: "Claude", CapabilityTier: CapabilityTierReasoning, Priority: 50, Enabled: true},
		{Slot: "chat.disabled", Capability: CapabilityChat, ProviderKind: "mock", DisplayName: "Off", Priority: 100, Enabled: false},
	} {
		if _, err := st.UpsertModelConfig(ctx, "admin", m); err != nil {
			t.Fatalf("upsert %s: %v", m.Slot, err)
		}
	}
	reg.Invalidate()

	catalog := reg.ListChatModels()
	if len(catalog) != 3 {
		t.Fatalf("catalog len = %d, want 3 (disabled excluded)", len(catalog))
	}
	gotOrder := []string{catalog[0].ID, catalog[1].ID, catalog[2].ID}
	wantOrder := []string{"gpt-4o", "claude-sonnet", "deepseek-v4"}
	for i := range wantOrder {
		if gotOrder[i] != wantOrder[i] {
			t.Fatalf("catalog order = %v, want %v (priority desc)", gotOrder, wantOrder)
		}
	}
	if catalog[0].Label != "GPT-4o" || catalog[0].Description != "首选" || catalog[0].Vendor != "ChatGPT" || catalog[0].CapabilityTier != CapabilityTierMax {
		t.Fatalf("top entry = %+v, want GPT-4o catalog metadata", catalog[0])
	}

	if def := reg.DefaultChatModelID(); def != "gpt-4o" {
		t.Fatalf("DefaultChatModelID = %q, want gpt-4o (highest priority)", def)
	}

	if _, _, _, ok := reg.ResolveModel("claude-sonnet"); !ok {
		t.Fatal("ResolveModel(claude-sonnet) should resolve")
	}
	if _, _, _, ok := reg.ResolveModel("chat.disabled"); ok {
		t.Fatal("ResolveModel(chat.disabled) must NOT resolve (disabled)")
	}
	if _, _, _, ok := reg.ResolveModel("chat.unknown"); ok {
		t.Fatal("ResolveModel(unknown) must NOT resolve")
	}
}

func TestSeedFromRealEnvEncryptsKeysAndPicksProviders(t *testing.T) {
	cfg := config.Default()
	cfg.MockLLM = false
	cfg.ConfigEncryptionKey = "unit-test-key"
	cfg.FastProviderBaseURL = "https://api.deepseek.com"
	cfg.FastProviderAPIKey = "sk-fast"
	cfg.AnthropicAPIKey = "sk-anthropic"

	st := store.NewMemoryStore()
	reg := New(st, cfg)
	if err := reg.EnsureSeed(context.Background()); err != nil {
		t.Fatalf("EnsureSeed: %v", err)
	}

	configs, _ := st.ListModelConfigs(context.Background(), CapabilityChat)
	for _, c := range configs {
		if c.Slot != SlotChatFast && c.Slot != SlotChatDeep {
			continue
		}
		if c.APIKeyEncrypted == "" {
			t.Fatalf("slot %s: api key not seeded", c.Slot)
		}
		if c.APIKeyEncrypted == "sk-fast" || c.APIKeyEncrypted == "sk-anthropic" {
			t.Fatalf("slot %s: api key stored in plaintext", c.Slot)
		}
	}

	fastP, _, _, ok := reg.ResolveModel(SlotChatFast)
	if !ok || llm.KindOfProvider(fastP) == llm.ProviderKindMock {
		t.Fatalf("fast provider should be a real openai-compatible provider, got %v", llm.KindOfProvider(fastP))
	}
	deepP, _, _, ok := reg.ResolveModel(SlotChatDeep)
	if !ok || llm.KindOfProvider(deepP) != llm.ProviderKindAnthropic {
		t.Fatalf("deep provider kind = %v, want anthropic", llm.KindOfProvider(deepP))
	}
}
