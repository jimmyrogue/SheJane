-- Phase 5: per-conversation E2B sandbox sessions for the code.execute tool.
--
-- Each row represents one E2B microVM that's been provisioned (or once was)
-- on behalf of a user's conversation. A conversation owns at most one
-- *active* sandbox at any given moment — reuse keeps the Jupyter kernel
-- variables alive across multiple code.execute calls so the agent can
-- iterate ("now do X to that DataFrame") without losing state.
--
-- Lifecycle:
--   active   → newly created OR recently used
--   timeout  → background reaper killed it after idle TTL elapsed
--   killed   → explicit kill (conversation ended, hard-lifetime hit, manual)
--   failed   → E2B refused / network died mid-call; cannot be reused
--
-- We carry total_seconds + total_credits_cost rolling sums so admin /
-- usage reports don't need to re-aggregate per-call rows from
-- external_tool_call_records.

CREATE TABLE IF NOT EXISTS sandbox_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    conversation_id VARCHAR(120) NOT NULL,
    e2b_sandbox_id VARCHAR(120) NOT NULL,
    provider VARCHAR(40) NOT NULL DEFAULT 'e2b',
    template_id VARCHAR(120) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    killed_at TIMESTAMPTZ,
    total_seconds INTEGER NOT NULL DEFAULT 0,
    total_credits_cost BIGINT NOT NULL DEFAULT 0
);

-- One active sandbox per (user, conversation). Once status flips to
-- timeout/killed/failed, the unique slot frees up and a new active row
-- can be created on the next code.execute call.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_sandbox_sessions_active_per_conversation
    ON sandbox_sessions(user_id, conversation_id)
    WHERE status = 'active';

-- Reaper lookups: scan only active rows, ordered by oldest activity.
CREATE INDEX IF NOT EXISTS idx_sandbox_sessions_reaper
    ON sandbox_sessions(last_used_at)
    WHERE status = 'active';

-- Admin / per-user history: most-recent first.
CREATE INDEX IF NOT EXISTS idx_sandbox_sessions_user_recent
    ON sandbox_sessions(user_id, last_used_at DESC);
