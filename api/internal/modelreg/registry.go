// Package modelreg turns admin-editable model_configs rows into live llm
// providers, with an in-process cache that hot-reloads on admin writes and a
// TTL safety refresh so other instances / external DB edits converge.
package modelreg

import (
	"context"
	"encoding/json"
	"log"
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

	cacheTTL = 30 * time.Second

	// BillingSettingsKey is the app_settings row holding the global billing
	// knobs (JSON): markup_factor and currency_per_credit (= the baseline
	// DeepSeek-V4-Pro per-token cost, used to price money-billed models).
	BillingSettingsKey = "credit.currency_per_credit"

	// DefaultMarkupFactor is the fixed gross markup applied to every metered
	// call when no value is configured (1.15 = +15%, within the 10–20% band
	// the product treats as its core margin).
	DefaultMarkupFactor = 1.15
	minMarkupFactor     = 1.0
	maxMarkupFactor     = 3.0
)

// SlotForMode maps a chat routing mode to its model_configs slot.
func SlotForMode(mode llm.Mode) string {
	if mode == llm.ModeDeep {
		return SlotChatDeep
	}
	return SlotChatFast
}

type resolved struct {
	provider   llm.Provider
	model      string
	multiplier float64
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
	markup            float64
	currencyPerCredit float64
	loadedAt          time.Time
	stamp             string // concatenated id+updatedAt of cached rows; cache key
}

func New(st store.Store, cfg config.Config) *Registry {
	return &Registry{
		store:     st,
		cfg:       cfg,
		cipher:    secrets.New(cfg.ConfigEncryptionKey),
		bySlot:    map[string]resolved{},
		bySlotImg: map[string]imageResolved{},
		markup:    DefaultMarkupFactor,
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

// CurrencyPerCredit returns the baseline DeepSeek-V4-Pro per-token cost (¥),
// used only to convert money-priced models (image) into credits. ok is false
// when it has not been configured.
func (r *Registry) CurrencyPerCredit() (float64, bool) {
	r.refreshIfStale(context.Background())
	r.mu.RLock()
	defer r.mu.RUnlock()
	if r.currencyPerCredit <= 0 {
		return 0, false
	}
	return r.currencyPerCredit, true
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

// Resolve returns the provider/model/multiplier for a chat mode. ok is false
// when no enabled config exists for the slot (caller should fall back).
func (r *Registry) Resolve(mode llm.Mode) (llm.Provider, string, float64, bool) {
	slot := SlotForMode(mode)
	r.refreshIfStale(context.Background())
	r.mu.RLock()
	res, ok := r.bySlot[slot]
	r.mu.RUnlock()
	if !ok {
		return nil, "", 1, false
	}
	return res.provider, res.model, res.multiplier, true
}

func (r *Registry) refreshIfStale(ctx context.Context) {
	r.mu.RLock()
	fresh := !r.loadedAt.IsZero() && time.Since(r.loadedAt) < cacheTTL
	r.mu.RUnlock()
	if fresh {
		return
	}

	currency, markup := r.loadBillingSettings(ctx)

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
	if stamp == r.stamp && !r.loadedAt.IsZero() {
		r.loadedAt = time.Now()
		return
	}
	next := map[string]resolved{}
	nextImg := map[string]imageResolved{}
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
		next[cfg.Slot] = resolved{
			provider:   r.buildProvider(cfg),
			model:      cfg.ModelName,
			multiplier: normalizeMultiplier(cfg.CreditMultiplier),
		}
	}
	r.bySlot = next
	r.bySlotImg = nextImg
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
		return llm.NewMockImageProvider(name)
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
			return llm.NewMockProvider(name, "Mock SheJane response (anthropic key missing)")
		}
		version := stringParam(cfg.Params, "anthropic_version", r.cfg.AnthropicVersion)
		return llm.NewAnthropicProvider(apiKey, version)
	default:
		if apiKey == "" || cfg.BaseURL == "" {
			return llm.NewMockProvider(name, "Mock SheJane response (provider not configured)")
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

func stringParam(params map[string]any, key string, fallback string) string {
	if params == nil {
		return fallback
	}
	if v, ok := params[key].(string); ok && strings.TrimSpace(v) != "" {
		return v
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
