package store

import (
	"context"
	"errors"
	"time"

	"github.com/coldflame/shejane/api/internal/billing"
	"github.com/coldflame/shejane/api/internal/documents"
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

// SandboxSessionRecord is one row of the sandbox_sessions table (Phase 5).
//
// A user's conversation owns at most one *active* sandbox at a time —
// reuse keeps the Jupyter kernel variables alive across multiple
// code.execute calls so the agent can iterate ("now do X to that
// DataFrame") without losing state. When status flips to
// timeout/killed/failed the unique-active-per-conversation index frees
// up and the next code.execute call provisions a fresh sandbox.
type SandboxSessionRecord struct {
	ID             string `json:"id"`
	UserID         string `json:"user_id"`
	ConversationID string `json:"conversation_id"`
	E2BSandboxID   string `json:"e2b_sandbox_id"`
	// E2BClientID is the routing component E2B returns at sandbox
	// create time. The per-sandbox URL is
	// `https://{port}-{E2BSandboxID}-{E2BClientID}.e2b.dev`. Without
	// it we can't talk to the sandbox at all post-create.
	E2BClientID      string    `json:"e2b_client_id"`
	Provider         string    `json:"provider"`
	TemplateID       string    `json:"template_id"`
	Status           string    `json:"status"` // active | timeout | killed | failed
	CreatedAt        time.Time `json:"created_at"`
	LastUsedAt       time.Time `json:"last_used_at"`
	KilledAt         time.Time `json:"killed_at,omitempty"`
	TotalSeconds     int       `json:"total_seconds"`
	TotalCreditsCost int64     `json:"total_credits_cost"`
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
	// Ping reports whether the backing store is reachable. Used by the
	// /readyz readiness probe so an unhealthy DB is visible to monitoring
	// and orchestration instead of surfacing as opaque 500s.
	Ping(ctx context.Context) error

	CreateUser(ctx context.Context, email string, passwordHash string, name string) (User, error)
	UserByEmail(ctx context.Context, email string) (User, error)
	UserByID(ctx context.Context, id string) (User, error)
	UpdateUserRole(ctx context.Context, userID string, role string) (User, error)

	SaveRefreshToken(ctx context.Context, token string, userID string, expiresAt time.Time) error
	UseRefreshToken(ctx context.Context, token string) (User, error)
	RevokeRefreshToken(ctx context.Context, token string) error

	// SavePasswordResetToken records a new reset token (stored hashed).
	SavePasswordResetToken(ctx context.Context, token string, userID string, expiresAt time.Time) error
	// ResetPasswordWithToken ATOMICALLY consumes a reset token (single-use,
	// expiring), sets the new password hash, and revokes ALL of the user's
	// refresh tokens (force re-login everywhere). All-or-nothing: if any step
	// fails, the token is NOT consumed and the password is unchanged — so a
	// reset can never half-succeed and leave a compromised session live.
	// Returns the owning user id; errors if the token is missing/expired/used.
	ResetPasswordWithToken(ctx context.Context, token string, passwordHash string) (string, error)

	EnsureWallet(ctx context.Context, userID string, monthlyCredits int64) (*billing.Wallet, error)
	// GrantSignupCredits adds a one-time gift to the user's extra_credits_balance.
	// Idempotent (no-op if already granted for this user).
	GrantSignupCredits(ctx context.Context, userID string, amount int64) error
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

	// Sandbox session lifecycle (Phase 5 — code.execute tool).
	//
	// GetActiveSandboxSessionByConversation returns ErrNotFound when no
	// active row exists; callers should then provision via E2B + Create.
	// Concurrent code.execute calls on the same conversation are
	// serialized at the gateway level (per-tool_call_id idempotency
	// already in place), so we don't need a SELECT … FOR UPDATE here.
	GetActiveSandboxSessionByConversation(ctx context.Context, userID string, conversationID string) (SandboxSessionRecord, error)
	CreateSandboxSession(ctx context.Context, record SandboxSessionRecord) (SandboxSessionRecord, error)
	TouchSandboxSession(ctx context.Context, id string, addedSeconds int, addedCreditsCost int64) error
	MarkSandboxSessionStatus(ctx context.Context, id string, status string) error
	// ListReapableSandboxSessions returns active sandboxes that have
	// either been idle for `idleSince` or live past `bornBefore`. The
	// reaper job calls KillSandbox + MarkSandboxSessionStatus("timeout"
	// or "killed") on each result.
	ListReapableSandboxSessions(ctx context.Context, idleSince time.Time, bornBefore time.Time, limit int) ([]SandboxSessionRecord, error)

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
	// SetDocumentMetadata replaces the document's `metadata` jsonb
	// column with the supplied map. Used by the documents service
	// to persist pdfinfo output at upload time. nil clears it to
	// '{}'. Returns documents.ErrAlreadyDeleted if the row is
	// already tombstoned (callers treat this as a benign no-op).
	SetDocumentMetadata(ctx context.Context, userID string, documentID string, metadata map[string]any) (documents.Document, error)
	DeleteDocument(ctx context.Context, userID string, documentID string) (documents.Document, error)
	// ListExpiredDocuments returns up to `limit` documents whose
	// expires_at is strictly before `cutoff` and whose status isn't
	// already 'deleted'. Used by the documents reaper background
	// job to find candidates for hard deletion (S3 object delete +
	// row tombstone). Ordered by created_at ASC so the oldest go
	// first — bounds the tail latency of any single reaper tick
	// when there's a large backlog (post-incident catch-up case).
	ListExpiredDocuments(ctx context.Context, cutoff time.Time, limit int) ([]documents.Document, error)

	CreatePaymentOrder(ctx context.Context, order PaymentOrder) (PaymentOrder, error)
	PaymentOrdersByWallet(ctx context.Context, walletID string) ([]PaymentOrder, error)
	MarkSubscriptionPaid(ctx context.Context, stripeSessionID string, stripeSubscriptionID string, eventID string, monthlyCredits int64, periodEnd time.Time) error
	MarkSubscriptionRenewed(ctx context.Context, stripeSubscriptionID string, eventID string, monthlyCredits int64, periodEnd time.Time) error
	UpdateSubscriptionStatus(ctx context.Context, stripeSubscriptionID string, status string, periodEnd time.Time) error
	RevokeSubscriptionCredits(ctx context.Context, stripeSubscriptionID string, eventID string) error
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
