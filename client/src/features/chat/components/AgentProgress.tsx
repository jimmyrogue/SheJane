import { useState } from 'react'
import { IconChevronDown, IconDownload, IconWorld } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { createTranslator, useI18n, type Translator } from '@/shared/i18n/i18n'
import type { AgentTimelineItem, AgentToolDetail, ChatMessage } from '@/shared/local-data/types'

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
  onOpenDiagnostics,
}: {
  message: ChatMessage
  /** Kept in the prop signature for backwards compatibility with the
   *  call site in App.tsx — the artifact preview link was removed from
   *  this component as part of the timeline cleanup (users said the
   *  expanded view was too noisy and they only wanted diagnostics). */
  onOpenArtifact?: (artifactID: string) => void
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
  const bodyId = `agent-progress-body-${message.id}`
  // While the run is active: the current action + its concrete target
  // ("正在打开 weather.com"). Once finished: an aggregated tally of what was
  // done ("读取 3 个文件 · 运行 2 条命令"). Never success/failure or step count.
  const headline = summaryHeadline(events, message, t)
  // Prefer the rich `toolDetail` shape when present (set by
  // chatStore.timelineItem when the daemon's tool.requested event
  // surfaces real args). Fall back to the legacy `target` string for
  // older persisted events / replayed conversations from before the
  // tool.requested flow shipped.
  const detail: AgentToolDetail | undefined =
    headline.source?.toolDetail ??
    (headline.source?.target ? { kind: 'text', text: headline.source.target } : undefined)
  const canExpand = Boolean(progress.diagnosticsRunID && onOpenDiagnostics)

  // The leading status dot we used to show next to the headline was
  // pure ornament — the tone is already reflected in the label
  // (e.g. "已完成 …" vs "搜索网页"). Dropped per UX feedback. The
  // `working` state instead surfaces "ongoingness" via the CSS-animated
  // trailing dots on `.agent-progress-summary` (see styles.css).
  //
  // When the source event has a `toolDetail`, we draw a "· {detail}"
  // segment after the verb — host with a globe icon for web tools,
  // basename for filesystem tools, query / prompt for search-style.
  // The animated trailing dots stay attached to the verb only, so the
  // target text doesn't visually shake.
  const summaryInner = (
    <>
      <span className="name" key={headline.label}>{headline.label}</span>
      {detail ? (
        <>
          <span className="agent-progress-sep" aria-hidden="true">·</span>
          {detail.showWebIcon ? (
            <IconWorld className="agent-progress-target-icon" size={12} aria-hidden="true" />
          ) : null}
          <span className="agent-progress-target" title={detail.tooltip ?? detail.text}>
            {detail.text}
          </span>
        </>
      ) : null}
      {canExpand ? <IconChevronDown className="tool-card-caret" aria-hidden="true" /> : null}
    </>
  )

  return (
    <div
      className={cn('tool-card agent-progress mt-4', `agent-progress-${progress.tone}`)}
      data-state={progress.tone}
      data-expanded={expanded}
    >
      {canExpand ? (
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
      ) : (
        // No diagnostics → no point in being expandable. Render the
        // headline as a passive row so users don't see a chevron that
        // opens an empty drawer.
        <div className="tool-card-header agent-progress-summary agent-progress-summary-static">
          {summaryInner}
        </div>
      )}

      {/* Expanded body intentionally contains ONLY the diagnostics
       *  button. The old per-event step list (graph.node /
       *  llm.tool_call_chunk / run.started …) was internal-machinery
       *  noise the user didn't need — the headline above already says
       *  what's happening in plain language; diagnostics is the
       *  escape hatch for when something feels wrong. */}
      {expanded && canExpand ? (
        <div className="tool-card-results agent-progress-results" id={bodyId} aria-label={t('agent.summary')}>
          <Button
            className="agent-progress-action"
            size="sm"
            variant="outline"
            title={t('agent.viewDiagnostics', { id: progress.diagnosticsRunID! })}
            onClick={() => onOpenDiagnostics!(progress.diagnosticsRunID!)}
          >
            <IconDownload size={13} />
            {t('agent.diagnostics')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

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

/** Strip whichever of the known "前缀X" markers prefix the event label so
 *  the tool name comes out clean, then re-wrap it as "正在 X" — the
 *  in-progress framing the user expects in the AgentProgress headline.
 *  Used during active runs to relabel completed/failed events too. */
const TOOL_PHASE_PREFIXES = [
  '调用工具：',
  '工具开始：',
  '工具完成：',
  '工具失败：',
  '验证失败：',
  'Tool started: ',
  'Tool completed: ',
  'Tool failed: ',
]

function asInProgressToolLabel(event: AgentTimelineItem, t: Translator): string {
  return t('agent.toolRunning', { tool: stripKnownPrefix(event.label, TOOL_PHASE_PREFIXES) })
}

/** Build the live-action headline.
 *
 *  Earlier iterations of this got two things wrong in sequence:
 *  1. We surfaced `tool.completed` as the headline ("已完成 X") which
 *     read as "the whole task is done" while the run kept going.
 *  2. We then fell back to a generic "正在思考" between tool calls —
 *     but the ThinkingIndicator above already says "正在思考", so users
 *     saw two duplicate labels.
 *
 *  Current rule, during active runs:
 *    a. Prefer a tool that has more dispatches than completions
 *       (genuinely in flight). Frame as "正在 X".
 *    b. Otherwise re-frame the most recent tool event (even if
 *       completed) as "正在 X" — the agent is still working on that
 *       tool's results until the next tool kicks off.
 *    c. Otherwise fall through to other activity events (browser
 *       observed / verification / UI action) with their natural label.
 *    d. Otherwise the generic working label.
 *  Once the run actually finishes, the inactive branch uses natural
 *  framing so the final headline can read as completed.
 */
/** Result of headline scoring — the verb-only label PLUS the event we
 *  derived it from, so the renderer can pull `event.toolDetail` to
 *  build a richer per-tool subtitle ("搜索 · 普吉岛雨季天气"). */
interface CurrentActivity {
  label: string
  source?: AgentTimelineItem
}

function currentActivityLabel(events: AgentTimelineItem[], message: ChatMessage, t: Translator): CurrentActivity {
  const isActive = ACTIVE_RUN_STATUSES.has(message.status)
  if (isActive) {
    // Per-tool tally: positive ⇒ at least one call still in flight.
    // Counted by tool name (not eventId) so parallel dispatches of
    // the same tool collapse correctly.
    const pending = new Map<string, number>()
    for (const event of events) {
      if (!event.tool) {
        continue
      }
      if (event.type === 'tool.requested' || event.type === 'tool.started') {
        pending.set(event.tool, (pending.get(event.tool) ?? 0) + 1)
      } else if (event.type === 'tool.completed' || event.type === 'tool.failed') {
        pending.set(event.tool, (pending.get(event.tool) ?? 0) - 1)
      }
    }
    // (a) latest in-flight tool
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event.type !== 'tool.requested' && event.type !== 'tool.started') {
        continue
      }
      if (!event.tool || (pending.get(event.tool) ?? 0) <= 0) {
        continue
      }
      return { label: asInProgressToolLabel(event, t), source: event }
    }
    // (b) latest tool event of any phase, reframed as "正在 X"
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (!event.tool) {
        continue
      }
      if (
        event.type === 'tool.requested' ||
        event.type === 'tool.started' ||
        event.type === 'tool.completed' ||
        event.type === 'tool.failed'
      ) {
        return { label: asInProgressToolLabel(event, t), source: event }
      }
    }
    // (c) non-tool activity events
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (ACTIVITY_TYPES.has(event.type)) {
        return { label: operationLabel(event, t), source: event }
      }
    }
    // (d) generic
    return { label: defaultWorkingLabel(message, t) }
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (ACTIVITY_TYPES.has(event.type)) {
      return { label: operationLabel(event, t), source: event }
    }
  }
  return { label: defaultWorkingLabel(message, t) }
}

/**
 * Claude Code-style headline: while the run is active show the current action
 * and its concrete target; once finished show the aggregated tally of what was
 * done. Falls back to the latest activity when no completed tools were tallied.
 * Returns `{label, source?}` so the renderer can read `source.toolDetail`
 * to draw a richer subtitle ("搜索 · query") next to the verb.
 */
function summaryHeadline(events: AgentTimelineItem[], message: ChatMessage, t: Translator): CurrentActivity {
  if (ACTIVE_RUN_STATUSES.has(message.status)) {
    return currentActivityLabel(events, message, t)
  }
  // Inactive: prefer the aggregated count label (no source — it's a
  // tally across many tools, not a single event). Fall back to the
  // latest activity when no tools matched the bucket list.
  const aggregated = operationCountsLabel(events, t)
  if (aggregated) {
    return { label: aggregated }
  }
  return currentActivityLabel(events, message, t)
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

