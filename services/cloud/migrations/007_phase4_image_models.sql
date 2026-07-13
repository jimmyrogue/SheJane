-- Phase 4 (Phase 2 of the rollout): per-call pricing for image-generation
-- models. Money-per-call is converted to credits via the global
-- app_settings 'credit.currency_per_credit' rate. Idempotent.

ALTER TABLE model_configs
    ADD COLUMN IF NOT EXISTS price_per_call_cny NUMERIC(12,4) NOT NULL DEFAULT 0;
