package store

import (
	"context"
	"database/sql"
	"encoding/json"
)

const modelConfigColumns = `id::text, slot, capability, provider_kind, display_name, base_url,
	model_name, api_key_encrypted, credit_multiplier::double precision,
	COALESCE(input_credit_multiplier, 0)::double precision,
	COALESCE(output_credit_multiplier, 0)::double precision,
	COALESCE(cached_input_credit_multiplier, 0)::double precision,
	COALESCE(cache_write_credit_multiplier, 0)::double precision,
	price_per_call_cny::double precision, enabled,
	COALESCE(params, '{}'::jsonb)::text, created_at, updated_at, COALESCE(updated_by::text, ''),
	COALESCE(description, ''), COALESCE(priority, 0)`

func scanModelConfig(scanner interface{ Scan(...any) error }) (ModelConfig, error) {
	var cfg ModelConfig
	var paramsRaw string
	if err := scanner.Scan(
		&cfg.ID, &cfg.Slot, &cfg.Capability, &cfg.ProviderKind, &cfg.DisplayName, &cfg.BaseURL,
		&cfg.ModelName, &cfg.APIKeyEncrypted, &cfg.CreditMultiplier,
		&cfg.InputCreditMultiplier, &cfg.OutputCreditMultiplier,
		&cfg.CachedInputCreditMultiplier, &cfg.CacheWriteCreditMultiplier,
		&cfg.PricePerCallCNY, &cfg.Enabled,
		&paramsRaw, &cfg.CreatedAt, &cfg.UpdatedAt, &cfg.UpdatedBy,
		&cfg.Description, &cfg.Priority,
	); err != nil {
		return ModelConfig{}, err
	}
	cfg.Params = decodeParams(paramsRaw)
	return cfg, nil
}

func decodeParams(raw string) map[string]any {
	params := map[string]any{}
	if raw == "" {
		return params
	}
	_ = json.Unmarshal([]byte(raw), &params)
	if params == nil {
		params = map[string]any{}
	}
	return params
}

func encodeParams(params map[string]any) json.RawMessage {
	if params == nil {
		return json.RawMessage(`{}`)
	}
	raw, err := json.Marshal(params)
	if err != nil {
		return json.RawMessage(`{}`)
	}
	return json.RawMessage(raw)
}

func (s *PostgresStore) CountModelConfigs(ctx context.Context) (int64, error) {
	var count int64
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM model_configs`).Scan(&count); err != nil {
		return 0, err
	}
	return count, nil
}

func (s *PostgresStore) ListModelConfigs(ctx context.Context, capability string) ([]ModelConfig, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT `+modelConfigColumns+`
		FROM model_configs
		WHERE ($1 = '' OR capability = $1)
		ORDER BY capability, slot, enabled DESC, updated_at DESC
	`, capability)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	configs := make([]ModelConfig, 0)
	for rows.Next() {
		cfg, err := scanModelConfig(rows)
		if err != nil {
			return nil, err
		}
		configs = append(configs, cfg)
	}
	return configs, rows.Err()
}

func (s *PostgresStore) GetModelConfig(ctx context.Context, id string) (ModelConfig, error) {
	cfg, err := scanModelConfig(s.db.QueryRowContext(ctx, `SELECT `+modelConfigColumns+` FROM model_configs WHERE id=$1`, id))
	if err != nil {
		return ModelConfig{}, mapNotFound(err)
	}
	return cfg, nil
}

func (s *PostgresStore) UpsertModelConfig(ctx context.Context, actorUserID string, cfg ModelConfig) (ModelConfig, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return ModelConfig{}, err
	}
	defer rollback(tx)

	if cfg.Enabled {
		if _, err := tx.ExecContext(ctx, `
			UPDATE model_configs SET enabled=false, updated_at=NOW()
			WHERE slot=$1 AND enabled AND ($2='' OR id::text<>$2)
		`, cfg.Slot, cfg.ID); err != nil {
			return ModelConfig{}, err
		}
	}

	var saved ModelConfig
	if cfg.ID == "" {
		saved, err = scanModelConfig(tx.QueryRowContext(ctx, `
			INSERT INTO model_configs
				(slot, capability, provider_kind, display_name, base_url, model_name,
				 api_key_encrypted, credit_multiplier, input_credit_multiplier, output_credit_multiplier,
				 cached_input_credit_multiplier, cache_write_credit_multiplier, price_per_call_cny, enabled,
				 params, updated_by, description, priority)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, NULLIF($16,'')::uuid, $17, $18)
			RETURNING `+modelConfigColumns+`
		`, cfg.Slot, cfg.Capability, cfg.ProviderKind, cfg.DisplayName, cfg.BaseURL, cfg.ModelName,
			cfg.APIKeyEncrypted, cfg.CreditMultiplier, cfg.InputCreditMultiplier, cfg.OutputCreditMultiplier,
			cfg.CachedInputCreditMultiplier, cfg.CacheWriteCreditMultiplier, cfg.PricePerCallCNY, cfg.Enabled,
			encodeParams(cfg.Params), actorUserID,
			cfg.Description, cfg.Priority))
	} else {
		saved, err = scanModelConfig(tx.QueryRowContext(ctx, `
			UPDATE model_configs SET
				slot=$2, capability=$3, provider_kind=$4, display_name=$5, base_url=$6,
				model_name=$7, api_key_encrypted=$8, credit_multiplier=$9,
				input_credit_multiplier=$10, output_credit_multiplier=$11,
				cached_input_credit_multiplier=$12, cache_write_credit_multiplier=$13,
				price_per_call_cny=$14, enabled=$15, params=$16, updated_at=NOW(),
				updated_by=NULLIF($17,'')::uuid, description=$18, priority=$19
			WHERE id=$1
			RETURNING `+modelConfigColumns+`
		`, cfg.ID, cfg.Slot, cfg.Capability, cfg.ProviderKind, cfg.DisplayName, cfg.BaseURL,
			cfg.ModelName, cfg.APIKeyEncrypted, cfg.CreditMultiplier, cfg.InputCreditMultiplier,
			cfg.OutputCreditMultiplier, cfg.CachedInputCreditMultiplier, cfg.CacheWriteCreditMultiplier,
			cfg.PricePerCallCNY, cfg.Enabled, encodeParams(cfg.Params), actorUserID, cfg.Description,
			cfg.Priority))
	}
	if err != nil {
		return ModelConfig{}, mapNotFound(err)
	}

	if err := insertAuditLog(ctx, tx, actorUserID, "model_config.upsert", "model_config", saved.ID, map[string]any{
		"slot": saved.Slot, "provider_kind": saved.ProviderKind, "model_name": saved.ModelName,
		"credit_multiplier": saved.CreditMultiplier, "input_credit_multiplier": saved.InputCreditMultiplier,
		"output_credit_multiplier": saved.OutputCreditMultiplier, "enabled": saved.Enabled,
	}); err != nil {
		return ModelConfig{}, err
	}
	return saved, tx.Commit()
}

func (s *PostgresStore) SetModelConfigEnabled(ctx context.Context, actorUserID string, id string, enabled bool) (ModelConfig, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return ModelConfig{}, err
	}
	defer rollback(tx)

	var slot string
	if err := tx.QueryRowContext(ctx, `SELECT slot FROM model_configs WHERE id=$1`, id).Scan(&slot); err != nil {
		return ModelConfig{}, mapNotFound(err)
	}
	if enabled {
		if _, err := tx.ExecContext(ctx, `
			UPDATE model_configs SET enabled=false, updated_at=NOW()
			WHERE slot=$1 AND enabled AND id::text<>$2
		`, slot, id); err != nil {
			return ModelConfig{}, err
		}
	}
	saved, err := scanModelConfig(tx.QueryRowContext(ctx, `
		UPDATE model_configs SET enabled=$2, updated_at=NOW(), updated_by=NULLIF($3,'')::uuid
		WHERE id=$1
		RETURNING `+modelConfigColumns+`
	`, id, enabled, actorUserID))
	if err != nil {
		return ModelConfig{}, mapNotFound(err)
	}
	if err := insertAuditLog(ctx, tx, actorUserID, "model_config.toggle", "model_config", id, map[string]any{"enabled": enabled}); err != nil {
		return ModelConfig{}, err
	}
	return saved, tx.Commit()
}

func (s *PostgresStore) DeleteModelConfig(ctx context.Context, actorUserID string, id string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer rollback(tx)

	res, err := tx.ExecContext(ctx, `DELETE FROM model_configs WHERE id=$1`, id)
	if err != nil {
		return err
	}
	if affected, _ := res.RowsAffected(); affected == 0 {
		return ErrNotFound
	}
	if err := insertAuditLog(ctx, tx, actorUserID, "model_config.delete", "model_config", id, map[string]any{}); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *PostgresStore) GetAppSetting(ctx context.Context, key string) (AppSetting, error) {
	var setting AppSetting
	err := s.db.QueryRowContext(ctx, `
		SELECT key, value::text, updated_at FROM app_settings WHERE key=$1
	`, key).Scan(&setting.Key, &setting.Value, &setting.UpdatedAt)
	if err != nil {
		if err == sql.ErrNoRows {
			return AppSetting{}, ErrNotFound
		}
		return AppSetting{}, err
	}
	return setting, nil
}

func (s *PostgresStore) SetAppSetting(ctx context.Context, actorUserID string, key string, valueJSON string) (AppSetting, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return AppSetting{}, err
	}
	defer rollback(tx)

	var setting AppSetting
	if err := tx.QueryRowContext(ctx, `
		INSERT INTO app_settings (key, value, updated_by)
		VALUES ($1, $2::jsonb, NULLIF($3,'')::uuid)
		ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW(), updated_by=EXCLUDED.updated_by
		RETURNING key, value::text, updated_at
	`, key, valueJSON, actorUserID).Scan(&setting.Key, &setting.Value, &setting.UpdatedAt); err != nil {
		return AppSetting{}, err
	}
	if err := insertAuditLog(ctx, tx, actorUserID, "app_setting.update", "app_setting", "", map[string]any{"key": key, "value": valueJSON}); err != nil {
		return AppSetting{}, err
	}
	return setting, tx.Commit()
}
