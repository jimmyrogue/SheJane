// Package modelreg turns admin-editable model_configs rows into live llm
// providers, with an in-process cache that hot-reloads on admin writes and a
// TTL safety refresh so other instances / external DB edits converge.
package modelreg

import (
	"context"
	"encoding/json"
	"log"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coldflame/shejane/api/internal/config"
	"github.com/coldflame/shejane/api/internal/llm"
	"github.com/coldflame/shejane/api/internal/secrets"
	"github.com/coldflame/shejane/api/internal/store"
)

const (
	SlotChatFast     = "chat.fast"
	SlotChatDeep     = "chat.deep"
	SlotImageDefault = "image.default"

	CapabilityChat  = "chat"
	CapabilityImage = "image"

	CapabilityTierFast      = "fast"
	CapabilityTierBalanced  = "balanced"
	CapabilityTierReasoning = "reasoning"
	CapabilityTierMax       = "max"

	cacheTTL = 30 * time.Second

	// BillingSettingsKey is the app_settings row holding the global billing
	// knobs (JSON): markup_factor and currency_per_credit (= CNY represented
	// by one credit, used to convert money-priced usage into credits).
	BillingSettingsKey = "credit.currency_per_credit"

	// BillingLeversKey is the app_settings row holding the admin-tunable
	// per-call cost levers (JSON): tavily_search_credits,
	// e2b_code_exec_base_credits, e2b_code_exec_per_second_credits. These are
	// pure Reserve→Settle cost inputs (never wallet grants), so they ride the
	// same 30s registry cache + Invalidate as the markup; the .env values are
	// the first-boot seed and the per-field fallback default.
	BillingLeversKey = "billing.levers"

	// DefaultMarkupFactor is the fixed gross markup applied to every metered
	// call when no value is configured (1.15 = +15%, within the 10–20% band
	// the product treats as its core margin).
	DefaultMarkupFactor = 1.15
	minMarkupFactor     = 1.0
	maxMarkupFactor     = 3.0
)

// ChatModelInfo is the user-facing catalog entry for a selectable chat model.
// No secrets (provider_kind / base_url / api_key are NOT exposed). Served by
// GET /api/v1/models and fed to the Auto router as candidate context.
type ChatModelInfo struct {
	ID                            string  `json:"id"` // stable model id; persisted in legacy slot column
	Label                         string  `json:"label"`
	Description                   string  `json:"description,omitempty"`
	Vendor                        string  `json:"vendor,omitempty"`
	VendorInfo                    string  `json:"vendor_info,omitempty"`
	CapabilityTier                string  `json:"capability_tier,omitempty"`
	InputPricePerMillionCNY       float64 `json:"input_price_per_million_cny"`
	OutputPricePerMillionCNY      float64 `json:"output_price_per_million_cny"`
	CachedInputPricePerMillionCNY float64 `json:"cached_input_price_per_million_cny"`
	CacheWritePricePerMillionCNY  float64 `json:"cache_write_price_per_million_cny"`
	Priority                      int     `json:"priority"`
}

type resolved struct {
	provider   llm.Provider
	model      string
	multiplier float64
	billing    llm.ModelBilling
}

type imageResolved struct {
	provider     llm.ImageProvider
	model        string
	pricePerCall float64
}

type Registry struct {
	store  store.Store
	cfg    config.Config
	cipher *secrets.Cipher

	mu                sync.RWMutex
	bySlot            map[string]resolved
	bySlotImg         map[string]imageResolved
	chatCatalog       []ChatModelInfo // enabled chat models, priority desc (cache)
	markup            float64
	currencyPerCredit float64
	// Admin-tunable per-call cost levers (billing.levers row), refreshed on
	// the same tick as markup; default to the env/coded value (set in New +
	// per-field fallback in loadBillingLevers) so a missing/zero field never
	// makes a paid tool free.
	tavilySearchCredits         int64
	e2bCodeExecBaseCredits      int64
	e2bCodeExecPerSecondCredits int64
	loadedAt                    time.Time
	stamp                       string // concatenated id+updatedAt of cached rows; cache key
}

func New(st store.Store, cfg config.Config) *Registry {
	return &Registry{
		store:                       st,
		cfg:                         cfg,
		cipher:                      secrets.New(cfg.ConfigEncryptionKey),
		bySlot:                      map[string]resolved{},
		bySlotImg:                   map[string]imageResolved{},
		markup:                      DefaultMarkupFactor,
		tavilySearchCredits:         cfg.TavilySearchCredits,
		e2bCodeExecBaseCredits:      cfg.E2BCodeExecBaseCredits,
		e2bCodeExecPerSecondCredits: cfg.E2BCodeExecPerSecondCredits,
	}
}

// Markup returns the global gross markup factor applied to every metered call
// (chat and image). Defaults to DefaultMarkupFactor when unset.
func (r *Registry) Markup() float64 {
	r.refreshIfStale(context.Background())
	r.mu.RLock()
	defer r.mu.RUnlock()
	if r.markup < minMarkupFactor {
		return DefaultMarkupFactor
	}
	return r.markup
}

// CurrencyPerCredit returns the CNY amount represented by one credit. ok is
// false when it has not been configured.
func (r *Registry) CurrencyPerCredit() (float64, bool) {
	r.refreshIfStale(context.Background())
	r.mu.RLock()
	defer r.mu.RUnlock()
	if r.currencyPerCredit <= 0 {
		return 0, false
	}
	return r.currencyPerCredit, true
}

// TavilySearchCredits returns the per-call credit cost charged for a web.search
// (a Reserve→Settle cost input). Admin-tunable via the billing.levers row;
// falls back to the env/coded default.
func (r *Registry) TavilySearchCredits() int64 {
	r.refreshIfStale(context.Background())
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.tavilySearchCredits
}

// E2BCodeExecBaseCredits returns the per-call flat charge for code.execute.
// Admin-tunable via billing.levers; falls back to the env/coded default.
func (r *Registry) E2BCodeExecBaseCredits() int64 {
	r.refreshIfStale(context.Background())
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.e2bCodeExecBaseCredits
}

// E2BCodeExecPerSecondCredits returns the per-sandbox-second multiplier for
// code.execute. A single request reads this ONCE and uses the same value for
// both the reservation ceiling and the settle, so an admin edit mid-request
// can never split reserve vs settle. Falls back to the env/coded default.
func (r *Registry) E2BCodeExecPerSecondCredits() int64 {
	r.refreshIfStale(context.Background())
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.e2bCodeExecPerSecondCredits
}

// Cipher exposes the at-rest cipher so handlers can encrypt incoming API keys
// with the same key the registry uses to decrypt them.
func (r *Registry) Cipher() *secrets.Cipher { return r.cipher }

// Invalidate forces the next Resolve to reload from the store immediately.
func (r *Registry) Invalidate() {
	r.mu.Lock()
	r.loadedAt = time.Time{}
	r.stamp = ""
	r.mu.Unlock()
}

// ResolveModel returns the provider/model/multiplier for a catalog model id.
// The id is persisted in the legacy model_configs.slot column. ok is false
// when no enabled config has that id (caller falls back to DefaultChatModelID).
func (r *Registry) ResolveModel(modelID string) (llm.Provider, string, float64, bool) {
	r.refreshIfStale(context.Background())
	r.mu.RLock()
	res, ok := r.bySlot[modelID]
	r.mu.RUnlock()
	if !ok {
		return nil, "", 1, false
	}
	return res.provider, res.model, res.multiplier, true
}

// ResolveBilling returns the token-level billing shape for a catalog model id.
// ok is false when no enabled model has that id.
func (r *Registry) ResolveBilling(modelID string) (llm.ModelBilling, bool) {
	r.refreshIfStale(context.Background())
	r.mu.RLock()
	res, ok := r.bySlot[modelID]
	r.mu.RUnlock()
	if !ok {
		return llm.ModelBilling{CreditMultiplier: 1}, false
	}
	return res.billing, true
}

// ListChatModels returns the user-facing catalog (enabled chat models, highest
// priority first). Safe copy; no secrets.
func (r *Registry) ListChatModels() []ChatModelInfo {
	r.refreshIfStale(context.Background())
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]ChatModelInfo, len(r.chatCatalog))
	copy(out, r.chatCatalog)
	return out
}

// DefaultChatModelID is the highest-priority enabled chat model id — used when
// a request omits a model or names an unknown one. Empty if the catalog is empty.
func (r *Registry) DefaultChatModelID() string {
	r.refreshIfStale(context.Background())
	r.mu.RLock()
	defer r.mu.RUnlock()
	if len(r.chatCatalog) == 0 {
		return ""
	}
	return r.chatCatalog[0].ID
}

func (r *Registry) refreshIfStale(ctx context.Context) {
	r.mu.RLock()
	fresh := !r.loadedAt.IsZero() && time.Since(r.loadedAt) < cacheTTL
	r.mu.RUnlock()
	if fresh {
		return
	}

	currency, markup := r.loadBillingSettings(ctx)
	tavily, e2bBase, e2bPerSec := r.loadBillingLevers(ctx)

	configs, err := r.store.ListModelConfigs(ctx, "")
	if err != nil {
		log.Printf("modelreg: list model configs failed: %v", err)
		return
	}
	stamp := stampFor(configs)

	r.mu.Lock()
	defer r.mu.Unlock()
	r.currencyPerCredit = currency
	r.markup = markup
	r.tavilySearchCredits = tavily
	r.e2bCodeExecBaseCredits = e2bBase
	r.e2bCodeExecPerSecondCredits = e2bPerSec
	if stamp == r.stamp && !r.loadedAt.IsZero() {
		r.loadedAt = time.Now()
		return
	}
	next := map[string]resolved{}
	nextImg := map[string]imageResolved{}
	catalog := make([]ChatModelInfo, 0)
	for _, cfg := range configs {
		if !cfg.Enabled {
			continue
		}
		if cfg.Capability == CapabilityImage {
			nextImg[cfg.Slot] = imageResolved{
				provider:     r.buildImageProvider(cfg),
				model:        cfg.ModelName,
				pricePerCall: cfg.PricePerCallCNY,
			}
			continue
		}
		billing := llm.ModelBilling{
			CreditMultiplier:              normalizeMultiplier(cfg.CreditMultiplier),
			InputCreditMultiplier:         cfg.InputCreditMultiplier,
			OutputCreditMultiplier:        cfg.OutputCreditMultiplier,
			CachedInputCreditMultiplier:   cfg.CachedInputCreditMultiplier,
			CacheWriteCreditMultiplier:    cfg.CacheWriteCreditMultiplier,
			InputPricePerMillionCNY:       cfg.InputPricePerMillionCNY,
			OutputPricePerMillionCNY:      cfg.OutputPricePerMillionCNY,
			CachedInputPricePerMillionCNY: cfg.CachedInputPricePerMillionCNY,
			CacheWritePricePerMillionCNY:  cfg.CacheWritePricePerMillionCNY,
		}.Normalized()
		next[cfg.Slot] = resolved{
			provider:   r.buildProvider(cfg),
			model:      cfg.ModelName,
			multiplier: normalizeMultiplier(cfg.CreditMultiplier),
			billing:    billing,
		}
		label := cfg.DisplayName
		if strings.TrimSpace(label) == "" {
			label = cfg.Slot
		}
		catalog = append(catalog, ChatModelInfo{
			ID:                            cfg.Slot,
			Label:                         label,
			Description:                   cfg.Description,
			Vendor:                        strings.TrimSpace(cfg.Vendor),
			VendorInfo:                    strings.TrimSpace(cfg.VendorInfo),
			CapabilityTier:                NormalizeCapabilityTier(cfg.CapabilityTier),
			InputPricePerMillionCNY:       billing.InputPricePerMillionCNY,
			OutputPricePerMillionCNY:      billing.OutputPricePerMillionCNY,
			CachedInputPricePerMillionCNY: billing.CachedInputPricePerMillionCNY,
			CacheWritePricePerMillionCNY:  billing.CacheWritePricePerMillionCNY,
			Priority:                      cfg.Priority,
		})
	}
	// Highest priority first; stable id tiebreak. Drives the picker order,
	// Auto-router preference, and DefaultChatModelID.
	sort.Slice(catalog, func(i, j int) bool {
		if catalog[i].Priority != catalog[j].Priority {
			return catalog[i].Priority > catalog[j].Priority
		}
		return catalog[i].ID < catalog[j].ID
	})
	r.bySlot = next
	r.bySlotImg = nextImg
	r.chatCatalog = catalog
	r.stamp = stamp
	r.loadedAt = time.Now()
}

// ResolveImage returns the image provider/model/per-call price (in currency)
// for the default image slot. ok is false when no enabled image model exists.
func (r *Registry) ResolveImage() (llm.ImageProvider, string, float64, bool) {
	r.refreshIfStale(context.Background())
	r.mu.RLock()
	res, ok := r.bySlotImg[SlotImageDefault]
	r.mu.RUnlock()
	if !ok {
		return nil, "", 0, false
	}
	return res.provider, res.model, res.pricePerCall, true
}

func (r *Registry) buildImageProvider(cfg store.ModelConfig) llm.ImageProvider {
	name := cfg.DisplayName
	if strings.TrimSpace(name) == "" {
		name = cfg.Slot
	}
	if llm.NormalizeProviderKind(cfg.ProviderKind) == llm.ProviderKindMock {
		return llm.NewMockImageProvider(name)
	}
	apiKey := r.cipher.Decrypt(cfg.APIKeyEncrypted)
	if apiKey == "" || cfg.BaseURL == "" {
		// Real image provider with no usable credentials: fail loud instead
		// of returning a placeholder image that still settles credits.
		return llm.NewUnconfiguredImageProvider(name, "missing API key or base URL")
	}
	return llm.NewOpenAIImageProvider(name, cfg.BaseURL, apiKey)
}

func (r *Registry) buildProvider(cfg store.ModelConfig) llm.Provider {
	apiKey := r.cipher.Decrypt(cfg.APIKeyEncrypted)
	kind := llm.NormalizeProviderKind(cfg.ProviderKind)
	name := cfg.DisplayName
	if strings.TrimSpace(name) == "" {
		name = defaultProviderName(cfg.Slot)
	}
	switch kind {
	case llm.ProviderKindMock:
		return llm.NewMockProvider(name, stringParam(cfg.Params, "mock_reply", "Mock SheJane response"))
	case llm.ProviderKindAnthropic:
		if apiKey == "" {
			// Misconfigured real provider: error so the LLM billing path
			// releases the reservation, rather than charging for a mock reply.
			return llm.NewUnconfiguredProvider(name, "anthropic API key missing")
		}
		version := stringParam(cfg.Params, "anthropic_version", r.cfg.AnthropicVersion)
		// BaseURL supports proxy/gateway deployments; params.max_tokens caps the
		// response (0 → provider default). Anthropic thinking params are optional
		// per-row knobs for models that support extended/adaptive thinking.
		return llm.NewAnthropicProviderWithOptions(apiKey, version, llm.AnthropicProviderOptions{
			BaseURL:   cfg.BaseURL,
			MaxTokens: intParam(cfg.Params, "max_tokens", 0),
			Thinking: llm.AnthropicThinkingConfig{
				Type:         stringParam(cfg.Params, "thinking_type", ""),
				BudgetTokens: intParam(cfg.Params, "thinking_budget_tokens", 0),
				Display:      stringParam(cfg.Params, "thinking_display", ""),
				Effort:       stringParam(cfg.Params, "thinking_effort", ""),
			},
		})
	default:
		if apiKey == "" || cfg.BaseURL == "" {
			return llm.NewUnconfiguredProvider(name, "missing API key or base URL")
		}
		profileKind := llm.InferOpenAIProviderKind(cfg.ProviderKind, cfg.BaseURL)
		return llm.NewOpenAICompatibleProviderWithProfile(name, cfg.BaseURL, apiKey, llm.ProfileForProviderKind(profileKind))
	}
}

func defaultProviderName(slot string) string {
	switch slot {
	case SlotChatDeep:
		return "claude-deep"
	case SlotChatFast:
		return "deepseek-fast"
	default:
		return slot
	}
}

func normalizeMultiplier(m float64) float64 {
	if m <= 0 {
		return 1
	}
	return m
}

func NormalizeCapabilityTier(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "", CapabilityTierBalanced:
		return CapabilityTierBalanced
	case CapabilityTierFast:
		return CapabilityTierFast
	case CapabilityTierReasoning:
		return CapabilityTierReasoning
	case CapabilityTierMax:
		return CapabilityTierMax
	default:
		return ""
	}
}

func stringParam(params map[string]any, key string, fallback string) string {
	if params == nil {
		return fallback
	}
	if v, ok := params[key].(string); ok && strings.TrimSpace(v) != "" {
		return v
	}
	return fallback
}

// intParam reads an integer param. JSON numbers decode as float64; admin input
// may also arrive as a string. Non-positive / unparseable → fallback.
func intParam(params map[string]any, key string, fallback int) int {
	if params == nil {
		return fallback
	}
	switch v := params[key].(type) {
	case float64:
		if v > 0 {
			return int(v)
		}
	case int:
		if v > 0 {
			return v
		}
	case string:
		if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil && n > 0 {
			return n
		}
	}
	return fallback
}

func (r *Registry) loadBillingSettings(ctx context.Context) (currency float64, markup float64) {
	markup = DefaultMarkupFactor
	setting, err := r.store.GetAppSetting(ctx, BillingSettingsKey)
	if err != nil {
		return 0, markup
	}
	var parsed struct {
		CurrencyPerCredit float64 `json:"currency_per_credit"`
		MarkupFactor      float64 `json:"markup_factor"`
	}
	if err := json.Unmarshal([]byte(setting.Value), &parsed); err != nil {
		return 0, markup
	}
	if parsed.MarkupFactor >= minMarkupFactor && parsed.MarkupFactor <= maxMarkupFactor {
		markup = parsed.MarkupFactor
	}
	if parsed.CurrencyPerCredit > 0 {
		currency = parsed.CurrencyPerCredit
	}
	return currency, markup
}

// loadBillingLevers reads the admin-tunable per-call cost levers from the
// billing.levers app_settings row. Each field falls back PER-FIELD to the
// env/coded default (cfg.*) when the row is absent or the field is
// missing/non-positive — a stored 0 must never silently make a paid tool free.
func (r *Registry) loadBillingLevers(ctx context.Context) (tavily, e2bBase, e2bPerSec int64) {
	tavily = r.cfg.TavilySearchCredits
	e2bBase = r.cfg.E2BCodeExecBaseCredits
	e2bPerSec = r.cfg.E2BCodeExecPerSecondCredits
	setting, err := r.store.GetAppSetting(ctx, BillingLeversKey)
	if err != nil {
		return
	}
	var parsed struct {
		TavilySearchCredits         int64 `json:"tavily_search_credits"`
		E2BCodeExecBaseCredits      int64 `json:"e2b_code_exec_base_credits"`
		E2BCodeExecPerSecondCredits int64 `json:"e2b_code_exec_per_second_credits"`
	}
	if err := json.Unmarshal([]byte(setting.Value), &parsed); err != nil {
		return
	}
	if parsed.TavilySearchCredits > 0 {
		tavily = parsed.TavilySearchCredits
	}
	if parsed.E2BCodeExecBaseCredits > 0 {
		e2bBase = parsed.E2BCodeExecBaseCredits
	}
	if parsed.E2BCodeExecPerSecondCredits > 0 {
		e2bPerSec = parsed.E2BCodeExecPerSecondCredits
	}
	return
}

func stampFor(configs []store.ModelConfig) string {
	var b strings.Builder
	for _, c := range configs {
		b.WriteString(c.ID)
		b.WriteByte('@')
		b.WriteString(c.UpdatedAt.UTC().Format(time.RFC3339Nano))
		b.WriteByte(';')
	}
	return b.String()
}
