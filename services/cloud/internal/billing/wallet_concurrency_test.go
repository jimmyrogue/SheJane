package billing

import (
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
)

// These tests are meaningful only under `go test -race` (make test-race),
// which previously had ZERO concurrent ledger coverage. They hammer one
// wallet from many goroutines and assert the money invariants hold:
// conservation, full restore on release, and no overselling.

// Reserve+Settle from many goroutines must conserve credits exactly: the
// total consumed (monthly used + extra spent) equals the sum of settled
// actuals — no credits invented or lost under contention.
func TestWalletConcurrentReserveSettleConservation(t *testing.T) {
	const (
		monthly = int64(1_000_000)
		extra   = int64(1_000_000)
		workers = 16
		iters   = 200
	)
	wallet := NewWallet("w", monthly, extra)
	var settledActual int64

	var wg sync.WaitGroup
	for g := 0; g < workers; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for i := 0; i < iters; i++ {
				est := int64(10 + (i % 40)) // 10..49, always > the refund delta below
				res, err := wallet.Reserve(est, ReservationMeta{RequestID: fmt.Sprintf("g%d-i%d", g, i)})
				if err != nil {
					continue // pool exhaustion is legitimate, not a leak
				}
				actual := est - int64(i%10) // in [est-9, est] → always the refund path
				if err := wallet.Settle(res.ID, actual); err != nil {
					t.Errorf("settle: %v", err)
					return
				}
				atomic.AddInt64(&settledActual, actual)
			}
		}(g)
	}
	wg.Wait()

	snap := wallet.Snapshot()
	if snap.MonthlyCreditsUsed < 0 || snap.ExtraCreditsBalance < 0 {
		t.Fatalf("negative balance: monthlyUsed=%d extra=%d", snap.MonthlyCreditsUsed, snap.ExtraCreditsBalance)
	}
	consumed := snap.MonthlyCreditsUsed + (extra - snap.ExtraCreditsBalance)
	if consumed != settledActual {
		t.Fatalf("conservation violated: consumed %d != settled actual %d", consumed, settledActual)
	}
}

// Reserve+Release must return the wallet to its starting state exactly.
func TestWalletConcurrentReserveReleaseRestoresPool(t *testing.T) {
	const (
		monthly = int64(500_000)
		extra   = int64(500_000)
		workers = 16
		iters   = 200
	)
	wallet := NewWallet("w", monthly, extra)

	var wg sync.WaitGroup
	for g := 0; g < workers; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for i := 0; i < iters; i++ {
				res, err := wallet.Reserve(50, ReservationMeta{RequestID: fmt.Sprintf("g%d-i%d", g, i)})
				if err != nil {
					continue
				}
				if err := wallet.Release(res.ID); err != nil {
					t.Errorf("release: %v", err)
					return
				}
			}
		}(g)
	}
	wg.Wait()

	snap := wallet.Snapshot()
	if snap.MonthlyCreditsUsed != 0 || snap.ExtraCreditsBalance != extra {
		t.Fatalf("pool not restored after release: monthlyUsed=%d extra=%d (want 0/%d)", snap.MonthlyCreditsUsed, snap.ExtraCreditsBalance, extra)
	}
}

// A small pool under heavy concurrent demand must never be oversold: the sum
// of granted reservations can't exceed the pool, and balances never go negative.
func TestWalletConcurrentReserveNeverOversells(t *testing.T) {
	const (
		monthly = int64(1_000)
		extra   = int64(0)
		workers = 32
		iters   = 100
		est     = int64(50)
	)
	wallet := NewWallet("w", monthly, extra)
	var granted int64

	var wg sync.WaitGroup
	for g := 0; g < workers; g++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < iters; i++ {
				if _, err := wallet.Reserve(est, ReservationMeta{RequestID: "r"}); err != nil {
					continue
				}
				atomic.AddInt64(&granted, est) // held, never settled/released
			}
		}()
	}
	wg.Wait()

	if granted > monthly+extra {
		t.Fatalf("oversold: granted %d > pool %d", granted, monthly+extra)
	}
	snap := wallet.Snapshot()
	if snap.MonthlyCreditsUsed > monthly {
		t.Fatalf("monthly used %d exceeds limit %d", snap.MonthlyCreditsUsed, monthly)
	}
	if snap.MonthlyRemaining < 0 || snap.ExtraCreditsBalance < 0 {
		t.Fatalf("negative remaining: monthly=%d extra=%d", snap.MonthlyRemaining, snap.ExtraCreditsBalance)
	}
	if granted != snap.MonthlyCreditsUsed {
		t.Fatalf("granted %d != monthly used %d (held reservations should equal consumption)", granted, snap.MonthlyCreditsUsed)
	}
}
