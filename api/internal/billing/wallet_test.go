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
