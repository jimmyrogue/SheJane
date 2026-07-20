import type { AgentTimelineItem, ChatMessage } from '@/shared/local-data/types'

export type AgentFailureAction = 'retry' | 'repair' | 'workspace' | 'diagnostics'
export type RecoveryAction = 'retry' | 'repair'

export interface RecoveryTarget {
  conversationID: string
  assistantMessageID: string
}

export interface RecoveryState {
  inFlight: Set<string>
}

export function createRecoveryState(): RecoveryState {
  return { inFlight: new Set() }
}

export function recoveryTargetKey(target: RecoveryTarget): string {
  return `${target.conversationID}:${target.assistantMessageID}`
}

export function beginRecoveryAction(state: RecoveryState, action: RecoveryAction, target: RecoveryTarget): boolean {
  const key = `${action}:${recoveryTargetKey(target)}`
  if (state.inFlight.has(key)) {
    return false
  }
  state.inFlight.add(key)
  return true
}

export function endRecoveryAction(state: RecoveryState, action: RecoveryAction, target: RecoveryTarget): void {
  state.inFlight.delete(`${action}:${recoveryTargetKey(target)}`)
}

export function failureRecoveryAction(event: AgentTimelineItem | undefined): AgentFailureAction | undefined {
  if (!event) {
    return undefined
  }
  if (isAgentFailureAction(event.failureRecoveryAction)) {
    return event.failureRecoveryAction
  }
  if (event.failureActionKind === 'retry') {
    return 'retry'
  }
  if (event.failureActionKind === 'repair') {
    return 'repair'
  }
  switch (event.failureCategory) {
    case 'quota':
    case 'auth':
      return 'diagnostics'
    case 'workspace':
      return 'workspace'
    case 'permission':
      return 'retry'
    case 'configuration':
    case 'fatal':
    case 'unknown':
      return 'diagnostics'
    default:
      return undefined
  }
}

function isAgentFailureAction(value: unknown): value is AgentFailureAction {
  return value === 'retry' ||
    value === 'repair' ||
    value === 'workspace' ||
    value === 'diagnostics'
}

export function latestRunFailureEvent(message: ChatMessage): AgentTimelineItem | undefined {
  return [...(message.agentEvents ?? [])].reverse().find((event) => event.type === 'run.failed')
}

export function nextRepairAttempt(message: ChatMessage): number {
  return nextAttempt(message, 'repairAttempt')
}

export function nextRetryAttempt(message: ChatMessage): number {
  return nextAttempt(message, 'retryAttempt')
}

function nextAttempt(message: ChatMessage, field: 'repairAttempt' | 'retryAttempt'): number {
  const attempts = (message.agentEvents ?? [])
    .map((event) => event[field])
    .filter((attempt): attempt is number => typeof attempt === 'number' && Number.isFinite(attempt))
  return Math.max(0, ...attempts) + 1
}
