-- Phase 7: flat model catalog (remove fast/deep tiers).
-- Each chat model becomes its own selectable catalog row (its `slot` is now a
-- stable model id, not a tier). These additive columns drive the picker + the
-- Auto router. Idempotent: re-applied on every container start.

ALTER TABLE model_configs ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';
-- Higher = preferred. Orders the picker, breaks Auto-router ties, and selects
-- the default model (highest-priority enabled chat row).
ALTER TABLE model_configs ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 0;
