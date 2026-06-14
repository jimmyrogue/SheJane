-- Model CNY token prices: let admins enter supplier costs directly as
-- RMB per 1M tokens. Existing multiplier-based rows remain valid because
-- these fields default to 0 and the billing path falls back to multipliers
-- unless both input/output prices are configured.

ALTER TABLE model_configs
    ADD COLUMN IF NOT EXISTS input_price_per_million_cny NUMERIC(12,4) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS output_price_per_million_cny NUMERIC(12,4) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS cached_input_price_per_million_cny NUMERIC(12,4) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS cache_write_price_per_million_cny NUMERIC(12,4) NOT NULL DEFAULT 0;
