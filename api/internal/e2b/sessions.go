// Session pool: stitches the E2B HTTP client to the Postgres-backed
// sandbox_sessions table. Callers (the tool_gateway code.execute
// branch) interact with this layer, not the raw client — that's where
// the "find-or-create per conversation, kill when idle" policy lives.

package e2b

import (
	"context"
	"errors"
	"fmt"
	"log"
	"time"

	"github.com/coldflame/shejane/api/internal/store"
)

// SessionConfig captures the timing knobs that govern when a sandbox
// gets reaped. Fed from Config (api/internal/config) at startup.
type SessionConfig struct {
	TemplateID          string
	IdleTTL             time.Duration
	MaxLifetime         time.Duration
	CodeExecuteTimeout  time.Duration
	PerSecondCreditCost int64
}

// SessionManager is the orchestration layer the gateway calls into.
type SessionManager struct {
	client *Client
	store  store.Store
	cfg    SessionConfig
}

// Client exposes the underlying E2B HTTP client. Used by the gateway
// layer to do file IO (UploadSandboxFile / ListSandboxFiles /
// DownloadSandboxFile) without re-implementing client construction
// or duplicating the auth header / base URL.
func (m *SessionManager) Client() *Client {
	return m.client
}

// NewSessionManager wires a client + store + config. cfg.IdleTTL of
// zero is normalized to 15 minutes (matches E2B's own default
// sandbox lifetime) so callers can pass a zero-config struct and
// get sensible behavior.
func NewSessionManager(client *Client, st store.Store, cfg SessionConfig) *SessionManager {
	if cfg.IdleTTL <= 0 {
		cfg.IdleTTL = 15 * time.Minute
	}
	if cfg.MaxLifetime <= 0 {
		cfg.MaxLifetime = 60 * time.Minute
	}
	if cfg.CodeExecuteTimeout <= 0 {
		cfg.CodeExecuteTimeout = 60 * time.Second
	}
	if cfg.TemplateID == "" {
		cfg.TemplateID = "code-interpreter-v1"
	}
	return &SessionManager{client: client, store: st, cfg: cfg}
}

// GetOrCreateForConversation finds the active sandbox for (user,
// conversationID); if none exists (or the existing one's E2B side has
// gone missing) it provisions a fresh one. Returns the
// SandboxSessionRecord that the gateway can then call RunCode against.
//
// The double-check on "sandbox vanished on E2B's side" matters:
// long-idle sandboxes can be reclaimed by E2B even when our DB still
// thinks they're active. We catch that lazily on the next code.execute
// rather than polling.
func (m *SessionManager) GetOrCreateForConversation(ctx context.Context, userID string, conversationID string) (store.SandboxSessionRecord, error) {
	rec, err := m.store.GetActiveSandboxSessionByConversation(ctx, userID, conversationID)
	if err == nil {
		// Hard-lifetime check: even if E2B keeps it alive, we kill
		// past the ceiling so a runaway agent can't hold a sandbox
		// for hours.
		if time.Since(rec.CreatedAt) > m.cfg.MaxLifetime {
			_ = m.killAndMark(ctx, rec, "killed")
			return m.createFresh(ctx, userID, conversationID)
		}
		return rec, nil
	}
	if !errors.Is(err, store.ErrNotFound) {
		return store.SandboxSessionRecord{}, fmt.Errorf("lookup sandbox session: %w", err)
	}
	return m.createFresh(ctx, userID, conversationID)
}

// createFresh provisions a new E2B sandbox and inserts the DB row.
// Concurrent calls on the same conversation race on the unique-active
// index — the loser gets ErrAlreadyExists and we then fall back to
// the row the winner created.
func (m *SessionManager) createFresh(ctx context.Context, userID string, conversationID string) (store.SandboxSessionRecord, error) {
	info, err := m.client.CreateSandbox(ctx, m.cfg.TemplateID, map[string]string{
		"shejane_user_id":         userID,
		"shejane_conversation_id": conversationID,
	})
	if err != nil {
		return store.SandboxSessionRecord{}, fmt.Errorf("provision sandbox: %w", err)
	}
	rec, err := m.store.CreateSandboxSession(ctx, store.SandboxSessionRecord{
		UserID:         userID,
		ConversationID: conversationID,
		E2BSandboxID:   info.SandboxID,
		E2BClientID:    info.ClientID,
		Provider:       "e2b",
		TemplateID:     info.TemplateID,
		Status:         "active",
	})
	if err != nil {
		if errors.Is(err, store.ErrAlreadyExists) {
			// Race lost: another concurrent create already inserted.
			// Kill the orphan we just provisioned (otherwise it lives
			// 15 min on E2B's bill) and reuse the winner's row. Kill
			// failure is logged — the orphan will reap on E2B's side
			// at the platform TTL, but we still want operator
			// visibility into the leak window.
			if killErr := m.client.KillSandbox(ctx, info.SandboxID); killErr != nil {
				log.Printf("e2b: orphan sandbox %s leak after race-lost create: kill failed: %v", info.SandboxID, killErr)
			}
			return m.store.GetActiveSandboxSessionByConversation(ctx, userID, conversationID)
		}
		// DB write failed → kill the orphan so we don't leak E2B time.
		if killErr := m.client.KillSandbox(ctx, info.SandboxID); killErr != nil {
			log.Printf("e2b: orphan sandbox %s leak after DB write failure: kill failed: %v", info.SandboxID, killErr)
		}
		return store.SandboxSessionRecord{}, fmt.Errorf("persist sandbox session: %w", err)
	}
	return rec, nil
}

// RunCode executes the given code inside the sandbox referenced by
// `rec`. Does NOT retry on ErrSandboxNotFound — the caller has the
// context (e.g. files_in that need re-uploading) to decide whether
// and how to retry. See InvalidateSession + GetOrCreateForConversation
// for the recovery path.
//
// Pre-conditions: `rec` must come from GetOrCreateForConversation /
// the result of a prior call so it's the canonical active row.
func (m *SessionManager) RunCode(ctx context.Context, rec store.SandboxSessionRecord, code string, language string) (CodeExecuteResult, error) {
	result, err := m.client.RunCode(ctx, rec.E2BSandboxID, rec.E2BClientID, code, language, m.cfg.CodeExecuteTimeout)
	if err != nil {
		return result, err
	}
	// Touch the row with the elapsed seconds + cost, so per-sandbox
	// usage stats stay current. NB: this updates the *descriptive*
	// columns on sandbox_sessions; the user-facing billing happens via
	// the gateway's SettleUsage on its reservation. Not double-counted
	// — TouchSandboxSession does not touch the wallet ledger.
	seconds := int(result.ExecutionMs / 1000)
	if seconds < 1 {
		seconds = 1
	}
	creditsCost := int64(seconds) * m.cfg.PerSecondCreditCost
	if touchErr := m.store.TouchSandboxSession(ctx, rec.ID, seconds, creditsCost); touchErr != nil {
		log.Printf("e2b: touch sandbox session %s failed: %v", rec.ID, touchErr)
	}
	return result, nil
}

// InvalidateSession marks `rec` as failed so the next
// GetOrCreateForConversation call will provision a fresh sandbox.
// Used by the gateway after ErrSandboxNotFound surfaces.
func (m *SessionManager) InvalidateSession(ctx context.Context, rec store.SandboxSessionRecord) error {
	return m.store.MarkSandboxSessionStatus(ctx, rec.ID, "failed")
}

// ReapTick scans for sandboxes that have crossed either the idle TTL
// or the absolute max-lifetime ceiling, kills them on E2B, and
// updates the DB row. Intended to be called periodically by the
// background reaper goroutine (5-minute cadence is reasonable).
//
// Errors per-row are logged and skipped — one stuck sandbox should
// not block reaping the others.
func (m *SessionManager) ReapTick(ctx context.Context) (killed int, err error) {
	now := time.Now().UTC()
	idleSince := now.Add(-m.cfg.IdleTTL)
	bornBefore := now.Add(-m.cfg.MaxLifetime)
	rows, err := m.store.ListReapableSandboxSessions(ctx, idleSince, bornBefore, 100)
	if err != nil {
		return 0, fmt.Errorf("list reapable: %w", err)
	}
	for _, rec := range rows {
		newStatus := "timeout"
		if rec.CreatedAt.Before(bornBefore) {
			newStatus = "killed" // hard ceiling trumps idle
		}
		if err := m.killAndMark(ctx, rec, newStatus); err != nil {
			log.Printf("e2b: reap sandbox %s (%s): %v", rec.ID, rec.E2BSandboxID, err)
			continue
		}
		killed++
	}
	return killed, nil
}

func (m *SessionManager) killAndMark(ctx context.Context, rec store.SandboxSessionRecord, newStatus string) error {
	if err := m.client.KillSandbox(ctx, rec.E2BSandboxID); err != nil {
		// Even if E2B kill fails (timeout/network), mark the DB row so
		// we don't keep trying to reuse a likely-dead sandbox. The
		// orphan will eventually time out on E2B's side at no cost.
		_ = m.store.MarkSandboxSessionStatus(ctx, rec.ID, "failed")
		return err
	}
	return m.store.MarkSandboxSessionStatus(ctx, rec.ID, newStatus)
}

// StartReaper kicks off a goroutine that calls ReapTick every
// `interval` until ctx is cancelled. Intended for cmd/main.go to call
// once at startup. Safe no-op if interval is zero (test mode).
func (m *SessionManager) StartReaper(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		return
	}
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if killed, err := m.ReapTick(ctx); err != nil {
					log.Printf("e2b: reaper tick: %v", err)
				} else if killed > 0 {
					log.Printf("e2b: reaper killed %d sandbox(es)", killed)
				}
			}
		}
	}()
}
