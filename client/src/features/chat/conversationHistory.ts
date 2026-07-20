import type { ChatMessage } from '@/shared/local-data/types'

export interface AgentHistoryMessage {
  role: 'user' | 'assistant'
  content: string
}

// Temporary P2 transport boundary while the client still uploads prior
// messages. The Runtime request schema accepts at most 256 items and 1 MiB;
// leave headroom for the goal and settings. Context compaction itself belongs
// to the Runtime's token-aware Deep Agents pipeline, not this client helper.
const TRANSPORT_MAX_MESSAGES = 256
const TRANSPORT_MAX_CHARS = 750_000

// Deterministic (no-LLM) compaction marker: when older turns are elided by the
// caps, tell the model context was truncated instead of silently dropping it,
// so it won't mistake a partial thread for the whole conversation. (LLM-based
// summarization compaction is the separate phase-3 enhancement.)
function omittedTurnsMarker(count: number): AgentHistoryMessage {
  return {
    role: 'user',
    content: `【上下文提示｜由于传输大小限制，已省略更早的 ${count} 条消息；如需其中信息请让用户重述。】`,
  }
}

/**
 * Turn the conversation's PRIOR messages (everything before the new user
 * input) into a structured {role, content} history for an agent run.
 * Skips system rows, the empty streaming/pending assistant placeholder, and
 * failed turns; keeps only the most recent messages within a char budget.
 */
export function deriveAgentHistory(
  priorMessages: ChatMessage[],
): AgentHistoryMessage[] {
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

  let recent = turns.slice(-TRANSPORT_MAX_MESSAGES)
  let total = recent.reduce((sum, turn) => sum + turn.content.length, 0)
  while (recent.length > 1 && total > TRANSPORT_MAX_CHARS) {
    total -= recent[0].content.length
    recent = recent.slice(1)
  }

  const omitted = turns.length - recent.length
  if (omitted > 0) {
    return [omittedTurnsMarker(omitted), ...recent]
  }
  return recent
}
