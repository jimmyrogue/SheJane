import type { AgentPlanTodo, Conversation } from '@/shared/local-data/types'

export interface PendingPlanApproval {
  messageID: string
  requestID: string
  todos: AgentPlanTodo[]
}

export function findConversationPendingPlanApproval(
  conversation: Conversation | undefined,
): PendingPlanApproval | null {
  if (!conversation) {
    return null
  }
  for (const message of [...conversation.messages].reverse()) {
    const events = message.agentEvents ?? []
    if (!events.length) {
      continue
    }
    const resolved = new Set<string>()
    for (const event of events) {
      if (event.type === 'plan.approval_resolved' && event.planApprovalRequestId) {
        resolved.add(event.planApprovalRequestId)
      }
    }
    for (const event of [...events].reverse()) {
      if (
        event.type === 'plan.approval_required' &&
        event.planApprovalRequestId &&
        !resolved.has(event.planApprovalRequestId)
      ) {
        return {
          messageID: message.id,
          requestID: event.planApprovalRequestId,
          todos: event.planTodos ?? [],
        }
      }
    }
  }
  return null
}
