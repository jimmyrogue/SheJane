import type { AgentQuestionItem, Conversation } from '@/shared/local-data/types'

export interface PendingQuestion {
  messageID: string
  requestID: string
  questions: AgentQuestionItem[]
}

/**
 * Find the single outstanding `user.ask` question for a conversation.
 *
 * Mirrors `findConversationPendingApproval`: questions are surfaced once, in a
 * card above the composer. We scan messages newest-first and, within a
 * message, return the most recent `question.asked` whose request has not been
 * answered.
 */
export function findConversationPendingQuestion(
  conversation: Conversation | undefined,
): PendingQuestion | null {
  if (!conversation) {
    return null
  }
  for (const message of [...conversation.messages].reverse()) {
    const events = message.agentEvents ?? []
    if (!events.length) {
      continue
    }
    const answered = new Set<string>()
    for (const event of events) {
      if (event.type === 'question.answered' && event.questionRequestId) {
        answered.add(event.questionRequestId)
      }
    }
    for (const event of [...events].reverse()) {
      if (
        event.type === 'question.asked' &&
        event.questionRequestId &&
        !answered.has(event.questionRequestId) &&
        event.questions &&
        event.questions.length > 0
      ) {
        return {
          messageID: message.id,
          requestID: event.questionRequestId,
          questions: event.questions,
        }
      }
    }
  }
  return null
}
