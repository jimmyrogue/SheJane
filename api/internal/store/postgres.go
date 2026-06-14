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

	"github.com/coldflame/shejane/api/internal/billing"
	"github.com/coldflame/shejane/api/internal/documents"
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

// Ping verifies the database connection for the /readyz readiness probe.
func (s *PostgresStore) Ping(ctx context.Context) error {
	return s.db.PingContext(ctx)
}

func (s *PostgresStore) CreateUser(ctx context.Context, email string, passwordHash string, name string) (User, error) {
	var user User
	err := s.db.QueryRowContext(ctx, `
		INSERT INTO users (email, password_hash, name)
		VALUES ($1, $2, $3)
		RETURNING id::text, email, password_hash, name, role, status, created_at, email_verified
	`, normalizeEmail(email), passwordHash, name).Scan(&user.ID, &user.Email, &user.PasswordHash, &user.Name, &user.Role, &user.Status, &user.CreatedAt, &user.EmailVerified)
	if err != nil {
		if isUniqueViolation(err) {
			return User{}, ErrAlreadyExists
		}
		return User{}, err
	}
	return user, nil
}

func (s *PostgresStore) UserByEmail(ctx context.Context, email string) (User, error) {
	return s.userByQuery(ctx, `SELECT id::text, email, password_hash, name, role, status, created_at, email_verified FROM users WHERE email=$1`, normalizeEmail(email))
}

func (s *PostgresStore) UserByID(ctx context.Context, id string) (User, error) {
	return s.userByQuery(ctx, `SELECT id::text, email, password_hash, name, role, status, created_at, email_verified FROM users WHERE id=$1`, id)
}

func (s *PostgresStore) UpdateUserRole(ctx context.Context, userID string, role string) (User, error) {
	return scanUser(s.db.QueryRowContext(ctx, `
		UPDATE users
		SET role=$2, updated_at=NOW()
		WHERE id=$1
		RETURNING id::text, email, password_hash, name, role, status, created_at, email_verified
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
	user, err := scanUser(tx.QueryRowContext(ctx, `SELECT id::text, email, password_hash, name, role, status, created_at, email_verified FROM users WHERE id=$1`, userID))
	if err != nil {
		return User{}, err
	}
	return user, tx.Commit()
}

func (s *PostgresStore) RevokeRefreshToken(ctx context.Context, token string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE refresh_tokens SET revoked_at=NOW() WHERE token=$1 AND revoked_at IS NULL`, hashToken(token))
	return err
}

func (s *PostgresStore) SavePasswordResetToken(ctx context.Context, token string, userID string, expiresAt time.Time) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO password_reset_tokens (token, user_id, expires_at) VALUES ($1, $2, $3)`, hashToken(token), userID, expiresAt)
	return err
}

func (s *PostgresStore) ResetPasswordWithToken(ctx context.Context, token string, passwordHash string) (string, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return "", err
	}
	defer rollback(tx)

	var userID string
	var expiresAt time.Time
	var usedAt sql.NullTime
	err = tx.QueryRowContext(ctx, `SELECT user_id::text, expires_at, used_at FROM password_reset_tokens WHERE token=$1 FOR UPDATE`, hashToken(token)).Scan(&userID, &expiresAt, &usedAt)
	if err != nil {
		return "", mapNotFound(err)
	}
	if usedAt.Valid || time.Now().UTC().After(expiresAt) {
		return "", ErrNotFound
	}
	if _, err := tx.ExecContext(ctx, `UPDATE password_reset_tokens SET used_at=NOW() WHERE token=$1`, hashToken(token)); err != nil {
		return "", err
	}
	result, err := tx.ExecContext(ctx, `UPDATE users SET password_hash=$2, updated_at=NOW() WHERE id=$1`, userID, passwordHash)
	if err != nil {
		return "", err
	}
	if affected, err := result.RowsAffected(); err != nil {
		return "", err
	} else if affected == 0 {
		return "", ErrNotFound
	}
	// Force re-login everywhere — in the SAME transaction, so a failure here
	// rolls back the password change + token consumption (no half-reset that
	// leaves a compromised session live).
	if _, err := tx.ExecContext(ctx, `UPDATE refresh_tokens SET revoked_at=NOW() WHERE user_id=$1 AND revoked_at IS NULL`, userID); err != nil {
		return "", err
	}
	return userID, tx.Commit()
}

func (s *PostgresStore) SaveEmailVerificationToken(ctx context.Context, token string, userID string, expiresAt time.Time) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO email_verification_tokens (token, user_id, expires_at) VALUES ($1, $2, $3)`, hashToken(token), userID, expiresAt)
	return err
}

func (s *PostgresStore) VerifyEmailWithToken(ctx context.Context, token string) (string, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return "", err
	}
	defer rollback(tx)

	var userID string
	var expiresAt time.Time
	var usedAt sql.NullTime
	err = tx.QueryRowContext(ctx, `SELECT user_id::text, expires_at, used_at FROM email_verification_tokens WHERE token=$1 FOR UPDATE`, hashToken(token)).Scan(&userID, &expiresAt, &usedAt)
	if err != nil {
		return "", mapNotFound(err)
	}
	if usedAt.Valid || time.Now().UTC().After(expiresAt) {
		return "", ErrNotFound
	}
	if _, err := tx.ExecContext(ctx, `UPDATE email_verification_tokens SET used_at=NOW() WHERE token=$1`, hashToken(token)); err != nil {
		return "", err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE users SET email_verified=true, updated_at=NOW() WHERE id=$1`, userID); err != nil {
		return "", err
	}
	return userID, tx.Commit()
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

func (s *PostgresStore) GrantSignupCredits(ctx context.Context, userID string, amount int64) error {
	if amount <= 0 {
		return nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer rollback(tx)
	if err := ensureWalletTx(ctx, tx, userID, 0); err != nil {
		return err
	}
	idempotencyKey := "signup:" + userID
	var exists bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM wallet_transactions WHERE idempotency_key=$1)`, idempotencyKey).Scan(&exists); err != nil {
		return err
	}
	if exists {
		return nil
	}
	wallet, err := selectWalletTx(ctx, tx, userID, true)
	if err != nil {
		return err
	}
	wallet.ExtraCreditsBalance += amount
	if _, err := tx.ExecContext(ctx, `UPDATE wallets SET extra_credits_balance=$1, updated_at=NOW() WHERE id=$2`, wallet.ExtraCreditsBalance, wallet.ID); err != nil {
		return err
	}
	if err := insertWalletTransaction(ctx, tx, wallet.ID, "", "signup_grant", amount, wallet.MonthlyCreditsUsed, wallet.ExtraCreditsBalance, "signup gift credits granted", idempotencyKey); err != nil {
		return err
	}
	if err := insertAuditLog(ctx, tx, "", "billing.signup_grant", "wallet", wallet.ID, map[string]any{"amount": amount}); err != nil {
		return err
	}
	return tx.Commit()
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

func (s *PostgresStore) WalletTransactions(ctx context.Context, userID string) ([]billing.Transaction, error) {
	var walletID string
	err := s.db.QueryRowContext(ctx, `SELECT id::text FROM wallets WHERE user_id=$1`, userID).Scan(&walletID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return []billing.Transaction{}, nil
		}
		return nil, err
	}
	return s.walletTransactionsByWallet(ctx, walletID, 200)
}

func (s *PostgresStore) BillingActivities(ctx context.Context, userID string, limit int) ([]BillingActivity, error) {
	var walletID string
	err := s.db.QueryRowContext(ctx, `SELECT id::text FROM wallets WHERE user_id=$1`, userID).Scan(&walletID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return []BillingActivity{}, nil
		}
		return nil, err
	}

	transactions, err := s.walletTransactionsByWalletWithRun(ctx, walletID, 300)
	if err != nil {
		return nil, err
	}
	adminLLMCalls, err := s.AdminLLMCalls(ctx, AdminListOptions{UserID: userID, Limit: 300})
	if err != nil {
		return nil, err
	}
	adminToolCalls, err := s.AdminExternalToolCalls(ctx, AdminListOptions{UserID: userID, Limit: 300})
	if err != nil {
		return nil, err
	}

	llmCalls := make([]LLMCallRecord, 0, len(adminLLMCalls))
	for _, call := range adminLLMCalls {
		llmCalls = append(llmCalls, call.LLMCallRecord)
	}
	toolCalls := make([]ExternalToolCallRecord, 0, len(adminToolCalls))
	for _, call := range adminToolCalls {
		toolCalls = append(toolCalls, call.ExternalToolCallRecord)
	}
	return buildBillingActivities(transactions, llmCalls, toolCalls, limit), nil
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
			wallet_id, user_id, organization_id, run_id, client_conversation_id, client_message_id,
			request_id, mode, estimated_credits, reserved_monthly_credits, reserved_extra_credits
		) VALUES ($1, $2, NULLIF($3, '')::uuid, $4, $5, $6, $7, $8, $9, $10, $11)
		RETURNING id::text, created_at
	`, wallet.ID, userID, meta.OrganizationID, nullableString(meta.RunID), meta.ClientConversationID, meta.ClientMessageID, meta.RequestID, meta.Mode, estimatedCredits, monthlyReserved, extraReserved).
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
			request_id, user_id, wallet_id, reservation_id, run_id, client_conversation_id, client_message_id,
			mode, scene, model, provider, input_tokens, output_tokens, credits_cost, status, started_at
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
	`, record.RequestID, record.UserID, record.WalletID, record.ReservationID, nullableString(record.RunID), record.ClientConversationID, record.ClientMessageID, record.Mode, record.Scene, record.Model, record.Provider, record.InputTokens, record.OutputTokens, record.CreditsCost, record.Status, nonZeroTime(record.StartedAt))
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
			COALESCE(run_id,''), COALESCE(client_conversation_id,''), COALESCE(client_message_id,''), mode, COALESCE(scene,''),
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
		if err := rows.Scan(&record.RequestID, &record.UserID, &record.WalletID, &record.ReservationID, &record.RunID, &record.ClientConversationID, &record.ClientMessageID, &record.Mode, &record.Scene, &record.Model, &record.Provider, &record.InputTokens, &record.OutputTokens, &record.CreditsCost, &record.Status, &record.ErrorCode, &record.ErrorMessage, &record.StartedAt, &record.FinishedAt); err != nil {
			return nil, err
		}
		records = append(records, record)
	}
	return records, rows.Err()
}

func (s *PostgresStore) CreateExternalToolCall(ctx context.Context, record ExternalToolCallRecord) (ExternalToolCallRecord, bool, error) {
	responseData := record.ResponseData
	if responseData == nil {
		responseData = map[string]any{}
	}
	responseJSON, err := json.Marshal(responseData)
	if err != nil {
		return ExternalToolCallRecord{}, false, err
	}
	var created ExternalToolCallRecord
	var responseBytes []byte
	err = s.db.QueryRowContext(ctx, `
		INSERT INTO external_tool_call_records (
			request_id, user_id, wallet_id, reservation_id, run_id, tool_call_id, tool, provider,
			units, credits_cost, status, error_code, error_message, idempotency_key,
			response_content, response_data, started_at
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
		ON CONFLICT (idempotency_key) DO NOTHING
		RETURNING request_id, user_id::text, wallet_id::text, COALESCE(reservation_id::text,''),
			COALESCE(run_id,''), COALESCE(tool_call_id,''), tool, provider, units, credits_cost, status,
			COALESCE(error_code,''), COALESCE(error_message,''), COALESCE(idempotency_key,''),
			COALESCE(response_content,''), response_data, started_at, COALESCE(finished_at, '0001-01-01'::timestamptz)
	`, record.RequestID, record.UserID, record.WalletID, nullableString(record.ReservationID), nullableString(record.RunID), nullableString(record.ToolCallID), record.Tool, record.Provider, record.Units, record.CreditsCost, fallbackString(record.Status, "running"), nullableString(record.ErrorCode), nullableString(record.ErrorMessage), nullableString(record.IdempotencyKey), nullableString(record.ResponseContent), responseJSON, nonZeroTime(record.StartedAt)).
		Scan(&created.RequestID, &created.UserID, &created.WalletID, &created.ReservationID, &created.RunID, &created.ToolCallID, &created.Tool, &created.Provider, &created.Units, &created.CreditsCost, &created.Status, &created.ErrorCode, &created.ErrorMessage, &created.IdempotencyKey, &created.ResponseContent, &responseBytes, &created.StartedAt, &created.FinishedAt)
	if errors.Is(err, sql.ErrNoRows) {
		existing, existingErr := s.ExternalToolCallByIdempotencyKey(ctx, record.UserID, record.IdempotencyKey)
		return existing, false, existingErr
	}
	if err != nil {
		return ExternalToolCallRecord{}, false, err
	}
	if err := json.Unmarshal(responseBytes, &created.ResponseData); err != nil {
		return ExternalToolCallRecord{}, false, err
	}
	return created, true, nil
}

func (s *PostgresStore) ExternalToolCallByIdempotencyKey(ctx context.Context, userID string, idempotencyKey string) (ExternalToolCallRecord, error) {
	var record ExternalToolCallRecord
	var responseBytes []byte
	err := s.db.QueryRowContext(ctx, `
		SELECT request_id, user_id::text, wallet_id::text, COALESCE(reservation_id::text,''),
			COALESCE(run_id,''), COALESCE(tool_call_id,''), tool, provider, units, credits_cost, status,
			COALESCE(error_code,''), COALESCE(error_message,''), COALESCE(idempotency_key,''),
			COALESCE(response_content,''), response_data, started_at, COALESCE(finished_at, '0001-01-01'::timestamptz)
		FROM external_tool_call_records
		WHERE user_id=$1 AND idempotency_key=$2
	`, userID, idempotencyKey).
		Scan(&record.RequestID, &record.UserID, &record.WalletID, &record.ReservationID, &record.RunID, &record.ToolCallID, &record.Tool, &record.Provider, &record.Units, &record.CreditsCost, &record.Status, &record.ErrorCode, &record.ErrorMessage, &record.IdempotencyKey, &record.ResponseContent, &responseBytes, &record.StartedAt, &record.FinishedAt)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ExternalToolCallRecord{}, ErrNotFound
		}
		return ExternalToolCallRecord{}, err
	}
	if err := json.Unmarshal(responseBytes, &record.ResponseData); err != nil {
		return ExternalToolCallRecord{}, err
	}
	return record, nil
}

func (s *PostgresStore) FinishExternalToolCall(ctx context.Context, requestID string, status string, units int, creditsCost int64, errorCode string, errorMessage string, responseContent string, responseData map[string]any) error {
	if responseData == nil {
		responseData = map[string]any{}
	}
	responseJSON, err := json.Marshal(responseData)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `
		UPDATE external_tool_call_records
		SET status=$2, units=$3, credits_cost=$4, error_code=$5, error_message=$6,
			response_content=$7, response_data=$8, finished_at=NOW()
		WHERE request_id=$1
	`, requestID, status, units, creditsCost, nullableString(errorCode), nullableString(errorMessage), nullableString(responseContent), responseJSON)
	return err
}

// ---- Sandbox sessions (Phase 5 — code.execute tool) ----

func (s *PostgresStore) GetActiveSandboxSessionByConversation(ctx context.Context, userID string, conversationID string) (SandboxSessionRecord, error) {
	var rec SandboxSessionRecord
	err := s.db.QueryRowContext(ctx, `
		SELECT id::text, user_id::text, conversation_id, e2b_sandbox_id, e2b_client_id, provider, template_id,
			status, created_at, last_used_at, COALESCE(killed_at, '0001-01-01'::timestamptz),
			total_seconds, total_credits_cost
		FROM sandbox_sessions
		WHERE user_id=$1 AND conversation_id=$2 AND status='active'
	`, userID, conversationID).Scan(
		&rec.ID, &rec.UserID, &rec.ConversationID, &rec.E2BSandboxID, &rec.E2BClientID, &rec.Provider, &rec.TemplateID,
		&rec.Status, &rec.CreatedAt, &rec.LastUsedAt, &rec.KilledAt,
		&rec.TotalSeconds, &rec.TotalCreditsCost,
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return SandboxSessionRecord{}, ErrNotFound
		}
		return SandboxSessionRecord{}, err
	}
	return rec, nil
}

func (s *PostgresStore) CreateSandboxSession(ctx context.Context, record SandboxSessionRecord) (SandboxSessionRecord, error) {
	if record.Provider == "" {
		record.Provider = "e2b"
	}
	if record.Status == "" {
		record.Status = "active"
	}
	var created SandboxSessionRecord
	err := s.db.QueryRowContext(ctx, `
		INSERT INTO sandbox_sessions (
			user_id, conversation_id, e2b_sandbox_id, e2b_client_id, provider, template_id, status
		) VALUES ($1, $2, $3, $4, $5, $6, $7)
		RETURNING id::text, user_id::text, conversation_id, e2b_sandbox_id, e2b_client_id, provider, template_id,
			status, created_at, last_used_at, COALESCE(killed_at, '0001-01-01'::timestamptz),
			total_seconds, total_credits_cost
	`, record.UserID, record.ConversationID, record.E2BSandboxID, record.E2BClientID, record.Provider, record.TemplateID, record.Status).
		Scan(
			&created.ID, &created.UserID, &created.ConversationID, &created.E2BSandboxID, &created.E2BClientID, &created.Provider, &created.TemplateID,
			&created.Status, &created.CreatedAt, &created.LastUsedAt, &created.KilledAt,
			&created.TotalSeconds, &created.TotalCreditsCost,
		)
	if err != nil {
		// Unique violation on (user_id, conversation_id, status='active')
		// → another concurrent code.execute call beat us to it. Return
		// ErrAlreadyExists so the caller can fall back to GetActive.
		if isUniqueViolation(err) {
			return SandboxSessionRecord{}, ErrAlreadyExists
		}
		return SandboxSessionRecord{}, err
	}
	return created, nil
}

func (s *PostgresStore) TouchSandboxSession(ctx context.Context, id string, addedSeconds int, addedCreditsCost int64) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE sandbox_sessions
		SET last_used_at = NOW(),
			total_seconds = total_seconds + $2,
			total_credits_cost = total_credits_cost + $3
		WHERE id = $1
	`, id, addedSeconds, addedCreditsCost)
	return err
}

func (s *PostgresStore) MarkSandboxSessionStatus(ctx context.Context, id string, status string) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE sandbox_sessions
		SET status = $2,
			killed_at = CASE WHEN $2 = 'active' THEN killed_at ELSE NOW() END
		WHERE id = $1
	`, id, status)
	return err
}

func (s *PostgresStore) ListReapableSandboxSessions(ctx context.Context, idleSince time.Time, bornBefore time.Time, limit int) ([]SandboxSessionRecord, error) {
	if limit <= 0 {
		limit = 100
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT id::text, user_id::text, conversation_id, e2b_sandbox_id, e2b_client_id, provider, template_id,
			status, created_at, last_used_at, COALESCE(killed_at, '0001-01-01'::timestamptz),
			total_seconds, total_credits_cost
		FROM sandbox_sessions
		WHERE status = 'active'
		  AND (last_used_at < $1 OR created_at < $2)
		ORDER BY last_used_at
		LIMIT $3
	`, idleSince, bornBefore, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]SandboxSessionRecord, 0, limit)
	for rows.Next() {
		var rec SandboxSessionRecord
		if err := rows.Scan(
			&rec.ID, &rec.UserID, &rec.ConversationID, &rec.E2BSandboxID, &rec.E2BClientID, &rec.Provider, &rec.TemplateID,
			&rec.Status, &rec.CreatedAt, &rec.LastUsedAt, &rec.KilledAt,
			&rec.TotalSeconds, &rec.TotalCreditsCost,
		); err != nil {
			return nil, err
		}
		out = append(out, rec)
	}
	return out, rows.Err()
}

func (s *PostgresStore) CreateAgentRun(ctx context.Context, run AgentRun) (AgentRun, error) {
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
	now := time.Now().UTC()
	if run.CreatedAt.IsZero() {
		run.CreatedAt = now
	}
	if run.UpdatedAt.IsZero() {
		run.UpdatedAt = now
	}
	if run.ExpiresAt.IsZero() {
		run.ExpiresAt = now.Add(168 * time.Hour)
	}
	attachments, err := json.Marshal(run.Attachments)
	if err != nil {
		return AgentRun{}, err
	}
	history, err := json.Marshal(run.History)
	if err != nil {
		return AgentRun{}, err
	}
	return scanAgentRun(s.db.QueryRowContext(ctx, `
		INSERT INTO agent_runs (
			id, user_id, origin, status, mode, goal, goal_summary,
			client_conversation_id, client_message_id, attachments, expires_at, created_at, updated_at, history
		) VALUES ($1,$2,$3,$4,$5,$6,$7,NULLIF($8, ''),NULLIF($9, ''),$10,$11,$12,$13,$14)
		RETURNING id::text, user_id::text, origin, status, mode, goal, goal_summary,
			COALESCE(client_conversation_id,''), COALESCE(client_message_id,''), attachments::text, COALESCE(history::text,'[]'),
			COALESCE(error_code,''), COALESCE(error_message,''), expires_at, created_at, updated_at
	`, run.ID, run.UserID, run.Origin, run.Status, run.Mode, run.Goal, run.GoalSummary, run.ClientConversationID, run.ClientMessageID, json.RawMessage(attachments), run.ExpiresAt, run.CreatedAt, run.UpdatedAt, json.RawMessage(history)))
}

func (s *PostgresStore) AgentRunByID(ctx context.Context, userID string, runID string) (AgentRun, error) {
	return scanAgentRun(s.db.QueryRowContext(ctx, `
		SELECT id::text, user_id::text, origin, status, mode, goal, goal_summary,
			COALESCE(client_conversation_id,''), COALESCE(client_message_id,''), attachments::text, COALESCE(history::text,'[]'),
			COALESCE(error_code,''), COALESCE(error_message,''), expires_at, created_at, updated_at
		FROM agent_runs
		WHERE user_id=$1 AND id=$2
	`, userID, runID))
}

func (s *PostgresStore) UpdateAgentRunStatus(ctx context.Context, userID string, runID string, status string, errorCode string, errorMessage string) (AgentRun, error) {
	return scanAgentRun(s.db.QueryRowContext(ctx, `
		UPDATE agent_runs
		SET status=$3, error_code=NULLIF($4, ''), error_message=NULLIF($5, ''), updated_at=NOW()
		WHERE user_id=$1 AND id=$2
		RETURNING id::text, user_id::text, origin, status, mode, goal, goal_summary,
			COALESCE(client_conversation_id,''), COALESCE(client_message_id,''), attachments::text, COALESCE(history::text,'[]'),
			COALESCE(error_code,''), COALESCE(error_message,''), expires_at, created_at, updated_at
	`, userID, runID, status, errorCode, truncateString(errorMessage, 500)))
}

func (s *PostgresStore) AppendAgentEvent(ctx context.Context, runID string, eventType string, payload map[string]any) (AgentEvent, error) {
	if payload == nil {
		payload = map[string]any{}
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return AgentEvent{}, err
	}
	var event AgentEvent
	var payloadText string
	err = s.db.QueryRowContext(ctx, `
		INSERT INTO agent_events (run_id, seq, event_type, payload)
		VALUES ($1, (SELECT COALESCE(MAX(seq), 0) + 1 FROM agent_events WHERE run_id=$1), $2, $3)
		RETURNING id::text, run_id::text, seq, event_type, payload::text, created_at
	`, runID, eventType, json.RawMessage(raw)).Scan(&event.ID, &event.RunID, &event.Seq, &event.EventType, &payloadText, &event.CreatedAt)
	if err != nil {
		return AgentEvent{}, mapNotFound(err)
	}
	if err := json.Unmarshal([]byte(payloadText), &event.Payload); err != nil {
		return AgentEvent{}, err
	}
	return event, nil
}

func (s *PostgresStore) AgentEventsByRun(ctx context.Context, userID string, runID string) ([]AgentEvent, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT e.id::text, e.run_id::text, e.seq, e.event_type, e.payload::text, e.created_at
		FROM agent_events e
		JOIN agent_runs r ON r.id = e.run_id
		WHERE r.user_id=$1 AND r.id=$2
		ORDER BY e.seq ASC
	`, userID, runID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	events := make([]AgentEvent, 0)
	for rows.Next() {
		var event AgentEvent
		var payloadText string
		if err := rows.Scan(&event.ID, &event.RunID, &event.Seq, &event.EventType, &payloadText, &event.CreatedAt); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(payloadText), &event.Payload); err != nil {
			return nil, err
		}
		events = append(events, event)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(events) == 0 {
		if _, err := s.AgentRunByID(ctx, userID, runID); err != nil {
			return nil, err
		}
	}
	return events, nil
}

func (s *PostgresStore) CreateDocument(ctx context.Context, document documents.Document) (documents.Document, error) {
	// metadataJSON discarded after Scan — a freshly-created row
	// always has metadata = '{}', and Document.Metadata stays nil
	// (json.Unmarshal of "{}" produces an empty map but we treat
	// nil vs empty equivalently downstream). Service.go calls
	// SetDocumentMetadata later when it has the extractor output.
	var metadataJSON []byte
	err := s.db.QueryRowContext(ctx, `
		INSERT INTO documents (
			id, user_id, original_name, content_type, size_bytes, status,
			source_object_key, text_object_key, error_message, expires_at, created_at, updated_at
		) VALUES ($1,$2,$3,$4,$5,$6,$7,NULLIF($8, ''),NULLIF($9, ''),$10,$11,$12)
		RETURNING id::text, user_id::text, original_name, content_type, size_bytes, status,
			source_object_key, COALESCE(text_object_key, ''), COALESCE(error_message, ''),
			expires_at, created_at, updated_at,
			COALESCE(metadata, '{}'::jsonb)::text
	`, document.ID, document.UserID, document.OriginalName, document.ContentType, document.SizeBytes, document.Status, document.SourceObjectKey, document.TextObjectKey, document.ErrorMessage, document.ExpiresAt, nonZeroTime(document.CreatedAt), nonZeroTime(document.UpdatedAt)).
		Scan(&document.ID, &document.UserID, &document.OriginalName, &document.ContentType, &document.SizeBytes, &document.Status, &document.SourceObjectKey, &document.TextObjectKey, &document.ErrorMessage, &document.ExpiresAt, &document.CreatedAt, &document.UpdatedAt, &metadataJSON)
	return document, err
}

func (s *PostgresStore) DocumentsByUser(ctx context.Context, userID string) ([]documents.Document, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id::text, user_id::text, original_name, content_type, size_bytes, status,
			source_object_key, COALESCE(text_object_key, ''), COALESCE(error_message, ''),
			expires_at, created_at, updated_at,
			COALESCE(metadata, '{}'::jsonb)::text
		FROM documents
		WHERE user_id=$1 AND status <> 'deleted'
		ORDER BY created_at DESC
		LIMIT 100
	`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]documents.Document, 0)
	for rows.Next() {
		document, err := scanDocument(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, document)
	}
	return result, rows.Err()
}

func (s *PostgresStore) DocumentByID(ctx context.Context, userID string, documentID string) (documents.Document, error) {
	return scanDocument(s.db.QueryRowContext(ctx, `
		SELECT id::text, user_id::text, original_name, content_type, size_bytes, status,
			source_object_key, COALESCE(text_object_key, ''), COALESCE(error_message, ''),
			expires_at, created_at, updated_at,
			COALESCE(metadata, '{}'::jsonb)::text
		FROM documents
		WHERE user_id=$1 AND id=$2 AND status <> 'deleted'
	`, userID, documentID))
}

func (s *PostgresStore) MarkDocumentProcessing(ctx context.Context, userID string, documentID string) (documents.Document, error) {
	return s.updateDocumentStatus(ctx, userID, documentID, documents.StatusProcessing, "", "", true)
}

func (s *PostgresStore) MarkDocumentReady(ctx context.Context, userID string, documentID string, textObjectKey string) (documents.Document, error) {
	return s.updateDocumentStatus(ctx, userID, documentID, documents.StatusReady, textObjectKey, "", true)
}

func (s *PostgresStore) MarkDocumentFailed(ctx context.Context, userID string, documentID string, errorMessage string) (documents.Document, error) {
	return s.updateDocumentStatus(ctx, userID, documentID, documents.StatusFailed, "", truncateString(errorMessage, 500), false)
}

// SetDocumentMetadata persists the structured metadata extracted at
// upload time (PDF: pdfinfo output; future: DOCX page count etc.).
// Intentionally non-fatal in the calling service — failure here
// degrades to "no metadata visible" rather than tanking the whole
// upload (caller logs + continues). Uses jsonb so future keys
// don't require migrations.
func (s *PostgresStore) SetDocumentMetadata(ctx context.Context, userID string, documentID string, metadata map[string]any) (documents.Document, error) {
	if metadata == nil {
		metadata = map[string]any{}
	}
	payload, err := json.Marshal(metadata)
	if err != nil {
		return documents.Document{}, fmt.Errorf("marshal metadata: %w", err)
	}
	return scanDocument(s.db.QueryRowContext(ctx, `
		UPDATE documents
		SET metadata=$3::jsonb, updated_at=NOW()
		WHERE user_id=$1 AND id=$2 AND status <> 'deleted'
		RETURNING id::text, user_id::text, original_name, content_type, size_bytes, status,
			source_object_key, COALESCE(text_object_key, ''), COALESCE(error_message, ''),
			expires_at, created_at, updated_at,
			COALESCE(metadata, '{}'::jsonb)::text
	`, userID, documentID, string(payload)))
}

func (s *PostgresStore) DeleteDocument(ctx context.Context, userID string, documentID string) (documents.Document, error) {
	document, err := scanDocument(s.db.QueryRowContext(ctx, `
		UPDATE documents
		SET status='deleted', updated_at=NOW(), deleted_at=NOW()
		WHERE user_id=$1 AND id=$2 AND status <> 'deleted'
		RETURNING id::text, user_id::text, original_name, content_type, size_bytes, status,
			source_object_key, COALESCE(text_object_key, ''), COALESCE(error_message, ''),
			expires_at, created_at, updated_at,
			COALESCE(metadata, '{}'::jsonb)::text
	`, userID, documentID))
	if errors.Is(err, ErrNotFound) {
		// `WHERE status <> 'deleted'` matched zero rows. The row is
		// either already tombstoned (benign race with another
		// reaper tick or a user-initiated delete) or never existed
		// at all. Surface a typed sentinel so the reaper can skip
		// silently and the HTTP layer can still map to 404.
		return documents.Document{}, documents.ErrAlreadyDeleted
	}
	return document, err
}

// ListExpiredDocuments — see Store interface for contract. Index
// idx_documents_expiry (migration 002) supports the WHERE clause.
func (s *PostgresStore) ListExpiredDocuments(ctx context.Context, cutoff time.Time, limit int) ([]documents.Document, error) {
	if limit <= 0 {
		limit = 100
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT id::text, user_id::text, original_name, content_type, size_bytes, status,
			source_object_key, COALESCE(text_object_key, ''), COALESCE(error_message, ''),
			expires_at, created_at, updated_at,
			COALESCE(metadata, '{}'::jsonb)::text
		FROM documents
		WHERE expires_at < $1 AND status <> 'deleted'
		ORDER BY created_at ASC
		LIMIT $2
	`, cutoff, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]documents.Document, 0, limit)
	for rows.Next() {
		// The reaper doesn't actually use the metadata, but we Scan
		// it anyway so this stays parallel with scanDocument and
		// the SELECT projection (which had to add the column to
		// satisfy the new "metadata column on all reads" invariant).
		var doc documents.Document
		var metadataJSON []byte
		if err := rows.Scan(
			&doc.ID, &doc.UserID, &doc.OriginalName, &doc.ContentType, &doc.SizeBytes, &doc.Status,
			&doc.SourceObjectKey, &doc.TextObjectKey, &doc.ErrorMessage,
			&doc.ExpiresAt, &doc.CreatedAt, &doc.UpdatedAt,
			&metadataJSON,
		); err != nil {
			return nil, err
		}
		out = append(out, doc)
	}
	return out, rows.Err()
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

func (s *PostgresStore) CreateBillingTopUp(ctx context.Context, tx BillingTransaction) (BillingTransaction, error) {
	if tx.Status == "" {
		tx.Status = "pending"
	}
	if tx.Currency == "" {
		tx.Currency = "usd"
	}
	if tx.CreatedAt.IsZero() {
		tx.CreatedAt = time.Now().UTC()
	}
	tx.UpdatedAt = tx.CreatedAt
	err := s.db.QueryRowContext(ctx, `
		INSERT INTO billing_transactions (
			user_id, stripe_session_id, stripe_payment_intent_id, amount, currency, credits, status, raw_event_id, created_at, updated_at
		) VALUES ($1, $2, NULLIF($3, ''), $4, $5, $6, $7, NULLIF($8, ''), $9, $9)
		RETURNING id::text, created_at, updated_at
	`, tx.UserID, tx.StripeSessionID, tx.StripePaymentIntentID, tx.Amount, tx.Currency, tx.Credits, tx.Status, tx.RawEventID, tx.CreatedAt).
		Scan(&tx.ID, &tx.CreatedAt, &tx.UpdatedAt)
	return tx, err
}

func (s *PostgresStore) ApplyBillingTopUp(ctx context.Context, completion BillingTopUpCompletion) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer rollback(tx)

	var billingTx BillingTransaction
	err = tx.QueryRowContext(ctx, `
		SELECT id::text, user_id::text, stripe_session_id, COALESCE(stripe_payment_intent_id, ''),
			amount, currency, credits, status, COALESCE(raw_event_id, ''), created_at, updated_at
		FROM billing_transactions
		WHERE stripe_session_id=$1
		FOR UPDATE
	`, completion.StripeSessionID).Scan(
		&billingTx.ID, &billingTx.UserID, &billingTx.StripeSessionID, &billingTx.StripePaymentIntentID,
		&billingTx.Amount, &billingTx.Currency, &billingTx.Credits, &billingTx.Status, &billingTx.RawEventID,
		&billingTx.CreatedAt, &billingTx.UpdatedAt,
	)
	if err != nil {
		return mapNotFound(err)
	}
	if billingTx.Status == "paid" {
		return tx.Commit()
	}
	if billingTx.UserID != completion.UserID ||
		billingTx.Amount != completion.Amount ||
		billingTx.Currency != completion.Currency ||
		billingTx.Credits != completion.Credits {
		return ErrNotFound
	}

	if err := ensureWalletTx(ctx, tx, billingTx.UserID, 0); err != nil {
		return err
	}
	wallet, err := selectWalletTx(ctx, tx, billingTx.UserID, true)
	if err != nil {
		return err
	}
	wallet.ExtraCreditsBalance += completion.Credits
	if _, err := tx.ExecContext(ctx, `UPDATE wallets SET extra_credits_balance=$1, updated_at=NOW() WHERE id=$2`, wallet.ExtraCreditsBalance, wallet.ID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE billing_transactions
		SET status='paid',
			stripe_payment_intent_id=COALESCE(NULLIF($2, ''), stripe_payment_intent_id),
			raw_event_id=COALESCE(NULLIF($3, ''), raw_event_id),
			updated_at=NOW()
		WHERE id=$1
	`, billingTx.ID, completion.StripePaymentIntentID, completion.RawEventID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO credit_ledger (user_id, transaction_id, delta, reason)
		VALUES ($1, $2, $3, 'stripe_checkout')
		ON CONFLICT (transaction_id, reason) DO NOTHING
	`, billingTx.UserID, billingTx.ID, completion.Credits); err != nil {
		return err
	}
	if err := insertWalletTransaction(ctx, tx, wallet.ID, "", "recharge_grant", completion.Credits, wallet.MonthlyCreditsUsed, wallet.ExtraCreditsBalance, "Stripe Checkout credits purchased", "stripe_checkout:"+completion.StripeSessionID); err != nil {
		return err
	}
	if err := insertAuditLog(ctx, tx, "", "billing.recharge_paid", "user", billingTx.UserID, map[string]any{
		"event_id":                   completion.RawEventID,
		"stripe_checkout_session_id": completion.StripeSessionID,
		"credits":                    completion.Credits,
	}); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *PostgresStore) RevokeBillingTopUp(ctx context.Context, reversal BillingTopUpReversal) error {
	paymentIntentID := strings.TrimSpace(reversal.StripePaymentIntentID)
	if paymentIntentID == "" {
		return ErrNotFound
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer rollback(tx)

	var billingTx BillingTransaction
	err = tx.QueryRowContext(ctx, `
		SELECT id::text, user_id::text, stripe_session_id, COALESCE(stripe_payment_intent_id, ''),
			amount, currency, credits, status, COALESCE(raw_event_id, ''), created_at, updated_at
		FROM billing_transactions
		WHERE stripe_payment_intent_id=$1
		FOR UPDATE
	`, paymentIntentID).Scan(
		&billingTx.ID, &billingTx.UserID, &billingTx.StripeSessionID, &billingTx.StripePaymentIntentID,
		&billingTx.Amount, &billingTx.Currency, &billingTx.Credits, &billingTx.Status, &billingTx.RawEventID,
		&billingTx.CreatedAt, &billingTx.UpdatedAt,
	)
	if err != nil {
		return mapNotFound(err)
	}
	if billingTx.Status != "paid" {
		return tx.Commit()
	}
	if err := ensureWalletTx(ctx, tx, billingTx.UserID, 0); err != nil {
		return err
	}
	wallet, err := selectWalletTx(ctx, tx, billingTx.UserID, true)
	if err != nil {
		return err
	}
	wallet.ExtraCreditsBalance -= billingTx.Credits
	if _, err := tx.ExecContext(ctx, `UPDATE wallets SET extra_credits_balance=$1, updated_at=NOW() WHERE id=$2`, wallet.ExtraCreditsBalance, wallet.ID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE billing_transactions
		SET status='refunded',
			raw_event_id=COALESCE(NULLIF($2, ''), raw_event_id),
			updated_at=NOW()
		WHERE id=$1
	`, billingTx.ID, reversal.RawEventID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO credit_ledger (user_id, transaction_id, delta, reason)
		VALUES ($1, $2, $3, 'stripe_refund')
		ON CONFLICT (transaction_id, reason) DO NOTHING
	`, billingTx.UserID, billingTx.ID, -billingTx.Credits); err != nil {
		return err
	}
	if err := insertWalletTransaction(ctx, tx, wallet.ID, "", "recharge_refund", -billingTx.Credits, wallet.MonthlyCreditsUsed, wallet.ExtraCreditsBalance, "Stripe top-up refunded or disputed", "stripe_topup_refund:"+paymentIntentID); err != nil {
		return err
	}
	if err := insertAuditLog(ctx, tx, "", "billing.recharge_refunded", "user", billingTx.UserID, map[string]any{
		"event_id":                   reversal.RawEventID,
		"stripe_checkout_session_id": billingTx.StripeSessionID,
		"stripe_payment_intent_id":   paymentIntentID,
		"credits":                    -billingTx.Credits,
	}); err != nil {
		return err
	}
	return tx.Commit()
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

	// Whole-operation idempotency: if this Stripe event already produced a
	// wallet transaction, no-op. The transaction insert is ON CONFLICT-guarded
	// on its own, but the wallet RESET below is not — so a reprocess (crash
	// between this grant committing and the event being marked processed)
	// would otherwise re-zero monthly_credits_used.
	if applied, err := stripeEventApplied(ctx, tx, eventID); err != nil {
		return err
	} else if applied {
		return tx.Commit()
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
	if eventID == "" {
		eventID = stripeSubscriptionID
	}
	if applied, err := stripeEventApplied(ctx, tx, eventID); err != nil {
		return err
	} else if applied {
		return tx.Commit()
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

// RevokeSubscriptionCredits revokes the MONTHLY subscription allotment when a
// subscription is canceled/refunded (the wallet drops to the free tier with
// zero monthly credits and status 'canceled'). Pay-as-you-go extra credits
// are left untouched. Idempotent per Stripe event id, so retries / a dispute
// following a cancellation don't double-apply.
func (s *PostgresStore) RevokeSubscriptionCredits(ctx context.Context, stripeSubscriptionID string, eventID string) error {
	if strings.TrimSpace(stripeSubscriptionID) == "" {
		return ErrNotFound
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer rollback(tx)
	if eventID == "" {
		eventID = stripeSubscriptionID
	}
	if applied, err := stripeEventApplied(ctx, tx, eventID); err != nil {
		return err
	} else if applied {
		return tx.Commit()
	}

	var walletID string
	var monthlyLimit, monthlyUsed, extraBalance int64
	err = tx.QueryRowContext(ctx, `
		SELECT id::text, monthly_credit_limit, monthly_credits_used, extra_credits_balance
		FROM wallets WHERE stripe_subscription_id=$1 FOR UPDATE
	`, stripeSubscriptionID).Scan(&walletID, &monthlyLimit, &monthlyUsed, &extraBalance)
	if err != nil {
		return mapNotFound(err)
	}
	revoked := monthlyLimit - monthlyUsed
	if revoked < 0 {
		revoked = 0
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE wallets
		SET plan_code='free_trial', monthly_credit_limit=0, monthly_credits_used=0,
			status='canceled', updated_at=NOW()
		WHERE id=$1
	`, walletID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE payment_orders SET status='refunded'
		WHERE stripe_subscription_id=$1 AND type='subscription'
	`, stripeSubscriptionID); err != nil {
		return err
	}
	// Negative amount = credits removed; extra balance unchanged.
	if err := insertWalletTransaction(ctx, tx, walletID, "", "subscription_revoke", -revoked, 0, extraBalance, "subscription canceled/refunded — monthly credits revoked", "stripe:"+eventID); err != nil {
		return err
	}
	if err := insertAuditLog(ctx, tx, "", "billing.subscription_revoked", "wallet", walletID, map[string]any{"event_id": eventID, "stripe_subscription_id": stripeSubscriptionID, "revoked_credits": revoked}); err != nil {
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
		SELECT id::text, email, password_hash, name, role, status, created_at, email_verified
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
	detail := AdminUserDetail{User: user, Calls: make([]LLMCallRecord, 0), ToolCalls: make([]ExternalToolCallRecord, 0), Orders: make([]PaymentOrder, 0), Transactions: make([]billing.Transaction, 0)}
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
	toolCalls, err := s.AdminExternalToolCalls(ctx, AdminListOptions{UserID: userID, Limit: 50})
	if err != nil {
		return AdminUserDetail{}, err
	}
	for _, record := range toolCalls {
		detail.ToolCalls = append(detail.ToolCalls, record.ExternalToolCallRecord)
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
		RETURNING id::text, email, password_hash, name, role, status, created_at, email_verified
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
			COALESCE(c.run_id,''), COALESCE(c.client_conversation_id,''), COALESCE(c.client_message_id,''), c.mode, COALESCE(c.scene,''),
			COALESCE(c.model,''), COALESCE(c.provider,''), c.input_tokens, c.output_tokens, c.credits_cost, c.status,
			COALESCE(c.error_code,''), COALESCE(c.error_message,''), c.started_at, COALESCE(c.finished_at, '0001-01-01'::timestamptz),
			u.email
		FROM llm_call_records c
		JOIN users u ON u.id = c.user_id
		WHERE ($1='' OR c.user_id::text=$1)
			AND ($2='' OR c.status=$2)
			AND ($3='' OR COALESCE(c.run_id,'')=$3)
		ORDER BY c.started_at DESC
		LIMIT $4 OFFSET $5
	`, opts.UserID, opts.Status, opts.RunID, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	records := make([]AdminLLMCallRecord, 0)
	for rows.Next() {
		var item AdminLLMCallRecord
		if err := rows.Scan(&item.RequestID, &item.UserID, &item.WalletID, &item.ReservationID, &item.RunID, &item.ClientConversationID, &item.ClientMessageID, &item.Mode, &item.Scene, &item.Model, &item.Provider, &item.InputTokens, &item.OutputTokens, &item.CreditsCost, &item.Status, &item.ErrorCode, &item.ErrorMessage, &item.StartedAt, &item.FinishedAt, &item.UserEmail); err != nil {
			return nil, err
		}
		records = append(records, item)
	}
	return records, rows.Err()
}

func (s *PostgresStore) AdminExternalToolCalls(ctx context.Context, opts AdminListOptions) ([]AdminExternalToolCallRecord, error) {
	limit, offset := normalizeLimitOffset(opts.Limit, opts.Offset)
	rows, err := s.db.QueryContext(ctx, `
		SELECT c.request_id, c.user_id::text, c.wallet_id::text, COALESCE(c.reservation_id::text, ''),
			COALESCE(c.run_id,''), COALESCE(c.tool_call_id,''), c.tool, c.provider, c.units, c.credits_cost,
			c.status, COALESCE(c.error_code,''), COALESCE(c.error_message,''), COALESCE(c.idempotency_key,''),
			COALESCE(c.response_content,''), c.response_data, c.started_at, COALESCE(c.finished_at, '0001-01-01'::timestamptz),
			u.email
		FROM external_tool_call_records c
		JOIN users u ON u.id = c.user_id
		WHERE ($1='' OR c.user_id::text=$1)
			AND ($2='' OR c.status=$2)
			AND ($3='' OR COALESCE(c.run_id,'')=$3)
		ORDER BY c.started_at DESC
		LIMIT $4 OFFSET $5
	`, opts.UserID, opts.Status, opts.RunID, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	records := make([]AdminExternalToolCallRecord, 0)
	for rows.Next() {
		var item AdminExternalToolCallRecord
		var responseBytes []byte
		if err := rows.Scan(&item.RequestID, &item.UserID, &item.WalletID, &item.ReservationID, &item.RunID, &item.ToolCallID, &item.Tool, &item.Provider, &item.Units, &item.CreditsCost, &item.Status, &item.ErrorCode, &item.ErrorMessage, &item.IdempotencyKey, &item.ResponseContent, &responseBytes, &item.StartedAt, &item.FinishedAt, &item.UserEmail); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(responseBytes, &item.ResponseData); err != nil {
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

func (s *PostgresStore) AdminAgentRuns(ctx context.Context, opts AdminListOptions) ([]AdminAgentRun, error) {
	limit, offset := normalizeLimitOffset(opts.Limit, opts.Offset)
	rows, err := s.db.QueryContext(ctx, `
		SELECT r.id::text, r.user_id::text, r.origin, r.status, r.mode, r.goal, r.goal_summary,
			COALESCE(r.client_conversation_id,''), COALESCE(r.client_message_id,''), r.attachments::text,
			COALESCE(r.error_code,''), COALESCE(r.error_message,''), r.expires_at, r.created_at, r.updated_at,
			u.email
		FROM agent_runs r
		JOIN users u ON u.id = r.user_id
		WHERE ($1='' OR r.user_id::text=$1)
			AND ($2='' OR r.status=$2)
			AND ($3='' OR u.email ILIKE '%' || $3 || '%' OR r.id::text=$3)
		ORDER BY r.created_at DESC
		LIMIT $4 OFFSET $5
	`, opts.UserID, opts.Status, strings.TrimSpace(opts.Query), limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	runs := make([]AdminAgentRun, 0)
	for rows.Next() {
		var item AdminAgentRun
		var attachmentsText string
		if err := rows.Scan(&item.ID, &item.UserID, &item.Origin, &item.Status, &item.Mode, &item.Goal, &item.GoalSummary, &item.ClientConversationID, &item.ClientMessageID, &attachmentsText, &item.ErrorCode, &item.ErrorMessage, &item.ExpiresAt, &item.CreatedAt, &item.UpdatedAt, &item.UserEmail); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(attachmentsText), &item.Attachments); err != nil {
			return nil, err
		}
		runs = append(runs, item)
	}
	return runs, rows.Err()
}

func (s *PostgresStore) AdminAgentRunByID(ctx context.Context, runID string) (AdminAgentRun, error) {
	var item AdminAgentRun
	var attachmentsText string
	err := s.db.QueryRowContext(ctx, `
		SELECT r.id::text, r.user_id::text, r.origin, r.status, r.mode, r.goal, r.goal_summary,
			COALESCE(r.client_conversation_id,''), COALESCE(r.client_message_id,''), r.attachments::text,
			COALESCE(r.error_code,''), COALESCE(r.error_message,''), r.expires_at, r.created_at, r.updated_at,
			u.email
		FROM agent_runs r
		JOIN users u ON u.id = r.user_id
		WHERE r.id=$1
	`, runID).Scan(&item.ID, &item.UserID, &item.Origin, &item.Status, &item.Mode, &item.Goal, &item.GoalSummary, &item.ClientConversationID, &item.ClientMessageID, &attachmentsText, &item.ErrorCode, &item.ErrorMessage, &item.ExpiresAt, &item.CreatedAt, &item.UpdatedAt, &item.UserEmail)
	if err != nil {
		return AdminAgentRun{}, mapNotFound(err)
	}
	if err := json.Unmarshal([]byte(attachmentsText), &item.Attachments); err != nil {
		return AdminAgentRun{}, err
	}
	return item, nil
}

func (s *PostgresStore) AdminWalletTransactionsByRun(ctx context.Context, runID string, limit int) ([]billing.Transaction, error) {
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT tx.id::text, tx.wallet_id::text, COALESCE(tx.reservation_id::text, ''), tx.type, tx.amount,
			tx.monthly_used_after, tx.extra_balance_after, COALESCE(tx.description, ''), COALESCE(tx.idempotency_key, ''), tx.created_at
		FROM wallet_transactions tx
		JOIN usage_reservations r ON r.id = tx.reservation_id
		WHERE r.run_id=$1
			OR EXISTS (
				SELECT 1 FROM external_tool_call_records c
				WHERE c.reservation_id=tx.reservation_id AND c.run_id=$1
			)
		ORDER BY tx.created_at DESC
		LIMIT $2
	`, runID, limit)
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

// stripeEventApplied reports whether a wallet transaction keyed to this
// Stripe event already exists. Used to make webhook-driven grants/revokes
// idempotent as a whole operation (not just the transaction insert), so a
// reprocess after a mid-flight crash is a true no-op.
func stripeEventApplied(ctx context.Context, tx *sql.Tx, eventID string) (bool, error) {
	var applied bool
	err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM wallet_transactions WHERE idempotency_key=$1)`, "stripe:"+eventID).Scan(&applied)
	return applied, err
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

func (s *PostgresStore) updateDocumentStatus(ctx context.Context, userID string, documentID string, status string, textObjectKey string, errorMessage string, clearError bool) (documents.Document, error) {
	query := `
		UPDATE documents
		SET status=$3,
			text_object_key=COALESCE(NULLIF($4, ''), text_object_key),
			error_message=CASE WHEN $6 THEN NULL ELSE NULLIF($5, '') END,
			updated_at=NOW()
		WHERE user_id=$1 AND id=$2 AND status <> 'deleted'
		RETURNING id::text, user_id::text, original_name, content_type, size_bytes, status,
			source_object_key, COALESCE(text_object_key, ''), COALESCE(error_message, ''),
			expires_at, created_at, updated_at,
			COALESCE(metadata, '{}'::jsonb)::text
	`
	return scanDocument(s.db.QueryRowContext(ctx, query, userID, documentID, status, textObjectKey, errorMessage, clearError))
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

func (s *PostgresStore) walletTransactionsByWalletWithRun(ctx context.Context, walletID string, limit int) ([]billingTransactionWithRun, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT tx.id::text, tx.wallet_id::text, COALESCE(tx.reservation_id::text, ''), tx.type, tx.amount,
			tx.monthly_used_after, tx.extra_balance_after, COALESCE(tx.description, ''), COALESCE(tx.idempotency_key, ''), tx.created_at,
			COALESCE(r.run_id, '')
		FROM wallet_transactions tx
		LEFT JOIN usage_reservations r ON r.id = tx.reservation_id
		WHERE tx.wallet_id=$1
		ORDER BY tx.created_at DESC
		LIMIT $2
	`, walletID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	transactions := make([]billingTransactionWithRun, 0)
	for rows.Next() {
		var tx billingTransactionWithRun
		if err := rows.Scan(&tx.ID, &tx.WalletID, &tx.ReservationID, &tx.Type, &tx.Amount, &tx.MonthlyUsedAfter, &tx.ExtraBalanceAfter, &tx.Description, &tx.IdempotencyKey, &tx.CreatedAt, &tx.RunID); err != nil {
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
	err := row.Scan(&user.ID, &user.Email, &user.PasswordHash, &user.Name, &user.Role, &user.Status, &user.CreatedAt, &user.EmailVerified)
	if err != nil {
		return User{}, mapNotFound(err)
	}
	return user, nil
}

func scanDocument(row rowScanner) (documents.Document, error) {
	var document documents.Document
	// Metadata comes back as JSON bytes (text-cast in the SQL) so we
	// don't need a Postgres-specific scanner. Decoding into the
	// map[string]any field happens here so every doc query path
	// gets the same treatment.
	var metadataJSON []byte
	err := row.Scan(
		&document.ID, &document.UserID, &document.OriginalName, &document.ContentType,
		&document.SizeBytes, &document.Status, &document.SourceObjectKey,
		&document.TextObjectKey, &document.ErrorMessage,
		&document.ExpiresAt, &document.CreatedAt, &document.UpdatedAt,
		&metadataJSON,
	)
	if err != nil {
		return documents.Document{}, mapNotFound(err)
	}
	if len(metadataJSON) > 0 && string(metadataJSON) != "{}" {
		if err := json.Unmarshal(metadataJSON, &document.Metadata); err != nil {
			// Soft-fail: a corrupt metadata column shouldn't tank
			// the whole read. The map stays nil; clients see no
			// metadata, same as a freshly-uploaded doc.
			document.Metadata = nil
		}
	}
	return document, nil
}

func scanAgentRun(row rowScanner) (AgentRun, error) {
	var run AgentRun
	var attachmentsText string
	var historyText string
	err := row.Scan(&run.ID, &run.UserID, &run.Origin, &run.Status, &run.Mode, &run.Goal, &run.GoalSummary, &run.ClientConversationID, &run.ClientMessageID, &attachmentsText, &historyText, &run.ErrorCode, &run.ErrorMessage, &run.ExpiresAt, &run.CreatedAt, &run.UpdatedAt)
	if err != nil {
		return AgentRun{}, mapNotFound(err)
	}
	if attachmentsText == "" {
		attachmentsText = "[]"
	}
	if err := json.Unmarshal([]byte(attachmentsText), &run.Attachments); err != nil {
		return AgentRun{}, err
	}
	if historyText == "" {
		historyText = "[]"
	}
	if err := json.Unmarshal([]byte(historyText), &run.History); err != nil {
		return AgentRun{}, err
	}
	return run, nil
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

func fallbackString(value string, fallback string) string {
	if value == "" {
		return fallback
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
	return err != nil && (strings.Contains(err.Error(), "duplicate key") || strings.Contains(err.Error(), "SQLSTATE 23505"))
}

func truncateString(value string, limit int) string {
	runes := []rune(value)
	if limit <= 0 || len(runes) <= limit {
		return value
	}
	return string(runes[:limit])
}

func minInt64(a int64, b int64) int64 {
	if a < b {
		return a
	}
	return b
}
