import type { TranslationKey } from './i18n/i18n'
import type { ChatMode } from './local-data/types'

export type AutoIntent = '' | 'fast' | 'smart'
export type AutoChatMode = 'auto' | 'auto.fast' | 'auto.smart'

export function isAutoMode(mode: ChatMode | string | undefined | null): mode is AutoChatMode {
  return mode === 'auto' || mode === 'auto.fast' || mode === 'auto.smart'
}

export function autoIntentFromMode(mode: ChatMode | string | undefined | null): AutoIntent {
  if (mode === 'auto.fast') return 'fast'
  if (mode === 'auto.smart') return 'smart'
  return ''
}

export function autoModeForIntent(intent: AutoIntent): AutoChatMode {
  if (intent === 'fast') return 'auto.fast'
  if (intent === 'smart') return 'auto.smart'
  return 'auto'
}

export function autoModeLabelKey(mode: ChatMode | string | undefined | null): TranslationKey {
  if (mode === 'auto.fast') return 'composer.mode.intentFast'
  if (mode === 'auto.smart') return 'composer.mode.intentSmart'
  return 'composer.mode.auto'
}
