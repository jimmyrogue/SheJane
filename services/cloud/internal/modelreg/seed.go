package modelreg

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/coldflame/shejane/api/internal/llm"
	"github.com/coldflame/shejane/api/internal/store"
)

// defaultBaselineTokenCostCNY is the seeded CNY amount represented by one
// credit. The value matches the old DeepSeek-Pro-style token anchor
// (~¥20 / 1M credits) so existing wallets keep the same rough purchasing power.
const defaultBaselineTokenCostCNY = 0.00002

// EnsureSeed creates code-defined billing defaults and disabled model templates.
// It never enables a model or imports provider credentials: Admin-managed,
// encrypted model rows are the only production configuration source.
func (r *Registry) EnsureSeed(ctx context.Context) error {
	count, err := r.store.CountModelConfigs(ctx)
	if err != nil {
		return err
	}

	if count == 0 {
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
		if _, err := r.store.GetAppSetting(ctx, BillingLeversKey); err != nil {
			raw, _ := json.Marshal(map[string]any{
				"tavily_search_credits":            r.cfg.TavilySearchCredits,
				"e2b_code_exec_base_credits":       r.cfg.E2BCodeExecBaseCredits,
				"e2b_code_exec_per_second_credits": r.cfg.E2BCodeExecPerSecondCredits,
			})
			if _, err := r.store.SetAppSetting(ctx, "", BillingLeversKey, string(raw)); err != nil {
				return err
			}
		}
	}
	if err := r.ensureRecommendedTemplates(ctx); err != nil {
		return err
	}
	r.Invalidate()
	return nil
}

func (r *Registry) ensureRecommendedTemplates(ctx context.Context) error {
	configs, err := r.store.ListModelConfigs(ctx, CapabilityChat)
	if err != nil {
		return err
	}
	existing := make(map[string]bool, len(configs))
	for _, cfg := range configs {
		existing[cfg.Slot] = true
	}
	for _, template := range recommendedChatModelTemplates() {
		if existing[template.Slot] {
			continue
		}
		if _, err := r.store.UpsertModelConfig(ctx, "", template); err != nil {
			return err
		}
	}
	return nil
}

func recommendedChatModelTemplates() []store.ModelConfig {
	const openRouterBaseURL = "https://openrouter.ai/api/v1"
	return []store.ModelConfig{
		{
			Slot:                         "deepseek-v4-flash",
			Capability:                   CapabilityChat,
			ProviderKind:                 string(llm.ProviderKindOpenAICompatible),
			DisplayName:                  "DeepSeek V4 Flash",
			Vendor:                       "DeepSeek",
			VendorInfo:                   defaultVendorInfo("DeepSeek"),
			CapabilityTier:               CapabilityTierFast,
			Description:                  "OpenRouter 高使用量编码模型,适合快速问答、代码补全和低成本任务",
			BaseURL:                      openRouterBaseURL,
			ModelName:                    "deepseek/deepseek-v4-flash",
			CreditMultiplier:             0.1,
			InputCreditMultiplier:        0.1,
			OutputCreditMultiplier:       0.1,
			InputPricePerMillionCNY:      2,
			OutputPricePerMillionCNY:     2,
			CacheWritePricePerMillionCNY: 2,
			Priority:                     95,
			Enabled:                      false,
			Params:                       map[string]any{},
		},
		{
			Slot:                         "deepseek-v4-pro",
			Capability:                   CapabilityChat,
			ProviderKind:                 string(llm.ProviderKindOpenAICompatible),
			DisplayName:                  "DeepSeek V4 Pro",
			Vendor:                       "DeepSeek",
			VendorInfo:                   defaultVendorInfo("DeepSeek"),
			CapabilityTier:               CapabilityTierReasoning,
			Description:                  "DeepSeek 基准强推理模型,适合复杂分析、多步任务和代码审查",
			BaseURL:                      openRouterBaseURL,
			ModelName:                    "deepseek/deepseek-v4-pro",
			CreditMultiplier:             1,
			InputCreditMultiplier:        1,
			OutputCreditMultiplier:       1,
			InputPricePerMillionCNY:      20,
			OutputPricePerMillionCNY:     20,
			CacheWritePricePerMillionCNY: 20,
			Priority:                     90,
			Enabled:                      false,
			Params:                       map[string]any{},
		},
		{
			Slot:                         "mimo-v2-5",
			Capability:                   CapabilityChat,
			ProviderKind:                 string(llm.ProviderKindOpenAICompatible),
			DisplayName:                  "Mimo V2.5",
			Vendor:                       "Xiaomi",
			VendorInfo:                   defaultVendorInfo("Xiaomi"),
			CapabilityTier:               CapabilityTierBalanced,
			Description:                  "OpenRouter 编程榜高使用量模型,适合代码生成和日常开发任务",
			BaseURL:                      openRouterBaseURL,
			ModelName:                    "xiaomi/mimo-v2.5",
			CreditMultiplier:             0.6,
			InputCreditMultiplier:        0.5,
			OutputCreditMultiplier:       0.8,
			InputPricePerMillionCNY:      10,
			OutputPricePerMillionCNY:     16,
			CacheWritePricePerMillionCNY: 10,
			Priority:                     88,
			Enabled:                      false,
			Params:                       map[string]any{},
		},
		{
			Slot:                         "minimax-m3",
			Capability:                   CapabilityChat,
			ProviderKind:                 string(llm.ProviderKindOpenAICompatible),
			DisplayName:                  "MiniMax M3",
			Vendor:                       "MiniMax",
			VendorInfo:                   defaultVendorInfo("MiniMax"),
			CapabilityTier:               CapabilityTierReasoning,
			Description:                  "适合长上下文、工具调用、代理式编码和多步执行",
			BaseURL:                      openRouterBaseURL,
			ModelName:                    "minimax/minimax-m3",
			CreditMultiplier:             1,
			InputCreditMultiplier:        0.5,
			OutputCreditMultiplier:       1.5,
			InputPricePerMillionCNY:      10,
			OutputPricePerMillionCNY:     30,
			CacheWritePricePerMillionCNY: 10,
			Priority:                     86,
			Enabled:                      false,
			Params:                       map[string]any{},
		},
		{
			Slot:                         "gpt-5-5",
			Capability:                   CapabilityChat,
			ProviderKind:                 string(llm.ProviderKindOpenAICompatible),
			DisplayName:                  "GPT-5.5",
			Vendor:                       "ChatGPT",
			VendorInfo:                   defaultVendorInfo("ChatGPT"),
			CapabilityTier:               CapabilityTierMax,
			Description:                  "OpenAI 前沿通用模型模板,适合高难度推理、写作和综合任务",
			BaseURL:                      openRouterBaseURL,
			ModelName:                    "openai/gpt-5.5",
			CreditMultiplier:             6,
			InputCreditMultiplier:        4,
			OutputCreditMultiplier:       8,
			InputPricePerMillionCNY:      80,
			OutputPricePerMillionCNY:     160,
			CacheWritePricePerMillionCNY: 80,
			Priority:                     82,
			Enabled:                      false,
			Params:                       map[string]any{},
		},
		{
			Slot:                         "claude-opus-4-8",
			Capability:                   CapabilityChat,
			ProviderKind:                 string(llm.ProviderKindOpenAICompatible),
			DisplayName:                  "Claude Opus 4.8",
			Vendor:                       "Claude",
			VendorInfo:                   defaultVendorInfo("Claude"),
			CapabilityTier:               CapabilityTierMax,
			Description:                  "OpenRouter 编程榜强模型模板,适合复杂架构、长文推理和高风险改动",
			BaseURL:                      openRouterBaseURL,
			ModelName:                    "anthropic/claude-opus-4.8",
			CreditMultiplier:             6,
			InputCreditMultiplier:        4,
			OutputCreditMultiplier:       8,
			InputPricePerMillionCNY:      80,
			OutputPricePerMillionCNY:     160,
			CacheWritePricePerMillionCNY: 80,
			Priority:                     80,
			Enabled:                      false,
			Params:                       map[string]any{},
		},
		{
			Slot:                         "kimi-k2",
			Capability:                   CapabilityChat,
			ProviderKind:                 string(llm.ProviderKindOpenAICompatible),
			DisplayName:                  "Kimi K2",
			Vendor:                       "Kimi",
			VendorInfo:                   defaultVendorInfo("Kimi"),
			CapabilityTier:               CapabilityTierReasoning,
			Description:                  "Moonshot/Kimi 长上下文与推理模板,适合资料整理和复杂问答",
			BaseURL:                      openRouterBaseURL,
			ModelName:                    "moonshotai/kimi-k2",
			CreditMultiplier:             1.2,
			InputCreditMultiplier:        0.8,
			OutputCreditMultiplier:       2,
			InputPricePerMillionCNY:      16,
			OutputPricePerMillionCNY:     40,
			CacheWritePricePerMillionCNY: 16,
			Priority:                     76,
			Enabled:                      false,
			Params:                       map[string]any{},
		},
		{
			Slot:                         "qwen3-coder",
			Capability:                   CapabilityChat,
			ProviderKind:                 string(llm.ProviderKindOpenAICompatible),
			DisplayName:                  "Qwen3 Coder",
			Vendor:                       "Qwen",
			VendorInfo:                   defaultVendorInfo("Qwen"),
			CapabilityTier:               CapabilityTierBalanced,
			Description:                  "通义代码模型模板,适合常规代码生成、解释和中等复杂度开发",
			BaseURL:                      openRouterBaseURL,
			ModelName:                    "qwen/qwen3-coder",
			CreditMultiplier:             0.8,
			InputCreditMultiplier:        0.5,
			OutputCreditMultiplier:       1,
			InputPricePerMillionCNY:      10,
			OutputPricePerMillionCNY:     20,
			CacheWritePricePerMillionCNY: 10,
			Priority:                     74,
			Enabled:                      false,
			Params:                       map[string]any{},
		},
		{
			Slot:                         "gemini-3-1-pro",
			Capability:                   CapabilityChat,
			ProviderKind:                 string(llm.ProviderKindOpenAICompatible),
			DisplayName:                  "Gemini 3.1 Pro",
			Vendor:                       "Gemini",
			VendorInfo:                   defaultVendorInfo("Gemini"),
			CapabilityTier:               CapabilityTierMax,
			Description:                  "Google 前沿通用模型模板,适合长上下文、综合推理和复杂创作",
			BaseURL:                      openRouterBaseURL,
			ModelName:                    "google/gemini-3.1-pro-preview",
			CreditMultiplier:             5,
			InputCreditMultiplier:        3,
			OutputCreditMultiplier:       7,
			InputPricePerMillionCNY:      60,
			OutputPricePerMillionCNY:     140,
			CacheWritePricePerMillionCNY: 60,
			Priority:                     72,
			Enabled:                      false,
			Params:                       map[string]any{},
		},
	}
}

func defaultVendorInfo(vendor string) string {
	switch strings.ToLower(strings.TrimSpace(vendor)) {
	case "deepseek":
		return "深度求索，推理能力与性价比突出。"
	case "xiaomi":
		return "小米模型，适合快速问答与编码辅助。"
	case "chatgpt", "openai":
		return "OpenAI 出品，通用能力全面。"
	case "claude", "anthropic":
		return "Anthropic 出品，擅长写作、代码与长文理解。"
	case "minimax":
		return "MiniMax 出品，适合长上下文和 Agent 任务。"
	case "kimi":
		return "月之暗面，擅长长上下文与长文档。"
	case "qwen":
		return "阿里通义千问，中文与多语言表现出色。"
	case "gemini":
		return "Google 出品，原生多模态能力突出。"
	default:
		return ""
	}
}
