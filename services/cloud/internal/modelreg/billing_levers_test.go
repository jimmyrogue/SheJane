package modelreg

import (
	"context"
	"testing"

	"github.com/coldflame/shejane/api/internal/config"
	"github.com/coldflame/shejane/api/internal/store"
)

func leverCfg() config.Config {
	cfg := config.Default()
	// Pin the lever defaults so assertions don't depend on config.Default().
	cfg.TavilySearchCredits = 20
	cfg.E2BCodeExecBaseCredits = 5
	cfg.E2BCodeExecPerSecondCredits = 1
	return cfg
}

func TestBillingLeversDefaultWhenAbsent(t *testing.T) {
	reg := New(store.NewMemoryStore(), leverCfg())
	// No billing.levers row → each getter falls back to the env/coded default.
	if got := reg.TavilySearchCredits(); got != 20 {
		t.Fatalf("tavily default = %d, want 20", got)
	}
	if got := reg.E2BCodeExecBaseCredits(); got != 5 {
		t.Fatalf("e2b base default = %d, want 5", got)
	}
	if got := reg.E2BCodeExecPerSecondCredits(); got != 1 {
		t.Fatalf("e2b per-second default = %d, want 1", got)
	}
}

func TestBillingLeversOverrideAfterInvalidate(t *testing.T) {
	st := store.NewMemoryStore()
	reg := New(st, leverCfg())
	if _, err := st.SetAppSetting(context.Background(), "admin", BillingLeversKey,
		`{"tavily_search_credits":7,"e2b_code_exec_base_credits":8,"e2b_code_exec_per_second_credits":9}`); err != nil {
		t.Fatalf("set setting: %v", err)
	}
	reg.Invalidate()
	if got := reg.TavilySearchCredits(); got != 7 {
		t.Fatalf("tavily override = %d, want 7", got)
	}
	if got := reg.E2BCodeExecBaseCredits(); got != 8 {
		t.Fatalf("e2b base override = %d, want 8", got)
	}
	if got := reg.E2BCodeExecPerSecondCredits(); got != 9 {
		t.Fatalf("e2b per-second override = %d, want 9", got)
	}
}

func TestBillingLeversZeroFieldFallsBackToDefault(t *testing.T) {
	st := store.NewMemoryStore()
	reg := New(st, leverCfg())
	// A stored/absent 0 must NOT make a paid tool free — it falls back per-field.
	if _, err := st.SetAppSetting(context.Background(), "admin", BillingLeversKey,
		`{"tavily_search_credits":0,"e2b_code_exec_base_credits":50,"e2b_code_exec_per_second_credits":0}`); err != nil {
		t.Fatalf("set setting: %v", err)
	}
	reg.Invalidate()
	if got := reg.TavilySearchCredits(); got != 20 {
		t.Fatalf("tavily zero → fallback = %d, want 20", got)
	}
	if got := reg.E2BCodeExecBaseCredits(); got != 50 {
		t.Fatalf("e2b base override = %d, want 50", got)
	}
	if got := reg.E2BCodeExecPerSecondCredits(); got != 1 {
		t.Fatalf("e2b per-second zero → fallback = %d, want 1", got)
	}
}

func TestEnsureSeedWritesBillingLevers(t *testing.T) {
	st := store.NewMemoryStore()
	reg := New(st, leverCfg())
	if err := reg.EnsureSeed(context.Background()); err != nil {
		t.Fatalf("EnsureSeed: %v", err)
	}
	if _, err := st.GetAppSetting(context.Background(), BillingLeversKey); err != nil {
		t.Fatalf("billing.levers row not seeded: %v", err)
	}
}
