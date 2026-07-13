package llm

import "strings"

type ProviderKind string

const (
	ProviderKindDeepSeekV4       ProviderKind = "deepseek-v4"
	ProviderKindOpenAICompatible ProviderKind = "openai-compatible"
	ProviderKindAnthropic        ProviderKind = "anthropic"
	ProviderKindMock             ProviderKind = "mock"
)

type ProviderProfile struct {
	Kind                                ProviderKind
	SupportsToolCalls                   bool
	SupportsThinking                    bool
	RequiresReasoningContentOnToolCalls bool
	AllowToolMessageName                bool
	IncludeStreamUsage                  bool
	ThinkingType                        string
	AgentReasoningEffort                string
}

func OpenAICompatibleProfile() ProviderProfile {
	return ProviderProfile{
		Kind:               ProviderKindOpenAICompatible,
		SupportsToolCalls:  true,
		IncludeStreamUsage: true,
	}
}

func DeepSeekV4Profile() ProviderProfile {
	return ProviderProfile{
		Kind:                                ProviderKindDeepSeekV4,
		SupportsToolCalls:                   true,
		SupportsThinking:                    true,
		RequiresReasoningContentOnToolCalls: true,
		IncludeStreamUsage:                  true,
		ThinkingType:                        "enabled",
		AgentReasoningEffort:                "max",
	}
}

func ProfileForProviderKind(kind ProviderKind) ProviderProfile {
	switch kind {
	case ProviderKindDeepSeekV4:
		return DeepSeekV4Profile()
	default:
		return OpenAICompatibleProfile()
	}
}

// KindSupportsToolCalls reports whether a provider kind can do tool-calling
// turns (implements CompleteWithTools). The model catalog only admits
// tool-capable chat models (design decision: no tool-incapable rows), so the
// admin write path validates against this. All four built-in kinds qualify
// today; the guard exists for future kinds added without tool support.
func KindSupportsToolCalls(kind ProviderKind) bool {
	switch kind {
	case ProviderKindDeepSeekV4, ProviderKindOpenAICompatible, ProviderKindAnthropic, ProviderKindMock:
		return true
	default:
		return false
	}
}

func NormalizeProviderKind(kind string) ProviderKind {
	switch ProviderKind(strings.ToLower(strings.TrimSpace(kind))) {
	case ProviderKindDeepSeekV4:
		return ProviderKindDeepSeekV4
	case ProviderKindAnthropic:
		return ProviderKindAnthropic
	case ProviderKindMock:
		return ProviderKindMock
	case ProviderKindOpenAICompatible:
		return ProviderKindOpenAICompatible
	default:
		return ""
	}
}

func InferOpenAIProviderKind(configuredKind string, baseURL string) ProviderKind {
	if kind := NormalizeProviderKind(configuredKind); kind == ProviderKindDeepSeekV4 || kind == ProviderKindOpenAICompatible {
		return kind
	}
	normalizedBaseURL := strings.ToLower(strings.TrimSpace(baseURL))
	if strings.Contains(normalizedBaseURL, "deepseek") {
		return ProviderKindDeepSeekV4
	}
	return ProviderKindOpenAICompatible
}

type KindedProvider interface {
	ProviderKind() ProviderKind
}

func KindOfProvider(provider Provider) ProviderKind {
	if provider == nil {
		return ""
	}
	if kinded, ok := provider.(KindedProvider); ok {
		return kinded.ProviderKind()
	}
	return ""
}
