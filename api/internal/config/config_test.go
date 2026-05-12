package config

import "testing"

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
