-- Model catalog grouping + Auto-routing strength tiers.
-- `vendor` is the user/admin-facing group name used by model pickers.
-- `capability_tier` lets Auto prefer cheaper/faster models for simple tasks
-- and stronger reasoning models for difficult tasks.

ALTER TABLE model_configs
    ADD COLUMN IF NOT EXISTS vendor VARCHAR(60) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS capability_tier VARCHAR(20) NOT NULL DEFAULT 'balanced';

CREATE INDEX IF NOT EXISTS idx_model_configs_vendor
    ON model_configs(capability, vendor, enabled, priority DESC);
