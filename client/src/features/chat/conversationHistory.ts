import type { AgentHistoryMessage } from '@/shared/api/client'
import type { ChatMessage } from '@/shared/local-data/types'

// Bounded conversation-history derivation, mirroring 2026 agent-harness
// practice (Anthropic stateless message list / OpenAI Session limit): seed
// each run with recent prior turns, capped so long threads never blow the
// model context window.
const DEFAULT_MAX_MESSAGES = 20
const DEFAULT_MAX_CHARS = 12000

// Deterministic (no-LLM) compaction marker: when older turns are elided by the
// caps, tell the model context was truncated instead of silently dropping it,
// so it won't mistake a partial thread for the whole conversation. (LLM-based
// summarization compaction is the separate phase-3 enhancement.)
function omittedTurnsMarker(count: number): AgentHistoryMessage {
  return {
    role: 'user',
    content: `【上下文提示｜对话较长，已省略更早的 ${count} 轮，仅保留最近内容；如需更早信息请重述。】`,
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
  const maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS

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
    return [omittedTurnsMarker(omitted), ...recent]
  }
  return recent
}
