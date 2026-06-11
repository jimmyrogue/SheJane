import type { AgentHistoryMessage } from '@/shared/api/client'
import type { ChatMessage } from '@/shared/local-data/types'

// Bounded conversation-history derivation, mirroring 2026 agent-harness
// practice (Anthropic stateless message list / OpenAI Session limit): seed
// each run with recent prior turns, capped so long threads never blow the
// model context window.
const DEFAULT_MAX_MESSAGES = 20
const DEFAULT_MAX_CHARS = 12000
const SUMMARY_MAX_ITEMS = 6
const SUMMARY_HEAD_ITEMS = 2
const SUMMARY_IMPORTANT_ITEMS = 2
const SUMMARY_EXCERPT_CHARS = 140
const SUMMARY_MAX_CHARS = 900
const IMPORTANT_SUMMARY_RE = /(重要|决定|约定|必须|不要|记住|remember|decision|decided|must|requirement|constraint|important)/i

// Deterministic (no-LLM) compaction marker: when older turns are elided by the
// caps, tell the model context was truncated instead of silently dropping it,
// so it won't mistake a partial thread for the whole conversation. (LLM-based
// summarization compaction is the separate phase-3 enhancement.)
function omittedTurnsMarker(count: number, omittedTurns: AgentHistoryMessage[]): AgentHistoryMessage {
  const summary = summarizeOmittedTurns(omittedTurns)
  return {
    role: 'user',
    content: [
      `【上下文提示｜对话较长，已省略更早的 ${count} 条消息，仅保留最近内容；如需更早信息请重述。】`,
      summary ? `早期摘要：\n${summary}` : '',
    ].filter(Boolean).join('\n'),
  }
}

export interface DeriveAgentHistoryOptions {
  maxMessages?: number
  maxChars?: number
}

/**
 * Turn the conversation's PRIOR messages (everything before the new user
 * input) into a structured {role, content} history for an agent run.
 * Skips system rows, the empty streaming/pending assistant placeholder, and
 * failed turns; keeps only the most recent messages within a char budget.
 */
export function deriveAgentHistory(
  priorMessages: ChatMessage[],
  options: DeriveAgentHistoryOptions = {},
): AgentHistoryMessage[] {
  const maxMessages = clampPositiveInteger(options.maxMessages, DEFAULT_MAX_MESSAGES)
  const maxChars = clampPositiveInteger(options.maxChars, DEFAULT_MAX_CHARS)

  const turns: AgentHistoryMessage[] = []
  for (const message of priorMessages) {
    if (message.role !== 'user' && message.role !== 'assistant') {
      continue
    }
    if (message.status === 'error' || message.status === 'streaming' || message.status === 'pending') {
      continue
    }
    const content = message.content?.trim()
    if (!content) {
      continue
    }
    turns.push({ role: message.role, content })
  }

  let recent = turns.slice(-maxMessages)
  let total = recent.reduce((sum, turn) => sum + turn.content.length, 0)
  while (recent.length > 1 && total > maxChars) {
    total -= recent[0].content.length
    recent = recent.slice(1)
  }

  const omitted = turns.length - recent.length
  if (omitted > 0) {
    return [omittedTurnsMarker(omitted, turns.slice(0, omitted)), ...recent]
  }
  return recent
}

function summarizeOmittedTurns(omittedTurns: AgentHistoryMessage[]): string {
  const selected = selectSummaryTurns(omittedTurns)
  const lines = selected
    .map((turn) => {
      const excerpt = compactExcerpt(turn.content)
      if (!excerpt) return ''
      return `- ${turn.role === 'user' ? '用户' : '助手'}: ${excerpt}`
    })
    .filter(Boolean)
  const summary = lines.join('\n')
  return summary.length > SUMMARY_MAX_CHARS ? `${summary.slice(0, SUMMARY_MAX_CHARS).trimEnd()}...` : summary
}

function selectSummaryTurns(turns: AgentHistoryMessage[]): AgentHistoryMessage[] {
  if (turns.length <= SUMMARY_MAX_ITEMS) return turns
  const selected = new Set<number>()
  for (let i = 0; i < Math.min(SUMMARY_HEAD_ITEMS, turns.length); i += 1) {
    selected.add(i)
  }
  for (
    let i = SUMMARY_HEAD_ITEMS;
    i < turns.length && selected.size < SUMMARY_HEAD_ITEMS + SUMMARY_IMPORTANT_ITEMS;
    i += 1
  ) {
    if (IMPORTANT_SUMMARY_RE.test(turns[i].content)) {
      selected.add(i)
    }
  }
  for (let i = turns.length - 1; i >= 0 && selected.size < SUMMARY_MAX_ITEMS; i -= 1) {
    selected.add(i)
  }
  return Array.from(selected)
    .sort((a, b) => a - b)
    .map((index) => turns[index])
}

function compactExcerpt(content: string): string {
  const value = content.replace(/\s+/g, ' ').trim()
  return value.length > SUMMARY_EXCERPT_CHARS ? `${value.slice(0, SUMMARY_EXCERPT_CHARS).trimEnd()}...` : value
}

function clampPositiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback
  }
  return Math.max(1, Math.floor(value))
}
