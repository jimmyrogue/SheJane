-- Model token pricing: split the old single credit_multiplier into
-- input/output/cache multipliers while keeping the legacy multiplier as the
-- fallback for existing rows and old admin clients. All multipliers are cost
-- ratios relative to the DeepSeek Pro baseline (1.0).

ALTER TABLE model_configs
    ADD COLUMN IF NOT EXISTS input_credit_multiplier NUMERIC(10,4) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS output_credit_multiplier NUMERIC(10,4) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS cached_input_credit_multiplier NUMERIC(10,4) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS cache_write_credit_multiplier NUMERIC(10,4) NOT NULL DEFAULT 0;
