package store

import (
	"context"
	"sort"
	"time"
)

func cloneParams(params map[string]any) map[string]any {
	cloned := make(map[string]any, len(params))
	for k, v := range params {
		cloned[k] = v
	}
	return cloned
}

func (s *MemoryStore) CountModelConfigs(ctx context.Context) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return int64(len(s.modelConfigs)), nil
}

func (s *MemoryStore) ListModelConfigs(ctx context.Context, capability string) ([]ModelConfig, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	configs := make([]ModelConfig, 0, len(s.modelConfigs))
	for _, cfg := range s.modelConfigs {
		if capability != "" && cfg.Capability != capability {
			continue
		}
		cfg.Params = cloneParams(cfg.Params)
		configs = append(configs, cfg)
	}
	sort.Slice(configs, func(i, j int) bool {
		if configs[i].Capability != configs[j].Capability {
			return configs[i].Capability < configs[j].Capability
		}
		if configs[i].Vendor != configs[j].Vendor {
			if configs[i].Vendor == "" {
				return false
			}
			if configs[j].Vendor == "" {
				return true
			}
			return configs[i].Vendor < configs[j].Vendor
		}
		if configs[i].Enabled != configs[j].Enabled {
			return configs[i].Enabled
		}
		if configs[i].Priority != configs[j].Priority {
			return configs[i].Priority > configs[j].Priority
		}
		if configs[i].Slot != configs[j].Slot {
			return configs[i].Slot < configs[j].Slot
		}
		return configs[i].UpdatedAt.After(configs[j].UpdatedAt)
	})
	return configs, nil
}

func (s *MemoryStore) GetModelConfig(ctx context.Context, id string) (ModelConfig, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	cfg, ok := s.modelConfigs[id]
	if !ok {
		return ModelConfig{}, ErrNotFound
	}
	cfg.Params = cloneParams(cfg.Params)
	return cfg, nil
}

func (s *MemoryStore) UpsertModelConfig(ctx context.Context, actorUserID string, cfg ModelConfig) (ModelConfig, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := time.Now().UTC()
	if cfg.ID == "" {
		cfg.ID = newID("model")
		cfg.CreatedAt = now
	} else if existing, ok := s.modelConfigs[cfg.ID]; ok {
		cfg.CreatedAt = existing.CreatedAt
	} else {
		cfg.CreatedAt = now
	}
	cfg.UpdatedAt = now
	cfg.UpdatedBy = actorUserID
	if cfg.Params == nil {
		cfg.Params = map[string]any{}
	}
	if cfg.Enabled {
		for id, other := range s.modelConfigs {
			if id != cfg.ID && other.Slot == cfg.Slot && other.Enabled {
				other.Enabled = false
				other.UpdatedAt = now
				s.modelConfigs[id] = other
			}
		}
	}
	s.modelConfigs[cfg.ID] = cfg
	s.appendAuditLocked(actorUserID, "model_config.upsert", "model_config", cfg.ID, "", map[string]any{"slot": cfg.Slot})
	stored := cfg
	stored.Params = cloneParams(cfg.Params)
	return stored, nil
}

func (s *MemoryStore) SetModelConfigEnabled(ctx context.Context, actorUserID string, id string, enabled bool) (ModelConfig, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	cfg, ok := s.modelConfigs[id]
	if !ok {
		return ModelConfig{}, ErrNotFound
	}
	now := time.Now().UTC()
	if enabled {
		for otherID, other := range s.modelConfigs {
			if otherID != id && other.Slot == cfg.Slot && other.Enabled {
				other.Enabled = false
				other.UpdatedAt = now
				s.modelConfigs[otherID] = other
			}
		}
	}
	cfg.Enabled = enabled
	cfg.UpdatedAt = now
	cfg.UpdatedBy = actorUserID
	s.modelConfigs[id] = cfg
	s.appendAuditLocked(actorUserID, "model_config.toggle", "model_config", id, "", map[string]any{"enabled": enabled})
	stored := cfg
	stored.Params = cloneParams(cfg.Params)
	return stored, nil
}

func (s *MemoryStore) DeleteModelConfig(ctx context.Context, actorUserID string, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.modelConfigs[id]; !ok {
		return ErrNotFound
	}
	delete(s.modelConfigs, id)
	s.appendAuditLocked(actorUserID, "model_config.delete", "model_config", id, "", map[string]any{})
	return nil
}

func (s *MemoryStore) GetAppSetting(ctx context.Context, key string) (AppSetting, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	setting, ok := s.appSettings[key]
	if !ok {
		return AppSetting{}, ErrNotFound
	}
	return setting, nil
}

func (s *MemoryStore) SetAppSetting(ctx context.Context, actorUserID string, key string, valueJSON string) (AppSetting, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	setting := AppSetting{Key: key, Value: valueJSON, UpdatedAt: time.Now().UTC()}
	s.appSettings[key] = setting
	s.appendAuditLocked(actorUserID, "app_setting.update", "app_setting", "", "", map[string]any{"key": key})
	return setting, nil
}
