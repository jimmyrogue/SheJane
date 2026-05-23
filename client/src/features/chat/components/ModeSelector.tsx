import { IconBolt, IconCheck, IconChevronDown, IconSparkles, IconStars } from '@tabler/icons-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useI18n } from '@/shared/i18n/i18n'
import type { ChatMode } from '@/shared/local-data/types'

/**
 * Composer-attached model picker. Three options, one always-visible:
 *   Auto — daemon's classifier picks fast or pro at run start
 *   Fast — cheaper / lower-latency tier (good for simple tasks)
 *   Pro  — higher-quality tier (better at multi-step reasoning)
 *
 * The concrete model each tier maps to is decided by the Go LLM router
 * (api/internal/modelreg/) at runtime, not here — so this UI must NOT
 * name specific providers or model versions. The auto-router picks
 * between "fast" and "deep" mode strings; the cloud resolves those.
 *
 * Auto is the default so the user doesn't have to think about cost on
 * every send. The actual model the auto-router resolves to is surfaced
 * on the response message via a small "Auto → Pro" badge.
 */
export function ModeSelector({
  mode,
  onChange,
  disabled = false,
}: {
  mode: ChatMode
  onChange: (next: ChatMode) => void
  disabled?: boolean
}) {
  const { t } = useI18n()
  const current = MODE_META[mode]

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          type="button"
          className="composer-mode-trigger"
          aria-label={t('composer.mode.menuLabel')}
          title={t(current.hintKey)}
          disabled={disabled}
        >
          <current.Icon size={14} aria-hidden="true" />
          <span className="composer-mode-trigger-label">{t(current.labelKey)}</span>
          <IconChevronDown size={12} aria-hidden="true" className="composer-mode-trigger-chevron" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="composer-mode-menu">
        {(['auto', 'fast', 'pro'] as const).map((value) => {
          const meta = MODE_META[value]
          const isActive = value === mode
          return (
            <DropdownMenuItem
              key={value}
              className={`composer-mode-item${isActive ? ' is-active' : ''}`}
              onSelect={() => onChange(value)}
            >
              {/* No leading icon — keeps the menu narrow. Active state
               *  is signalled by a trailing check on the right, matching
               *  the macOS / Claude-style picker convention. */}
              <div className="composer-mode-item-text">
                <span className="composer-mode-item-label">{t(meta.labelKey)}</span>
                <span className="composer-mode-item-hint">{t(meta.hintKey)}</span>
              </div>
              {isActive ? (
                <IconCheck size={14} aria-hidden="true" className="composer-mode-item-check" />
              ) : null}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const MODE_META = {
  auto: { Icon: IconSparkles, labelKey: 'composer.mode.auto', hintKey: 'composer.mode.autoHint' },
  fast: { Icon: IconBolt, labelKey: 'composer.mode.fast', hintKey: 'composer.mode.fastHint' },
  pro: { Icon: IconStars, labelKey: 'composer.mode.pro', hintKey: 'composer.mode.proHint' },
} as const
