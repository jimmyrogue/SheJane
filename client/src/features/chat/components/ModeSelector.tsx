import { IconCheck, IconChevronDown, IconSparkles } from '@tabler/icons-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useI18n } from '@/shared/i18n/i18n'
import type { ChatMode } from '@/shared/local-data/types'

/** One selectable catalog model (subset of the API's model info). */
export interface ModelOption {
  id: string
  label: string
  description?: string
}

/**
 * Composer-attached model picker. "Auto" is always offered (the Go LLM router
 * picks the default / highest-priority model — a task-aware classifier is a
 * later upgrade); below it sit the enabled catalog models fetched from
 * GET /api/v1/models. The selected value is `'auto'` or a concrete model id.
 *
 * On the web build with no models configured, only Auto shows. The concrete
 * provider/model mapping lives in the Go registry, never here.
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
  const autoLabel = t('composer.mode.auto')
  const selectedLabel = mode === 'auto' ? autoLabel : (models.find((m) => m.id === mode)?.label ?? autoLabel)

  const renderItem = (value: ChatMode, label: string, hint?: string) => (
    <DropdownMenuItem
      key={value}
      className={`composer-mode-item${value === mode ? ' is-active' : ''}`}
      onSelect={() => onChange(value)}
    >
      <div className="composer-mode-item-text">
        <span className="composer-mode-item-label">{label}</span>
        {hint ? <span className="composer-mode-item-hint">{hint}</span> : null}
      </div>
      {value === mode ? (
        <IconCheck size={14} aria-hidden="true" className="composer-mode-item-check" />
      ) : null}
    </DropdownMenuItem>
  )

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          type="button"
          className="composer-mode-trigger"
          aria-label={t('composer.mode.menuLabel')}
          disabled={disabled}
        >
          <IconSparkles size={14} aria-hidden="true" />
          <span className="composer-mode-trigger-label">{selectedLabel}</span>
          <IconChevronDown size={12} aria-hidden="true" className="composer-mode-trigger-chevron" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" alignOffset={4} sideOffset={8} className="composer-mode-menu">
        {renderItem('auto', autoLabel, t('composer.mode.autoHint'))}
        {models.map((m) => renderItem(m.id, m.label, m.description))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
