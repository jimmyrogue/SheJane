package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Environment string

	HTTPAddr        string
	AppBaseURL      string
	ClientBaseURL   string
	AdminBaseURL    string
	JWTSecret       string
	AccessTokenTTL  time.Duration
	RefreshTokenTTL time.Duration
	// Password-reset email. ResendAPIKey empty → a LogMailer logs the reset
	// link instead of sending (dev/test). MailFromAddress must be a
	// Resend-verified sender for real delivery. Reset links are built from
	// ClientBaseURL. PasswordResetTokenTTL bounds how long a link is valid.
	ResendAPIKey              string
	MailFromAddress           string
	MailFromName              string
	PasswordResetTokenTTL     time.Duration
	EmailVerificationTokenTTL time.Duration
	CookieSecure              bool
	DatabaseURL               string
	AdminEmails               []string

	MonthlyCredits int64
	// SignupCredits is the one-time gift (in credits) granted to a brand-new
	// user's wallet on first registration, written to extra_credits_balance
	// (semantically a one-shot bag, not a monthly quota). 0 disables it.
	SignupCredits int64
	MockLLM       bool

	// ConfigEncryptionKey encrypts model API keys at rest in the DB. When empty,
	// keys are stored as plaintext and a warning is logged at startup.
	ConfigEncryptionKey string

	// Sentry error tracking + performance tracing. An empty DSN disables it
	// entirely (no-op), so dev / CI run without Sentry.
	SentryDSN              string
	SentryEnvironment      string
	SentryTracesSampleRate float64

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
	// S3UseAccelerate routes presigned PUT / GET URLs through AWS's
	// Transfer Acceleration network (CloudFront edge → AWS backbone),
	// which is dramatically faster for cross-border uploads (typical
	// 3-10× speedup from China to AWS Singapore). Requires the bucket
	// to have Transfer Acceleration ENABLED in the AWS Console — the
	// SDK option alone doesn't enable the feature server-side, just
	// asks the SDK to use the accelerated endpoint when generating
	// URLs. Bucket name must not contain dots (DNS-style names only)
	// for accelerate to work; the SDK silently falls back to the
	// standard endpoint on dot-containing names.
	// Default off so an unprepared bucket doesn't break uploads;
	// enable per-environment after flipping the bucket flag.
	S3UseAccelerate   bool
	S3DocumentPrefix  string
	DocumentMaxBytes  int64
	DocumentTextLimit int
	DocumentTTLHours  int
	// DocumentReaperIntervalMinutes is how often the background job
	// scans for past-TTL documents and hard-deletes their S3 objects
	// + DB rows. 0 disables the job entirely (useful in tests + when
	// the operator wants to rely solely on S3 Lifecycle for cleanup).
	// 60 min is a reasonable default — we don't need real-time
	// cleanup, just bounded backlog growth between passes.
	DocumentReaperIntervalMinutes int
	// DocumentReaperBatchSize caps how many expired documents one
	// tick processes. Prevents a single tick from chewing through
	// thousands of S3 deletes during catch-up after the job was
	// disabled. Following tick picks up where the previous left off.
	DocumentReaperBatchSize int
	AgentRunTTLHours        int

	TavilyAPIKey        string
	TavilyBaseURL       string
	TavilySearchCredits int64
	ToolGatewayTimeout  time.Duration
	WebToolLoopMaxSteps int

	// AgentSpendRateLimitPerMinute is a tighter, dedicated per-user ceiling on
	// the spend-heavy agent endpoints (LLM + tool execute), layered ON TOP of
	// the general per-user limit. The web build drives these directly from the
	// browser (client-orchestrated tool loop), so the client-side step cap can't
	// be trusted; this bounds a runaway/tampered client server-side. Sized for
	// legit multi-step agent runs (desktop daemon), tight enough to stop a spin.
	AgentSpendRateLimitPerMinute int

	// E2B (cloud microVM sandbox) — used by code.execute tool.
	// E2BAPIKey empty disables code.execute entirely (the gateway
	// returns a "tool not configured" envelope so the agent gracefully
	// degrades). Per CLAUDE.md Invariant #1, this key MUST live in the
	// Go API only — never in the Python daemon's env. The daemon talks
	// to E2B exclusively through /api/v1/agent/tools/execute.
	E2BAPIKey  string
	E2BBaseURL string
	// E2BTemplateID picks which E2B base image is provisioned. Default
	// "code-interpreter-v1" ships with Python 3.10 + jupyter + pandas /
	// numpy / matplotlib / scikit-learn / pdfplumber / ffmpeg / etc.
	E2BTemplateID string
	// E2BSandboxIdleTTLSeconds is how long an idle conversation-bound
	// sandbox lives before the reaper kills it. 900s (15 min) matches
	// E2B's own default. Set lower in dev to debug the reaper.
	E2BSandboxIdleTTLSeconds int
	// E2BSandboxMaxLifetimeSeconds is the hard ceiling regardless of
	// activity — protects against runaway agents holding a sandbox
	// open for hours. 3600s (1 hr) is a reasonable safety net.
	E2BSandboxMaxLifetimeSeconds int
	// E2BCodeExecBaseCredits is the per-call flat charge (covers
	// startup + overhead amortized). 0 = free.
	E2BCodeExecBaseCredits int64
	// E2BCodeExecPerSecondCredits is the credits-per-sandbox-second
	// multiplier used when settling the reservation after the call
	// returns. Real E2B price ~$0.000014/vCPU-s; this lets us pick a
	// product-friendly integer mapping (e.g. 1 credit ≈ 10 seconds).
	E2BCodeExecPerSecondCredits int64
	// E2BSandboxRequestTimeoutSeconds is how long a single code.execute
	// request can take before we abort and release the reservation.
	// Plan says 60s for v0 (no streaming yet).
	E2BSandboxRequestTimeoutSeconds int
}

func Default() Config {
	return Config{
		Environment:                   "development",
		HTTPAddr:                      ":8080",
		AppBaseURL:                    "http://localhost:8080",
		ClientBaseURL:                 "http://localhost:5173",
		AdminBaseURL:                  "http://localhost:5174",
		JWTSecret:                     "dev-change-me",
		SentryEnvironment:             "production",
		SentryTracesSampleRate:        0.1,
		AccessTokenTTL:                15 * time.Minute,
		RefreshTokenTTL:               30 * 24 * time.Hour,
		ResendAPIKey:                  "",
		MailFromAddress:               "",
		MailFromName:                  "SheJane",
		PasswordResetTokenTTL:         time.Hour,
		EmailVerificationTokenTTL:     24 * time.Hour,
		DatabaseURL:                   "",
		AdminEmails:                   nil,
		MonthlyCredits:                0,
		SignupCredits:                 0,
		MockLLM:                       true,
		FastProviderKind:              "",
		FastProviderBaseURL:           "https://api.deepseek.com",
		FastModel:                     "deepseek-v4-flash",
		DeepProviderKind:              "",
		DeepModel:                     "claude-3-5-sonnet-latest",
		AnthropicVersion:              "2023-06-01",
		StripeWebhookSecret:           "",
		StripeSecretKey:               "",
		StripePriceID:                 "",
		DeepProviderBaseURL:           "",
		DeepProviderAPIKey:            "",
		FastProviderAPIKey:            "",
		AWSRegion:                     "",
		AWSAccessKeyID:                "",
		AWSSecretAccessKey:            "",
		S3Bucket:                      "",
		S3UseAccelerate:               false,
		S3DocumentPrefix:              "documents",
		DocumentMaxBytes:              30 * 1024 * 1024,
		DocumentTextLimit:             60_000,
		DocumentTTLHours:              168,
		DocumentReaperIntervalMinutes: 60,
		DocumentReaperBatchSize:       100,
		AgentRunTTLHours:              168,
		TavilyAPIKey:                  "",
		TavilyBaseURL:                 "https://api.tavily.com",
		TavilySearchCredits:           20,
		ToolGatewayTimeout:            15 * time.Second,
		WebToolLoopMaxSteps:           5,
		AgentSpendRateLimitPerMinute:  120,

		E2BAPIKey:                       "",
		E2BBaseURL:                      "https://api.e2b.dev",
		E2BTemplateID:                   "code-interpreter-v1",
		E2BSandboxIdleTTLSeconds:        900,
		E2BSandboxMaxLifetimeSeconds:    3600,
		E2BCodeExecBaseCredits:          5,
		E2BCodeExecPerSecondCredits:     1,
		E2BSandboxRequestTimeoutSeconds: 60,
	}
}

func Load() Config {
	cfg := Default()
	cfg.Environment = getEnv("SHEJANE_ENV", getEnv("APP_ENV", cfg.Environment))
	cfg.HTTPAddr = getEnv("HTTP_ADDR", cfg.HTTPAddr)
	cfg.AppBaseURL = getEnv("APP_BASE_URL", cfg.AppBaseURL)
	cfg.ClientBaseURL = getEnv("CLIENT_BASE_URL", cfg.ClientBaseURL)
	cfg.AdminBaseURL = getEnv("ADMIN_BASE_URL", cfg.AdminBaseURL)
	cfg.JWTSecret = getEnv("JWT_SECRET", cfg.JWTSecret)
	cfg.ResendAPIKey = getEnv("RESEND_API_KEY", cfg.ResendAPIKey)
	cfg.MailFromAddress = getEnv("MAIL_FROM_ADDRESS", cfg.MailFromAddress)
	cfg.MailFromName = getEnv("MAIL_FROM_NAME", cfg.MailFromName)
	cfg.CookieSecure = getEnvBool("COOKIE_SECURE", cfg.CookieSecure)
	cfg.DatabaseURL = getEnv("DATABASE_URL", cfg.DatabaseURL)
	cfg.AdminEmails = getEnvList("ADMIN_EMAILS", cfg.AdminEmails)
	cfg.MonthlyCredits = getEnvInt64("MONTHLY_CREDITS", cfg.MonthlyCredits)
	cfg.SignupCredits = getEnvInt64("SIGNUP_CREDITS", cfg.SignupCredits)
	cfg.MockLLM = getEnvBool("MOCK_LLM", cfg.MockLLM)
	cfg.ConfigEncryptionKey = getEnv("CONFIG_ENCRYPTION_KEY", cfg.ConfigEncryptionKey)
	cfg.SentryDSN = getEnv("SENTRY_DSN", cfg.SentryDSN)
	cfg.SentryEnvironment = getEnv("SENTRY_ENVIRONMENT", cfg.SentryEnvironment)
	cfg.SentryTracesSampleRate = getEnvFloat("SENTRY_TRACES_SAMPLE_RATE", cfg.SentryTracesSampleRate)
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
	cfg.S3UseAccelerate = getEnvBool("S3_USE_ACCELERATE", cfg.S3UseAccelerate)
	cfg.S3DocumentPrefix = getEnv("S3_DOCUMENT_PREFIX", cfg.S3DocumentPrefix)
	cfg.DocumentMaxBytes = getEnvInt64("DOCUMENT_MAX_BYTES", cfg.DocumentMaxBytes)
	cfg.DocumentTextLimit = getEnvInt("DOCUMENT_TEXT_LIMIT", cfg.DocumentTextLimit)
	cfg.DocumentTTLHours = getEnvInt("DOCUMENT_TTL_HOURS", cfg.DocumentTTLHours)
	cfg.DocumentReaperIntervalMinutes = getEnvInt("DOCUMENT_REAPER_INTERVAL_MINUTES", cfg.DocumentReaperIntervalMinutes)
	cfg.DocumentReaperBatchSize = getEnvInt("DOCUMENT_REAPER_BATCH_SIZE", cfg.DocumentReaperBatchSize)
	cfg.AgentRunTTLHours = getEnvInt("AGENT_RUN_TTL_HOURS", cfg.AgentRunTTLHours)
	cfg.AgentSpendRateLimitPerMinute = getEnvInt("AGENT_SPEND_RATE_LIMIT_PER_MINUTE", cfg.AgentSpendRateLimitPerMinute)
	cfg.TavilyAPIKey = getEnv("TAVILY_API_KEY", cfg.TavilyAPIKey)
	cfg.TavilyBaseURL = getEnv("TAVILY_BASE_URL", cfg.TavilyBaseURL)
	cfg.TavilySearchCredits = getEnvInt64("TAVILY_SEARCH_CREDITS", cfg.TavilySearchCredits)
	cfg.ToolGatewayTimeout = time.Duration(getEnvInt("TOOL_GATEWAY_TIMEOUT_MS", int(cfg.ToolGatewayTimeout/time.Millisecond))) * time.Millisecond
	cfg.WebToolLoopMaxSteps = clampInt(getEnvInt("WEB_TOOL_LOOP_MAX_STEPS", cfg.WebToolLoopMaxSteps), 1, 50)
	cfg.E2BAPIKey = getEnv("E2B_API_KEY", cfg.E2BAPIKey)
	cfg.E2BBaseURL = getEnv("E2B_BASE_URL", cfg.E2BBaseURL)
	cfg.E2BTemplateID = getEnv("E2B_TEMPLATE_ID", cfg.E2BTemplateID)
	cfg.E2BSandboxIdleTTLSeconds = getEnvInt("E2B_SANDBOX_IDLE_TTL_SECONDS", cfg.E2BSandboxIdleTTLSeconds)
	cfg.E2BSandboxMaxLifetimeSeconds = getEnvInt("E2B_SANDBOX_MAX_LIFETIME_SECONDS", cfg.E2BSandboxMaxLifetimeSeconds)
	cfg.E2BCodeExecBaseCredits = getEnvInt64("E2B_CODE_EXEC_BASE_CREDITS", cfg.E2BCodeExecBaseCredits)
	cfg.E2BCodeExecPerSecondCredits = getEnvInt64("E2B_CODE_EXEC_PER_SECOND_CREDITS", cfg.E2BCodeExecPerSecondCredits)
	cfg.E2BSandboxRequestTimeoutSeconds = getEnvInt("E2B_SANDBOX_REQUEST_TIMEOUT_SECONDS", cfg.E2BSandboxRequestTimeoutSeconds)
	return cfg
}

func LoadStrict() (Config, error) {
	cfg := Load()
	if err := cfg.Validate(); err != nil {
		return cfg, err
	}
	return cfg, nil
}

func (c Config) Validate() error {
	if !c.IsProduction() {
		return nil
	}

	var problems []string
	if weakSecret(c.JWTSecret) {
		problems = append(problems, "JWT_SECRET must be set to a strong non-placeholder value in production")
	}
	if weakSecret(c.ConfigEncryptionKey) {
		problems = append(problems, "CONFIG_ENCRYPTION_KEY must be set to a strong non-placeholder value in production")
	}
	if len(problems) == 0 {
		return nil
	}
	return fmt.Errorf("invalid production config: %s", strings.Join(problems, "; "))
}

func (c Config) IsProduction() bool {
	env := strings.ToLower(strings.TrimSpace(c.Environment))
	return env == "production" || env == "prod"
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

func weakSecret(value string) bool {
	normalized := strings.ToLower(strings.TrimSpace(value))
	if len(normalized) < 32 {
		return true
	}
	switch normalized {
	case "dev-change-me",
		"local-development-jwt-secret-change-me",
		"replace-with-a-long-random-secret",
		"change-me",
		"changeme",
		"secret",
		"test-secret",
		"shejane",
		"password":
		return true
	}
	return false
}

func getEnv(key string, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func getEnvFloat(key string, fallback float64) float64 {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseFloat(value, 64)
	if err != nil {
		return fallback
	}
	return parsed
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

func clampInt(value int, min int, max int) int {
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
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
