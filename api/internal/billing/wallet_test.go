package billing

import "testing"

func TestWalletReserveSettleAndRelease(t *testing.T) {
	wallet := NewWallet("wallet-1", 1_000, 200)

	reservation, err := wallet.Reserve(700, ReservationMeta{
		UserID:               "user-1",
		RequestID:            "req-1",
		ClientConversationID: "conv-1",
		ClientMessageID:      "msg-1",
		Mode:                 "fast",
	})
	if err != nil {
		t.Fatalf("reserve returned error: %v", err)
	}

	if wallet.MonthlyRemaining() != 300 {
		t.Fatalf("monthly remaining = %d, want 300", wallet.MonthlyRemaining())
	}
	if reservation.MonthlyCredits != 700 || reservation.ExtraCredits != 0 {
		t.Fatalf("reservation split = monthly:%d extra:%d, want monthly:700 extra:0", reservation.MonthlyCredits, reservation.ExtraCredits)
	}

	if err := wallet.Settle(reservation.ID, 450); err != nil {
		t.Fatalf("settle returned error: %v", err)
	}
	if wallet.MonthlyRemaining() != 550 {
		t.Fatalf("monthly remaining after settle = %d, want 550", wallet.MonthlyRemaining())
	}

	second, err := wallet.Reserve(700, ReservationMeta{
		UserID:    "user-1",
		RequestID: "req-2",
		Mode:      "deep",
	})
	if err != nil {
		t.Fatalf("second reserve returned error: %v", err)
	}
	if second.MonthlyCredits != 550 || second.ExtraCredits != 150 {
		t.Fatalf("second reservation split = monthly:%d extra:%d, want monthly:550 extra:150", second.MonthlyCredits, second.ExtraCredits)
	}
	if wallet.ExtraCreditsBalance != 50 {
		t.Fatalf("extra balance = %d, want 50", wallet.ExtraCreditsBalance)
	}

	if err := wallet.Release(second.ID); err != nil {
		t.Fatalf("release returned error: %v", err)
	}
	if wallet.MonthlyRemaining() != 550 || wallet.ExtraCreditsBalance != 200 {
		t.Fatalf("wallet after release = monthly:%d extra:%d, want monthly:550 extra:200", wallet.MonthlyRemaining(), wallet.ExtraCreditsBalance)
	}
}

func TestWalletSettleOverageFailureIsReleasable(t *testing.T) {
	// Regression: when actual usage exceeds the reserved estimate AND the
	// overage exceeds the balance, Settle must fail but leave the
	// reservation Reserved (not Failed), so the caller can Release it and
	// recover the held estimate. Previously Settle marked it Failed, which
	// made Release a no-op and stranded the reserved credits.
	wallet := NewWallet("wallet-1", 1_000, 0)

	res, err := wallet.Reserve(600, ReservationMeta{UserID: "u", RequestID: "r", Mode: "fast"})
	if err != nil {
		t.Fatalf("reserve: %v", err)
	}
	if wallet.MonthlyRemaining() != 400 {
		t.Fatalf("after reserve remaining = %d, want 400", wallet.MonthlyRemaining())
	}

	// actual 1200 > estimate 600; overage 600 > remaining 400 → must fail.
	err = wallet.Settle(res.ID, 1200)
	if err == nil || !IsInsufficientCredits(err) {
		t.Fatalf("settle overage err = %v, want insufficient credits", err)
	}

	// The reservation must still be releasable, and release must restore
	// the full held estimate — no stranded credits.
	if err := wallet.Release(res.ID); err != nil {
		t.Fatalf("release after failed settle: %v", err)
	}
	if wallet.MonthlyRemaining() != 1_000 {
		t.Fatalf("after release remaining = %d, want 1000 (held estimate recovered)", wallet.MonthlyRemaining())
	}
}

func TestWalletRejectsInsufficientCredits(t *testing.T) {
	wallet := NewWallet("wallet-1", 100, 20)

	_, err := wallet.Reserve(121, ReservationMeta{
		UserID:    "user-1",
		RequestID: "req-1",
		Mode:      "fast",
	})
	if err == nil {
		t.Fatal("reserve returned nil error, want insufficient credits")
	}
	if !IsInsufficientCredits(err) {
		t.Fatalf("reserve error = %v, want insufficient credits", err)
	}
}
