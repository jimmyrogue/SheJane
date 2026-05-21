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
	// SignupCredits is the one-time gift (in credits) granted to a brand-new
	// user's wallet on first registration, written to extra_credits_balance
	// (semantically a one-shot bag, not a monthly quota). 0 disables it.
	SignupCredits int64
	MockLLM       bool

	// ConfigEncryptionKey encrypts model API keys at rest in the DB. When empty,
	// keys are stored as plaintext and a warning is logged at startup.
	ConfigEncryptionKey string

	FastProviderKind    string
	FastProviderBaseURL string
	FastProviderAPIKey  string
	FastModel           string
	DeepProviderKind    string
	DeepProviderBaseURL string
	DeepProviderAPIKey  string
	DeepModel           string
	AnthropicAPIKey     string
	AnthropicVersion    string

	StripeSecretKey     string
	StripeWebhookSecret string
	StripePriceID       string

	AWSRegion          string
	AWSAccessKeyID     string
	AWSSecretAccessKey string
	S3Bucket           string
	S3DocumentPrefix   string
	DocumentMaxBytes   int64
	DocumentTextLimit  int
	DocumentTTLHours   int
	AgentRunTTLHours   int

	TavilyAPIKey        string
	TavilyBaseURL       string
	TavilySearchCredits int64
	ToolGatewayTimeout  time.Duration
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
		MonthlyCredits:      0,
		SignupCredits:       0,
		MockLLM:             true,
		FastProviderKind:    "",
		FastProviderBaseURL: "https://api.deepseek.com",
		FastModel:           "deepseek-v4-flash",
		DeepProviderKind:    "",
		DeepModel:           "claude-3-5-sonnet-latest",
		AnthropicVersion:    "2023-06-01",
		StripeWebhookSecret: "",
		StripeSecretKey:     "",
		StripePriceID:       "",
		DeepProviderBaseURL: "",
		DeepProviderAPIKey:  "",
		FastProviderAPIKey:  "",
		AWSRegion:           "",
		AWSAccessKeyID:      "",
		AWSSecretAccessKey:  "",
		S3Bucket:            "",
		S3DocumentPrefix:    "documents",
		DocumentMaxBytes:    30 * 1024 * 1024,
		DocumentTextLimit:   60_000,
		DocumentTTLHours:    168,
		AgentRunTTLHours:    168,
		TavilyAPIKey:        "",
		TavilyBaseURL:       "https://api.tavily.com",
		TavilySearchCredits: 20,
		ToolGatewayTimeout:  15 * time.Second,
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
	cfg.SignupCredits = getEnvInt64("SIGNUP_CREDITS", cfg.SignupCredits)
	cfg.MockLLM = getEnvBool("MOCK_LLM", cfg.MockLLM)
	cfg.ConfigEncryptionKey = getEnv("CONFIG_ENCRYPTION_KEY", cfg.ConfigEncryptionKey)
	cfg.FastProviderKind = getEnv("FAST_PROVIDER_KIND", cfg.FastProviderKind)
	cfg.FastProviderBaseURL = getEnv("FAST_PROVIDER_BASE_URL", cfg.FastProviderBaseURL)
	cfg.FastProviderAPIKey = getEnv("FAST_PROVIDER_API_KEY", cfg.FastProviderAPIKey)
	cfg.FastModel = getEnv("FAST_MODEL", cfg.FastModel)
	cfg.DeepProviderKind = getEnv("DEEP_PROVIDER_KIND", cfg.DeepProviderKind)
	cfg.DeepProviderBaseURL = getEnv("DEEP_PROVIDER_BASE_URL", cfg.DeepProviderBaseURL)
	cfg.DeepProviderAPIKey = getEnv("DEEP_PROVIDER_API_KEY", cfg.DeepProviderAPIKey)
	cfg.DeepModel = getEnv("DEEP_MODEL", cfg.DeepModel)
	cfg.AnthropicAPIKey = getEnv("ANTHROPIC_API_KEY", cfg.AnthropicAPIKey)
	cfg.AnthropicVersion = getEnv("ANTHROPIC_VERSION", cfg.AnthropicVersion)
	cfg.StripeSecretKey = getEnv("STRIPE_SECRET_KEY", cfg.StripeSecretKey)
	cfg.StripeWebhookSecret = getEnv("STRIPE_WEBHOOK_SECRET", cfg.StripeWebhookSecret)
	cfg.StripePriceID = getEnv("STRIPE_PRICE_ID", cfg.StripePriceID)
	cfg.AWSRegion = getEnv("AWS_REGION", cfg.AWSRegion)
	cfg.AWSAccessKeyID = getEnv("AWS_ACCESS_KEY_ID", cfg.AWSAccessKeyID)
	cfg.AWSSecretAccessKey = getEnv("AWS_SECRET_ACCESS_KEY", cfg.AWSSecretAccessKey)
	cfg.S3Bucket = getEnv("S3_BUCKET", cfg.S3Bucket)
	cfg.S3DocumentPrefix = getEnv("S3_DOCUMENT_PREFIX", cfg.S3DocumentPrefix)
	cfg.DocumentMaxBytes = getEnvInt64("DOCUMENT_MAX_BYTES", cfg.DocumentMaxBytes)
	cfg.DocumentTextLimit = getEnvInt("DOCUMENT_TEXT_LIMIT", cfg.DocumentTextLimit)
	cfg.DocumentTTLHours = getEnvInt("DOCUMENT_TTL_HOURS", cfg.DocumentTTLHours)
	cfg.AgentRunTTLHours = getEnvInt("AGENT_RUN_TTL_HOURS", cfg.AgentRunTTLHours)
	cfg.TavilyAPIKey = getEnv("TAVILY_API_KEY", cfg.TavilyAPIKey)
	cfg.TavilyBaseURL = getEnv("TAVILY_BASE_URL", cfg.TavilyBaseURL)
	cfg.TavilySearchCredits = getEnvInt64("TAVILY_SEARCH_CREDITS", cfg.TavilySearchCredits)
	cfg.ToolGatewayTimeout = time.Duration(getEnvInt("TOOL_GATEWAY_TIMEOUT_MS", int(cfg.ToolGatewayTimeout/time.Millisecond))) * time.Millisecond
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

func getEnvInt(key string, fallback int) int {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
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
