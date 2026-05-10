package store

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/coldflame/jiandanly/api/internal/billing"
)

type MemoryStore struct {
	mu sync.Mutex

	usersByID    map[string]User
	usersByEmail map[string]User
	refresh      map[string]RefreshToken
	wallets      map[string]*billing.Wallet
	llmCalls     map[string]LLMCallRecord
	orders       map[string]PaymentOrder
	stripeEvents map[string]struct{}
}

func NewMemoryStore() *MemoryStore {
	return &MemoryStore{
		usersByID:    make(map[string]User),
		usersByEmail: make(map[string]User),
		refresh:      make(map[string]RefreshToken),
		wallets:      make(map[string]*billing.Wallet),
		llmCalls:     make(map[string]LLMCallRecord),
		orders:       make(map[string]PaymentOrder),
		stripeEvents: make(map[string]struct{}),
	}
}

func (s *MemoryStore) CreateUser(ctx context.Context, email string, passwordHash string, name string) (User, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	normalizedEmail := normalizeEmail(email)
	if _, ok := s.usersByEmail[normalizedEmail]; ok {
		return User{}, ErrAlreadyExists
	}
	user := User{
		ID:           newID("user"),
		Email:        normalizedEmail,
		PasswordHash: passwordHash,
		Name:         strings.TrimSpace(name),
		Role:         "user",
		Status:       "active",
		CreatedAt:    time.Now().UTC(),
	}
	s.usersByID[user.ID] = user
	s.usersByEmail[normalizedEmail] = user
	return user, nil
}

func (s *MemoryStore) UserByEmail(ctx context.Context, email string) (User, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	user, ok := s.usersByEmail[normalizeEmail(email)]
	if !ok {
		return User{}, ErrNotFound
	}
	return user, nil
}

func (s *MemoryStore) UserByID(ctx context.Context, id string) (User, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	user, ok := s.usersByID[id]
	if !ok {
		return User{}, ErrNotFound
	}
	return user, nil
}

func (s *MemoryStore) SaveRefreshToken(ctx context.Context, token string, userID string, expiresAt time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.refresh[token] = RefreshToken{Token: token, UserID: userID, ExpiresAt: expiresAt}
	return nil
}

func (s *MemoryStore) UseRefreshToken(ctx context.Context, token string) (User, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	session, ok := s.refresh[token]
	if !ok || session.RevokedAt != nil || time.Now().After(session.ExpiresAt) {
		return User{}, ErrNotFound
	}
	now := time.Now().UTC()
	session.RevokedAt = &now
	s.refresh[token] = session

	user, ok := s.usersByID[session.UserID]
	if !ok {
		return User{}, ErrNotFound
	}
	return user, nil
}

func (s *MemoryStore) RevokeRefreshToken(ctx context.Context, token string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	session, ok := s.refresh[token]
	if !ok {
		return nil
	}
	now := time.Now().UTC()
	session.RevokedAt = &now
	s.refresh[token] = session
	return nil
}

func (s *MemoryStore) EnsureWallet(ctx context.Context, userID string, monthlyCredits int64) (*billing.Wallet, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if wallet, ok := s.wallets[userID]; ok {
		return wallet, nil
	}
	wallet := billing.NewWallet(newID("wallet"), monthlyCredits, 0)
	wallet.UserID = userID
	s.wallets[userID] = wallet
	return wallet, nil
}

func (s *MemoryStore) WalletByUser(ctx context.Context, userID string) (*billing.Wallet, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	wallet, ok := s.wallets[userID]
	if !ok {
		return nil, ErrNotFound
	}
	return wallet, nil
}

func (s *MemoryStore) ReserveUsage(ctx context.Context, userID string, monthlyCredits int64, estimatedCredits int64, meta billing.ReservationMeta) (*billing.Reservation, error) {
	wallet, err := s.EnsureWallet(ctx, userID, monthlyCredits)
	if err != nil {
		return nil, err
	}
	return wallet.Reserve(estimatedCredits, meta)
}

func (s *MemoryStore) SettleUsage(ctx context.Context, userID string, reservationID string, actualCredits int64) error {
	wallet, err := s.WalletByUser(ctx, userID)
	if err != nil {
		return err
	}
	return wallet.Settle(reservationID, actualCredits)
}

func (s *MemoryStore) ReleaseUsage(ctx context.Context, userID string, reservationID string) error {
	wallet, err := s.WalletByUser(ctx, userID)
	if err != nil {
		return err
	}
	return wallet.Release(reservationID)
}

func (s *MemoryStore) CreateLLMCall(ctx context.Context, record LLMCallRecord) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if record.StartedAt.IsZero() {
		record.StartedAt = time.Now().UTC()
	}
	s.llmCalls[record.RequestID] = record
	return nil
}

func (s *MemoryStore) FinishLLMCall(ctx context.Context, requestID string, status string, inputTokens int, outputTokens int, creditsCost int64, errorMessage string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	record, ok := s.llmCalls[requestID]
	if !ok {
		return ErrNotFound
	}
	record.Status = status
	record.InputTokens = inputTokens
	record.OutputTokens = outputTokens
	record.CreditsCost = creditsCost
	record.ErrorMessage = errorMessage
	record.FinishedAt = time.Now().UTC()
	s.llmCalls[requestID] = record
	return nil
}

func (s *MemoryStore) LLMCallsByUser(ctx context.Context, userID string) ([]LLMCallRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	records := make([]LLMCallRecord, 0)
	for _, record := range s.llmCalls {
		if record.UserID == userID {
			records = append(records, record)
		}
	}
	sort.Slice(records, func(i, j int) bool {
		return records[i].StartedAt.After(records[j].StartedAt)
	})
	return records, nil
}

func (s *MemoryStore) CreatePaymentOrder(ctx context.Context, order PaymentOrder) (PaymentOrder, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if order.ID == "" {
		order.ID = newID("order")
	}
	if order.Status == "" {
		order.Status = "pending"
	}
	if order.CreatedAt.IsZero() {
		order.CreatedAt = time.Now().UTC()
	}
	s.orders[order.ID] = order
	return order, nil
}

func (s *MemoryStore) PaymentOrdersByWallet(ctx context.Context, walletID string) ([]PaymentOrder, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	orders := make([]PaymentOrder, 0)
	for _, order := range s.orders {
		if order.WalletID == walletID {
			orders = append(orders, order)
		}
	}
	sort.Slice(orders, func(i, j int) bool {
		return orders[i].CreatedAt.After(orders[j].CreatedAt)
	})
	return orders, nil
}

func (s *MemoryStore) MarkSubscriptionPaid(ctx context.Context, stripeSessionID string, monthlyCredits int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	for id, order := range s.orders {
		if order.StripeSessionID == stripeSessionID || order.ID == stripeSessionID {
			order.Status = "paid"
			s.orders[id] = order
			for _, wallet := range s.wallets {
				if wallet.ID == order.WalletID {
					wallet.AddMonthlyGrant(monthlyCredits, "stripe:"+stripeSessionID)
					return nil
				}
			}
		}
	}
	return ErrNotFound
}

func (s *MemoryStore) RecordStripeEvent(ctx context.Context, eventID string, eventType string, payload []byte) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, ok := s.stripeEvents[eventID]; ok {
		return false, nil
	}
	s.stripeEvents[eventID] = struct{}{}
	return true, nil
}

func normalizeEmail(email string) string {
	return strings.ToLower(strings.TrimSpace(email))
}

func newID(prefix string) string {
	var bytes [8]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		panic(errors.New("crypto/rand failed"))
	}
	return prefix + "_" + hex.EncodeToString(bytes[:])
}
