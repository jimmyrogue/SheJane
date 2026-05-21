package modelreg

import (
	"context"
	"encoding/json"
	"log"

	"github.com/coldflame/jiandanly/api/internal/llm"
	"github.com/coldflame/jiandanly/api/internal/store"
)

// defaultBaselineTokenCostCNY is the seeded "1 credit ≈ 1 DeepSeek-V4-Pro
// token" anchor (¥/token), a conservative blend of Pro full-price input+output
// (~¥20 / 1M tokens). Used to convert money-billed models (image) to credits.
const defaultBaselineTokenCostCNY = 0.00002

// EnsureSeed creates the initial chat.fast / chat.deep rows from env config the
// first time the table is empty, so behavior is identical to the legacy
// env-only path on first boot. After that, admin edits are the source of truth.
func (r *Registry) EnsureSeed(ctx context.Context) error {
	count, err := r.store.CountModelConfigs(ctx)
	if err != nil {
		return err
	}
	if count > 0 {
		return nil
	}

	fast, deep := r.seedRows()
	if _, err := r.store.UpsertModelConfig(ctx, "", fast); err != nil {
		return err
	}
	if _, err := r.store.UpsertModelConfig(ctx, "", deep); err != nil {
		return err
	}
	if _, err := r.store.GetAppSetting(ctx, BillingSettingsKey); err != nil {
		raw, _ := json.Marshal(map[string]any{
			"markup_factor":       DefaultMarkupFactor,
			"currency_per_credit": defaultBaselineTokenCostCNY,
			"currency":            "cny",
			"configured":          true,
		})
		if _, err := r.store.SetAppSetting(ctx, "", BillingSettingsKey, string(raw)); err != nil {
			return err
		}
	}
	if !r.cipher.Enabled() && (r.cfg.FastProviderAPIKey != "" || r.cfg.DeepProviderAPIKey != "" || r.cfg.AnthropicAPIKey != "") {
		log.Printf("modelreg: CONFIG_ENCRYPTION_KEY is not set — model API keys are stored in plaintext")
	}
	r.Invalidate()
	return nil
}

func (r *Registry) seedRows() (store.ModelConfig, store.ModelConfig) {
	cfg := r.cfg

	fast := store.ModelConfig{
		Slot:       SlotChatFast,
		Capability: CapabilityChat,
		// Cost ratio vs the DeepSeek-V4-Pro baseline. DeepSeek-V4-Flash is
		// roughly 1/10 the blended cost of Pro, so 0.1; admins refine per
		// real provider pricing and the global markup adds the margin.
		DisplayName:      "deepseek-fast",
		CreditMultiplier: 0.1,
		Enabled:          true,
		Params:           map[string]any{},
	}
	switch {
	case cfg.MockLLM:
		fast.ProviderKind = string(llm.ProviderKindMock)
		fast.ModelName = cfg.FastModel
		fast.Params["mock_reply"] = "Mock SheJane response from fast mode"
	case cfg.FastProviderBaseURL != "" && cfg.FastProviderAPIKey != "":
		fast.ProviderKind = string(llm.InferOpenAIProviderKind(cfg.FastProviderKind, cfg.FastProviderBaseURL))
		fast.BaseURL = cfg.FastProviderBaseURL
		fast.ModelName = cfg.FastModel
		fast.APIKeyEncrypted = r.cipher.Encrypt(cfg.FastProviderAPIKey)
	default:
		fast.ProviderKind = string(llm.ProviderKindMock)
		fast.ModelName = cfg.FastModel
		fast.Params["mock_reply"] = "Mock SheJane response from fast fallback"
	}

	deep := store.ModelConfig{
		Slot:       SlotChatDeep,
		Capability: CapabilityChat,
		// Pure cost ratio vs the DeepSeek-V4-Pro baseline (1.0 = same cost).
		// Admins set the real ratio per provider pricing; the global markup
		// adds the margin on top.
		DisplayName:      "claude-deep",
		CreditMultiplier: 1,
		Enabled:          true,
		Params:           map[string]any{},
	}
	deepKind := llm.NormalizeProviderKind(cfg.DeepProviderKind)
	switch {
	case cfg.MockLLM:
		deep.ProviderKind = string(llm.ProviderKindMock)
		deep.ModelName = cfg.DeepModel
		deep.Params["mock_reply"] = "Mock SheJane response from deep mode"
	case cfg.AnthropicAPIKey != "" && (deepKind == "" || deepKind == llm.ProviderKindAnthropic):
		deep.ProviderKind = string(llm.ProviderKindAnthropic)
		deep.ModelName = cfg.DeepModel
		deep.APIKeyEncrypted = r.cipher.Encrypt(cfg.AnthropicAPIKey)
		deep.Params["anthropic_version"] = cfg.AnthropicVersion
	case cfg.DeepProviderBaseURL != "" && cfg.DeepProviderAPIKey != "":
		deep.DisplayName = "deep-compatible"
		deep.ProviderKind = string(llm.InferOpenAIProviderKind(cfg.DeepProviderKind, cfg.DeepProviderBaseURL))
		deep.BaseURL = cfg.DeepProviderBaseURL
		deep.ModelName = cfg.DeepModel
		deep.APIKeyEncrypted = r.cipher.Encrypt(cfg.DeepProviderAPIKey)
	default:
		deep.ProviderKind = string(llm.ProviderKindMock)
		deep.ModelName = cfg.DeepModel
		deep.Params["mock_reply"] = "Mock SheJane response from deep fallback"
	}

	return fast, deep
}
