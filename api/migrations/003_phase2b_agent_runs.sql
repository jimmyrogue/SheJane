CREATE TABLE IF NOT EXISTS agent_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    origin VARCHAR(20) NOT NULL DEFAULT 'cloud',
    status VARCHAR(40) NOT NULL DEFAULT 'queued',
    mode VARCHAR(20) NOT NULL DEFAULT 'fast',
    goal TEXT NOT NULL DEFAULT '',
    goal_summary VARCHAR(240) NOT NULL DEFAULT '',
    client_conversation_id VARCHAR(80),
    client_message_id VARCHAR(80),
    attachments JSONB NOT NULL DEFAULT '[]',
    error_code VARCHAR(80),
    error_message VARCHAR(500),
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_user_created ON agent_runs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_expiry ON agent_runs(expires_at);

CREATE TABLE IF NOT EXISTS agent_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    seq BIGINT NOT NULL,
    event_type VARCHAR(80) NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(run_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_agent_events_run_seq ON agent_events(run_id, seq);
CREATE INDEX IF NOT EXISTS idx_agent_events_type ON agent_events(event_type, created_at DESC);
