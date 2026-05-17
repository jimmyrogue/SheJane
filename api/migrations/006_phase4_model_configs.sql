-- Phase 4: dynamic model configuration + global app settings.
-- Replaces .env-only model config with admin-editable, hot-reloadable rows.
-- Idempotent: this file is re-applied on every container start.

CREATE TABLE IF NOT EXISTS model_configs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slot VARCHAR(40) NOT NULL,
    capability VARCHAR(20) NOT NULL DEFAULT 'chat',
    provider_kind VARCHAR(30) NOT NULL,
    display_name VARCHAR(120) NOT NULL DEFAULT '',
    base_url TEXT NOT NULL DEFAULT '',
    model_name VARCHAR(120) NOT NULL DEFAULT '',
    api_key_encrypted TEXT NOT NULL DEFAULT '',
    credit_multiplier NUMERIC(10,4) NOT NULL DEFAULT 1,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    params JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by UUID REFERENCES users(id)
);

-- At most one enabled config per logical slot (chat.fast / chat.deep / image.default ...).
CREATE UNIQUE INDEX IF NOT EXISTS idx_model_configs_slot_enabled
    ON model_configs(slot) WHERE enabled;

CREATE INDEX IF NOT EXISTS idx_model_configs_capability
    ON model_configs(capability, slot);

CREATE TABLE IF NOT EXISTS app_settings (
    key VARCHAR(80) PRIMARY KEY,
    value JSONB NOT NULL DEFAULT '{}',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by UUID REFERENCES users(id)
);
