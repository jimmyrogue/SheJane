import type { Translator } from '@/shared/i18n/i18n'
import type { Conversation } from '@/shared/local-data/types'

export interface PendingApproval {
  messageID: string
  requestID: string
  tool: string
}

/**
 * Find the single outstanding permission request for a conversation.
 *
 * Approvals are no longer rendered inline in the message list — they are
 * surfaced once, in a bar above the composer. We scan messages newest-first
 * and, within a message, return the most recent `permission.required` whose
 * request has not been resolved (resolved or auto-approved).
 */
export function findConversationPendingApproval(
  conversation: Conversation | undefined,
  t: Translator,
): PendingApproval | null {
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
      if (
        (event.type === 'permission.resolved' || event.type === 'permission.auto_approved') &&
        event.permissionRequestId
      ) {
        resolved.add(event.permissionRequestId)
      }
    }
    for (const event of [...events].reverse()) {
      if (
        event.type === 'permission.required' &&
        event.permissionRequestId &&
        !resolved.has(event.permissionRequestId)
      ) {
        return {
          messageID: message.id,
          requestID: event.permissionRequestId,
          tool:
            event.permissionTool ||
            stripKnownPrefix(event.label, ['需要权限：', 'Permission required: ']) ||
            t('agent.localAction'),
        }
      }
    }
  }
  return null
}

function stripKnownPrefix(value: string, prefixes: string[]): string {
  for (const prefix of prefixes) {
    if (value.startsWith(prefix)) {
      return value.slice(prefix.length)
    }
  }
  return value
}
