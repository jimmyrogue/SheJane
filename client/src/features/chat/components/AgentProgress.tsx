import { useState } from 'react'
import { IconChevronDown, IconDownload, IconEye } from '@tabler/icons-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { createTranslator, useI18n, type Translator } from '@/shared/i18n/i18n'
import type { AgentTimelineItem, ChatMessage } from '@/shared/local-data/types'

type ProgressTone = 'working' | 'permission' | 'done' | 'failed' | 'idle'

interface PendingPermission {
  requestID: string
  tool: string
}

interface AgentProgressState {
  tone: ProgressTone
  label: string
  detail?: string
  pendingPermission?: PendingPermission
  sourcesCount: number
  artifactsCount: number
  latestArtifactID?: string
  diagnosticsRunID?: string
}

export function AgentProgress({
  message,
  onOpenArtifact,
  onOpenDiagnostics,
}: {
  message: ChatMessage
  onOpenArtifact: (artifactID: string) => void
  onOpenDiagnostics?: (runID: string) => void
}) {
  const { t } = useI18n()
  const [expanded, setExpanded] = useState(false)
  const progress = deriveAgentProgress(message, t)
  // Permission prompts are no longer shown inline — they are surfaced once in
  // the approval bar above the composer. The remaining info states collapse
  // to a single muted line and expand on click.
  if (!progress || progress.tone === 'permission') {
    return null
  }

  const events = message.agentEvents ?? []
  // Only surface the progress line when there is real tool/operation activity;
  // a plain direct answer needs no "thinking" row.
  if (!events.some((event) => OPERATION_TYPES.has(event.type))) {
    return null
  }
  const bodyOpen = expanded
  const bodyId = `agent-progress-body-${message.id}`
  const steps = expanded ? stepEvents(events) : []
  // While the run is active: the current action + its concrete target
  // ("正在打开 weather.com"). Once finished: an aggregated tally of what was
  // done ("读取 3 个文件 · 运行 2 条命令"). Never success/failure or step count.
  const headline = summaryHeadline(events, message, t)

  const summaryInner = (
    <>
      <span className={cn('agent-progress-dot', dotClass(progress.tone))} aria-hidden="true" />
      <span className="name" key={headline}>{headline}</span>
      <IconChevronDown className="tool-card-caret" aria-hidden="true" />
    </>
  )

  return (
    <div
      className={cn('tool-card agent-progress mt-4', `agent-progress-${progress.tone}`)}
      data-state={progress.tone}
      data-expanded={bodyOpen}
    >
      <button
        type="button"
        className="tool-card-header agent-progress-summary"
        aria-expanded={expanded}
        aria-controls={bodyId}
        aria-label={expanded ? t('agent.collapseSteps') : t('agent.expandSteps')}
        onClick={() => setExpanded((value) => !value)}
      >
        {summaryInner}
      </button>

      {bodyOpen ? (
        <div className="tool-card-results agent-progress-results" id={bodyId} aria-label={t('agent.summary')}>
          {steps.length > 0 ? (
            <ul className="agent-progress-steps">
              {steps.map((event, index) => (
                <li
                  className={cn('agent-progress-step', isFailedEvent(event) && 'agent-progress-step-failed')}
                  key={`${event.eventId ?? event.type}-${index}`}
                >
                  {isFailedEvent(event) ? <span className="agent-progress-dot dot-danger" aria-hidden="true" /> : null}
                  <span className="agent-progress-step-group">{timelineGroup(event, t)}</span>
                  <span className="agent-progress-step-label">{event.label}</span>
                  {event.sourceUrl ? (
                    <a
                      className="agent-progress-step-source"
                      href={event.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {event.sourceUrl}
                    </a>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}

          {progress.sourcesCount > 0 ? (
            <div className="row">
              <span>{t('agent.sourcesCount', { count: progress.sourcesCount })}</span>
              <Badge variant="outline">source</Badge>
            </div>
          ) : null}
          {progress.artifactsCount > 0 ? (
            <div className="row">
              <span>{t('agent.artifactsCount', { count: progress.artifactsCount })}</span>
              <Badge variant="outline">artifact</Badge>
            </div>
          ) : null}
          {progress.latestArtifactID ? (
            <Button className="agent-progress-action" size="sm" variant="ghost" onClick={() => onOpenArtifact(progress.latestArtifactID!)}>
              <IconEye size={13} />
              {t('agent.viewArtifact')}
            </Button>
          ) : null}
          {progress.diagnosticsRunID && onOpenDiagnostics ? (
            <Button
              className="agent-progress-action"
              size="sm"
              variant="outline"
              title={t('agent.viewDiagnostics', { id: progress.diagnosticsRunID })}
              onClick={() => onOpenDiagnostics(progress.diagnosticsRunID!)}
            >
              <IconDownload size={13} />
              {t('agent.diagnostics')}
            </Button>
          ) : null}
          {!steps.length && !progress.sourcesCount && !progress.artifactsCount && !progress.latestArtifactID && !progress.diagnosticsRunID ? (
            <div className="row muted">
              <span>{progress.tone === 'working' ? t('agent.noResultsWorking') : t('agent.noResults')}</span>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

const STEP_HIDDEN_TYPES = new Set([
  'run.completed',
  'run.canceled',
  'run.failed',
  'permission.resolved',
  'permission.auto_approved',
  'llm.usage',
])

// skill.selected is emitted on every run as housekeeping — it is NOT a
// user-facing operation, so it must not make the progress row appear for a
// plain direct answer, nor become the headline.
const OPERATION_TYPES = new Set([
  'tool.requested',
  'tool.started',
  'tool.completed',
  'tool.failed',
  'browser.observed',
  'source.collected',
  'artifact.created',
  'verification.completed',
  'ui.action.requested',
  'ui.action.completed',
])

const ACTIVITY_TYPES = new Set([
  'tool.requested',
  'tool.started',
  'tool.completed',
  'tool.failed',
  'browser.observed',
  'verification.completed',
  'ui.action.requested',
  'ui.action.completed',
])

const ACTIVE_RUN_STATUSES = new Set<ChatMessage['status']>([
  'pending',
  'streaming',
  'waiting_permission',
  'waiting_input',
])

function currentActivityLabel(events: AgentTimelineItem[], message: ChatMessage, t: Translator): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (ACTIVITY_TYPES.has(events[index].type)) {
      return withTarget(operationLabel(events[index], t), events[index].target)
    }
  }
  return defaultWorkingLabel(message, t)
}

function withTarget(label: string, target?: string): string {
  return target ? `${label} ${target}` : label
}

/**
 * Claude Code-style headline: while the run is active show the current action
 * and its concrete target; once finished show the aggregated tally of what was
 * done. Falls back to the latest activity when no completed tools were tallied.
 */
function summaryHeadline(events: AgentTimelineItem[], message: ChatMessage, t: Translator): string {
  if (ACTIVE_RUN_STATUSES.has(message.status)) {
    return currentActivityLabel(events, message, t)
  }
  return operationCountsLabel(events, t) || currentActivityLabel(events, message, t)
}

function operationLabel(event: AgentTimelineItem, t: Translator): string {
  if (event.type === 'tool.failed') {
    return t('agent.toolRunning', {
      tool: stripKnownPrefix(event.label, ['工具失败：', '验证失败：', 'Tool failed: ']),
    })
  }
  if (event.type === 'verification.completed') {
    return t('agent.verifying')
  }
  return activeLabel(event, t)
}

const COUNT_BUCKETS: Array<{ key: Parameters<Translator>[0]; tools: Set<string> }> = [
  { key: 'agent.count.filesRead', tools: new Set(['fs.read', 'file.read']) },
  { key: 'agent.count.filesWritten', tools: new Set(['fs.write', 'file.write']) },
  { key: 'agent.count.commands', tools: new Set(['shell.run']) },
  { key: 'agent.count.pages', tools: new Set(['browser.open', 'web.fetch']) },
  { key: 'agent.count.searches', tools: new Set(['web.search', 'browser.search']) },
]

function operationCountsLabel(events: AgentTimelineItem[], t: Translator): string {
  const tallies = new Map<string, number>()
  let other = 0
  for (const event of events) {
    if (event.type !== 'tool.completed' || !event.tool) {
      continue
    }
    const bucket = COUNT_BUCKETS.find((entry) => entry.tools.has(event.tool as string))
    if (bucket) {
      tallies.set(bucket.key, (tallies.get(bucket.key) ?? 0) + 1)
    } else {
      other += 1
    }
  }
  const parts: string[] = []
  for (const bucket of COUNT_BUCKETS) {
    const count = tallies.get(bucket.key)
    if (count) {
      parts.push(t(bucket.key, { count }))
    }
  }
  if (other > 0) {
    parts.push(t('agent.count.operations', { count: other }))
  }
  return parts.join(' · ')
}

function stepEvents(events: AgentTimelineItem[]): AgentTimelineItem[] {
  return events.filter((event) => !STEP_HIDDEN_TYPES.has(event.type))
}

function isFailedEvent(event: AgentTimelineItem): boolean {
  return event.type === 'run.failed' || event.type === 'tool.failed' || event.verificationStatus === 'failed'
}

function timelineGroup(event: AgentTimelineItem, t: Translator): string {
  if (event.type.startsWith('permission')) return t('agent.timeline.permission')
  if (event.type.startsWith('tool')) return t('agent.timeline.tool')
  if (event.type.startsWith('browser')) return t('agent.timeline.browser')
  if (event.type === 'source.collected') return t('agent.timeline.source')
  if (event.type.startsWith('verification')) return t('agent.timeline.verification')
  if (event.type.startsWith('run')) return t('agent.timeline.run')
  if (event.type.startsWith('artifact')) return t('agent.timeline.artifact')
  return t('agent.timeline.event')
}

export function deriveAgentProgress(message: ChatMessage, t: Translator = createTranslator('zh')): AgentProgressState | null {
  const events = message.agentEvents ?? []
  const pendingPermission = findPendingPermission(events, t)
  const sourcesCount = uniqueCount(events, (event) => (event.type === 'source.collected' ? event.sourceUrl || event.sourceTitle || event.eventId : undefined))
  const artifacts = uniqueValues(events, (event) => event.artifactId)
  const latestArtifactID = [...events].reverse().find((event) => event.artifactId)?.artifactId
  const diagnosticsRunID = message.runOrigin === 'local' ? message.runId : undefined

  if (!events.length && !message.runId) {
    return null
  }

  if (pendingPermission) {
    return {
      tone: 'permission',
      label: t('agent.waitingApproval', { tool: pendingPermission.tool }),
      detail: t('agent.permissionDetail'),
      pendingPermission,
      sourcesCount,
      artifactsCount: artifacts.length,
      latestArtifactID,
      diagnosticsRunID,
    }
  }

  const latestFailure = [...events].reverse().find((event) => event.type === 'run.failed' || event.type === 'tool.failed' || event.verificationStatus === 'failed')
  if (latestFailure || message.status === 'error') {
    return {
      tone: 'failed',
      label: latestFailure?.label || message.content || t('agent.failed'),
      detail: sourcesCount || artifacts.length ? t('agent.failedDetail') : undefined,
      sourcesCount,
      artifactsCount: artifacts.length,
      latestArtifactID,
      diagnosticsRunID,
    }
  }

  const latestCompletion = [...events].reverse().find((event) => event.type === 'run.completed' || event.type === 'run.canceled')
  if (latestCompletion || message.status === 'done') {
    return {
      tone: latestCompletion?.type === 'run.canceled' ? 'idle' : 'done',
      label: latestCompletion?.label || t('agent.completed'),
      detail: completionDetail(sourcesCount, artifacts.length, t),
      sourcesCount,
      artifactsCount: artifacts.length,
      latestArtifactID,
      diagnosticsRunID,
    }
  }

  const latestActive = [...events].reverse().find((event) => isProgressEvent(event))
  return {
    tone: 'working',
    label: latestActive ? activeLabel(latestActive, t) : defaultWorkingLabel(message, t),
    detail: activeDetail(latestActive, sourcesCount, t),
    sourcesCount,
    artifactsCount: artifacts.length,
    latestArtifactID,
    diagnosticsRunID,
  }
}

function findPendingPermission(events: AgentTimelineItem[], t: Translator): PendingPermission | undefined {
  const resolved = new Set<string>()
  for (const event of events) {
    if ((event.type === 'permission.resolved' || event.type === 'permission.auto_approved') && event.permissionRequestId) {
      resolved.add(event.permissionRequestId)
    }
  }
  for (const event of [...events].reverse()) {
    if (event.type === 'permission.required' && event.permissionRequestId && !resolved.has(event.permissionRequestId)) {
      return {
        requestID: event.permissionRequestId,
        tool: event.permissionTool || stripKnownPrefix(event.label, ['需要权限：', 'Permission required: ']) || t('agent.localAction'),
      }
    }
  }
  return undefined
}

function uniqueCount(events: AgentTimelineItem[], select: (event: AgentTimelineItem) => string | undefined): number {
  return uniqueValues(events, select).length
}

function uniqueValues(events: AgentTimelineItem[], select: (event: AgentTimelineItem) => string | undefined): string[] {
  const values = new Set<string>()
  for (const event of events) {
    const value = select(event)
    if (value) {
      values.add(value)
    }
  }
  return [...values]
}

function isProgressEvent(event: AgentTimelineItem): boolean {
  return [
    'skill.selected',
    'tool.requested',
    'tool.started',
    'tool.completed',
    'browser.observed',
    'source.collected',
    'ui.action.requested',
    'ui.action.completed',
    'verification.completed',
    'run.budget_warning',
    'checkpoint.resumed',
  ].includes(event.type)
}

function activeLabel(event: AgentTimelineItem, t: Translator): string {
  if (event.type === 'tool.requested' || event.type === 'tool.started') {
    return t('agent.toolRunning', { tool: stripKnownPrefix(event.label, ['调用工具：', '工具开始：', 'Tool started: ']) })
  }
  if (event.type === 'tool.completed') {
    return t('agent.toolCompleted', { tool: stripKnownPrefix(event.label, ['工具完成：', 'Tool completed: ']) })
  }
  if (event.type === 'browser.observed') {
    return t('agent.browserObserved', { target: stripKnownPrefix(event.label, ['观察网页：', 'Observed page: ']) })
  }
  if (event.type === 'source.collected') {
    return t('agent.organizingSources')
  }
  if (event.type === 'verification.completed') {
    return event.verificationStatus === 'failed' ? event.label : t('agent.verifying')
  }
  if (event.type === 'skill.selected') {
    return t('agent.selectingSkill')
  }
  if (event.type === 'ui.action.requested') {
    return t('agent.uiPreparing', { action: stripKnownPrefix(event.label, ['请求操作：', 'Action requested: ']) })
  }
  if (event.type === 'ui.action.completed') {
    return t('agent.uiCompleted', { action: stripKnownPrefix(event.label, ['操作完成：', 'Action completed: ']) })
  }
  return event.label || t('agent.processingFallback')
}

function activeDetail(event: AgentTimelineItem | undefined, sourcesCount: number, t: Translator): string | undefined {
  if (!event) {
    return undefined
  }
  if (sourcesCount > 0 && ['source.collected', 'browser.observed', 'tool.completed'].includes(event.type)) {
    return t('agent.detail.hasSources')
  }
  if (event.type === 'run.budget_warning') {
    return t('agent.detail.longRunning')
  }
  return undefined
}

function completionDetail(sourcesCount: number, artifactsCount: number, t: Translator): string | undefined {
  if (sourcesCount > 0) {
    return t('agent.detail.completedWithSources', { count: sourcesCount })
  }
  if (artifactsCount > 0) {
    return t('agent.detail.completedWithArtifacts', { count: artifactsCount })
  }
  return undefined
}

function defaultWorkingLabel(message: ChatMessage, t: Translator): string {
  if (message.status === 'waiting_permission') {
    return t('agent.waitingLocalAction')
  }
  return t('agent.working')
}

function stripKnownPrefix(value: string, prefixes: string[]): string {
  for (const prefix of prefixes) {
    if (value.startsWith(prefix)) {
      return value.slice(prefix.length)
    }
  }
  return value
}

function dotClass(tone: ProgressTone): string {
  if (tone === 'failed') return 'dot-danger'
  if (tone === 'working' || tone === 'permission') return 'dot-warning'
  return 'dot-success'
}
