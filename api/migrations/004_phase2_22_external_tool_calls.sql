CREATE TABLE IF NOT EXISTS external_tool_call_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id VARCHAR(80) UNIQUE NOT NULL,
    user_id UUID NOT NULL REFERENCES users(id),
    wallet_id UUID NOT NULL REFERENCES wallets(id),
    reservation_id UUID REFERENCES usage_reservations(id),
    run_id VARCHAR(120),
    tool_call_id VARCHAR(120),
    tool VARCHAR(120) NOT NULL,
    provider VARCHAR(80) NOT NULL,
    units INT NOT NULL DEFAULT 0,
    credits_cost BIGINT NOT NULL DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'running',
    error_code VARCHAR(80),
    error_message VARCHAR(500),
    idempotency_key VARCHAR(255) UNIQUE,
    response_content TEXT,
    response_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_external_tool_calls_user ON external_tool_call_records(user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_external_tool_calls_run ON external_tool_call_records(run_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_external_tool_calls_tool ON external_tool_call_records(tool, started_at DESC);
