package app

import (
	"context"
	"testing"

	"github.com/coldflame/shejane/api/internal/config"
	"github.com/coldflame/shejane/api/internal/modelreg"
	"github.com/coldflame/shejane/api/internal/store"
)

func TestUsageCreditsUsesSeparateInputAndOutputMultipliers(t *testing.T) {
	ctx := context.Background()
	st := store.NewMemoryStore()
	application := New(config.Default(), st)

	if _, err := st.SetAppSetting(ctx, "admin", modelreg.BillingSettingsKey, `{"markup_factor":1,"currency_per_credit":0.00002}`); err != nil {
		t.Fatalf("set billing settings: %v", err)
	}
	if _, err := st.UpsertModelConfig(ctx, "admin", store.ModelConfig{
		Slot:                   "deepseek-pro-compatible",
		Capability:             modelreg.CapabilityChat,
		ProviderKind:           "mock",
		DisplayName:            "DeepSeek Pro Compatible",
		ModelName:              "deepseek-v4-pro",
		CreditMultiplier:       9,
		InputCreditMultiplier:  0.5,
		OutputCreditMultiplier: 2,
		Enabled:                true,
	}); err != nil {
		t.Fatalf("upsert model config: %v", err)
	}
	application.Registry.Invalidate()

	got := application.UsageCreditsForTokens("deepseek-pro-compatible", 100, 50)
	// 100 input * 0.5 + 50 output * 2 = 150 credits. The legacy multiplier
	// must not be applied when explicit input/output rates are configured.
	if got != 150 {
		t.Fatalf("credits = %d, want 150", got)
	}
}

func TestUsageCreditsUsesPerMillionCNYPricesBeforeLegacyMultipliers(t *testing.T) {
	ctx := context.Background()
	st := store.NewMemoryStore()
	application := New(config.Default(), st)

	if _, err := st.SetAppSetting(ctx, "admin", modelreg.BillingSettingsKey, `{"markup_factor":1.15,"currency_per_credit":0.00002,"currency":"cny"}`); err != nil {
		t.Fatalf("set billing settings: %v", err)
	}
	if _, err := st.UpsertModelConfig(ctx, "admin", store.ModelConfig{
		Slot:                          "cny-priced",
		Capability:                    modelreg.CapabilityChat,
		ProviderKind:                  "mock",
		DisplayName:                   "CNY Priced",
		ModelName:                     "cny-priced",
		CreditMultiplier:              99,
		InputCreditMultiplier:         99,
		OutputCreditMultiplier:        99,
		InputPricePerMillionCNY:       20,
		OutputPricePerMillionCNY:      80,
		CachedInputPricePerMillionCNY: 2,
		CacheWritePricePerMillionCNY:  20,
		Enabled:                       true,
	}); err != nil {
		t.Fatalf("upsert model config: %v", err)
	}
	application.Registry.Invalidate()

	got := application.UsageCreditsForTokens("cny-priced", 1000, 500)
	// ((1000/1M*20) + (500/1M*80)) * 1.15 / 0.00002 = 3450 credits.
	// The legacy 99x multipliers must not be applied when CNY prices exist.
	if got != 3450 {
		t.Fatalf("credits = %d, want 3450", got)
	}
}

func TestUsageCreditsFallsBackToLegacyMultiplier(t *testing.T) {
	ctx := context.Background()
	st := store.NewMemoryStore()
	application := New(config.Default(), st)

	if _, err := st.SetAppSetting(ctx, "admin", modelreg.BillingSettingsKey, `{"markup_factor":1,"currency_per_credit":0.00002}`); err != nil {
		t.Fatalf("set billing settings: %v", err)
	}
	if _, err := st.UpsertModelConfig(ctx, "admin", store.ModelConfig{
		Slot:             "legacy-priced",
		Capability:       modelreg.CapabilityChat,
		ProviderKind:     "mock",
		DisplayName:      "Legacy Priced",
		ModelName:        "legacy-priced",
		CreditMultiplier: 1.25,
		Enabled:          true,
	}); err != nil {
		t.Fatalf("upsert model config: %v", err)
	}
	application.Registry.Invalidate()

	got := application.UsageCreditsForTokens("legacy-priced", 100, 60)
	if got != 200 {
		t.Fatalf("credits = %d, want 200", got)
	}
}
