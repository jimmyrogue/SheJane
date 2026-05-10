package billing

import (
	"errors"
	"fmt"
	"sync"
	"time"
)

var ErrInsufficientCredits = errors.New("insufficient credits")

// IsInsufficientCredits lets HTTP handlers translate wallet failures into a
// stable product error without depending on the wallet internals.
func IsInsufficientCredits(err error) bool {
	return errors.Is(err, ErrInsufficientCredits)
}

type ReservationStatus string

const (
	ReservationReserved ReservationStatus = "reserved"
	ReservationSettled  ReservationStatus = "settled"
	ReservationReleased ReservationStatus = "released"
	ReservationFailed   ReservationStatus = "failed"
)

type ReservationMeta struct {
	UserID               string
	OrganizationID       string
	RequestID            string
	ClientConversationID string
	ClientMessageID      string
	Mode                 string
}

type Reservation struct {
	ID       string
	WalletID string
	ReservationMeta
	EstimatedCredits int64
	ActualCredits    int64
	MonthlyCredits   int64
	ExtraCredits     int64
	Status           ReservationStatus
	CreatedAt        time.Time
	SettledAt        *time.Time
}

type Transaction struct {
	ID                string    `json:"id"`
	WalletID          string    `json:"wallet_id"`
	ReservationID     string    `json:"reservation_id,omitempty"`
	Type              string    `json:"type"`
	Amount            int64     `json:"amount"`
	MonthlyUsedAfter  int64     `json:"monthly_used_after"`
	ExtraBalanceAfter int64     `json:"extra_balance_after"`
	Description       string    `json:"description"`
	IdempotencyKey    string    `json:"idempotency_key,omitempty"`
	CreatedAt         time.Time `json:"created_at"`
}

type Wallet struct {
	mu sync.Mutex

	ID                   string
	OwnerType            string
	UserID               string
	PlanCode             string
	MonthlyCreditLimit   int64
	MonthlyCreditsUsed   int64
	ExtraCreditsBalance  int64
	PeriodStart          time.Time
	PeriodEnd            time.Time
	Status               string
	StripeSubscriptionID string

	reservations map[string]*Reservation
	transactions []*Transaction
}

func NewWallet(id string, monthlyLimit int64, extraBalance int64) *Wallet {
	now := time.Now().UTC()
	return &Wallet{
		ID:                  id,
		OwnerType:           "user",
		PlanCode:            "free_trial",
		MonthlyCreditLimit:  monthlyLimit,
		ExtraCreditsBalance: extraBalance,
		PeriodStart:         now,
		PeriodEnd:           now.AddDate(0, 1, 0),
		Status:              "active",
		reservations:        make(map[string]*Reservation),
	}
}

func (w *Wallet) MonthlyRemaining() int64 {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.monthlyRemainingLocked()
}

func (w *Wallet) Transactions() []Transaction {
	w.mu.Lock()
	defer w.mu.Unlock()

	out := make([]Transaction, 0, len(w.transactions))
	for _, tx := range w.transactions {
		out = append(out, *tx)
	}
	return out
}

func (w *Wallet) Reserve(estimatedCredits int64, meta ReservationMeta) (*Reservation, error) {
	w.mu.Lock()
	defer w.mu.Unlock()

	if estimatedCredits <= 0 {
		estimatedCredits = 1
	}

	monthly := minInt64(estimatedCredits, w.monthlyRemainingLocked())
	extra := estimatedCredits - monthly
	if extra > w.ExtraCreditsBalance {
		return nil, fmt.Errorf("%w: need %d credits, have %d", ErrInsufficientCredits, estimatedCredits, w.monthlyRemainingLocked()+w.ExtraCreditsBalance)
	}

	w.MonthlyCreditsUsed += monthly
	w.ExtraCreditsBalance -= extra

	reservation := &Reservation{
		ID:               newID("res"),
		WalletID:         w.ID,
		ReservationMeta:  meta,
		EstimatedCredits: estimatedCredits,
		MonthlyCredits:   monthly,
		ExtraCredits:     extra,
		Status:           ReservationReserved,
		CreatedAt:        time.Now().UTC(),
	}
	w.reservations[reservation.ID] = reservation
	w.appendTransactionLocked("usage_reserve", reservation.ID, -estimatedCredits, "reserved credits for model request", meta.RequestID)
	return cloneReservation(reservation), nil
}

func (w *Wallet) Settle(reservationID string, actualCredits int64) error {
	w.mu.Lock()
	defer w.mu.Unlock()

	reservation, ok := w.reservations[reservationID]
	if !ok {
		return fmt.Errorf("reservation %s not found", reservationID)
	}
	if reservation.Status != ReservationReserved {
		return fmt.Errorf("reservation %s is %s", reservationID, reservation.Status)
	}
	if actualCredits < 0 {
		actualCredits = 0
	}

	if actualCredits > reservation.EstimatedCredits {
		if err := w.consumeAdditionalLocked(actualCredits - reservation.EstimatedCredits); err != nil {
			reservation.Status = ReservationFailed
			return err
		}
	}

	if actualCredits < reservation.EstimatedCredits {
		w.refundLocked(reservation, reservation.EstimatedCredits-actualCredits)
	}

	now := time.Now().UTC()
	reservation.ActualCredits = actualCredits
	reservation.Status = ReservationSettled
	reservation.SettledAt = &now
	w.appendTransactionLocked("usage_settle", reservation.ID, -actualCredits, "settled actual model usage", reservation.RequestID+":settle")
	return nil
}

func (w *Wallet) Release(reservationID string) error {
	w.mu.Lock()
	defer w.mu.Unlock()

	reservation, ok := w.reservations[reservationID]
	if !ok {
		return fmt.Errorf("reservation %s not found", reservationID)
	}
	if reservation.Status != ReservationReserved {
		return fmt.Errorf("reservation %s is %s", reservationID, reservation.Status)
	}

	w.MonthlyCreditsUsed -= reservation.MonthlyCredits
	w.ExtraCreditsBalance += reservation.ExtraCredits
	reservation.Status = ReservationReleased
	now := time.Now().UTC()
	reservation.SettledAt = &now
	w.appendTransactionLocked("usage_release", reservation.ID, reservation.EstimatedCredits, "released unused reservation", reservation.RequestID+":release")
	return nil
}

func (w *Wallet) AddMonthlyGrant(amount int64, idempotencyKey string) {
	w.ApplySubscriptionGrant(amount, "", time.Time{}, idempotencyKey)
}

func (w *Wallet) ApplySubscriptionGrant(amount int64, stripeSubscriptionID string, periodEnd time.Time, idempotencyKey string) {
	w.mu.Lock()
	defer w.mu.Unlock()

	w.MonthlyCreditLimit = amount
	w.MonthlyCreditsUsed = 0
	w.PlanCode = "pro"
	w.Status = "active"
	if stripeSubscriptionID != "" {
		w.StripeSubscriptionID = stripeSubscriptionID
	}
	w.PeriodStart = time.Now().UTC()
	if periodEnd.IsZero() || periodEnd.Before(w.PeriodStart) {
		w.PeriodEnd = w.PeriodStart.AddDate(0, 1, 0)
	} else {
		w.PeriodEnd = periodEnd
	}
	w.appendTransactionLocked("subscription_grant", "", amount, "monthly subscription credits granted", idempotencyKey)
}

func (w *Wallet) UpdateSubscriptionStatus(status string, periodEnd time.Time) {
	w.mu.Lock()
	defer w.mu.Unlock()

	if status != "" {
		w.Status = status
	}
	if !periodEnd.IsZero() {
		w.PeriodEnd = periodEnd
	}
}

func (w *Wallet) AdjustExtraCredits(delta int64, reason string, idempotencyKey string) error {
	w.mu.Lock()
	defer w.mu.Unlock()

	next := w.ExtraCreditsBalance + delta
	if next < 0 {
		return fmt.Errorf("%w: extra credits cannot go below zero", ErrInsufficientCredits)
	}
	w.ExtraCreditsBalance = next
	w.appendTransactionLocked("admin_adjust", "", delta, reason, idempotencyKey)
	return nil
}

func (w *Wallet) Snapshot() WalletSnapshot {
	w.mu.Lock()
	defer w.mu.Unlock()

	return WalletSnapshot{
		ID:                   w.ID,
		PlanCode:             w.PlanCode,
		MonthlyCreditLimit:   w.MonthlyCreditLimit,
		MonthlyCreditsUsed:   w.MonthlyCreditsUsed,
		MonthlyRemaining:     w.monthlyRemainingLocked(),
		ExtraCreditsBalance:  w.ExtraCreditsBalance,
		PeriodStart:          w.PeriodStart,
		PeriodEnd:            w.PeriodEnd,
		Status:               w.Status,
		StripeSubscriptionID: w.StripeSubscriptionID,
	}
}

type WalletSnapshot struct {
	ID                   string    `json:"id"`
	PlanCode             string    `json:"plan_code"`
	MonthlyCreditLimit   int64     `json:"monthly_credit_limit"`
	MonthlyCreditsUsed   int64     `json:"monthly_credits_used"`
	MonthlyRemaining     int64     `json:"monthly_remaining"`
	ExtraCreditsBalance  int64     `json:"extra_credits_balance"`
	PeriodStart          time.Time `json:"period_start"`
	PeriodEnd            time.Time `json:"period_end"`
	Status               string    `json:"status"`
	StripeSubscriptionID string    `json:"stripe_subscription_id,omitempty"`
}

func (w *Wallet) monthlyRemainingLocked() int64 {
	return maxInt64(0, w.MonthlyCreditLimit-w.MonthlyCreditsUsed)
}

func (w *Wallet) consumeAdditionalLocked(amount int64) error {
	monthly := minInt64(amount, w.monthlyRemainingLocked())
	extra := amount - monthly
	if extra > w.ExtraCreditsBalance {
		return fmt.Errorf("%w: settlement needs %d additional credits", ErrInsufficientCredits, amount)
	}
	w.MonthlyCreditsUsed += monthly
	w.ExtraCreditsBalance -= extra
	return nil
}

func (w *Wallet) refundLocked(reservation *Reservation, amount int64) {
	extraRefund := minInt64(amount, reservation.ExtraCredits)
	w.ExtraCreditsBalance += extraRefund
	amount -= extraRefund

	monthlyRefund := minInt64(amount, reservation.MonthlyCredits)
	w.MonthlyCreditsUsed -= monthlyRefund
}

func (w *Wallet) appendTransactionLocked(txType string, reservationID string, amount int64, description string, idempotencyKey string) {
	w.transactions = append(w.transactions, &Transaction{
		ID:                newID("tx"),
		WalletID:          w.ID,
		ReservationID:     reservationID,
		Type:              txType,
		Amount:            amount,
		MonthlyUsedAfter:  w.MonthlyCreditsUsed,
		ExtraBalanceAfter: w.ExtraCreditsBalance,
		Description:       description,
		IdempotencyKey:    idempotencyKey,
		CreatedAt:         time.Now().UTC(),
	})
}

func cloneReservation(reservation *Reservation) *Reservation {
	copy := *reservation
	return &copy
}

func newID(prefix string) string {
	return fmt.Sprintf("%s_%d", prefix, time.Now().UTC().UnixNano())
}

func minInt64(a int64, b int64) int64 {
	if a < b {
		return a
	}
	return b
}

func maxInt64(a int64, b int64) int64 {
	if a > b {
		return a
	}
	return b
}
