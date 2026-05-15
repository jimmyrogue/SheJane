-- Multi-turn context: prior conversation turns that seed an agent run.
-- Idempotent (re-applied by the migrate glob on every startup).
ALTER TABLE agent_runs
    ADD COLUMN IF NOT EXISTS history JSONB NOT NULL DEFAULT '[]'::jsonb;
