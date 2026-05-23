import { IconBlobFilled } from '@tabler/icons-react'
import { useI18n } from '@/shared/i18n/i18n'
import type { ChatMessage } from '@/shared/local-data/types'

const THINKING_STATUSES = new Set<ChatMessage['status']>(['pending', 'streaming'])

/**
 * Tiny left-aligned pulsing icon shown below the latest assistant
 * message while the model is thinking. No logo, no elapsed time, no
 * token counter — just a quiet "something's happening" cue. The
 * detailed run timeline is still available in AgentProgress inside
 * the bubble; this is just the ambient pulse.
 *
 * Icon choice: a filled blob (rounded pebble shape) as a small nod to
 * the product name 石间 / "between stones". A warm-tinted stone
 * gently breathing.
 *
 * Paused (waiting_permission / waiting_input) doesn't render anything
 * here because PendingApprovalBar / PendingQuestionBar take over the
 * UI focus during those states.
 */
export function ThinkingIndicator({ message }: { message: ChatMessage }) {
  const { t } = useI18n()
  const isAssistant = message.role === 'assistant'
  const active = isAssistant && THINKING_STATUSES.has(message.status)
  if (!active) {
    return null
  }
  return (
    <div className="thinking-indicator" role="status" aria-label={t('agent.thinking')}>
      <IconBlobFilled size={20} className="thinking-pulse" aria-hidden="true" />
    </div>
  )
}
