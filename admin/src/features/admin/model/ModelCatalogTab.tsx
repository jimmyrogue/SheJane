import KeyRound from 'lucide-react/dist/esm/icons/key-round'
import Pencil from 'lucide-react/dist/esm/icons/pencil'
import Search from 'lucide-react/dist/esm/icons/search'
import Trash2 from 'lucide-react/dist/esm/icons/trash-2'
import type { AdminModelConfig } from '@/shared/api/client'
import { FilterChip, Toggle } from '../components/ui-helpers'
import { formatCapabilityTier, formatMultiplier } from '../shared/format'
import type { ModelStats } from './types'

const VENDOR_GLYPH: Record<string, string> = {
  ChatGPT: 'GP', OpenAI: 'AI', Claude: 'CL', DeepSeek: 'DS', Gemini: 'GM',
  Kimi: 'KM', MiniMax: 'MM', Qwen: 'QW', Xiaomi: 'MI',
}

function vendorGlyph(vendor?: string) {
  if (!vendor) return '··'
  if (VENDOR_GLYPH[vendor]) return VENDOR_GLYPH[vendor]
  const letters = vendor.replace(/[^A-Za-z]/g, '')
  if (letters.length >= 2) return letters.slice(0, 2).toUpperCase()
  return vendor.slice(0, 2).toUpperCase()
}

const TIER_TONE: Record<string, string> = { max: 'admin-pill-ink', reasoning: '', balanced: '', fast: 'admin-pill-faint' }

function ModelRow({
  cfg,
  onOpenEdit,
  onToggleEnabled,
  onRemoveConfig,
}: {
  cfg: AdminModelConfig
  onOpenEdit: (cfg: AdminModelConfig) => void
  onToggleEnabled: (cfg: AdminModelConfig) => Promise<void>
  onRemoveConfig: (cfg: AdminModelConfig) => Promise<void>
}) {
  const inRate = cfg.input_credit_multiplier || cfg.credit_multiplier
  const outRate = cfg.output_credit_multiplier || cfg.credit_multiplier
  const baseHost = (cfg.base_url || '').replace(/^https?:\/\//, '') || 'default'

  return (
    <div className={`admin-model-grid-row${cfg.enabled ? '' : ' disabled'}`}>
      {/* 模型 */}
      <div className="flex min-w-0 items-center gap-3">
        <span className="admin-monogram">{vendorGlyph(cfg.vendor)}</span>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="admin-model-name">{cfg.display_name || cfg.slot}</span>
            <span className={`admin-pill ${TIER_TONE[cfg.capability_tier ?? 'balanced'] ?? ''}`}>{formatCapabilityTier(cfg.capability_tier)}</span>
          </div>
          <div className="admin-model-id">{cfg.slot}</div>
        </div>
      </div>
      {/* 上游连接 */}
      <div className="min-w-0">
        <div className="admin-model-upstream-name">{cfg.model_name || cfg.provider_kind}</div>
        <div className="admin-model-upstream flex items-center gap-1.5">
          <span className="admin-pill admin-pill-faint">{cfg.provider_kind}</span>
          <span className="truncate">{baseHost}</span>
        </div>
      </div>
      {/* Token 费率 */}
      <div className="admin-rate">
        <div className="admin-rate-main">
          <span className="faint">in</span> ×{formatMultiplier(inRate)}
          <span className="sep">·</span>
          <span className="faint">out</span> ×{formatMultiplier(outRate)}
        </div>
        <div className="admin-rate-base">base ×{formatMultiplier(cfg.credit_multiplier)}</div>
      </div>
      {/* 状态 */}
      <div className="flex flex-col items-start gap-2">
        <div className="flex items-center gap-2">
          <Toggle on={cfg.enabled} label={cfg.enabled ? '停用' : '启用'} onClick={() => void onToggleEnabled(cfg)} />
          <span className="text-xs" style={{ color: cfg.enabled ? 'var(--sj-ink-soft)' : 'var(--sj-ink-faint)' }}>{cfg.enabled ? '启用' : '停用'}</span>
        </div>
        {cfg.api_key_configured ? (
          <span className="admin-keychip-on">
            <span className="admin-chip-dot" style={{ background: 'var(--sj-moss)' }} />
            Key 已配置
          </span>
        ) : (
          <span className="admin-keychip-off">
            <KeyRound />
            Key 未配置
          </span>
        )}
      </div>
      {/* 操作 */}
      <div className="admin-model-actions">
        <button type="button" className="admin-icon-action" title="编辑" aria-label="编辑" onClick={() => onOpenEdit(cfg)}>
          <Pencil />
        </button>
        <button type="button" className="admin-icon-action danger" title="删除" aria-label="删除" onClick={() => void onRemoveConfig(cfg)}>
          <Trash2 />
        </button>
      </div>
    </div>
  )
}

export function ModelCatalogTab({
  configs,
  visibleConfigs,
  modelStats,
  catalogQuery,
  vendorFilter,
  onCatalogQueryChange,
  onVendorFilterChange,
  onOpenEdit,
  onToggleEnabled,
  onRemoveConfig,
}: {
  configs: AdminModelConfig[]
  visibleConfigs: AdminModelConfig[]
  modelStats: ModelStats
  catalogQuery: string
  vendorFilter: string
  onCatalogQueryChange: (value: string) => void
  onVendorFilterChange: (value: string) => void
  onOpenEdit: (cfg: AdminModelConfig) => void
  onToggleEnabled: (cfg: AdminModelConfig) => Promise<void>
  onRemoveConfig: (cfg: AdminModelConfig) => Promise<void>
}) {
  return (
    <div id="providers">
      <div className="admin-catalog-tools">
        <div className="admin-search-field">
          <Search className="size-4" />
          <input
            value={catalogQuery}
            onChange={(event) => onCatalogQueryChange(event.target.value)}
            placeholder="搜索模型 ID / 名称 / 上游…"
          />
        </div>
        <div className="admin-filter-chips">
          <FilterChip label="全部" active={vendorFilter === 'all'} onClick={() => onVendorFilterChange('all')} />
          {modelStats.vendors.map((vendor) => (
            <FilterChip key={vendor} label={vendor} active={vendorFilter === vendor} onClick={() => onVendorFilterChange(vendor)} />
          ))}
          <FilterChip label="已停用" active={vendorFilter === 'off'} onClick={() => onVendorFilterChange('off')} />
        </div>
      </div>

      <div className="admin-model-table-card">
        <div className="admin-model-grid-head">
          <span>模型</span>
          <span>上游连接</span>
          <span>Token 费率</span>
          <span>状态</span>
          <span className="text-right">操作</span>
        </div>
        <div>
          {visibleConfigs.length ? (
            visibleConfigs.map((cfg) => (
              <ModelRow
                key={cfg.id}
                cfg={cfg}
                onOpenEdit={onOpenEdit}
                onToggleEnabled={onToggleEnabled}
                onRemoveConfig={onRemoveConfig}
              />
            ))
          ) : (
            <div className="admin-empty-inline">{configs.length ? '没有匹配的模型' : '暂无模型配置（首次启动会从 env 自动播种）'}</div>
          )}
        </div>
      </div>
    </div>
  )
}
