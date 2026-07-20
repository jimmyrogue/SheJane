import type { ChatMessage, Conversation } from '@/shared/local-data/types'
import { failureRecoveryAction, type AgentFailureAction, type RecoveryTarget } from './recovery'

export interface RecoverableFailure {
  target: RecoveryTarget
  action: AgentFailureAction
  message: ChatMessage
  updatedAt: string
}

export function recentRecoverableFailures(conversations: Conversation[], limit = 3): RecoverableFailure[] {
  const failures: RecoverableFailure[] = []
  for (const conversation of conversations) {
    for (const message of conversation.messages) {
      if (message.role !== 'assistant' || message.status !== 'error') {
        continue
      }
      const failed = [...(message.agentEvents ?? [])].reverse().find((event) => event.type === 'run.failed')
      const action = failureRecoveryAction(failed)
      if (!action) {
        continue
      }
      failures.push({
        target: { conversationID: conversation.id, assistantMessageID: message.id },
        action,
        message,
        updatedAt: conversation.updatedAt,
      })
    }
  }
  return failures
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, Math.max(0, limit))
}
