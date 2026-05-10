CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(100) NOT NULL DEFAULT '',
    role VARCHAR(20) NOT NULL DEFAULT 'user',
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_login_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

CREATE TABLE IF NOT EXISTS refresh_tokens (
    token VARCHAR(160) PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wallets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_type VARCHAR(20) NOT NULL DEFAULT 'user',
    user_id UUID UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    organization_id UUID,
    plan_code VARCHAR(50) NOT NULL DEFAULT 'free_trial',
    monthly_credit_limit BIGINT NOT NULL DEFAULT 0,
    monthly_credits_used BIGINT NOT NULL DEFAULT 0,
    period_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    period_end TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '30 days',
    extra_credits_balance BIGINT NOT NULL DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    stripe_subscription_id VARCHAR(255),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS usage_reservations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id UUID NOT NULL REFERENCES wallets(id),
    user_id UUID NOT NULL REFERENCES users(id),
    organization_id UUID,
    client_conversation_id VARCHAR(80),
    client_message_id VARCHAR(80),
    request_id VARCHAR(80) UNIQUE NOT NULL,
    mode VARCHAR(20) NOT NULL,
    estimated_credits BIGINT NOT NULL,
    actual_credits BIGINT,
    reserved_monthly_credits BIGINT NOT NULL DEFAULT 0,
    reserved_extra_credits BIGINT NOT NULL DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'reserved',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    settled_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_reservations_wallet ON usage_reservations(wallet_id, created_at DESC);

CREATE TABLE IF NOT EXISTS wallet_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id UUID NOT NULL REFERENCES wallets(id),
    reservation_id UUID REFERENCES usage_reservations(id),
    type VARCHAR(40) NOT NULL,
    amount BIGINT NOT NULL,
    monthly_used_after BIGINT NOT NULL,
    extra_balance_after BIGINT NOT NULL,
    description VARCHAR(500),
    idempotency_key VARCHAR(255) UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wallet_tx_wallet ON wallet_transactions(wallet_id, created_at DESC);

CREATE TABLE IF NOT EXISTS llm_call_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id VARCHAR(80) UNIQUE NOT NULL,
    user_id UUID NOT NULL REFERENCES users(id),
    wallet_id UUID NOT NULL REFERENCES wallets(id),
    reservation_id UUID REFERENCES usage_reservations(id),
    client_conversation_id VARCHAR(80),
    client_message_id VARCHAR(80),
    mode VARCHAR(20) NOT NULL,
    scene VARCHAR(50),
    model VARCHAR(100),
    provider VARCHAR(50),
    input_tokens INT NOT NULL DEFAULT 0,
    output_tokens INT NOT NULL DEFAULT 0,
    credits_cost BIGINT NOT NULL DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'streaming',
    error_code VARCHAR(80),
    error_message VARCHAR(500),
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_llm_calls_user ON llm_call_records(user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_llm_calls_client_conv ON llm_call_records(user_id, client_conversation_id);

CREATE TABLE IF NOT EXISTS payment_orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id UUID NOT NULL REFERENCES wallets(id),
    package_id UUID,
    type VARCHAR(30) NOT NULL,
    amount_cny INT NOT NULL,
    currency VARCHAR(10) NOT NULL DEFAULT 'cny',
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    checkout_url TEXT,
    stripe_checkout_session_id VARCHAR(255) UNIQUE,
    stripe_payment_intent_id VARCHAR(255),
    stripe_subscription_id VARCHAR(255),
    idempotency_key VARCHAR(255) UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_orders_wallet ON payment_orders(wallet_id, created_at DESC);

CREATE TABLE IF NOT EXISTS stripe_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    stripe_event_id VARCHAR(255) UNIQUE NOT NULL,
    event_type VARCHAR(100) NOT NULL,
    payload JSONB NOT NULL,
    processed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_user_id UUID REFERENCES users(id),
    organization_id UUID,
    action VARCHAR(100) NOT NULL,
    target_type VARCHAR(80),
    target_id UUID,
    ip_address INET,
    user_agent TEXT,
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor_user_id, created_at DESC);
