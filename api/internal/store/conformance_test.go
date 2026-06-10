package store

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"testing"
	"time"
)

// Cross-implementation conformance: the SAME assertions run against both Store
// implementations so memory.go and postgres.go can't silently diverge (the #1
// bug class in CLAUDE.md — "memory test green, postgres path drifts").
//
// Memory always runs. Postgres runs when TEST_DATABASE_URL points at a
// MIGRATED database (e.g. the dev compose DB after `make migrate`); otherwise
// it's skipped so `go test ./...` stays green without a DB. CI can spin
// Postgres, run migrate, set TEST_DATABASE_URL, and get the full cross-check.

type storeFactory struct {
	name string
	// newStore returns a CLEAN store for one subtest.
	newStore func(t *testing.T) Store
}

func conformanceFactories(t *testing.T) []storeFactory {
	factories := []storeFactory{
		{name: "memory", newStore: func(*testing.T) Store { return NewMemoryStore() }},
	}
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Log("TEST_DATABASE_URL unset — postgres conformance skipped (memory only). " +
			"Point it at a migrated DB to cross-check the two implementations.")
		return factories
	}
	pg, err := NewPostgresStore(context.Background(), dsn)
	if err != nil {
		t.Fatalf("connect TEST_DATABASE_URL: %v", err)
	}
	factories = append(factories, storeFactory{
		name: "postgres",
		newStore: func(t *testing.T) Store {
			truncateAllTables(t, pg.db)
			return pg
		},
	})
	return factories
}

func truncateAllTables(t *testing.T, db *sql.DB) {
	t.Helper()
	_, err := db.Exec(`TRUNCATE users, wallets, refresh_tokens, password_reset_tokens,
		email_verification_tokens, payment_orders, wallet_transactions, stripe_events,
		audit_logs, usage_reservations, agent_runs, agent_events, documents,
		llm_call_records, external_tool_call_records, sandbox_sessions
		RESTART IDENTITY CASCADE`)
	if err != nil {
		t.Fatalf("truncate: %v", err)
	}
}

func TestStoreConformance(t *testing.T) {
	for _, f := range conformanceFactories(t) {
		f := f
		t.Run(f.name, func(t *testing.T) {
			t.Run("user lifecycle", func(t *testing.T) { conformUserLifecycle(t, f.newStore(t)) })
			t.Run("refresh token single use", func(t *testing.T) { conformRefreshToken(t, f.newStore(t)) })
			t.Run("password reset", func(t *testing.T) { conformPasswordReset(t, f.newStore(t)) })
			t.Run("email verification", func(t *testing.T) { conformEmailVerification(t, f.newStore(t)) })
			t.Run("signup credits idempotent", func(t *testing.T) { conformSignupCredits(t, f.newStore(t)) })
			t.Run("subscription lifecycle", func(t *testing.T) { conformSubscription(t, f.newStore(t)) })
			t.Run("model catalog fields", func(t *testing.T) { conformModelCatalog(t, f.newStore(t)) })
		})
	}
}

// conformModelCatalog locks the flat-catalog columns (description, priority)
// round-tripping identically through both store impls — the dual-impl drift
// guard for the model-catalog refactor.
func conformModelCatalog(t *testing.T, s Store) {
	ctx := context.Background()
	saved, err := s.UpsertModelConfig(ctx, "", ModelConfig{
		Slot:             "chat.deepseek-v4",
		Capability:       "chat",
		ProviderKind:     "deepseek-v4",
		DisplayName:      "DeepSeek V4",
		Description:      "通用快速模型",
		ModelName:        "deepseek-v4",
		CreditMultiplier: 1,
		Priority:         50,
		Enabled:          true,
	})
	if err != nil {
		t.Fatalf("UpsertModelConfig: %v", err)
	}
	if saved.Description != "通用快速模型" || saved.Priority != 50 {
		t.Fatalf("upsert returned description=%q priority=%d, want 通用快速模型/50", saved.Description, saved.Priority)
	}

	got, err := s.GetModelConfig(ctx, saved.ID)
	if err != nil {
		t.Fatalf("GetModelConfig: %v", err)
	}
	if got.Description != "通用快速模型" || got.Priority != 50 {
		t.Fatalf("get returned description=%q priority=%d, want 通用快速模型/50", got.Description, got.Priority)
	}

	// Update priority/description and confirm persistence.
	got.Priority = 10
	got.Description = "降级"
	if _, err := s.UpsertModelConfig(ctx, "", got); err != nil {
		t.Fatalf("UpsertModelConfig (update): %v", err)
	}
	reloaded, err := s.GetModelConfig(ctx, saved.ID)
	if err != nil {
		t.Fatalf("GetModelConfig (reload): %v", err)
	}
	if reloaded.Priority != 10 || reloaded.Description != "降级" {
		t.Fatalf("reloaded description=%q priority=%d, want 降级/10", reloaded.Description, reloaded.Priority)
	}

	list, err := s.ListModelConfigs(ctx, "chat")
	if err != nil || len(list) == 0 {
		t.Fatalf("ListModelConfigs: %v (len=%d)", err, len(list))
	}
}

func mustUser(t *testing.T, s Store, email string) User {
	t.Helper()
	u, err := s.CreateUser(context.Background(), email, "hash-"+email, "Name")
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	return u
}

func conformUserLifecycle(t *testing.T, s Store) {
	ctx := context.Background()
	u := mustUser(t, s, "alice@example.com")
	if u.EmailVerified {
		t.Error("new user should start unverified")
	}
	if u.Role != "user" || u.Status != "active" {
		t.Errorf("unexpected defaults: role=%q status=%q", u.Role, u.Status)
	}

	if byEmail, err := s.UserByEmail(ctx, "ALICE@example.com"); err != nil || byEmail.ID != u.ID {
		t.Errorf("UserByEmail (case-insensitive) = %+v, %v", byEmail, err)
	}
	if byID, err := s.UserByID(ctx, u.ID); err != nil || byID.Email != "alice@example.com" {
		t.Errorf("UserByID = %+v, %v", byID, err)
	}

	if _, err := s.CreateUser(ctx, "alice@example.com", "h", "n"); !errors.Is(err, ErrAlreadyExists) {
		t.Errorf("duplicate email error = %v, want ErrAlreadyExists", err)
	}

	promoted, err := s.UpdateUserRole(ctx, u.ID, "admin")
	if err != nil || promoted.Role != "admin" {
		t.Errorf("UpdateUserRole = %+v, %v", promoted, err)
	}
	if reloaded, _ := s.UserByID(ctx, u.ID); reloaded.Role != "admin" {
		t.Errorf("role not persisted: %q", reloaded.Role)
	}

	if _, err := s.UserByID(ctx, "00000000-0000-0000-0000-000000000000"); !errors.Is(err, ErrNotFound) {
		t.Errorf("missing user error = %v, want ErrNotFound", err)
	}
}

func conformRefreshToken(t *testing.T, s Store) {
	ctx := context.Background()
	u := mustUser(t, s, "refresh@example.com")
	future := time.Now().Add(time.Hour)

	if err := s.SaveRefreshToken(ctx, "tok-1", u.ID, future); err != nil {
		t.Fatalf("SaveRefreshToken: %v", err)
	}
	got, err := s.UseRefreshToken(ctx, "tok-1")
	if err != nil || got.ID != u.ID {
		t.Fatalf("UseRefreshToken = %+v, %v", got, err)
	}
	if _, err := s.UseRefreshToken(ctx, "tok-1"); !errors.Is(err, ErrNotFound) {
		t.Errorf("reused refresh token error = %v, want ErrNotFound (single-use)", err)
	}

	if err := s.SaveRefreshToken(ctx, "tok-2", u.ID, future); err != nil {
		t.Fatalf("SaveRefreshToken 2: %v", err)
	}
	if err := s.RevokeRefreshToken(ctx, "tok-2"); err != nil {
		t.Fatalf("RevokeRefreshToken: %v", err)
	}
	if _, err := s.UseRefreshToken(ctx, "tok-2"); !errors.Is(err, ErrNotFound) {
		t.Errorf("revoked refresh token error = %v, want ErrNotFound", err)
	}

	if _, err := s.UseRefreshToken(ctx, "expired"); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown refresh token error = %v, want ErrNotFound", err)
	}
}

func conformPasswordReset(t *testing.T, s Store) {
	ctx := context.Background()
	u := mustUser(t, s, "reset@example.com")
	// A live session that must be revoked when the password is reset.
	if err := s.SaveRefreshToken(ctx, "sess-1", u.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("SaveRefreshToken: %v", err)
	}
	if err := s.SavePasswordResetToken(ctx, "reset-1", u.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("SavePasswordResetToken: %v", err)
	}

	uid, err := s.ResetPasswordWithToken(ctx, "reset-1", "new-hash")
	if err != nil || uid != u.ID {
		t.Fatalf("ResetPasswordWithToken = %q, %v", uid, err)
	}
	if reloaded, _ := s.UserByID(ctx, u.ID); reloaded.PasswordHash != "new-hash" {
		t.Errorf("password not updated: %q", reloaded.PasswordHash)
	}
	// Reset must revoke all of the user's refresh tokens.
	if _, err := s.UseRefreshToken(ctx, "sess-1"); !errors.Is(err, ErrNotFound) {
		t.Errorf("session after reset = %v, want revoked (ErrNotFound)", err)
	}
	// Single-use.
	if _, err := s.ResetPasswordWithToken(ctx, "reset-1", "other"); !errors.Is(err, ErrNotFound) {
		t.Errorf("reused reset token = %v, want ErrNotFound", err)
	}
	// Expired token is rejected.
	if err := s.SavePasswordResetToken(ctx, "reset-expired", u.ID, time.Now().Add(-time.Minute)); err != nil {
		t.Fatalf("save expired: %v", err)
	}
	if _, err := s.ResetPasswordWithToken(ctx, "reset-expired", "x"); !errors.Is(err, ErrNotFound) {
		t.Errorf("expired reset token = %v, want ErrNotFound", err)
	}
}

func conformEmailVerification(t *testing.T, s Store) {
	ctx := context.Background()
	u := mustUser(t, s, "verify@example.com")
	if err := s.SaveEmailVerificationToken(ctx, "verify-1", u.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("SaveEmailVerificationToken: %v", err)
	}
	uid, err := s.VerifyEmailWithToken(ctx, "verify-1")
	if err != nil || uid != u.ID {
		t.Fatalf("VerifyEmailWithToken = %q, %v", uid, err)
	}
	if reloaded, _ := s.UserByID(ctx, u.ID); !reloaded.EmailVerified {
		t.Error("email_verified not set after confirm")
	}
	if _, err := s.VerifyEmailWithToken(ctx, "verify-1"); !errors.Is(err, ErrNotFound) {
		t.Errorf("reused verify token = %v, want ErrNotFound (single-use)", err)
	}
}

func conformSignupCredits(t *testing.T, s Store) {
	ctx := context.Background()
	u := mustUser(t, s, "wallet@example.com")
	if _, err := s.EnsureWallet(ctx, u.ID, 0); err != nil {
		t.Fatalf("EnsureWallet: %v", err)
	}
	// Granting twice must be idempotent (one bag of credits, not two).
	if err := s.GrantSignupCredits(ctx, u.ID, 500); err != nil {
		t.Fatalf("GrantSignupCredits: %v", err)
	}
	if err := s.GrantSignupCredits(ctx, u.ID, 500); err != nil {
		t.Fatalf("GrantSignupCredits 2: %v", err)
	}
	wallet, err := s.WalletByUser(ctx, u.ID)
	if err != nil {
		t.Fatalf("WalletByUser: %v", err)
	}
	if got := wallet.Snapshot().ExtraCreditsBalance; got != 500 {
		t.Errorf("extra credits after double grant = %d, want 500 (idempotent)", got)
	}
}

func conformSubscription(t *testing.T, s Store) {
	ctx := context.Background()
	u := mustUser(t, s, "sub@example.com")
	wallet, err := s.EnsureWallet(ctx, u.ID, 0)
	if err != nil {
		t.Fatalf("EnsureWallet: %v", err)
	}
	if err := s.GrantSignupCredits(ctx, u.ID, 1500); err != nil {
		t.Fatalf("GrantSignupCredits: %v", err)
	}
	if _, err := s.CreatePaymentOrder(ctx, PaymentOrder{
		WalletID:        wallet.ID,
		Type:            "subscription",
		StripeSessionID: "cs_conf",
		Status:          "pending",
	}); err != nil {
		t.Fatalf("CreatePaymentOrder: %v", err)
	}

	// Paid grants the monthly allotment; replaying the same event is idempotent.
	for i := 0; i < 2; i++ {
		if err := s.MarkSubscriptionPaid(ctx, "cs_conf", "sub_conf", "evt_paid", 9000, time.Time{}); err != nil {
			t.Fatalf("MarkSubscriptionPaid #%d: %v", i, err)
		}
	}
	w, _ := s.WalletByUser(ctx, u.ID)
	snap := w.Snapshot()
	if snap.MonthlyCreditLimit != 9000 {
		t.Errorf("monthly limit after paid = %d, want 9000", snap.MonthlyCreditLimit)
	}
	// Use WalletTransactions (the cross-impl ledger accessor) — wallet.Transactions()
	// is only hydrated on the memory store.
	txs, err := s.WalletTransactions(ctx, u.ID)
	if err != nil {
		t.Fatalf("WalletTransactions: %v", err)
	}
	grants := 0
	for _, tx := range txs {
		if tx.Type == "subscription_grant" {
			grants++
		}
	}
	if grants != 1 {
		t.Errorf("subscription_grant entries = %d, want 1 (idempotent)", grants)
	}

	// Revoke claws back monthly but keeps the pay-as-you-go extra credits.
	if err := s.RevokeSubscriptionCredits(ctx, "sub_conf", "evt_revoke"); err != nil {
		t.Fatalf("RevokeSubscriptionCredits: %v", err)
	}
	w2, _ := s.WalletByUser(ctx, u.ID)
	snap2 := w2.Snapshot()
	if snap2.MonthlyCreditLimit != 0 || snap2.MonthlyCreditsUsed != 0 {
		t.Errorf("monthly after revoke = %d/%d, want 0/0", snap2.MonthlyCreditLimit, snap2.MonthlyCreditsUsed)
	}
	if snap2.ExtraCreditsBalance != 1500 {
		t.Errorf("extra after revoke = %d, want 1500 (kept)", snap2.ExtraCreditsBalance)
	}
	if snap2.Status != "canceled" {
		t.Errorf("status after revoke = %q, want canceled", snap2.Status)
	}
}
