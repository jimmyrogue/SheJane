package store

import (
	"context"
	"testing"
	"time"

	"github.com/coldflame/shejane/api/internal/billing"
)

// seedSubscribedWallet creates a wallet with an active subscription grant plus
// some pay-as-you-go extra credits, and returns the wallet id.
func seedSubscribedWallet(t *testing.T, s *MemoryStore, userID string, monthlyLimit int64, extra int64, subscriptionID string) string {
	t.Helper()
	ctx := context.Background()
	wallet, err := s.EnsureWallet(ctx, userID, 0)
	if err != nil {
		t.Fatalf("EnsureWallet: %v", err)
	}
	wallet.ApplySubscriptionGrant(monthlyLimit, subscriptionID, time.Time{}, "stripe:evt_seed_"+userID)
	if extra > 0 {
		if err := wallet.AdjustExtraCredits(extra, "seed extra", "seed_extra_"+userID); err != nil {
			t.Fatalf("AdjustExtraCredits: %v", err)
		}
	}
	return wallet.ID
}

func countTxByType(wallet *billing.Wallet, txType string) (count int, lastAmount int64) {
	for _, tx := range wallet.Transactions() {
		if tx.Type == txType {
			count++
			lastAmount = tx.Amount
		}
	}
	return count, lastAmount
}

func TestRevokeSubscriptionCreditsClawsBackMonthlyKeepsExtra(t *testing.T) {
	s := NewMemoryStore()
	ctx := context.Background()
	seedSubscribedWallet(t, s, "user-revoke", 9000, 1500, "sub_revoke_1")

	// Consume part of the monthly allotment so we can confirm only the UNUSED
	// portion (9000-2000 = 7000) is clawed back in the ledger entry.
	wallet, _ := s.WalletByUser(ctx, "user-revoke")
	if _, err := wallet.Reserve(2000, billing.ReservationMeta{RequestID: "req-1"}); err != nil {
		t.Fatalf("Reserve: %v", err)
	}

	if err := s.RevokeSubscriptionCredits(ctx, "sub_revoke_1", "evt_cancel_1"); err != nil {
		t.Fatalf("RevokeSubscriptionCredits: %v", err)
	}

	snap := wallet.Snapshot()
	if snap.Status != "canceled" {
		t.Errorf("status = %q, want canceled", snap.Status)
	}
	if snap.PlanCode != "free_trial" {
		t.Errorf("plan = %q, want free_trial", snap.PlanCode)
	}
	if snap.MonthlyCreditLimit != 0 || snap.MonthlyCreditsUsed != 0 {
		t.Errorf("monthly = %d/%d, want 0/0", snap.MonthlyCreditLimit, snap.MonthlyCreditsUsed)
	}
	if snap.ExtraCreditsBalance != 1500 {
		t.Errorf("extra = %d, want 1500 (pay-as-you-go kept)", snap.ExtraCreditsBalance)
	}
	count, amount := countTxByType(wallet, "subscription_revoke")
	if count != 1 {
		t.Errorf("subscription_revoke ledger entries = %d, want 1", count)
	}
	if amount != -7000 {
		t.Errorf("revoke ledger amount = %d, want -7000 (unused monthly only)", amount)
	}
}

func TestRevokeSubscriptionCreditsIsIdempotent(t *testing.T) {
	s := NewMemoryStore()
	ctx := context.Background()
	seedSubscribedWallet(t, s, "user-idem", 9000, 0, "sub_idem_1")

	for i := 0; i < 3; i++ {
		if err := s.RevokeSubscriptionCredits(ctx, "sub_idem_1", "evt_cancel_same"); err != nil {
			t.Fatalf("RevokeSubscriptionCredits #%d: %v", i, err)
		}
	}
	wallet, _ := s.WalletByUser(ctx, "user-idem")
	if count, _ := countTxByType(wallet, "subscription_revoke"); count != 1 {
		t.Fatalf("subscription_revoke entries after 3 identical events = %d, want 1", count)
	}
}

func TestMarkSubscriptionPaidIsIdempotentAtLedger(t *testing.T) {
	s := NewMemoryStore()
	ctx := context.Background()
	wallet, err := s.EnsureWallet(ctx, "user-paid", 0)
	if err != nil {
		t.Fatalf("EnsureWallet: %v", err)
	}
	if _, err := s.CreatePaymentOrder(ctx, PaymentOrder{
		WalletID:        wallet.ID,
		Type:            "subscription",
		StripeSessionID: "cs_paid_1",
		Status:          "pending",
	}); err != nil {
		t.Fatalf("CreatePaymentOrder: %v", err)
	}

	// The same checkout event delivered twice (a retry after the processed
	// flag failed to persist) must grant credits exactly once.
	for i := 0; i < 2; i++ {
		if err := s.MarkSubscriptionPaid(ctx, "cs_paid_1", "sub_paid_1", "evt_paid_same", 9000, time.Time{}); err != nil {
			t.Fatalf("MarkSubscriptionPaid #%d: %v", i, err)
		}
	}

	w, _ := s.WalletByUser(ctx, "user-paid")
	if count, _ := countTxByType(w, "subscription_grant"); count != 1 {
		t.Fatalf("subscription_grant entries after duplicate event = %d, want 1", count)
	}
	if snap := w.Snapshot(); snap.MonthlyCreditLimit != 9000 {
		t.Fatalf("monthly limit = %d, want 9000 (single grant)", snap.MonthlyCreditLimit)
	}
}

func TestApplyBillingTopUpIsIdempotentAtLedger(t *testing.T) {
	s := NewMemoryStore()
	ctx := context.Background()
	user, err := s.CreateUser(ctx, "topup@example.com", "hash", "Top Up")
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	wallet, err := s.EnsureWallet(ctx, user.ID, 0)
	if err != nil {
		t.Fatalf("EnsureWallet: %v", err)
	}
	startingExtra := wallet.Snapshot().ExtraCreditsBalance
	tx, err := s.CreateBillingTopUp(ctx, BillingTransaction{
		UserID:          user.ID,
		StripeSessionID: "cs_topup_1",
		Amount:          10,
		Currency:        "usd",
		Credits:         500_000,
		Status:          "pending",
	})
	if err != nil {
		t.Fatalf("CreateBillingTopUp: %v", err)
	}
	if tx.ID == "" {
		t.Fatal("CreateBillingTopUp returned empty id")
	}

	for i := 0; i < 3; i++ {
		if err := s.ApplyBillingTopUp(ctx, BillingTopUpCompletion{
			UserID:                user.ID,
			StripeSessionID:       "cs_topup_1",
			StripePaymentIntentID: "pi_topup_1",
			Amount:                10,
			Currency:              "usd",
			Credits:               500_000,
			RawEventID:            "evt_topup_same",
		}); err != nil {
			t.Fatalf("ApplyBillingTopUp #%d: %v", i, err)
		}
	}

	w, err := s.WalletByUser(ctx, user.ID)
	if err != nil {
		t.Fatalf("WalletByUser: %v", err)
	}
	if got := w.Snapshot().ExtraCreditsBalance; got != startingExtra+500_000 {
		t.Fatalf("extra credits = %d, want %d", got, startingExtra+500_000)
	}
	if count, _ := countTxByType(w, "recharge_grant"); count != 1 {
		t.Fatalf("recharge_grant entries after duplicate events = %d, want 1", count)
	}
}
