-- Phase 6: password reset.
--
-- Tokens are stored HASHED (sha256 hex), never plaintext — same discipline as
-- refresh_tokens. We hand the user the plaintext token (in the emailed link),
-- store only its hash, and consume it single-use under a row lock.

CREATE TABLE IF NOT EXISTS password_reset_tokens (
    token VARCHAR(160) PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user ON password_reset_tokens(user_id);
