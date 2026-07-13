ALTER TABLE usage_reservations
ADD COLUMN IF NOT EXISTS run_id VARCHAR(120);

ALTER TABLE llm_call_records
ADD COLUMN IF NOT EXISTS run_id VARCHAR(120);

CREATE INDEX IF NOT EXISTS idx_reservations_run ON usage_reservations(run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_llm_calls_run ON llm_call_records(run_id, started_at DESC);
