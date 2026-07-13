import { describe, expect, it } from 'vitest'
import type { ChatMessage, Conversation } from '@/shared/local-data/types'
import { recentRecoverableFailures } from './recoverableFailures'

function assistant(
  id: string,
  status: ChatMessage['status'],
  failureCategory?: string,
  failureRecoveryAction?: NonNullable<ChatMessage['agentEvents']>[number]['failureRecoveryAction'],
): ChatMessage {
  return {
    id,
    role: 'assistant',
    content: '',
    createdAt: '2026-07-04T00:00:00.000Z',
    status,
    agentEvents: failureCategory
      ? [{ type: 'run.failed', label: failureCategory, failureCategory, failureRecoveryAction }]
      : undefined,
  }
}

function conversation(id: string, updatedAt: string, messages: ChatMessage[]): Conversation {
  return {
    id,
    title: id,
    archived: false,
    createdAt: updatedAt,
    updatedAt,
    messages,
  }
}

describe('recentRecoverableFailures', () => {
  it('returns newest recoverable assistant failures with stable targets', () => {
    const result = recentRecoverableFailures([
      conversation('old', '2026-07-04T00:00:00.000Z', [assistant('old-ok', 'done'), assistant('old-fail', 'error', 'quota')]),
      conversation('new', '2026-07-04T01:00:00.000Z', [assistant('new-fail', 'error', 'auth')]),
    ])

    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({
      action: 'diagnostics',
      target: { conversationID: 'new', assistantMessageID: 'new-fail' },
    })
    expect(result[1]).toMatchObject({
      action: 'diagnostics',
      target: { conversationID: 'old', assistantMessageID: 'old-fail' },
    })
  })

  it('ignores non-error messages and respects the limit', () => {
    const result = recentRecoverableFailures([
      conversation('one', '2026-07-04T00:00:00.000Z', [assistant('done-fail-event', 'done', 'quota')]),
      conversation('two', '2026-07-04T01:00:00.000Z', [assistant('two-fail', 'error', 'workspace')]),
      conversation('three', '2026-07-04T02:00:00.000Z', [assistant('three-fail', 'error', 'validation', 'repair')]),
    ], 1)

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      action: 'repair',
      target: { conversationID: 'three', assistantMessageID: 'three-fail' },
    })
  })
})
