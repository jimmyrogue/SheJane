package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"

	"github.com/coldflame/jiandanly/api/internal/billing"
)

type PostgresStore struct {
	db *sql.DB
}

func NewPostgresStore(ctx context.Context, databaseURL string) (*PostgresStore, error) {
	db, err := sql.Open("pgx", databaseURL)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(12)
	db.SetMaxIdleConns(6)
	db.SetConnMaxLifetime(30 * time.Minute)
	if err := db.PingContext(ctx); err != nil {
		return nil, err
	}
	return &PostgresStore{db: db}, nil
}

func (s *PostgresStore) CreateUser(ctx context.Context, email string, passwordHash string, name string) (User, error) {
	var user User
	err := s.db.QueryRowContext(ctx, `
		INSERT INTO users (email, password_hash, name)
		VALUES ($1, $2, $3)
		RETURNING id::text, email, password_hash, name, role, status, created_at
	`, normalizeEmail(email), passwordHash, name).Scan(&user.ID, &user.Email, &user.PasswordHash, &user.Name, &user.Role, &user.Status, &user.CreatedAt)
	if err != nil {
		if isUniqueViolation(err) {
			return User{}, ErrAlreadyExists
		}
		return User{}, err
	}
	return user, nil
}

func (s *PostgresStore) UserByEmail(ctx context.Context, email string) (User, error) {
	return s.userByQuery(ctx, `SELECT id::text, email, password_hash, name, role, status, created_at FROM users WHERE email=$1`, normalizeEmail(email))
}

func (s *PostgresStore) UserByID(ctx context.Context, id string) (User, error) {
	return s.userByQuery(ctx, `SELECT id::text, email, password_hash, name, role, status, created_at FROM users WHERE id=$1`, id)
}

func (s *PostgresStore) UpdateUserRole(ctx context.Context, userID string, role string) (User, error) {
	return scanUser(s.db.QueryRowContext(ctx, `
		UPDATE users
		SET role=$2, updated_at=NOW()
		WHERE id=$1
		RETURNING id::text, email, password_hash, name, role, status, created_at
	`, userID, role))
}

func (s *PostgresStore) SaveRefreshToken(ctx context.Context, token string, userID string, expiresAt time.Time) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO refresh_tokens (token, user_id, expires_at) VALUES ($1, $2, $3)`, hashToken(token), userID, expiresAt)
	return err
}

func (s *PostgresStore) UseRefreshToken(ctx context.Context, token string) (User, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return User{}, err
	}
	defer rollback(tx)

	var userID string
	var expiresAt time.Time
	var revokedAt sql.NullTime
	err = tx.QueryRowContext(ctx, `SELECT user_id::text, expires_at, revoked_at FROM refresh_tokens WHERE token=$1 FOR UPDATE`, hashToken(token)).Scan(&userID, &expiresAt, &revokedAt)
	if err != nil {
		return User{}, mapNotFound(err)
	}
	if revokedAt.Valid || time.Now().UTC().After(expiresAt) {
		return User{}, ErrNotFound
	}
	if _, err := tx.ExecContext(ctx, `UPDATE refresh_tokens SET revoked_at=NOW() WHERE token=$1`, hashToken(token)); err != nil {
		return User{}, err
	}
	user, err := scanUser(tx.QueryRowContext(ctx, `SELECT id::text, email, password_hash, name, role, status, created_at FROM users WHERE id=$1`, userID))
	if err != nil {
		return User{}, err
	}
	return user, tx.Commit()
}

func (s *PostgresStore) RevokeRefreshToken(ctx context.Context, token string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE refresh_tokens SET revoked_at=NOW() WHERE token=$1 AND revoked_at IS NULL`, hashToken(token))
	return err
}

func (s *PostgresStore) EnsureWallet(ctx context.Context, userID string, monthlyCredits int64) (*billing.Wallet, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer rollback(tx)
	if err := ensureWalletTx(ctx, tx, userID, monthlyCredits); err != nil {
		return nil, err
	}
	wallet, err := selectWalletTx(ctx, tx, userID, false)
	if err != nil {
		return nil, err
	}
	return wallet, tx.Commit()
}

func (s *PostgresStore) WalletByUser(ctx context.Context, userID string) (*billing.Wallet, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer rollback(tx)
	wallet, err := selectWalletTx(ctx, tx, userID, false)
	if err != nil {
		return nil, err
	}
	return wallet, tx.Commit()
}

func (s *PostgresStore) ReserveUsage(ctx context.Context, userID string, monthlyCredits int64, estimatedCredits int64, meta billing.ReservationMeta) (*billing.Reservation, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer rollback(tx)

	if err := ensureWalletTx(ctx, tx, userID, monthlyCredits); err != nil {
		return nil, err
	}
	wallet, err := selectWalletTx(ctx, tx, userID, true)
	if err != nil {
		return nil, err
	}
	if estimatedCredits <= 0 {
		estimatedCredits = 1
	}

	monthlyRemaining := wallet.MonthlyCreditLimit - wallet.MonthlyCreditsUsed
	if monthlyRemaining < 0 {
		monthlyRemaining = 0
	}
	monthlyReserved := minInt64(estimatedCredits, monthlyRemaining)
	extraReserved := estimatedCredits - monthlyReserved
	if extraReserved > wallet.ExtraCreditsBalance {
		return nil, fmt.Errorf("%w: need %d credits, have %d", billing.ErrInsufficientCredits, estimatedCredits, monthlyRemaining+wallet.ExtraCreditsBalance)
	}

	wallet.MonthlyCreditsUsed += monthlyReserved
	wallet.ExtraCreditsBalance -= extraReserved
	if _, err := tx.ExecContext(ctx, `UPDATE wallets SET monthly_credits_used=$1, extra_credits_balance=$2, updated_at=NOW() WHERE id=$3`, wallet.MonthlyCreditsUsed, wallet.ExtraCreditsBalance, wallet.ID); err != nil {
		return nil, err
	}

	reservation := &billing.Reservation{
		WalletID:         wallet.ID,
		ReservationMeta:  meta,
		EstimatedCredits: estimatedCredits,
		MonthlyCredits:   monthlyReserved,
		ExtraCredits:     extraReserved,
		Status:           billing.ReservationReserved,
	}
	err = tx.QueryRowContext(ctx, `
		INSERT INTO usage_reservations (
			wallet_id, user_id, organization_id, client_conversation_id, client_message_id,
			request_id, mode, estimated_credits, reserved_monthly_credits, reserved_extra_credits
		) VALUES ($1, $2, NULLIF($3, '')::uuid, $4, $5, $6, $7, $8, $9, $10)
		RETURNING id::text, created_at
	`, wallet.ID, userID, meta.OrganizationID, meta.ClientConversationID, meta.ClientMessageID, meta.RequestID, meta.Mode, estimatedCredits, monthlyReserved, extraReserved).
		Scan(&reservation.ID, &reservation.CreatedAt)
	if err != nil {
		return nil, err
	}
	if err := insertWalletTransaction(ctx, tx, wallet.ID, reservation.ID, "usage_reserve", -estimatedCredits, wallet.MonthlyCreditsUsed, wallet.ExtraCreditsBalance, "reserved credits for model request", meta.RequestID); err != nil {
		return nil, err
	}
	return reservation, tx.Commit()
}

func (s *PostgresStore) SettleUsage(ctx context.Context, userID string, reservationID string, actualCredits int64) error {
	return s.finishReservation(ctx, userID, reservationID, actualCredits, false)
}

func (s *PostgresStore) ReleaseUsage(ctx context.Context, userID string, reservationID string) error {
	return s.finishReservation(ctx, userID, reservationID, 0, true)
}

func (s *PostgresStore) CreateLLMCall(ctx context.Context, record LLMCallRecord) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO llm_call_records (
			request_id, user_id, wallet_id, reservation_id, client_conversation_id, client_message_id,
			mode, scene, model, provider, input_tokens, output_tokens, credits_cost, status, started_at
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
	`, record.RequestID, record.UserID, record.WalletID, record.ReservationID, record.ClientConversationID, record.ClientMessageID, record.Mode, record.Scene, record.Model, record.Provider, record.InputTokens, record.OutputTokens, record.CreditsCost, record.Status, nonZeroTime(record.StartedAt))
	return err
}

func (s *PostgresStore) FinishLLMCall(ctx context.Context, requestID string, status string, inputTokens int, outputTokens int, creditsCost int64, errorMessage string) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE llm_call_records
		SET status=$2, input_tokens=$3, output_tokens=$4, credits_cost=$5, error_message=$6, finished_at=NOW()
		WHERE request_id=$1
	`, requestID, status, inputTokens, outputTokens, creditsCost, nullableString(errorMessage))
	return err
}

func (s *PostgresStore) LLMCallsByUser(ctx context.Context, userID string) ([]LLMCallRecord, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT request_id, user_id::text, wallet_id::text, COALESCE(reservation_id::text, ''),
			COALESCE(client_conversation_id,''), COALESCE(client_message_id,''), mode, COALESCE(scene,''),
			COALESCE(model,''), COALESCE(provider,''), input_tokens, output_tokens, credits_cost, status,
			COALESCE(error_code,''), COALESCE(error_message,''), started_at, COALESCE(finished_at, '0001-01-01'::timestamptz)
		FROM llm_call_records
		WHERE user_id=$1
		ORDER BY started_at DESC
		LIMIT 100
	`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	records := make([]LLMCallRecord, 0)
	for rows.Next() {
		var record LLMCallRecord
		if err := rows.Scan(&record.RequestID, &record.UserID, &record.WalletID, &record.ReservationID, &record.ClientConversationID, &record.ClientMessageID, &record.Mode, &record.Scene, &record.Model, &record.Provider, &record.InputTokens, &record.OutputTokens, &record.CreditsCost, &record.Status, &record.ErrorCode, &record.ErrorMessage, &record.StartedAt, &record.FinishedAt); err != nil {
			return nil, err
		}
		records = append(records, record)
	}
	return records, rows.Err()
}

func (s *PostgresStore) CreatePaymentOrder(ctx context.Context, order PaymentOrder) (PaymentOrder, error) {
	if order.Status == "" {
		order.Status = "pending"
	}
	if order.CreatedAt.IsZero() {
		order.CreatedAt = time.Now().UTC()
	}
	err := s.db.QueryRowContext(ctx, `
		INSERT INTO payment_orders (wallet_id, type, amount_cny, status, checkout_url, stripe_checkout_session_id, stripe_subscription_id, idempotency_key, created_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
		RETURNING id::text, created_at
	`, order.WalletID, order.Type, order.AmountCNY, order.Status, order.CheckoutURL, nullableString(order.StripeSessionID), nullableString(order.StripeSubscriptionID), nullableString(order.IdempotencyKey), order.CreatedAt).
		Scan(&order.ID, &order.CreatedAt)
	return order, err
}

func (s *PostgresStore) PaymentOrdersByWallet(ctx context.Context, walletID string) ([]PaymentOrder, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id::text, wallet_id::text, type, amount_cny, status, COALESCE(checkout_url,''), COALESCE(stripe_checkout_session_id,''), COALESCE(stripe_subscription_id,''), COALESCE(idempotency_key,''), created_at
		FROM payment_orders
		WHERE wallet_id=$1
		ORDER BY created_at DESC
	`, walletID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	orders := make([]PaymentOrder, 0)
	for rows.Next() {
		var order PaymentOrder
		if err := rows.Scan(&order.ID, &order.WalletID, &order.Type, &order.AmountCNY, &order.Status, &order.CheckoutURL, &order.StripeSessionID, &order.StripeSubscriptionID, &order.IdempotencyKey, &order.CreatedAt); err != nil {
			return nil, err
		}
		orders = append(orders, order)
	}
	return orders, rows.Err()
}

func (s *PostgresStore) MarkSubscriptionPaid(ctx context.Context, stripeSessionID string, stripeSubscriptionID string, eventID string, monthlyCredits int64, periodEnd time.Time) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer rollback(tx)
	if periodEnd.IsZero() {
		periodEnd = time.Now().UTC().AddDate(0, 1, 0)
	}
	if eventID == "" {
		eventID = stripeSessionID
	}

	var walletID string
	err = tx.QueryRowContext(ctx, `
		UPDATE payment_orders
		SET status='paid', stripe_subscription_id=COALESCE(NULLIF($2, ''), stripe_subscription_id)
		WHERE stripe_checkout_session_id=$1 OR id::text=$1
		RETURNING wallet_id::text
	`, stripeSessionID, stripeSubscriptionID).Scan(&walletID)
	if err != nil {
		return mapNotFound(err)
	}

	var monthlyUsed int64
	var extraBalance int64
	err = tx.QueryRowContext(ctx, `
		UPDATE wallets
		SET plan_code='pro',
			monthly_credit_limit=$2,
			monthly_credits_used=0,
			period_start=NOW(),
			period_end=$3,
			status='active',
			stripe_subscription_id=COALESCE(NULLIF($4, ''), stripe_subscription_id),
			updated_at=NOW()
		WHERE id=$1
		RETURNING monthly_credits_used, extra_credits_balance
	`, walletID, monthlyCredits, periodEnd, stripeSubscriptionID).Scan(&monthlyUsed, &extraBalance)
	if err != nil {
		return err
	}
	if err := insertWalletTransaction(ctx, tx, walletID, "", "subscription_grant", monthlyCredits, monthlyUsed, extraBalance, "monthly subscription credits granted", "stripe:"+eventID); err != nil {
		return err
	}
	if err := insertAuditLog(ctx, tx, "", "billing.subscription_paid", "wallet", walletID, map[string]any{"event_id": eventID, "stripe_checkout_session_id": stripeSessionID, "stripe_subscription_id": stripeSubscriptionID}); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *PostgresStore) MarkSubscriptionRenewed(ctx context.Context, stripeSubscriptionID string, eventID string, monthlyCredits int64, periodEnd time.Time) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer rollback(tx)
	if periodEnd.IsZero() {
		periodEnd = time.Now().UTC().AddDate(0, 1, 0)
	}

	var walletID string
	var monthlyUsed int64
	var extraBalance int64
	err = tx.QueryRowContext(ctx, `
		UPDATE wallets
		SET plan_code='pro',
			monthly_credit_limit=$2,
			monthly_credits_used=0,
			period_start=NOW(),
			period_end=$3,
			status='active',
			updated_at=NOW()
		WHERE stripe_subscription_id=$1
		RETURNING id::text, monthly_credits_used, extra_credits_balance
	`, stripeSubscriptionID, monthlyCredits, periodEnd).Scan(&walletID, &monthlyUsed, &extraBalance)
	if err != nil {
		return mapNotFound(err)
	}
	if err := insertWalletTransaction(ctx, tx, walletID, "", "subscription_grant", monthlyCredits, monthlyUsed, extraBalance, "monthly subscription credits renewed", "stripe:"+eventID); err != nil {
		return err
	}
	if err := insertAuditLog(ctx, tx, "", "billing.subscription_renewed", "wallet", walletID, map[string]any{"event_id": eventID, "stripe_subscription_id": stripeSubscriptionID}); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *PostgresStore) UpdateSubscriptionStatus(ctx context.Context, stripeSubscriptionID string, status string, periodEnd time.Time) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer rollback(tx)

	var walletID string
	if periodEnd.IsZero() {
		err = tx.QueryRowContext(ctx, `
			UPDATE wallets
			SET status=$2, updated_at=NOW()
			WHERE stripe_subscription_id=$1
			RETURNING id::text
		`, stripeSubscriptionID, status).Scan(&walletID)
	} else {
		err = tx.QueryRowContext(ctx, `
			UPDATE wallets
			SET status=$2, period_end=$3, updated_at=NOW()
			WHERE stripe_subscription_id=$1
			RETURNING id::text
		`, stripeSubscriptionID, status, periodEnd).Scan(&walletID)
	}
	if err != nil {
		return mapNotFound(err)
	}
	if status != "active" {
		if _, err := tx.ExecContext(ctx, `
			UPDATE payment_orders
			SET status=$2
			WHERE stripe_subscription_id=$1 AND type='subscription'
		`, stripeSubscriptionID, status); err != nil {
			return err
		}
	}
	if err := insertAuditLog(ctx, tx, "", "billing.subscription_status_update", "wallet", walletID, map[string]any{"status": status, "stripe_subscription_id": stripeSubscriptionID}); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *PostgresStore) RecordStripeEvent(ctx context.Context, eventID string, eventType string, payload []byte) (bool, error) {
	var raw json.RawMessage = payload
	if _, err := s.db.ExecContext(ctx, `
		INSERT INTO stripe_events (stripe_event_id, event_type, payload)
		VALUES ($1, $2, $3)
		ON CONFLICT (stripe_event_id) DO NOTHING
	`, eventID, eventType, raw); err != nil {
		return false, err
	}
	var processedAt sql.NullTime
	if err := s.db.QueryRowContext(ctx, `SELECT processed_at FROM stripe_events WHERE stripe_event_id=$1`, eventID).Scan(&processedAt); err != nil {
		return false, err
	}
	return !processedAt.Valid, nil
}

func (s *PostgresStore) MarkStripeEventProcessed(ctx context.Context, eventID string) error {
	result, err := s.db.ExecContext(ctx, `UPDATE stripe_events SET processed_at=NOW() WHERE stripe_event_id=$1`, eventID)
	if err != nil {
		return err
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if rows == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *PostgresStore) AdminOverview(ctx context.Context) (AdminOverview, error) {
	var overview AdminOverview
	if err := s.db.QueryRowContext(ctx, `
		SELECT
			COUNT(*),
			COUNT(*) FILTER (WHERE status='active'),
			COUNT(*) FILTER (WHERE status='disabled')
		FROM users
	`).Scan(&overview.UsersTotal, &overview.ActiveUsers, &overview.DisabledUsers); err != nil {
		return AdminOverview{}, err
	}
	if err := s.db.QueryRowContext(ctx, `
		SELECT
			COUNT(*),
			COUNT(*) FILTER (WHERE status='failed'),
			COALESCE(SUM(credits_cost), 0)
		FROM llm_call_records
	`).Scan(&overview.LLMCallsTotal, &overview.LLMCallsFailed, &overview.CreditsCostTotal); err != nil {
		return AdminOverview{}, err
	}
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM payment_orders`).Scan(&overview.OrdersTotal); err != nil {
		return AdminOverview{}, err
	}
	return overview, nil
}

func (s *PostgresStore) AdminUsers(ctx context.Context, opts AdminListOptions) ([]AdminUserSummary, error) {
	limit, offset := normalizeLimitOffset(opts.Limit, opts.Offset)
	rows, err := s.db.QueryContext(ctx, `
		SELECT id::text, email, password_hash, name, role, status, created_at
		FROM users
		WHERE ($1='' OR email ILIKE '%' || $1 || '%' OR name ILIKE '%' || $1 || '%')
			AND ($2='' OR status=$2)
		ORDER BY created_at DESC
		LIMIT $3 OFFSET $4
	`, strings.TrimSpace(opts.Query), opts.Status, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := make([]AdminUserSummary, 0)
	for rows.Next() {
		user, err := scanUser(rows)
		if err != nil {
			return nil, err
		}
		summary := AdminUserSummary{User: user}
		if wallet, err := s.WalletByUser(ctx, user.ID); err == nil {
			snapshot := wallet.Snapshot()
			summary.Wallet = &snapshot
		} else if !errors.Is(err, ErrNotFound) {
			return nil, err
		}
		if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*), COALESCE(SUM(credits_cost), 0) FROM llm_call_records WHERE user_id=$1`, user.ID).Scan(&summary.CallsCount, &summary.CreditsCost); err != nil {
			return nil, err
		}
		result = append(result, summary)
	}
	return result, rows.Err()
}

func (s *PostgresStore) AdminUserDetail(ctx context.Context, userID string) (AdminUserDetail, error) {
	user, err := s.UserByID(ctx, userID)
	if err != nil {
		return AdminUserDetail{}, err
	}
	detail := AdminUserDetail{User: user, Calls: make([]LLMCallRecord, 0), Orders: make([]PaymentOrder, 0), Transactions: make([]billing.Transaction, 0)}
	wallet, err := s.WalletByUser(ctx, userID)
	if err == nil {
		snapshot := wallet.Snapshot()
		detail.Wallet = &snapshot
		detail.Orders, err = s.PaymentOrdersByWallet(ctx, wallet.ID)
		if err != nil {
			return AdminUserDetail{}, err
		}
		detail.Transactions, err = s.walletTransactionsByWallet(ctx, wallet.ID, 50)
		if err != nil {
			return AdminUserDetail{}, err
		}
	} else if !errors.Is(err, ErrNotFound) {
		return AdminUserDetail{}, err
	}
	detail.Calls, err = s.LLMCallsByUser(ctx, userID)
	if err != nil {
		return AdminUserDetail{}, err
	}
	return detail, nil
}

func (s *PostgresStore) UpdateUserStatus(ctx context.Context, actorUserID string, userID string, status string, reason string) (User, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return User{}, err
	}
	defer rollback(tx)

	user, err := scanUser(tx.QueryRowContext(ctx, `
		UPDATE users
		SET status=$2, updated_at=NOW()
		WHERE id=$1
		RETURNING id::text, email, password_hash, name, role, status, created_at
	`, userID, status))
	if err != nil {
		return User{}, err
	}
	if err := insertAuditLog(ctx, tx, actorUserID, "admin.user_status_update", "user", userID, map[string]any{"status": status, "reason": reason}); err != nil {
		return User{}, err
	}
	return user, tx.Commit()
}

func (s *PostgresStore) AdjustExtraCredits(ctx context.Context, actorUserID string, userID string, delta int64, reason string) (*billing.Wallet, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer rollback(tx)

	var userExists bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM users WHERE id=$1)`, userID).Scan(&userExists); err != nil {
		return nil, err
	}
	if !userExists {
		return nil, ErrNotFound
	}
	if err := ensureWalletTx(ctx, tx, userID, 0); err != nil {
		return nil, err
	}
	wallet, err := selectWalletTx(ctx, tx, userID, true)
	if err != nil {
		return nil, err
	}
	nextExtra := wallet.ExtraCreditsBalance + delta
	if nextExtra < 0 {
		return nil, fmt.Errorf("%w: extra credits cannot go below zero", billing.ErrInsufficientCredits)
	}
	wallet.ExtraCreditsBalance = nextExtra
	if _, err := tx.ExecContext(ctx, `UPDATE wallets SET extra_credits_balance=$1, updated_at=NOW() WHERE id=$2`, wallet.ExtraCreditsBalance, wallet.ID); err != nil {
		return nil, err
	}
	idempotencyKey := fmt.Sprintf("admin:%s:%s:%d", actorUserID, userID, time.Now().UTC().UnixNano())
	if err := insertWalletTransaction(ctx, tx, wallet.ID, "", "admin_adjust", delta, wallet.MonthlyCreditsUsed, wallet.ExtraCreditsBalance, reason, idempotencyKey); err != nil {
		return nil, err
	}
	if err := insertAuditLog(ctx, tx, actorUserID, "admin.extra_credit_adjust", "user", userID, map[string]any{"delta": delta, "reason": reason}); err != nil {
		return nil, err
	}
	return wallet, tx.Commit()
}

func (s *PostgresStore) AdminLLMCalls(ctx context.Context, opts AdminListOptions) ([]AdminLLMCallRecord, error) {
	limit, offset := normalizeLimitOffset(opts.Limit, opts.Offset)
	rows, err := s.db.QueryContext(ctx, `
		SELECT c.request_id, c.user_id::text, c.wallet_id::text, COALESCE(c.reservation_id::text, ''),
			COALESCE(c.client_conversation_id,''), COALESCE(c.client_message_id,''), c.mode, COALESCE(c.scene,''),
			COALESCE(c.model,''), COALESCE(c.provider,''), c.input_tokens, c.output_tokens, c.credits_cost, c.status,
			COALESCE(c.error_code,''), COALESCE(c.error_message,''), c.started_at, COALESCE(c.finished_at, '0001-01-01'::timestamptz),
			u.email
		FROM llm_call_records c
		JOIN users u ON u.id = c.user_id
		WHERE ($1='' OR c.user_id::text=$1)
			AND ($2='' OR c.status=$2)
		ORDER BY c.started_at DESC
		LIMIT $3 OFFSET $4
	`, opts.UserID, opts.Status, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	records := make([]AdminLLMCallRecord, 0)
	for rows.Next() {
		var item AdminLLMCallRecord
		if err := rows.Scan(&item.RequestID, &item.UserID, &item.WalletID, &item.ReservationID, &item.ClientConversationID, &item.ClientMessageID, &item.Mode, &item.Scene, &item.Model, &item.Provider, &item.InputTokens, &item.OutputTokens, &item.CreditsCost, &item.Status, &item.ErrorCode, &item.ErrorMessage, &item.StartedAt, &item.FinishedAt, &item.UserEmail); err != nil {
			return nil, err
		}
		records = append(records, item)
	}
	return records, rows.Err()
}

func (s *PostgresStore) AdminPaymentOrders(ctx context.Context, opts AdminListOptions) ([]AdminPaymentOrder, error) {
	limit, offset := normalizeLimitOffset(opts.Limit, opts.Offset)
	rows, err := s.db.QueryContext(ctx, `
		SELECT o.id::text, o.wallet_id::text, o.type, o.amount_cny, o.status, COALESCE(o.checkout_url,''),
			COALESCE(o.stripe_checkout_session_id,''), COALESCE(o.stripe_subscription_id,''), COALESCE(o.idempotency_key,''), o.created_at,
			u.id::text, u.email, w.plan_code, w.status
		FROM payment_orders o
		JOIN wallets w ON w.id = o.wallet_id
		JOIN users u ON u.id = w.user_id
		WHERE ($1='' OR u.id::text=$1)
			AND ($2='' OR o.status=$2)
		ORDER BY o.created_at DESC
		LIMIT $3 OFFSET $4
	`, opts.UserID, opts.Status, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	orders := make([]AdminPaymentOrder, 0)
	for rows.Next() {
		var item AdminPaymentOrder
		if err := rows.Scan(&item.ID, &item.WalletID, &item.Type, &item.AmountCNY, &item.Status, &item.CheckoutURL, &item.StripeSessionID, &item.StripeSubscriptionID, &item.IdempotencyKey, &item.CreatedAt, &item.UserID, &item.UserEmail, &item.PlanCode, &item.WalletStatus); err != nil {
			return nil, err
		}
		orders = append(orders, item)
	}
	return orders, rows.Err()
}

func (s *PostgresStore) AdminAuditLogs(ctx context.Context, opts AdminListOptions) ([]AuditLog, error) {
	limit, offset := normalizeLimitOffset(opts.Limit, opts.Offset)
	rows, err := s.db.QueryContext(ctx, `
		SELECT id::text, COALESCE(actor_user_id::text, ''), action, COALESCE(target_type, ''),
			COALESCE(target_id::text, ''), metadata::text, created_at
		FROM audit_logs
		WHERE ($1='' OR actor_user_id::text=$1 OR target_id::text=$1)
		ORDER BY created_at DESC
		LIMIT $2 OFFSET $3
	`, opts.UserID, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	logs := make([]AuditLog, 0)
	for rows.Next() {
		var log AuditLog
		if err := rows.Scan(&log.ID, &log.ActorUserID, &log.Action, &log.TargetType, &log.TargetID, &log.Metadata, &log.CreatedAt); err != nil {
			return nil, err
		}
		logs = append(logs, log)
	}
	return logs, rows.Err()
}

func (s *PostgresStore) userByQuery(ctx context.Context, query string, args ...any) (User, error) {
	return scanUser(s.db.QueryRowContext(ctx, query, args...))
}

func (s *PostgresStore) finishReservation(ctx context.Context, userID string, reservationID string, actualCredits int64, release bool) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer rollback(tx)

	var reservation billing.Reservation
	var monthlyLimit int64
	var monthlyUsed int64
	var extraBalance int64
	err = tx.QueryRowContext(ctx, `
		SELECT r.wallet_id::text, r.estimated_credits, r.reserved_monthly_credits, r.reserved_extra_credits, r.status,
			w.monthly_credit_limit, w.monthly_credits_used, w.extra_credits_balance
		FROM usage_reservations r
		JOIN wallets w ON w.id = r.wallet_id
		WHERE r.id=$1 AND r.user_id=$2
		FOR UPDATE
	`, reservationID, userID).Scan(&reservation.WalletID, &reservation.EstimatedCredits, &reservation.MonthlyCredits, &reservation.ExtraCredits, &reservation.Status, &monthlyLimit, &monthlyUsed, &extraBalance)
	if err != nil {
		return mapNotFound(err)
	}
	if reservation.Status != billing.ReservationReserved {
		return fmt.Errorf("reservation %s is %s", reservationID, reservation.Status)
	}

	status := string(billing.ReservationSettled)
	transactionType := "usage_settle"
	transactionAmount := -actualCredits
	description := "settled actual model usage"
	if release {
		actualCredits = 0
		status = string(billing.ReservationReleased)
		transactionType = "usage_release"
		transactionAmount = reservation.EstimatedCredits
		description = "released unused reservation"
	}

	if actualCredits > reservation.EstimatedCredits {
		delta := actualCredits - reservation.EstimatedCredits
		monthlyRemaining := monthlyLimit - monthlyUsed
		if monthlyRemaining < 0 {
			monthlyRemaining = 0
		}
		monthlyExtra := minInt64(delta, monthlyRemaining)
		extraNeeded := delta - monthlyExtra
		if extraNeeded > extraBalance {
			return fmt.Errorf("%w: settlement needs %d additional credits", billing.ErrInsufficientCredits, delta)
		}
		monthlyUsed += monthlyExtra
		extraBalance -= extraNeeded
	}

	if actualCredits < reservation.EstimatedCredits {
		refund := reservation.EstimatedCredits - actualCredits
		extraRefund := minInt64(refund, reservation.ExtraCredits)
		extraBalance += extraRefund
		refund -= extraRefund
		monthlyRefund := minInt64(refund, reservation.MonthlyCredits)
		monthlyUsed -= monthlyRefund
	}

	if _, err := tx.ExecContext(ctx, `UPDATE wallets SET monthly_credits_used=$1, extra_credits_balance=$2, updated_at=NOW() WHERE id=$3`, monthlyUsed, extraBalance, reservation.WalletID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE usage_reservations SET actual_credits=$1, status=$2, settled_at=NOW() WHERE id=$3`, actualCredits, status, reservationID); err != nil {
		return err
	}
	if err := insertWalletTransaction(ctx, tx, reservation.WalletID, reservationID, transactionType, transactionAmount, monthlyUsed, extraBalance, description, reservationID+":"+transactionType); err != nil {
		return err
	}
	return tx.Commit()
}

func ensureWalletTx(ctx context.Context, tx *sql.Tx, userID string, monthlyCredits int64) error {
	_, err := tx.ExecContext(ctx, `
		INSERT INTO wallets (owner_type, user_id, plan_code, monthly_credit_limit, period_start, period_end)
		VALUES ('user', $1, 'free_trial', $2, NOW(), NOW() + INTERVAL '30 days')
		ON CONFLICT (user_id) DO NOTHING
	`, userID, monthlyCredits)
	return err
}

func selectWalletTx(ctx context.Context, tx *sql.Tx, userID string, forUpdate bool) (*billing.Wallet, error) {
	query := `
		SELECT id::text, COALESCE(user_id::text,''), plan_code, monthly_credit_limit, monthly_credits_used,
			extra_credits_balance, period_start, period_end, status, COALESCE(stripe_subscription_id, '')
		FROM wallets
		WHERE user_id=$1
	`
	if forUpdate {
		query += " FOR UPDATE"
	}
	var id string
	var walletUserID string
	var planCode string
	var monthlyLimit int64
	var monthlyUsed int64
	var extraBalance int64
	var periodStart time.Time
	var periodEnd time.Time
	var status string
	var stripeSubscriptionID string
	err := tx.QueryRowContext(ctx, query, userID).Scan(&id, &walletUserID, &planCode, &monthlyLimit, &monthlyUsed, &extraBalance, &periodStart, &periodEnd, &status, &stripeSubscriptionID)
	if err != nil {
		return nil, mapNotFound(err)
	}
	wallet := billing.NewWallet(id, monthlyLimit, extraBalance)
	wallet.UserID = walletUserID
	wallet.PlanCode = planCode
	wallet.MonthlyCreditsUsed = monthlyUsed
	wallet.PeriodStart = periodStart
	wallet.PeriodEnd = periodEnd
	wallet.Status = status
	wallet.StripeSubscriptionID = stripeSubscriptionID
	return wallet, nil
}

func insertWalletTransaction(ctx context.Context, tx *sql.Tx, walletID string, reservationID string, txType string, amount int64, monthlyUsedAfter int64, extraBalanceAfter int64, description string, idempotencyKey string) error {
	_, err := tx.ExecContext(ctx, `
		INSERT INTO wallet_transactions (
			wallet_id, reservation_id, type, amount, monthly_used_after, extra_balance_after, description, idempotency_key
		) VALUES ($1, NULLIF($2, '')::uuid, $3, $4, $5, $6, $7, $8)
		ON CONFLICT (idempotency_key) DO NOTHING
	`, walletID, reservationID, txType, amount, monthlyUsedAfter, extraBalanceAfter, description, idempotencyKey)
	return err
}

func insertAuditLog(ctx context.Context, tx *sql.Tx, actorUserID string, action string, targetType string, targetID string, metadata map[string]any) error {
	raw, err := json.Marshal(metadata)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `
		INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, metadata)
		VALUES (NULLIF($1, '')::uuid, $2, $3, NULLIF($4, '')::uuid, $5)
	`, actorUserID, action, targetType, targetID, json.RawMessage(raw))
	return err
}

func (s *PostgresStore) walletTransactionsByWallet(ctx context.Context, walletID string, limit int) ([]billing.Transaction, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id::text, wallet_id::text, COALESCE(reservation_id::text, ''), type, amount,
			monthly_used_after, extra_balance_after, COALESCE(description, ''), COALESCE(idempotency_key, ''), created_at
		FROM wallet_transactions
		WHERE wallet_id=$1
		ORDER BY created_at DESC
		LIMIT $2
	`, walletID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	transactions := make([]billing.Transaction, 0)
	for rows.Next() {
		var tx billing.Transaction
		if err := rows.Scan(&tx.ID, &tx.WalletID, &tx.ReservationID, &tx.Type, &tx.Amount, &tx.MonthlyUsedAfter, &tx.ExtraBalanceAfter, &tx.Description, &tx.IdempotencyKey, &tx.CreatedAt); err != nil {
			return nil, err
		}
		transactions = append(transactions, tx)
	}
	return transactions, rows.Err()
}

type rowScanner interface {
	Scan(dest ...any) error
}

func scanUser(row rowScanner) (User, error) {
	var user User
	err := row.Scan(&user.ID, &user.Email, &user.PasswordHash, &user.Name, &user.Role, &user.Status, &user.CreatedAt)
	if err != nil {
		return User{}, mapNotFound(err)
	}
	return user, nil
}

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func nullableString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func nonZeroTime(value time.Time) time.Time {
	if value.IsZero() {
		return time.Now().UTC()
	}
	return value
}

func rollback(tx *sql.Tx) {
	_ = tx.Rollback()
}

func mapNotFound(err error) error {
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	return err
}

func isUniqueViolation(err error) bool {
	return err != nil && (contains(err.Error(), "duplicate key") || contains(err.Error(), "SQLSTATE 23505"))
}

func contains(value string, needle string) bool {
	return len(value) >= len(needle) && (value == needle || len(needle) == 0 || stringContains(value, needle))
}

func stringContains(value string, needle string) bool {
	for i := 0; i+len(needle) <= len(value); i++ {
		if value[i:i+len(needle)] == needle {
			return true
		}
	}
	return false
}

func minInt64(a int64, b int64) int64 {
	if a < b {
		return a
	}
	return b
}
