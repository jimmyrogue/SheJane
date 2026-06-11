-- Phase 6: email verification.
--
-- Advisory only — login is NOT gated on verification (v1). New signups get a
-- verify email; a dismissible banner nudges them. Verify tokens follow the
-- same hashed-single-use-expiring discipline as password_reset_tokens.

ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS email_verification_tokens (
    token VARCHAR(160) PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_verification_tokens_user ON email_verification_tokens(user_id);

-- Grandfather accounts that predate email verification. New signups get a
-- verification token at registration before email delivery is attempted, so
-- they remain unverified even if an old psql-loop deployment re-applies this
-- file or the versioned runner first records an existing database.
UPDATE users
SET email_verified = true
WHERE email_verified = false
  AND NOT EXISTS (
    SELECT 1
    FROM email_verification_tokens
    WHERE email_verification_tokens.user_id = users.id
  );
