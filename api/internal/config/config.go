package config

import (
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	HTTPAddr        string
	AppBaseURL      string
	ClientBaseURL   string
	AdminBaseURL    string
	JWTSecret       string
	AccessTokenTTL  time.Duration
	RefreshTokenTTL time.Duration
	CookieSecure    bool
	DatabaseURL     string
	AdminEmails     []string

	MonthlyCredits int64
	MockLLM        bool

	FastProviderBaseURL string
	FastProviderAPIKey  string
	FastModel           string
	DeepProviderBaseURL string
	DeepProviderAPIKey  string
	DeepModel           string
	AnthropicAPIKey     string
	AnthropicVersion    string

	StripeSecretKey     string
	StripeWebhookSecret string
	StripePriceID       string
}

func Default() Config {
	return Config{
		HTTPAddr:            ":8080",
		AppBaseURL:          "http://localhost:8080",
		ClientBaseURL:       "http://localhost:5173",
		AdminBaseURL:        "http://localhost:5174",
		JWTSecret:           "dev-change-me",
		AccessTokenTTL:      15 * time.Minute,
		RefreshTokenTTL:     30 * 24 * time.Hour,
		DatabaseURL:         "",
		AdminEmails:         nil,
		MonthlyCredits:      20_000,
		MockLLM:             true,
		FastProviderBaseURL: "https://api.deepseek.com",
		FastModel:           "deepseek-v4-flash",
		DeepModel:           "claude-3-5-sonnet-latest",
		AnthropicVersion:    "2023-06-01",
		StripeWebhookSecret: "",
		StripeSecretKey:     "",
		StripePriceID:       "",
		DeepProviderBaseURL: "",
		DeepProviderAPIKey:  "",
		FastProviderAPIKey:  "",
	}
}

func Load() Config {
	cfg := Default()
	cfg.HTTPAddr = getEnv("HTTP_ADDR", cfg.HTTPAddr)
	cfg.AppBaseURL = getEnv("APP_BASE_URL", cfg.AppBaseURL)
	cfg.ClientBaseURL = getEnv("CLIENT_BASE_URL", cfg.ClientBaseURL)
	cfg.AdminBaseURL = getEnv("ADMIN_BASE_URL", cfg.AdminBaseURL)
	cfg.JWTSecret = getEnv("JWT_SECRET", cfg.JWTSecret)
	cfg.CookieSecure = getEnvBool("COOKIE_SECURE", cfg.CookieSecure)
	cfg.DatabaseURL = getEnv("DATABASE_URL", cfg.DatabaseURL)
	cfg.AdminEmails = getEnvList("ADMIN_EMAILS", cfg.AdminEmails)
	cfg.MonthlyCredits = getEnvInt64("MONTHLY_CREDITS", cfg.MonthlyCredits)
	cfg.MockLLM = getEnvBool("MOCK_LLM", cfg.MockLLM)
	cfg.FastProviderBaseURL = getEnv("FAST_PROVIDER_BASE_URL", cfg.FastProviderBaseURL)
	cfg.FastProviderAPIKey = getEnv("FAST_PROVIDER_API_KEY", cfg.FastProviderAPIKey)
	cfg.FastModel = getEnv("FAST_MODEL", cfg.FastModel)
	cfg.DeepProviderBaseURL = getEnv("DEEP_PROVIDER_BASE_URL", cfg.DeepProviderBaseURL)
	cfg.DeepProviderAPIKey = getEnv("DEEP_PROVIDER_API_KEY", cfg.DeepProviderAPIKey)
	cfg.DeepModel = getEnv("DEEP_MODEL", cfg.DeepModel)
	cfg.AnthropicAPIKey = getEnv("ANTHROPIC_API_KEY", cfg.AnthropicAPIKey)
	cfg.AnthropicVersion = getEnv("ANTHROPIC_VERSION", cfg.AnthropicVersion)
	cfg.StripeSecretKey = getEnv("STRIPE_SECRET_KEY", cfg.StripeSecretKey)
	cfg.StripeWebhookSecret = getEnv("STRIPE_WEBHOOK_SECRET", cfg.StripeWebhookSecret)
	cfg.StripePriceID = getEnv("STRIPE_PRICE_ID", cfg.StripePriceID)
	return cfg
}

func (c Config) IsAdminEmail(email string) bool {
	normalized := strings.ToLower(strings.TrimSpace(email))
	for _, candidate := range c.AdminEmails {
		if normalized == strings.ToLower(strings.TrimSpace(candidate)) {
			return true
		}
	}
	return false
}

func getEnv(key string, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func getEnvBool(key string, fallback bool) bool {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func getEnvInt64(key string, fallback int64) int64 {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return fallback
	}
	return parsed
}

func getEnvList(key string, fallback []string) []string {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	parts := strings.Split(value, ",")
	items := make([]string, 0, len(parts))
	for _, part := range parts {
		item := strings.ToLower(strings.TrimSpace(part))
		if item != "" {
			items = append(items, item)
		}
	}
	return items
}
