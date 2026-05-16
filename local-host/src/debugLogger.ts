const debugEnabledValues = new Set(['1', 'true', 'yes', 'on', 'debug'])
const redactedKeyPattern = /(token|secret|password|authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|credential)/i
const sensitiveArgumentKeys = new Set(['query', 'text', 'content', 'input', 'value'])
const loggedEvents = new Set([
  'run.started',
  'run.completed',
  'run.failed',
  'run.canceled',
  'run.budget_warning',
  'skill.selected',
  'llm.started',
  'tool.requested',
  'tool.started',
  'tool.completed',
  'tool.failed',
  'permission.required',
  'permission.resolved',
  'verification.started',
  'verification.completed',
  'artifact.created',
  'browser.observed',
  'environment.observed',
  'ui.action.requested',
  'ui.action.completed',
  // Phase 1–5 observability (Agentic Design Patterns upgrades): without these
  // the dev/debug console silently hides routing/guard/plan/reflection/retry
  // events even though they are persisted and streamed.
  'input.guard.started',
  'input.guard.completed',
  'input.flagged',
  'input.guard.blocked',
  'input.guard.error',
  'input.guard.override',
  'tool.retry',
  'run.tool_failure_circuit',
  'plan.started',
  'plan.created',
  'plan.skipped',
  'route.started',
  'route.selected',
  'route.error',
  'reflection.started',
  'reflection.critique',
  'reflection.applied',
  'reflection.skipped',
  'reflection.error',
])

export function localHostDebugEnabled(): boolean {
  return debugEnabledValues.has((process.env.JIANDANLY_LOCAL_HOST_DEBUG ?? '').toLowerCase())
}

export function logLocalHostEvent(runID: string, eventType: string, payload: Record<string, unknown>): void {
  if (!localHostDebugEnabled() || !loggedEvents.has(eventType)) {
    return
  }
  const entry = {
    run_id: runID,
    event_type: eventType,
    payload: sanitizeForLocalHostLog(payload),
  }
  const serialized = JSON.stringify(entry)
  const verificationFailed = eventType === 'verification.completed' && payload.status !== 'passed'
  if (eventType === 'tool.failed' || eventType === 'run.failed' || verificationFailed) {
    // eslint-disable-next-line no-console
    console.warn('[jiandanly:local-host]', eventType, serialized)
    return
  }
  // eslint-disable-next-line no-console
  console.log('[jiandanly:local-host]', eventType, serialized)
}

export function logLocalHostError(scope: string, error: unknown, metadata: Record<string, unknown> = {}): void {
  if (!localHostDebugEnabled()) {
    return
  }
  const message = error instanceof Error ? error.message : String(error)
  const stack = error instanceof Error ? error.stack : undefined
  // eslint-disable-next-line no-console
  console.error(
    '[jiandanly:local-host]',
    scope,
    JSON.stringify(
      sanitizeForLocalHostLog({
        ...metadata,
        message,
        stack,
      }),
    ),
  )
}

export function sanitizeForLocalHostLog(value: unknown): unknown {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'string') {
    return truncateLogString(value)
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map(sanitizeForLocalHostLog)
  }
  if (typeof value !== 'object') {
    return String(value)
  }
  const output: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (redactedKeyPattern.test(key)) {
      output[key] = '[redacted]'
      continue
    }
    if (key === 'arguments' && nested && typeof nested === 'object' && !Array.isArray(nested)) {
      output[key] = sanitizeToolArguments(nested as Record<string, unknown>)
      continue
    }
    output[key] = sanitizeForLocalHostLog(nested)
  }
  return output
}

function sanitizeToolArguments(args: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) {
    if (redactedKeyPattern.test(key)) {
      output[key] = '[redacted]'
      continue
    }
    if (sensitiveArgumentKeys.has(key)) {
      output[key] = summarizeSensitiveArgument(value)
      continue
    }
    output[key] = sanitizeForLocalHostLog(value)
  }
  return output
}

function summarizeSensitiveArgument(value: unknown): string {
  if (typeof value === 'string') {
    return `[redacted ${value.length} chars]`
  }
  if (Array.isArray(value)) {
    return `[redacted array length=${value.length}]`
  }
  if (value && typeof value === 'object') {
    return '[redacted object]'
  }
  return '[redacted]'
}

function truncateLogString(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  return compact.length > 800 ? `${compact.slice(0, 800)}...` : compact
}
