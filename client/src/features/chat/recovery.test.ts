import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@/shared/local-data/types'
import {
  beginRecoveryAction,
  createRecoveryState,
  endRecoveryAction,
  failureRecoveryAction,
  latestRunFailureEvent,
  nextRepairAttempt,
  nextRetryAttempt,
  queueCloudSessionRecovery,
  takeCloudSessionRecovery,
  type RecoveryTarget,
} from './recovery'

const target: RecoveryTarget = {
  conversationID: 'conv-1',
  assistantMessageID: 'msg-1',
}

describe('chat recovery state', () => {
  it('deduplicates one in-flight action per failed assistant message', () => {
    const state = createRecoveryState()

    expect(beginRecoveryAction(state, 'retry', target)).toBe(true)
    expect(beginRecoveryAction(state, 'retry', target)).toBe(false)
    expect(beginRecoveryAction(state, 'repair', target)).toBe(true)

    endRecoveryAction(state, 'retry', target)
    expect(beginRecoveryAction(state, 'retry', target)).toBe(true)
  })

  it('keeps queued cloud-session recovery scoped to the original user', () => {
    const state = createRecoveryState()

    queueCloudSessionRecovery(state, target, 'user-1')
    expect(takeCloudSessionRecovery(state, 'user-2')).toBeUndefined()
    expect(takeCloudSessionRecovery(state, 'user-1')).toBeUndefined()

    queueCloudSessionRecovery(state, target, 'user-1')
    expect(takeCloudSessionRecovery(state, 'user-1')).toEqual(target)
  })

  it('maps failure policy fields to the smallest recovery action', () => {
    expect(failureRecoveryAction({ type: 'run.failed', label: 'busy', failureActionKind: 'retry' })).toBe('retry')
    expect(failureRecoveryAction({ type: 'run.failed', label: 'bad args', failureActionKind: 'repair' })).toBe('repair')
    expect(failureRecoveryAction({ type: 'run.failed', label: 'credits', failureCategory: 'quota' })).toBe('recharge')
    expect(failureRecoveryAction({ type: 'run.failed', label: 'login', failureCategory: 'auth' })).toBe('refresh_session')
    expect(failureRecoveryAction({ type: 'run.failed', label: 'workspace', failureCategory: 'workspace' })).toBe('workspace')
    expect(failureRecoveryAction({ type: 'run.failed', label: 'permission', failureCategory: 'permission' })).toBe('retry')
    expect(failureRecoveryAction({ type: 'run.failed', label: 'config', failureCategory: 'configuration' })).toBe('diagnostics')
  })

  it('prefers daemon-provided recovery action over legacy category fallback', () => {
    expect(failureRecoveryAction({
      type: 'run.failed',
      label: 'runtime says diagnostics',
      failureCategory: 'transient',
      failureActionKind: 'retry',
      failureRecoveryAction: 'diagnostics',
    })).toBe('diagnostics')
  })

  it('keeps retry and repair metadata derived from the failed message history', () => {
    const message: ChatMessage = {
      id: 'msg-1',
      role: 'assistant',
      content: '',
      createdAt: '2026-07-04T00:00:00.000Z',
      status: 'error',
      agentEvents: [
        { type: 'run.failed', label: 'old failure', failureCategory: 'transient' },
        { type: 'ui.action.requested', label: 'retry', retryAttempt: 1 },
        { type: 'ui.action.requested', label: 'repair', repairAttempt: 2 },
        { type: 'run.failed', label: 'new failure', failureCategory: 'validation' },
      ],
    }

    expect(latestRunFailureEvent(message)).toMatchObject({ label: 'new failure', failureCategory: 'validation' })
    expect(nextRetryAttempt(message)).toBe(2)
    expect(nextRepairAttempt(message)).toBe(3)
  })
})
