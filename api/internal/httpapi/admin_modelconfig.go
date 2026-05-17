package httpapi

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/coldflame/jiandanly/api/internal/modelreg"
	"github.com/coldflame/jiandanly/api/internal/store"
)

const creditRateSettingKey = modelreg.BillingSettingsKey

// adminModelConfigView is the API shape for a model config. It deliberately
// omits the encrypted API key and only reports whether one is configured.
type adminModelConfigView struct {
	ID               string         `json:"id"`
	Slot             string         `json:"slot"`
	Capability       string         `json:"capability"`
	ProviderKind     string         `json:"provider_kind"`
	DisplayName      string         `json:"display_name"`
	BaseURL          string         `json:"base_url"`
	ModelName        string         `json:"model_name"`
	CreditMultiplier float64        `json:"credit_multiplier"`
	Enabled          bool           `json:"enabled"`
	Params           map[string]any `json:"params"`
	APIKeyConfigured bool           `json:"api_key_configured"`
	UpdatedAt        string         `json:"updated_at"`
}

func toModelConfigView(c store.ModelConfig) adminModelConfigView {
	params := c.Params
	if params == nil {
		params = map[string]any{}
	}
	return adminModelConfigView{
		ID:               c.ID,
		Slot:             c.Slot,
		Capability:       c.Capability,
		ProviderKind:     c.ProviderKind,
		DisplayName:      c.DisplayName,
		BaseURL:          c.BaseURL,
		ModelName:        c.ModelName,
		CreditMultiplier: c.CreditMultiplier,
		Enabled:          c.Enabled,
		Params:           params,
		APIKeyConfigured: strings.TrimSpace(c.APIKeyEncrypted) != "",
		UpdatedAt:        c.UpdatedAt.UTC().Format("2006-01-02T15:04:05Z07:00"),
	}
}

type modelConfigInput struct {
	Slot             string         `json:"slot"`
	Capability       string         `json:"capability"`
	ProviderKind     string         `json:"provider_kind"`
	DisplayName      string         `json:"display_name"`
	BaseURL          string         `json:"base_url"`
	ModelName        string         `json:"model_name"`
	CreditMultiplier float64        `json:"credit_multiplier"`
	PricePerCallCNY  float64        `json:"price_per_call_cny"`
	Enabled          *bool          `json:"enabled"`
	Params           map[string]any `json:"params"`
	APIKey           string         `json:"api_key"`
}

func (s *Server) adminListModelConfigs(w http.ResponseWriter, r *http.Request, user store.User) {
	capability := strings.TrimSpace(r.URL.Query().Get("capability"))
	configs, err := s.app.Store.ListModelConfigs(r.Context(), capability)
	if err != nil {
		writeError(w, http.StatusInternalServerError, 50001, "读取模型配置失败")
		return
	}
	views := make([]adminModelConfigView, 0, len(configs))
	for _, c := range configs {
		views = append(views, toModelConfigView(c))
	}
	writeJSON(w, http.StatusOK, apiResponse[[]adminModelConfigView]{Code: 0, Message: "ok", Data: views})
}

func (s *Server) adminCreateModelConfig(w http.ResponseWriter, r *http.Request, user store.User) {
	var input modelConfigInput
	if !decodeJSON(w, r, &input) {
		return
	}
	cfg, ok := s.buildModelConfigFromInput(w, input, store.ModelConfig{})
	if !ok {
		return
	}
	saved, err := s.app.Store.UpsertModelConfig(r.Context(), user.ID, cfg)
	if err != nil {
		writeError(w, http.StatusInternalServerError, 50001, "保存模型配置失败")
		return
	}
	s.app.Registry.Invalidate()
	writeJSON(w, http.StatusOK, apiResponse[adminModelConfigView]{Code: 0, Message: "ok", Data: toModelConfigView(saved)})
}

func (s *Server) adminUpdateModelConfig(w http.ResponseWriter, r *http.Request, user store.User) {
	id := r.PathValue("id")
	existing, err := s.app.Store.GetModelConfig(r.Context(), id)
	if err != nil {
		writeStoreReadError(w, err, "读取模型配置失败")
		return
	}
	var input modelConfigInput
	if !decodeJSON(w, r, &input) {
		return
	}
	cfg, ok := s.buildModelConfigFromInput(w, input, existing)
	if !ok {
		return
	}
	cfg.ID = existing.ID
	saved, err := s.app.Store.UpsertModelConfig(r.Context(), user.ID, cfg)
	if err != nil {
		writeError(w, http.StatusInternalServerError, 50001, "保存模型配置失败")
		return
	}
	s.app.Registry.Invalidate()
	writeJSON(w, http.StatusOK, apiResponse[adminModelConfigView]{Code: 0, Message: "ok", Data: toModelConfigView(saved)})
}

// buildModelConfigFromInput validates input and merges it onto an existing row
// (zero-value existing for create). A blank api_key keeps the stored key.
func (s *Server) buildModelConfigFromInput(w http.ResponseWriter, input modelConfigInput, existing store.ModelConfig) (store.ModelConfig, bool) {
	slot := strings.TrimSpace(input.Slot)
	providerKind := strings.TrimSpace(input.ProviderKind)
	if slot == "" || providerKind == "" {
		writeError(w, http.StatusBadRequest, 40201, "slot 与 provider_kind 必填")
		return store.ModelConfig{}, false
	}
	capability := strings.TrimSpace(input.Capability)
	if capability == "" {
		capability = existing.Capability
	}
	if capability == "" {
		capability = "chat"
	}
	multiplier := input.CreditMultiplier
	if multiplier <= 0 {
		multiplier = 1
	}
	enabled := true
	if input.Enabled != nil {
		enabled = *input.Enabled
	} else if existing.ID != "" {
		enabled = existing.Enabled
	}
	params := input.Params
	if params == nil {
		params = existing.Params
	}
	if params == nil {
		params = map[string]any{}
	}
	apiKeyEncrypted := existing.APIKeyEncrypted
	if strings.TrimSpace(input.APIKey) != "" {
		apiKeyEncrypted = s.app.Registry.Cipher().Encrypt(input.APIKey)
	}
	return store.ModelConfig{
		Slot:             slot,
		Capability:       capability,
		ProviderKind:     providerKind,
		DisplayName:      strings.TrimSpace(input.DisplayName),
		BaseURL:          strings.TrimSpace(input.BaseURL),
		ModelName:        strings.TrimSpace(input.ModelName),
		APIKeyEncrypted:  apiKeyEncrypted,
		CreditMultiplier: multiplier,
		PricePerCallCNY:  input.PricePerCallCNY,
		Enabled:          enabled,
		Params:           params,
	}, true
}

func (s *Server) adminToggleModelConfig(w http.ResponseWriter, r *http.Request, user store.User) {
	var body struct {
		Enabled bool `json:"enabled"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	saved, err := s.app.Store.SetModelConfigEnabled(r.Context(), user.ID, r.PathValue("id"), body.Enabled)
	if err != nil {
		writeStoreReadError(w, err, "更新模型配置状态失败")
		return
	}
	s.app.Registry.Invalidate()
	writeJSON(w, http.StatusOK, apiResponse[adminModelConfigView]{Code: 0, Message: "ok", Data: toModelConfigView(saved)})
}

func (s *Server) adminDeleteModelConfig(w http.ResponseWriter, r *http.Request, user store.User) {
	if err := s.app.Store.DeleteModelConfig(r.Context(), user.ID, r.PathValue("id")); err != nil {
		writeStoreReadError(w, err, "删除模型配置失败")
		return
	}
	s.app.Registry.Invalidate()
	writeJSON(w, http.StatusOK, apiResponse[map[string]any]{Code: 0, Message: "ok", Data: map[string]any{"deleted": true}})
}

// creditRateView carries the two global billing knobs: the fixed markup
// factor (the product's core margin) and the baseline DeepSeek-V4-Pro
// per-token cost used to convert money-billed models into credits.
type creditRateView struct {
	MarkupFactor      float64 `json:"markup_factor"`
	CurrencyPerCredit float64 `json:"currency_per_credit"`
	Currency          string  `json:"currency"`
	Configured        bool    `json:"configured"`
}

func (s *Server) adminGetCreditRate(w http.ResponseWriter, r *http.Request, user store.User) {
	view := creditRateView{Currency: "cny", MarkupFactor: modelreg.DefaultMarkupFactor}
	if setting, err := s.app.Store.GetAppSetting(r.Context(), creditRateSettingKey); err == nil {
		_ = json.Unmarshal([]byte(setting.Value), &view)
		if view.MarkupFactor <= 0 {
			view.MarkupFactor = modelreg.DefaultMarkupFactor
		}
		if strings.TrimSpace(view.Currency) == "" {
			view.Currency = "cny"
		}
		view.Configured = true
	}
	writeJSON(w, http.StatusOK, apiResponse[creditRateView]{Code: 0, Message: "ok", Data: view})
}

func (s *Server) adminSetCreditRate(w http.ResponseWriter, r *http.Request, user store.User) {
	var body struct {
		MarkupFactor      float64 `json:"markup_factor"`
		CurrencyPerCredit float64 `json:"currency_per_credit"`
		Currency          string  `json:"currency"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	if body.MarkupFactor < 1.0 || body.MarkupFactor > 3.0 {
		writeError(w, http.StatusBadRequest, 40201, "加价系数必须在 1.0–3.0 之间（1.15 = 加价 15%）")
		return
	}
	if body.CurrencyPerCredit < 0 {
		writeError(w, http.StatusBadRequest, 40201, "基准每 token 成本不能为负")
		return
	}
	if strings.TrimSpace(body.Currency) == "" {
		body.Currency = "cny"
	}
	view := creditRateView{
		MarkupFactor:      body.MarkupFactor,
		CurrencyPerCredit: body.CurrencyPerCredit,
		Currency:          body.Currency,
		Configured:        true,
	}
	raw, _ := json.Marshal(view)
	if _, err := s.app.Store.SetAppSetting(r.Context(), user.ID, creditRateSettingKey, string(raw)); err != nil {
		writeError(w, http.StatusInternalServerError, 50001, "保存计费参数失败")
		return
	}
	s.app.Registry.Invalidate()
	writeJSON(w, http.StatusOK, apiResponse[creditRateView]{Code: 0, Message: "ok", Data: view})
}
