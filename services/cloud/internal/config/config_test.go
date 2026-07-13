package config

import (
	"strings"
	"testing"
)

func TestLoadProviderKinds(t *testing.T) {
	t.Setenv("FAST_PROVIDER_KIND", "openai-compatible")
	t.Setenv("DEEP_PROVIDER_KIND", "deepseek-v4")

	cfg := Load()

	if cfg.FastProviderKind != "openai-compatible" {
		t.Fatalf("FastProviderKind = %q, want openai-compatible", cfg.FastProviderKind)
	}
	if cfg.DeepProviderKind != "deepseek-v4" {
		t.Fatalf("DeepProviderKind = %q, want deepseek-v4", cfg.DeepProviderKind)
	}
}

func TestLoadWebToolLoopMaxSteps(t *testing.T) {
	t.Setenv("WEB_TOOL_LOOP_MAX_STEPS", "9")

	cfg := Load()

	if cfg.WebToolLoopMaxSteps != 9 {
		t.Fatalf("WebToolLoopMaxSteps = %d, want 9", cfg.WebToolLoopMaxSteps)
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
