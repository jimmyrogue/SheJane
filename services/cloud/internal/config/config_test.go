package config

import (
	"strings"
	"testing"
)

func TestLoadIgnoresModelAndTuningEnvironment(t *testing.T) {
	t.Setenv("FAST_PROVIDER_API_KEY", "must-not-load")
	t.Setenv("MONTHLY_CREDITS", "999")
	t.Setenv("WEB_TOOL_LOOP_MAX_STEPS", "9")

	cfg := Load()

	if cfg.MonthlyCredits != 0 {
		t.Fatalf("MonthlyCredits = %d, want code default 0", cfg.MonthlyCredits)
	}
	if cfg.WebToolLoopMaxSteps != Default().WebToolLoopMaxSteps {
		t.Fatalf("WebToolLoopMaxSteps = %d, want code default %d", cfg.WebToolLoopMaxSteps, Default().WebToolLoopMaxSteps)
	}
}

func TestLoadReadsExternalServiceConfiguration(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://cloud")
	t.Setenv("TAVILY_API_KEY", "tavily-key")
	t.Setenv("E2B_BASE_URL", "https://e2b.example.com")

	cfg := Load()

	if cfg.DatabaseURL != "postgres://cloud" || cfg.TavilyAPIKey != "tavily-key" || cfg.E2BBaseURL != "https://e2b.example.com" {
		t.Fatalf("external service configuration was not loaded: %+v", cfg)
	}
}

func TestLoadStrictRejectsProductionWeakSecrets(t *testing.T) {
	t.Setenv("SHEJANE_ENV", "production")
	t.Setenv("JWT_SECRET", "replace-with-a-long-random-secret")
	t.Setenv("CONFIG_ENCRYPTION_KEY", "")

	_, err := LoadStrict()
	if err == nil {
		t.Fatal("LoadStrict() error = nil, want production secret validation error")
	}
	message := err.Error()
	for _, field := range []string{"JWT_SECRET", "CONFIG_ENCRYPTION_KEY"} {
		if !strings.Contains(message, field) {
			t.Fatalf("LoadStrict() error = %q, want it to mention %s", message, field)
		}
	}
}

func TestLoadStrictAllowsDevelopmentDefaults(t *testing.T) {
	t.Setenv("SHEJANE_ENV", "development")

	cfg, err := LoadStrict()
	if err != nil {
		t.Fatalf("LoadStrict() error = %v, want nil in development", err)
	}
	if cfg.Environment != "development" {
		t.Fatalf("Environment = %q, want development", cfg.Environment)
	}
}

func TestLoadStrictAcceptsProductionStrongSecrets(t *testing.T) {
	t.Setenv("SHEJANE_ENV", "production")
	t.Setenv("JWT_SECRET", "prod-jwt-secret-0123456789abcdef0123456789")
	t.Setenv("CONFIG_ENCRYPTION_KEY", "prod-config-key-0123456789abcdef012345")

	cfg, err := LoadStrict()
	if err != nil {
		t.Fatalf("LoadStrict() error = %v, want nil", err)
	}
	if cfg.Environment != "production" {
		t.Fatalf("Environment = %q, want production", cfg.Environment)
	}
}
