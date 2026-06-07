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
	if len(configs) != 2 {
		t.Fatalf("seeded configs = %d, want 2", len(configs))
	}

	fastP, fastModel, fastMult, ok := reg.Resolve(llm.ModeFast)
	if !ok || fastP.Name() != "deepseek-fast" || fastModel != cfg.FastModel || fastMult != 0.1 {
		t.Fatalf("fast resolve = (%v,%q,%v,%v) want fast cost ratio 0.1", fastP, fastModel, fastMult, ok)
	}
	deepP, deepModel, deepMult, ok := reg.Resolve(llm.ModeDeep)
	if !ok || deepP.Name() != "claude-deep" || deepModel != cfg.DeepModel || deepMult != 1 {
		t.Fatalf("deep resolve = (%v,%q,%v,%v) want deep cost ratio 1", deepP, deepModel, deepMult, ok)
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
	if len(configs) != 2 {
		t.Fatalf("configs after double seed = %d, want 2", len(configs))
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
	_, model, mult, ok := reg.Resolve(llm.ModeFast)
	if !ok || model != "rotated-model" || mult != 0.5 {
		t.Fatalf("after invalidate resolve = (%q,%v,%v), want rotated-model/0.5", model, mult, ok)
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
		if c.APIKeyEncrypted == "" {
			t.Fatalf("slot %s: api key not seeded", c.Slot)
		}
		if c.APIKeyEncrypted == "sk-fast" || c.APIKeyEncrypted == "sk-anthropic" {
			t.Fatalf("slot %s: api key stored in plaintext", c.Slot)
		}
	}

	fastP, _, _, ok := reg.Resolve(llm.ModeFast)
	if !ok || llm.KindOfProvider(fastP) == llm.ProviderKindMock {
		t.Fatalf("fast provider should be a real openai-compatible provider, got %v", llm.KindOfProvider(fastP))
	}
	deepP, _, _, ok := reg.Resolve(llm.ModeDeep)
	if !ok || llm.KindOfProvider(deepP) != llm.ProviderKindAnthropic {
		t.Fatalf("deep provider kind = %v, want anthropic", llm.KindOfProvider(deepP))
	}
}
