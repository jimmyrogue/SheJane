CREATE TABLE IF NOT EXISTS billing_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    stripe_session_id VARCHAR(255) UNIQUE NOT NULL,
    stripe_payment_intent_id VARCHAR(255),
    amount INT NOT NULL,
    currency VARCHAR(10) NOT NULL,
    credits BIGINT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    raw_event_id VARCHAR(255),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_billing_transactions_user
    ON billing_transactions(user_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_transactions_payment_intent
    ON billing_transactions(stripe_payment_intent_id)
    WHERE stripe_payment_intent_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS credit_ledger (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    transaction_id UUID NOT NULL REFERENCES billing_transactions(id) ON DELETE CASCADE,
    delta BIGINT NOT NULL,
    reason VARCHAR(100) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(transaction_id, reason)
);

CREATE INDEX IF NOT EXISTS idx_credit_ledger_user
    ON credit_ledger(user_id, created_at DESC);
