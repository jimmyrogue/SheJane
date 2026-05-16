import { useEffect, useMemo, useRef, useState } from 'react'
import { appLogoURL } from '@/shared/assets/logo'
import { useI18n } from '@/shared/i18n/i18n'
import type { ChatMessage } from '@/shared/local-data/types'

const THINKING_STATUSES = new Set<ChatMessage['status']>(['pending', 'streaming'])
const PAUSED_STATUSES = new Set<ChatMessage['status']>(['waiting_permission', 'waiting_input'])

/**
 * Single per-conversation indicator (rendered once, below the latest message):
 * - thinking/executing  → slowly spinning logo + elapsed time
 * - paused for approval / a user.ask answer → static logo, timer frozen,
 *   "paused" text (the waited time is excluded from the elapsed total)
 * - finished → just the static logo
 */
export function ThinkingIndicator({ message }: { message: ChatMessage }) {
  const { t } = useI18n()
  const isAssistant = message.role === 'assistant'
  const thinking = isAssistant && THINKING_STATUSES.has(message.status)
  const paused = isAssistant && PAUSED_STATUSES.has(message.status)

  const start = useMemo(() => {
    const parsed = new Date(message.createdAt).getTime()
    return Number.isFinite(parsed) ? parsed : Date.now()
  }, [message.createdAt])

  const pausedAccumRef = useRef(0)
  const pauseSinceRef = useRef<number | null>(null)
  const [now, setNow] = useState(() => Date.now())

  // Bank time spent while paused so it is excluded from the elapsed total.
  useEffect(() => {
    if (paused) {
      pauseSinceRef.current = Date.now()
    }
    return () => {
      if (pauseSinceRef.current != null) {
        pausedAccumRef.current += Date.now() - pauseSinceRef.current
        pauseSinceRef.current = null
      }
    }
  }, [paused])

  // Tick only while actively thinking.
  useEffect(() => {
    if (!thinking) {
      return
    }
    setNow(Date.now())
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [thinking])

  if (!isAssistant) {
    return null
  }

  const elapsed = Math.max(0, now - start - pausedAccumRef.current)
  // Real-time: sum the per-call llm.usage timeline items as they stream in
  // (persisted in agentEvents, so reload/history still totals correctly).
  // Fall back to the run.completed total captured on the message.
  // Tokens for THIS turn only — sum the current message's own llm.usage
  // items. Each turn is its own assistant message, so this naturally resets
  // to zero at the start of every turn (no conversation-wide accumulation).
  const turnTokens = (message.agentEvents ?? []).reduce(
    (sum, item) => (item.type === 'llm.usage' && typeof item.tokens === 'number' ? sum + item.tokens : sum),
    0,
  )
  const tokensText = turnTokens > 0 ? t('agent.tokens', { count: formatTokens(turnTokens) }) : ''

  let detail: string | null = null
  if (thinking) {
    detail = tokensText ? `${formatElapsed(elapsed)} · ${tokensText}` : formatElapsed(elapsed)
  } else if (paused) {
    detail = t('agent.thinkingPaused')
  } else if (tokensText) {
    detail = tokensText
  }

  return (
    <div className="thinking-indicator" data-active={thinking}>
      <img className="thinking-logo" data-active={thinking} src={appLogoURL} alt="" aria-hidden="true" />
      {detail ? <span className="thinking-time">{detail}</span> : null}
    </div>
  )
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`
  }
  if (n >= 1000) {
    return `${(n / 1000).toFixed(1)}k`
  }
  return `${n}`
}

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000)
  const seconds = total % 60
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3600)
  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`
  }
  return `${seconds}s`
}
