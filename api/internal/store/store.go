package store

import (
	"context"
	"errors"
	"time"

	"github.com/coldflame/jiandanly/api/internal/billing"
)

var (
	ErrNotFound      = errors.New("not found")
	ErrAlreadyExists = errors.New("already exists")
)

type User struct {
	ID           string    `json:"id"`
	Email        string    `json:"email"`
	PasswordHash string    `json:"-"`
	Name         string    `json:"name"`
	Role         string    `json:"role"`
	Status       string    `json:"status"`
	CreatedAt    time.Time `json:"created_at"`
}

type RefreshToken struct {
	Token     string
	UserID    string
	ExpiresAt time.Time
	RevokedAt *time.Time
}

type LLMCallRecord struct {
	RequestID            string    `json:"request_id"`
	UserID               string    `json:"user_id"`
	WalletID             string    `json:"wallet_id"`
	ReservationID        string    `json:"reservation_id"`
	ClientConversationID string    `json:"client_conversation_id"`
	ClientMessageID      string    `json:"client_message_id"`
	Mode                 string    `json:"mode"`
	Scene                string    `json:"scene"`
	Model                string    `json:"model"`
	Provider             string    `json:"provider"`
	InputTokens          int       `json:"input_tokens"`
	OutputTokens         int       `json:"output_tokens"`
	CreditsCost          int64     `json:"credits_cost"`
	Status               string    `json:"status"`
	ErrorCode            string    `json:"error_code,omitempty"`
	ErrorMessage         string    `json:"error_message,omitempty"`
	StartedAt            time.Time `json:"started_at"`
	FinishedAt           time.Time `json:"finished_at,omitempty"`
}

type PaymentOrder struct {
	ID              string    `json:"id"`
	WalletID        string    `json:"wallet_id"`
	Type            string    `json:"type"`
	AmountCNY       int       `json:"amount_cny"`
	Status          string    `json:"status"`
	CheckoutURL     string    `json:"checkout_url"`
	StripeSessionID string    `json:"stripe_checkout_session_id"`
	IdempotencyKey  string    `json:"idempotency_key"`
	CreatedAt       time.Time `json:"created_at"`
}

type Store interface {
	CreateUser(ctx context.Context, email string, passwordHash string, name string) (User, error)
	UserByEmail(ctx context.Context, email string) (User, error)
	UserByID(ctx context.Context, id string) (User, error)

	SaveRefreshToken(ctx context.Context, token string, userID string, expiresAt time.Time) error
	UseRefreshToken(ctx context.Context, token string) (User, error)
	RevokeRefreshToken(ctx context.Context, token string) error

	EnsureWallet(ctx context.Context, userID string, monthlyCredits int64) (*billing.Wallet, error)
	WalletByUser(ctx context.Context, userID string) (*billing.Wallet, error)
	ReserveUsage(ctx context.Context, userID string, monthlyCredits int64, estimatedCredits int64, meta billing.ReservationMeta) (*billing.Reservation, error)
	SettleUsage(ctx context.Context, userID string, reservationID string, actualCredits int64) error
	ReleaseUsage(ctx context.Context, userID string, reservationID string) error

	CreateLLMCall(ctx context.Context, record LLMCallRecord) error
	FinishLLMCall(ctx context.Context, requestID string, status string, inputTokens int, outputTokens int, creditsCost int64, errorMessage string) error
	LLMCallsByUser(ctx context.Context, userID string) ([]LLMCallRecord, error)

	CreatePaymentOrder(ctx context.Context, order PaymentOrder) (PaymentOrder, error)
	PaymentOrdersByWallet(ctx context.Context, walletID string) ([]PaymentOrder, error)
	MarkSubscriptionPaid(ctx context.Context, stripeSessionID string, monthlyCredits int64) error
	RecordStripeEvent(ctx context.Context, eventID string, eventType string, payload []byte) (bool, error)
}
