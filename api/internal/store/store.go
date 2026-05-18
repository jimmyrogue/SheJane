package store

import (
	"context"
	"errors"
	"time"

	"github.com/coldflame/jiandanly/api/internal/billing"
	"github.com/coldflame/jiandanly/api/internal/documents"
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

type ExternalToolCallRecord struct {
	RequestID       string         `json:"request_id"`
	UserID          string         `json:"user_id"`
	WalletID        string         `json:"wallet_id"`
	ReservationID   string         `json:"reservation_id"`
	RunID           string         `json:"run_id"`
	ToolCallID      string         `json:"tool_call_id"`
	Tool            string         `json:"tool"`
	Provider        string         `json:"provider"`
	Units           int            `json:"units"`
	CreditsCost     int64          `json:"credits_cost"`
	Status          string         `json:"status"`
	ErrorCode       string         `json:"error_code,omitempty"`
	ErrorMessage    string         `json:"error_message,omitempty"`
	IdempotencyKey  string         `json:"idempotency_key,omitempty"`
	ResponseContent string         `json:"-"`
	ResponseData    map[string]any `json:"-"`
	StartedAt       time.Time      `json:"started_at"`
	FinishedAt      time.Time      `json:"finished_at,omitempty"`
}

type AgentAttachment struct {
	Type       string `json:"type"`
	DocumentID string `json:"document_id,omitempty"`
	Name       string `json:"name,omitempty"`
}

type AgentRun struct {
	ID                   string            `json:"id"`
	UserID               string            `json:"user_id"`
	Origin               string            `json:"origin"`
	Status               string            `json:"status"`
	Mode                 string            `json:"mode"`
	Goal                 string            `json:"-"`
	GoalSummary          string            `json:"goal_summary"`
	ClientConversationID string            `json:"client_conversation_id,omitempty"`
	ClientMessageID      string            `json:"client_message_id,omitempty"`
	Attachments          []AgentAttachment `json:"attachments,omitempty"`
	History              []HistoryMessage  `json:"-"`
	ErrorCode            string            `json:"error_code,omitempty"`
	ErrorMessage         string            `json:"error_message,omitempty"`
	ExpiresAt            time.Time         `json:"expires_at"`
	CreatedAt            time.Time         `json:"created_at"`
	UpdatedAt            time.Time         `json:"updated_at"`
}

// HistoryMessage is a prior conversation turn used to seed an agent run with
// multi-turn context (kept server-side only; not serialized to API clients).
type HistoryMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type AgentEvent struct {
	ID        string         `json:"id"`
	RunID     string         `json:"run_id"`
	Seq       int64          `json:"seq"`
	EventType string         `json:"event_type"`
	Payload   map[string]any `json:"payload"`
	CreatedAt time.Time      `json:"created_at"`
}

type AdminAgentRun struct {
	AgentRun
	UserEmail string `json:"user_email"`
}

type PaymentOrder struct {
	ID                   string    `json:"id"`
	WalletID             string    `json:"wallet_id"`
	Type                 string    `json:"type"`
	AmountCNY            int       `json:"amount_cny"`
	Status               string    `json:"status"`
	CheckoutURL          string    `json:"checkout_url"`
	StripeSessionID      string    `json:"stripe_checkout_session_id"`
	StripeSubscriptionID string    `json:"stripe_subscription_id"`
	IdempotencyKey       string    `json:"idempotency_key"`
	CreatedAt            time.Time `json:"created_at"`
}

type AdminListOptions struct {
	Query  string
	UserID string
	Status string
	Limit  int
	Offset int
}

type AdminOverview struct {
	UsersTotal       int64 `json:"users_total"`
	ActiveUsers      int64 `json:"active_users"`
	DisabledUsers    int64 `json:"disabled_users"`
	LLMCallsTotal    int64 `json:"llm_calls_total"`
	LLMCallsFailed   int64 `json:"llm_calls_failed"`
	CreditsCostTotal int64 `json:"credits_cost_total"`
	OrdersTotal      int64 `json:"orders_total"`
}

type AdminUserSummary struct {
	User        User                    `json:"user"`
	Wallet      *billing.WalletSnapshot `json:"wallet,omitempty"`
	CallsCount  int64                   `json:"calls_count"`
	CreditsCost int64                   `json:"credits_cost"`
}

type AdminUserDetail struct {
	User         User                     `json:"user"`
	Wallet       *billing.WalletSnapshot  `json:"wallet,omitempty"`
	Calls        []LLMCallRecord          `json:"calls"`
	ToolCalls    []ExternalToolCallRecord `json:"tool_calls"`
	Orders       []PaymentOrder           `json:"orders"`
	Transactions []billing.Transaction    `json:"transactions"`
}

type AdminLLMCallRecord struct {
	LLMCallRecord
	UserEmail string `json:"user_email"`
}

type AdminExternalToolCallRecord struct {
	ExternalToolCallRecord
	UserEmail string `json:"user_email"`
}

type AdminPaymentOrder struct {
	PaymentOrder
	UserID       string `json:"user_id"`
	UserEmail    string `json:"user_email"`
	PlanCode     string `json:"plan_code"`
	WalletStatus string `json:"wallet_status"`
}

type AuditLog struct {
	ID          string    `json:"id"`
	ActorUserID string    `json:"actor_user_id"`
	Action      string    `json:"action"`
	TargetType  string    `json:"target_type"`
	TargetID    string    `json:"target_id"`
	Metadata    string    `json:"metadata"`
	CreatedAt   time.Time `json:"created_at"`
}

// ModelConfig is an admin-editable, hot-reloadable model/provider definition.
// APIKeyEncrypted holds ciphertext (or plaintext when no CONFIG_ENCRYPTION_KEY
// is set); it is never serialized to API clients.
type ModelConfig struct {
	ID               string         `json:"id"`
	Slot             string         `json:"slot"`
	Capability       string         `json:"capability"`
	ProviderKind     string         `json:"provider_kind"`
	DisplayName      string         `json:"display_name"`
	BaseURL          string         `json:"base_url"`
	ModelName        string         `json:"model_name"`
	APIKeyEncrypted  string         `json:"-"`
	CreditMultiplier float64        `json:"credit_multiplier"`
	PricePerCallCNY  float64        `json:"price_per_call_cny"`
	Enabled          bool           `json:"enabled"`
	Params           map[string]any `json:"params"`
	CreatedAt        time.Time      `json:"created_at"`
	UpdatedAt        time.Time      `json:"updated_at"`
	UpdatedBy        string         `json:"updated_by,omitempty"`
}

// AppSetting is a generic global key/value knob (value is raw JSON text).
type AppSetting struct {
	Key       string    `json:"key"`
	Value     string    `json:"value"`
	UpdatedAt time.Time `json:"updated_at"`
}

type Store interface {
	CreateUser(ctx context.Context, email string, passwordHash string, name string) (User, error)
	UserByEmail(ctx context.Context, email string) (User, error)
	UserByID(ctx context.Context, id string) (User, error)
	UpdateUserRole(ctx context.Context, userID string, role string) (User, error)

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

	CreateExternalToolCall(ctx context.Context, record ExternalToolCallRecord) (ExternalToolCallRecord, bool, error)
	ExternalToolCallByIdempotencyKey(ctx context.Context, userID string, idempotencyKey string) (ExternalToolCallRecord, error)
	FinishExternalToolCall(ctx context.Context, requestID string, status string, units int, creditsCost int64, errorCode string, errorMessage string, responseContent string, responseData map[string]any) error

	CreateAgentRun(ctx context.Context, run AgentRun) (AgentRun, error)
	AgentRunByID(ctx context.Context, userID string, runID string) (AgentRun, error)
	UpdateAgentRunStatus(ctx context.Context, userID string, runID string, status string, errorCode string, errorMessage string) (AgentRun, error)
	AppendAgentEvent(ctx context.Context, runID string, eventType string, payload map[string]any) (AgentEvent, error)
	AgentEventsByRun(ctx context.Context, userID string, runID string) ([]AgentEvent, error)

	CreateDocument(ctx context.Context, document documents.Document) (documents.Document, error)
	DocumentsByUser(ctx context.Context, userID string) ([]documents.Document, error)
	DocumentByID(ctx context.Context, userID string, documentID string) (documents.Document, error)
	MarkDocumentProcessing(ctx context.Context, userID string, documentID string) (documents.Document, error)
	MarkDocumentReady(ctx context.Context, userID string, documentID string, textObjectKey string) (documents.Document, error)
	MarkDocumentFailed(ctx context.Context, userID string, documentID string, errorMessage string) (documents.Document, error)
	DeleteDocument(ctx context.Context, userID string, documentID string) (documents.Document, error)

	CreatePaymentOrder(ctx context.Context, order PaymentOrder) (PaymentOrder, error)
	PaymentOrdersByWallet(ctx context.Context, walletID string) ([]PaymentOrder, error)
	MarkSubscriptionPaid(ctx context.Context, stripeSessionID string, stripeSubscriptionID string, eventID string, monthlyCredits int64, periodEnd time.Time) error
	MarkSubscriptionRenewed(ctx context.Context, stripeSubscriptionID string, eventID string, monthlyCredits int64, periodEnd time.Time) error
	UpdateSubscriptionStatus(ctx context.Context, stripeSubscriptionID string, status string, periodEnd time.Time) error
	RecordStripeEvent(ctx context.Context, eventID string, eventType string, payload []byte) (bool, error)
	MarkStripeEventProcessed(ctx context.Context, eventID string) error

	AdminOverview(ctx context.Context) (AdminOverview, error)
	AdminUsers(ctx context.Context, opts AdminListOptions) ([]AdminUserSummary, error)
	AdminUserDetail(ctx context.Context, userID string) (AdminUserDetail, error)
	UpdateUserStatus(ctx context.Context, actorUserID string, userID string, status string, reason string) (User, error)
	AdjustExtraCredits(ctx context.Context, actorUserID string, userID string, delta int64, reason string) (*billing.Wallet, error)
	AdminLLMCalls(ctx context.Context, opts AdminListOptions) ([]AdminLLMCallRecord, error)
	AdminExternalToolCalls(ctx context.Context, opts AdminListOptions) ([]AdminExternalToolCallRecord, error)
	AdminPaymentOrders(ctx context.Context, opts AdminListOptions) ([]AdminPaymentOrder, error)
	AdminAgentRuns(ctx context.Context, opts AdminListOptions) ([]AdminAgentRun, error)
	AdminAuditLogs(ctx context.Context, opts AdminListOptions) ([]AuditLog, error)

	CountModelConfigs(ctx context.Context) (int64, error)
	ListModelConfigs(ctx context.Context, capability string) ([]ModelConfig, error)
	GetModelConfig(ctx context.Context, id string) (ModelConfig, error)
	UpsertModelConfig(ctx context.Context, actorUserID string, cfg ModelConfig) (ModelConfig, error)
	SetModelConfigEnabled(ctx context.Context, actorUserID string, id string, enabled bool) (ModelConfig, error)
	DeleteModelConfig(ctx context.Context, actorUserID string, id string) error
	GetAppSetting(ctx context.Context, key string) (AppSetting, error)
	SetAppSetting(ctx context.Context, actorUserID string, key string, valueJSON string) (AppSetting, error)
}
