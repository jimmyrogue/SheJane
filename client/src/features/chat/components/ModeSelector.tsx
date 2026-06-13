import { useMemo, useState } from 'react'
import {
  IconCheck,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconInfoCircle,
  IconSparkles,
} from '@tabler/icons-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useI18n } from '@/shared/i18n/i18n'
import type { ChatMode } from '@/shared/local-data/types'
import { autoModeForIntent, autoModeLabelKey, isAutoMode, type AutoIntent } from '@/shared/modelMode'

/** One selectable catalog model (subset of the API's model info). */
export interface ModelOption {
  id: string
  label: string
  description?: string
  vendor?: string
  capability_tier?: string
}

/**
 * Composer-attached model picker. "Auto" is always offered and asks the
 * backend resolver to choose among enabled chat models; intent shortcuts keep
 * the same Auto pipeline but bias it toward speed or capability.
 */
export function ModeSelector({
  mode,
  models,
  onChange,
  disabled = false,
}: {
  mode: ChatMode
  models: ModelOption[]
  onChange: (next: ChatMode) => void
  disabled?: boolean
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<'intent' | 'models'>('intent')

  const autoLabel = t('composer.mode.auto')
  const selectedModel = models.find((model) => model.id === mode)
  const groupedModels = useMemo(() => groupModelsByVendor(models), [models])
  const selectedLabel = isAutoMode(mode) ? t(autoModeLabelKey(mode)) : (selectedModel?.label ?? autoLabel)

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen)
    if (!nextOpen) setView('intent')
  }

  const selectAuto = () => {
    onChange('auto')
  }

  const selectIntent = (intent: AutoIntent) => {
    onChange(autoModeForIntent(intent))
  }

  const selectModel = (model: ModelOption) => {
    onChange(model.id)
  }

  const renderChoice = ({
    key,
    label,
    hint,
    active,
    hero = false,
    onSelect,
  }: {
    key: string
    label: string
    hint?: string
    active: boolean
    hero?: boolean
    onSelect: () => void
  }) => (
    <DropdownMenuItem
      key={key}
      className={`composer-mode-item${active ? ' is-active' : ''}${hero ? ' is-hero' : ''}`}
      onSelect={onSelect}
    >
      {hero ? <IconSparkles size={14} aria-hidden="true" className="composer-mode-item-hero-icon" /> : null}
      <span className="composer-mode-item-text">
        <span className="composer-mode-item-label">{label}</span>
        {hint ? <span className="composer-mode-item-hint">{hint}</span> : null}
      </span>
      {active ? (
        <IconCheck size={14} aria-hidden="true" className="composer-mode-item-check" />
      ) : (
        <span aria-hidden="true" className="composer-mode-item-spacer" />
      )}
    </DropdownMenuItem>
  )

  const renderModel = (model: ModelOption) => {
    const tier = tierIndicator(model.capability_tier)
    const active = model.id === mode
    return (
      <DropdownMenuItem
        key={model.id}
        className={`composer-mode-item composer-mode-model-item${active ? ' is-active' : ''}`}
        onSelect={() => selectModel(model)}
      >
        <span className="composer-mode-item-text">
          <span className="composer-mode-item-label">{model.label}</span>
        </span>
        <span className="composer-mode-item-side">
          {tier ? <span className="composer-mode-tier-indicator">{tier}</span> : null}
          {active ? (
            <IconCheck size={14} aria-hidden="true" className="composer-mode-item-check" />
          ) : (
            <span aria-hidden="true" className="composer-mode-item-spacer" />
          )}
        </span>
      </DropdownMenuItem>
    )
  }

  return (
    <DropdownMenu open={open} onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          type="button"
          className="composer-mode-trigger"
          aria-label={t('composer.mode.menuLabel')}
          title={selectedLabel}
          disabled={disabled}
        >
          <IconSparkles size={14} aria-hidden="true" />
          <span className="composer-mode-trigger-label">{selectedLabel}</span>
          <IconChevronDown size={12} aria-hidden="true" className="composer-mode-trigger-chevron" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" alignOffset={4} sideOffset={8} className="composer-mode-menu">
        {view === 'intent' ? (
          <>
            {renderChoice({
              key: 'auto',
              label: autoLabel,
              hint: t('composer.mode.autoHint'),
              active: mode === 'auto',
              hero: true,
              onSelect: selectAuto,
            })}
            <DropdownMenuSeparator className="composer-mode-separator" />
            {renderChoice({
              key: 'intent-fast',
              label: t('composer.mode.intentFast'),
              hint: t('composer.mode.intentFastHint'),
              active: mode === 'auto.fast',
              onSelect: () => selectIntent('fast'),
            })}
            {renderChoice({
              key: 'intent-smart',
              label: t('composer.mode.intentSmart'),
              hint: t('composer.mode.intentSmartHint'),
              active: mode === 'auto.smart',
              onSelect: () => selectIntent('smart'),
            })}
            <DropdownMenuSeparator className="composer-mode-separator" />
            <DropdownMenuItem
              className="composer-mode-nav-item"
              onSelect={(event) => {
                event.preventDefault()
                setView('models')
              }}
            >
              <span>{t('composer.mode.chooseModel')}</span>
              <IconChevronRight size={14} aria-hidden="true" />
            </DropdownMenuItem>
          </>
        ) : (
          <>
            <DropdownMenuItem
              className="composer-mode-back-item"
              onSelect={(event) => {
                event.preventDefault()
                setView('intent')
              }}
            >
              <IconChevronLeft size={14} aria-hidden="true" />
              <span>{t('composer.mode.specificModels')}</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator className="composer-mode-separator" />
            <div className="composer-mode-model-list">
              {groupedModels.map((group) => (
                <div key={group.vendor}>
                  <div className="composer-mode-group-heading">
                    <span className="composer-mode-group-line" />
                    <span className="composer-mode-group-label">
                      {group.vendor}
                      <IconInfoCircle
                        size={12}
                        strokeWidth={1.8}
                        aria-label={vendorInfo(group.vendor)}
                        title={vendorInfo(group.vendor)}
                      />
                    </span>
                    <span className="composer-mode-group-line" />
                  </div>
                  {group.models.map(renderModel)}
                </div>
              ))}
            </div>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function groupModelsByVendor(models: ModelOption[]): Array<{ vendor: string; models: ModelOption[] }> {
  const groups: Array<{ vendor: string; models: ModelOption[] }> = []
  const byVendor = new Map<string, ModelOption[]>()
  for (const model of models) {
    const vendor = model.vendor?.trim() || '其他'
    let bucket = byVendor.get(vendor)
    if (!bucket) {
      bucket = []
      byVendor.set(vendor, bucket)
      groups.push({ vendor, models: bucket })
    }
    bucket.push(model)
  }
  for (const group of groups) {
    group.models.sort((a, b) => capabilityRank(a.capability_tier) - capabilityRank(b.capability_tier))
  }
  return groups
}

function capabilityRank(tier?: string): number {
  switch (tier) {
    case 'max':
      return 0
    case 'reasoning':
      return 1
    case 'balanced':
      return 2
    case 'fast':
      return 3
    default:
      return 4
  }
}

function tierIndicator(tier?: string): string {
  switch (tier) {
    case 'max':
      return '智力高'
    case 'reasoning':
      return '推理'
    case 'balanced':
      return '均衡'
    case 'fast':
      return '速度快'
    default:
      return ''
  }
}

function vendorInfo(vendor: string): string {
  switch (vendor.toLowerCase()) {
    case 'deepseek':
      return '深度求索，推理能力与性价比突出。'
    case 'claude':
      return 'Anthropic 出品，擅长写作、代码与长文理解。'
    case 'chatgpt':
    case 'openai':
      return 'OpenAI 出品，通用能力全面。'
    case 'qwen':
      return '阿里通义千问，中文与多语言表现出色。'
    case 'kimi':
      return '月之暗面，擅长长上下文与长文档。'
    case 'gemini':
      return 'Google 出品，原生多模态能力突出。'
    case 'minimax':
      return 'MiniMax 出品，适合长上下文和 Agent 任务。'
    case 'xiaomi':
      return '小米模型，适合快速问答与编码辅助。'
    default:
      return `${vendor} 模型`
  }
}
