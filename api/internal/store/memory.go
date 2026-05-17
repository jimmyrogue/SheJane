package store

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/coldflame/jiandanly/api/internal/billing"
	"github.com/coldflame/jiandanly/api/internal/documents"
)

type MemoryStore struct {
	mu sync.Mutex

	usersByID    map[string]User
	usersByEmail map[string]User
	refresh      map[string]RefreshToken
	wallets      map[string]*billing.Wallet
	llmCalls     map[string]LLMCallRecord
	toolCalls    map[string]ExternalToolCallRecord
	agentRuns    map[string]AgentRun
	agentEvents  map[string][]AgentEvent
	documents    map[string]documents.Document
	orders       map[string]PaymentOrder
	stripeEvents map[string]bool
	auditLogs    []AuditLog
	modelConfigs map[string]ModelConfig
	appSettings  map[string]AppSetting
}

func NewMemoryStore() *MemoryStore {
	return &MemoryStore{
		usersByID:    make(map[string]User),
		usersByEmail: make(map[string]User),
		refresh:      make(map[string]RefreshToken),
		wallets:      make(map[string]*billing.Wallet),
		llmCalls:     make(map[string]LLMCallRecord),
		toolCalls:    make(map[string]ExternalToolCallRecord),
		agentRuns:    make(map[string]AgentRun),
		agentEvents:  make(map[string][]AgentEvent),
		documents:    make(map[string]documents.Document),
		orders:       make(map[string]PaymentOrder),
		stripeEvents: make(map[string]bool),
		auditLogs:    make([]AuditLog, 0),
		modelConfigs: make(map[string]ModelConfig),
		appSettings:  make(map[string]AppSetting),
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

func (s *MemoryStore) UpdateUserRole(ctx context.Context, userID string, role string) (User, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	user, ok := s.usersByID[userID]
	if !ok {
		return User{}, ErrNotFound
	}
	user.Role = role
	s.usersByID[user.ID] = user
	s.usersByEmail[user.Email] = user
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

func (s *MemoryStore) CreateExternalToolCall(ctx context.Context, record ExternalToolCallRecord) (ExternalToolCallRecord, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if record.IdempotencyKey != "" {
		for _, existing := range s.toolCalls {
			if existing.UserID == record.UserID && existing.IdempotencyKey == record.IdempotencyKey {
				return cloneExternalToolCall(existing), false, nil
			}
		}
	}
	if record.StartedAt.IsZero() {
		record.StartedAt = time.Now().UTC()
	}
	if record.Status == "" {
		record.Status = "running"
	}
	if record.ResponseData == nil {
		record.ResponseData = map[string]any{}
	}
	s.toolCalls[record.RequestID] = cloneExternalToolCall(record)
	return cloneExternalToolCall(record), true, nil
}

func (s *MemoryStore) ExternalToolCallByIdempotencyKey(ctx context.Context, userID string, idempotencyKey string) (ExternalToolCallRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if idempotencyKey == "" {
		return ExternalToolCallRecord{}, ErrNotFound
	}
	for _, record := range s.toolCalls {
		if record.UserID == userID && record.IdempotencyKey == idempotencyKey {
			return cloneExternalToolCall(record), nil
		}
	}
	return ExternalToolCallRecord{}, ErrNotFound
}

func (s *MemoryStore) FinishExternalToolCall(ctx context.Context, requestID string, status string, units int, creditsCost int64, errorCode string, errorMessage string, responseContent string, responseData map[string]any) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	record, ok := s.toolCalls[requestID]
	if !ok {
		return ErrNotFound
	}
	record.Status = status
	record.Units = units
	record.CreditsCost = creditsCost
	record.ErrorCode = errorCode
	record.ErrorMessage = errorMessage
	record.ResponseContent = responseContent
	record.ResponseData = cloneMap(responseData)
	record.FinishedAt = time.Now().UTC()
	s.toolCalls[requestID] = record
	return nil
}

func (s *MemoryStore) CreateAgentRun(ctx context.Context, run AgentRun) (AgentRun, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, ok := s.usersByID[run.UserID]; !ok {
		return AgentRun{}, ErrNotFound
	}
	now := time.Now().UTC()
	if run.ID == "" {
		run.ID = newUUID()
	}
	if run.Origin == "" {
		run.Origin = "cloud"
	}
	if run.Status == "" {
		run.Status = "queued"
	}
	if run.Mode == "" {
		run.Mode = "fast"
	}
	if run.CreatedAt.IsZero() {
		run.CreatedAt = now
	}
	if run.UpdatedAt.IsZero() {
		run.UpdatedAt = now
	}
	if run.ExpiresAt.IsZero() {
		run.ExpiresAt = now.Add(168 * time.Hour)
	}
	if run.Attachments == nil {
		run.Attachments = []AgentAttachment{}
	}
	s.agentRuns[run.ID] = run
	return run, nil
}

func (s *MemoryStore) AgentRunByID(ctx context.Context, userID string, runID string) (AgentRun, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	run, ok := s.agentRuns[runID]
	if !ok || run.UserID != userID {
		return AgentRun{}, ErrNotFound
	}
	return run, nil
}

func (s *MemoryStore) UpdateAgentRunStatus(ctx context.Context, userID string, runID string, status string, errorCode string, errorMessage string) (AgentRun, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	run, ok := s.agentRuns[runID]
	if !ok || run.UserID != userID {
		return AgentRun{}, ErrNotFound
	}
	run.Status = status
	run.ErrorCode = errorCode
	run.ErrorMessage = truncateString(errorMessage, 500)
	run.UpdatedAt = time.Now().UTC()
	s.agentRuns[run.ID] = run
	return run, nil
}

func (s *MemoryStore) AppendAgentEvent(ctx context.Context, runID string, eventType string, payload map[string]any) (AgentEvent, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, ok := s.agentRuns[runID]; !ok {
		return AgentEvent{}, ErrNotFound
	}
	if payload == nil {
		payload = map[string]any{}
	}
	event := AgentEvent{
		ID:        newUUID(),
		RunID:     runID,
		Seq:       int64(len(s.agentEvents[runID]) + 1),
		EventType: eventType,
		Payload:   payload,
		CreatedAt: time.Now().UTC(),
	}
	s.agentEvents[runID] = append(s.agentEvents[runID], event)
	return event, nil
}

func (s *MemoryStore) AgentEventsByRun(ctx context.Context, userID string, runID string) ([]AgentEvent, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	run, ok := s.agentRuns[runID]
	if !ok || run.UserID != userID {
		return nil, ErrNotFound
	}
	events := append([]AgentEvent(nil), s.agentEvents[runID]...)
	sort.Slice(events, func(i, j int) bool {
		return events[i].Seq < events[j].Seq
	})
	return events, nil
}

func (s *MemoryStore) CreateDocument(ctx context.Context, document documents.Document) (documents.Document, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, ok := s.usersByID[document.UserID]; !ok {
		return documents.Document{}, ErrNotFound
	}
	now := time.Now().UTC()
	if document.ID == "" {
		document.ID = newUUID()
	}
	if document.Status == "" {
		document.Status = documents.StatusUploading
	}
	if document.CreatedAt.IsZero() {
		document.CreatedAt = now
	}
	document.UpdatedAt = now
	s.documents[document.ID] = document
	return document, nil
}

func (s *MemoryStore) DocumentsByUser(ctx context.Context, userID string) ([]documents.Document, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	items := make([]documents.Document, 0)
	for _, document := range s.documents {
		if document.UserID == userID && document.Status != documents.StatusDeleted {
			items = append(items, document)
		}
	}
	sort.Slice(items, func(i, j int) bool {
		return items[i].CreatedAt.After(items[j].CreatedAt)
	})
	return items, nil
}

func (s *MemoryStore) DocumentByID(ctx context.Context, userID string, documentID string) (documents.Document, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.documentByIDLocked(userID, documentID)
}

func (s *MemoryStore) MarkDocumentProcessing(ctx context.Context, userID string, documentID string) (documents.Document, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	document, err := s.documentByIDLocked(userID, documentID)
	if err != nil {
		return documents.Document{}, err
	}
	document.Status = documents.StatusProcessing
	document.ErrorMessage = ""
	document.UpdatedAt = time.Now().UTC()
	s.documents[document.ID] = document
	return document, nil
}

func (s *MemoryStore) MarkDocumentReady(ctx context.Context, userID string, documentID string, textObjectKey string) (documents.Document, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	document, err := s.documentByIDLocked(userID, documentID)
	if err != nil {
		return documents.Document{}, err
	}
	document.Status = documents.StatusReady
	document.TextObjectKey = textObjectKey
	document.ErrorMessage = ""
	document.UpdatedAt = time.Now().UTC()
	s.documents[document.ID] = document
	return document, nil
}

func (s *MemoryStore) MarkDocumentFailed(ctx context.Context, userID string, documentID string, errorMessage string) (documents.Document, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	document, err := s.documentByIDLocked(userID, documentID)
	if err != nil {
		return documents.Document{}, err
	}
	document.Status = documents.StatusFailed
	document.ErrorMessage = truncateString(errorMessage, 500)
	document.UpdatedAt = time.Now().UTC()
	s.documents[document.ID] = document
	return document, nil
}

func (s *MemoryStore) DeleteDocument(ctx context.Context, userID string, documentID string) (documents.Document, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	document, err := s.documentByIDLocked(userID, documentID)
	if err != nil {
		return documents.Document{}, err
	}
	document.Status = documents.StatusDeleted
	document.UpdatedAt = time.Now().UTC()
	s.documents[document.ID] = document
	return document, nil
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

func (s *MemoryStore) MarkSubscriptionPaid(ctx context.Context, stripeSessionID string, stripeSubscriptionID string, eventID string, monthlyCredits int64, periodEnd time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	for id, order := range s.orders {
		if order.StripeSessionID == stripeSessionID || order.ID == stripeSessionID {
			order.Status = "paid"
			order.StripeSubscriptionID = stripeSubscriptionID
			s.orders[id] = order
			for _, wallet := range s.wallets {
				if wallet.ID == order.WalletID {
					wallet.ApplySubscriptionGrant(monthlyCredits, stripeSubscriptionID, periodEnd, "stripe:"+eventID)
					s.appendAuditLocked("", "billing.subscription_paid", "wallet", wallet.ID, "stripe checkout completed", map[string]any{"event_id": eventID, "stripe_subscription_id": stripeSubscriptionID})
					return nil
				}
			}
		}
	}
	return ErrNotFound
}

func (s *MemoryStore) MarkSubscriptionRenewed(ctx context.Context, stripeSubscriptionID string, eventID string, monthlyCredits int64, periodEnd time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	for _, wallet := range s.wallets {
		if wallet.StripeSubscriptionID == stripeSubscriptionID {
			wallet.ApplySubscriptionGrant(monthlyCredits, stripeSubscriptionID, periodEnd, "stripe:"+eventID)
			s.appendAuditLocked("", "billing.subscription_renewed", "wallet", wallet.ID, "stripe invoice paid", map[string]any{"event_id": eventID, "stripe_subscription_id": stripeSubscriptionID})
			return nil
		}
	}
	return ErrNotFound
}

func (s *MemoryStore) UpdateSubscriptionStatus(ctx context.Context, stripeSubscriptionID string, status string, periodEnd time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	for id, order := range s.orders {
		if order.StripeSubscriptionID == stripeSubscriptionID && status != "active" {
			order.Status = status
			s.orders[id] = order
		}
	}
	for _, wallet := range s.wallets {
		if wallet.StripeSubscriptionID == stripeSubscriptionID {
			wallet.UpdateSubscriptionStatus(status, periodEnd)
			s.appendAuditLocked("", "billing.subscription_status_update", "wallet", wallet.ID, "stripe subscription status", map[string]any{"status": status, "stripe_subscription_id": stripeSubscriptionID})
			return nil
		}
	}
	return ErrNotFound
}

func (s *MemoryStore) RecordStripeEvent(ctx context.Context, eventID string, eventType string, payload []byte) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if processed, ok := s.stripeEvents[eventID]; ok {
		return !processed, nil
	}
	s.stripeEvents[eventID] = false
	return true, nil
}

func (s *MemoryStore) MarkStripeEventProcessed(ctx context.Context, eventID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, ok := s.stripeEvents[eventID]; !ok {
		return ErrNotFound
	}
	s.stripeEvents[eventID] = true
	return nil
}

func (s *MemoryStore) AdminOverview(ctx context.Context) (AdminOverview, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	var overview AdminOverview
	overview.UsersTotal = int64(len(s.usersByID))
	for _, user := range s.usersByID {
		switch user.Status {
		case "active":
			overview.ActiveUsers++
		case "disabled":
			overview.DisabledUsers++
		}
	}
	overview.OrdersTotal = int64(len(s.orders))
	for _, record := range s.llmCalls {
		overview.LLMCallsTotal++
		if record.Status == "failed" {
			overview.LLMCallsFailed++
		}
		overview.CreditsCostTotal += record.CreditsCost
	}
	return overview, nil
}

func (s *MemoryStore) AdminUsers(ctx context.Context, opts AdminListOptions) ([]AdminUserSummary, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	limit, offset := normalizeLimitOffset(opts.Limit, opts.Offset)
	query := strings.ToLower(strings.TrimSpace(opts.Query))
	users := make([]User, 0, len(s.usersByID))
	for _, user := range s.usersByID {
		if query != "" && !strings.Contains(user.Email, query) && !strings.Contains(strings.ToLower(user.Name), query) {
			continue
		}
		if opts.Status != "" && user.Status != opts.Status {
			continue
		}
		users = append(users, user)
	}
	sort.Slice(users, func(i, j int) bool {
		return users[i].CreatedAt.After(users[j].CreatedAt)
	})
	if offset > len(users) {
		return []AdminUserSummary{}, nil
	}
	end := minInt(offset+limit, len(users))
	result := make([]AdminUserSummary, 0, end-offset)
	for _, user := range users[offset:end] {
		result = append(result, s.adminUserSummaryLocked(user))
	}
	return result, nil
}

func (s *MemoryStore) AdminUserDetail(ctx context.Context, userID string) (AdminUserDetail, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	user, ok := s.usersByID[userID]
	if !ok {
		return AdminUserDetail{}, ErrNotFound
	}
	detail := AdminUserDetail{
		User:         user,
		Calls:        s.llmCallsByUserLocked(userID, 20),
		Orders:       s.ordersByUserLocked(userID, 20),
		Transactions: make([]billing.Transaction, 0),
	}
	if wallet, ok := s.wallets[userID]; ok {
		snapshot := wallet.Snapshot()
		detail.Wallet = &snapshot
		detail.Transactions = wallet.Transactions()
		sort.Slice(detail.Transactions, func(i, j int) bool {
			return detail.Transactions[i].CreatedAt.After(detail.Transactions[j].CreatedAt)
		})
	}
	return detail, nil
}

func (s *MemoryStore) UpdateUserStatus(ctx context.Context, actorUserID string, userID string, status string, reason string) (User, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	user, ok := s.usersByID[userID]
	if !ok {
		return User{}, ErrNotFound
	}
	user.Status = status
	s.usersByID[user.ID] = user
	s.usersByEmail[user.Email] = user
	s.appendAuditLocked(actorUserID, "admin.user_status_update", "user", userID, reason, map[string]any{"status": status})
	return user, nil
}

func (s *MemoryStore) AdjustExtraCredits(ctx context.Context, actorUserID string, userID string, delta int64, reason string) (*billing.Wallet, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, ok := s.usersByID[userID]; !ok {
		return nil, ErrNotFound
	}
	wallet, ok := s.wallets[userID]
	if !ok {
		wallet = billing.NewWallet(newID("wallet"), 0, 0)
		wallet.UserID = userID
		s.wallets[userID] = wallet
	}
	idempotencyKey := fmt.Sprintf("admin:%s:%s:%d", actorUserID, userID, time.Now().UTC().UnixNano())
	if err := wallet.AdjustExtraCredits(delta, reason, idempotencyKey); err != nil {
		return nil, err
	}
	s.appendAuditLocked(actorUserID, "admin.extra_credit_adjust", "user", userID, reason, map[string]any{"delta": delta})
	return wallet, nil
}

func (s *MemoryStore) AdminLLMCalls(ctx context.Context, opts AdminListOptions) ([]AdminLLMCallRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	limit, offset := normalizeLimitOffset(opts.Limit, opts.Offset)
	records := make([]AdminLLMCallRecord, 0, len(s.llmCalls))
	for _, record := range s.llmCalls {
		if opts.UserID != "" && record.UserID != opts.UserID {
			continue
		}
		if opts.Status != "" && record.Status != opts.Status {
			continue
		}
		item := AdminLLMCallRecord{LLMCallRecord: record}
		if user, ok := s.usersByID[record.UserID]; ok {
			item.UserEmail = user.Email
		}
		records = append(records, item)
	}
	sort.Slice(records, func(i, j int) bool {
		return records[i].StartedAt.After(records[j].StartedAt)
	})
	if offset > len(records) {
		return []AdminLLMCallRecord{}, nil
	}
	return records[offset:minInt(offset+limit, len(records))], nil
}

func (s *MemoryStore) AdminExternalToolCalls(ctx context.Context, opts AdminListOptions) ([]AdminExternalToolCallRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	limit, offset := normalizeLimitOffset(opts.Limit, opts.Offset)
	records := make([]AdminExternalToolCallRecord, 0, len(s.toolCalls))
	for _, record := range s.toolCalls {
		if opts.UserID != "" && record.UserID != opts.UserID {
			continue
		}
		if opts.Status != "" && record.Status != opts.Status {
			continue
		}
		item := AdminExternalToolCallRecord{ExternalToolCallRecord: cloneExternalToolCall(record)}
		if user, ok := s.usersByID[record.UserID]; ok {
			item.UserEmail = user.Email
		}
		records = append(records, item)
	}
	sort.Slice(records, func(i, j int) bool {
		return records[i].StartedAt.After(records[j].StartedAt)
	})
	if offset > len(records) {
		return []AdminExternalToolCallRecord{}, nil
	}
	return records[offset:minInt(offset+limit, len(records))], nil
}

func (s *MemoryStore) AdminPaymentOrders(ctx context.Context, opts AdminListOptions) ([]AdminPaymentOrder, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	limit, offset := normalizeLimitOffset(opts.Limit, opts.Offset)
	orders := make([]AdminPaymentOrder, 0, len(s.orders))
	for _, order := range s.orders {
		userID, email := s.userForWalletLocked(order.WalletID)
		if opts.UserID != "" && userID != opts.UserID {
			continue
		}
		if opts.Status != "" && order.Status != opts.Status {
			continue
		}
		item := AdminPaymentOrder{PaymentOrder: order, UserID: userID, UserEmail: email}
		if wallet := s.walletByIDLocked(order.WalletID); wallet != nil {
			item.PlanCode = wallet.PlanCode
			item.WalletStatus = wallet.Status
		}
		orders = append(orders, item)
	}
	sort.Slice(orders, func(i, j int) bool {
		return orders[i].CreatedAt.After(orders[j].CreatedAt)
	})
	if offset > len(orders) {
		return []AdminPaymentOrder{}, nil
	}
	return orders[offset:minInt(offset+limit, len(orders))], nil
}

func (s *MemoryStore) AdminAgentRuns(ctx context.Context, opts AdminListOptions) ([]AdminAgentRun, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	limit, offset := normalizeLimitOffset(opts.Limit, opts.Offset)
	query := strings.ToLower(strings.TrimSpace(opts.Query))
	runs := make([]AdminAgentRun, 0, len(s.agentRuns))
	for _, run := range s.agentRuns {
		user := s.usersByID[run.UserID]
		if opts.UserID != "" && run.UserID != opts.UserID {
			continue
		}
		if opts.Status != "" && run.Status != opts.Status {
			continue
		}
		if query != "" && !strings.Contains(strings.ToLower(user.Email), query) && !strings.Contains(strings.ToLower(run.ID), query) {
			continue
		}
		runs = append(runs, AdminAgentRun{AgentRun: run, UserEmail: user.Email})
	}
	sort.Slice(runs, func(i, j int) bool {
		return runs[i].CreatedAt.After(runs[j].CreatedAt)
	})
	if offset > len(runs) {
		return []AdminAgentRun{}, nil
	}
	return runs[offset:minInt(offset+limit, len(runs))], nil
}

func (s *MemoryStore) AdminAuditLogs(ctx context.Context, opts AdminListOptions) ([]AuditLog, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	limit, offset := normalizeLimitOffset(opts.Limit, opts.Offset)
	logs := make([]AuditLog, 0, len(s.auditLogs))
	for _, log := range s.auditLogs {
		if opts.UserID != "" && log.ActorUserID != opts.UserID && log.TargetID != opts.UserID {
			continue
		}
		logs = append(logs, log)
	}
	sort.Slice(logs, func(i, j int) bool {
		return logs[i].CreatedAt.After(logs[j].CreatedAt)
	})
	if offset > len(logs) {
		return []AuditLog{}, nil
	}
	return logs[offset:minInt(offset+limit, len(logs))], nil
}

func (s *MemoryStore) HasAuditLog(action string, targetID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	for _, log := range s.auditLogs {
		if log.Action == action && log.TargetID == targetID {
			return true
		}
	}
	return false
}

func (s *MemoryStore) documentByIDLocked(userID string, documentID string) (documents.Document, error) {
	document, ok := s.documents[documentID]
	if !ok || document.UserID != userID || document.Status == documents.StatusDeleted {
		return documents.Document{}, ErrNotFound
	}
	return document, nil
}

func (s *MemoryStore) adminUserSummaryLocked(user User) AdminUserSummary {
	summary := AdminUserSummary{User: user}
	if wallet, ok := s.wallets[user.ID]; ok {
		snapshot := wallet.Snapshot()
		summary.Wallet = &snapshot
	}
	for _, record := range s.llmCalls {
		if record.UserID == user.ID {
			summary.CallsCount++
			summary.CreditsCost += record.CreditsCost
		}
	}
	return summary
}

func (s *MemoryStore) llmCallsByUserLocked(userID string, limit int) []LLMCallRecord {
	records := make([]LLMCallRecord, 0)
	for _, record := range s.llmCalls {
		if record.UserID == userID {
			records = append(records, record)
		}
	}
	sort.Slice(records, func(i, j int) bool {
		return records[i].StartedAt.After(records[j].StartedAt)
	})
	if len(records) > limit {
		return records[:limit]
	}
	return records
}

func (s *MemoryStore) ordersByUserLocked(userID string, limit int) []PaymentOrder {
	orders := make([]PaymentOrder, 0)
	wallet, ok := s.wallets[userID]
	if !ok {
		return orders
	}
	for _, order := range s.orders {
		if order.WalletID == wallet.ID {
			orders = append(orders, order)
		}
	}
	sort.Slice(orders, func(i, j int) bool {
		return orders[i].CreatedAt.After(orders[j].CreatedAt)
	})
	if len(orders) > limit {
		return orders[:limit]
	}
	return orders
}

func (s *MemoryStore) userForWalletLocked(walletID string) (string, string) {
	for userID, wallet := range s.wallets {
		if wallet.ID == walletID {
			if user, ok := s.usersByID[userID]; ok {
				return user.ID, user.Email
			}
		}
	}
	return "", ""
}

func (s *MemoryStore) walletByIDLocked(walletID string) *billing.Wallet {
	for _, wallet := range s.wallets {
		if wallet.ID == walletID {
			return wallet
		}
	}
	return nil
}

func (s *MemoryStore) appendAuditLocked(actorUserID string, action string, targetType string, targetID string, reason string, metadata map[string]any) {
	s.auditLogs = append(s.auditLogs, AuditLog{
		ID:          newID("audit"),
		ActorUserID: actorUserID,
		Action:      action,
		TargetType:  targetType,
		TargetID:    targetID,
		Metadata:    fmt.Sprintf("%v reason=%s", metadata, reason),
		CreatedAt:   time.Now().UTC(),
	})
}

func normalizeEmail(email string) string {
	return strings.ToLower(strings.TrimSpace(email))
}

func normalizeLimitOffset(limit int, offset int) (int, int) {
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	if offset < 0 {
		offset = 0
	}
	return limit, offset
}

func minInt(a int, b int) int {
	if a < b {
		return a
	}
	return b
}

func cloneExternalToolCall(record ExternalToolCallRecord) ExternalToolCallRecord {
	record.ResponseData = cloneMap(record.ResponseData)
	return record
}

func cloneMap(input map[string]any) map[string]any {
	if input == nil {
		return map[string]any{}
	}
	output := make(map[string]any, len(input))
	for key, value := range input {
		output[key] = value
	}
	return output
}

func newID(prefix string) string {
	var bytes [8]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		panic(errors.New("crypto/rand failed"))
	}
	return prefix + "_" + hex.EncodeToString(bytes[:])
}

func newUUID() string {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		panic(err)
	}
	bytes[6] = (bytes[6] & 0x0f) | 0x40
	bytes[8] = (bytes[8] & 0x3f) | 0x80
	encoded := hex.EncodeToString(bytes[:])
	return encoded[0:8] + "-" + encoded[8:12] + "-" + encoded[12:16] + "-" + encoded[16:20] + "-" + encoded[20:32]
}
