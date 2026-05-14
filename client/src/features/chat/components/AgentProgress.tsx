import {
  IconAlertCircle,
  IconChevronDown,
  IconCircleCheck,
  IconDownload,
  IconEye,
  IconLoader2,
  IconShieldCheck,
  IconX,
} from '@tabler/icons-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { createTranslator, useI18n, type Translator } from '@/shared/i18n/i18n'
import type { LocalPermissionScope } from '@/shared/local-host/client'
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
  onPermissionDecision,
}: {
  message: ChatMessage
  onOpenArtifact: (artifactID: string) => void
  onOpenDiagnostics?: (runID: string) => void
  onPermissionDecision: (requestID: string, decision: 'approve' | 'deny', scope?: LocalPermissionScope) => void
}) {
  const { t } = useI18n()
  const progress = deriveAgentProgress(message, t)
  if (!progress) {
    return null
  }

  const Icon = progressIcon(progress.tone)

  return (
    <div className={cn('tool-card agent-progress mt-4', `agent-progress-${progress.tone}`)} data-state={progress.tone}>
      <div className="tool-card-header">
        <span className={cn('dot', dotClass(progress.tone))} />
        <Icon className="tool-card-icon" aria-hidden="true" />
        <span className="name" key={progress.label}>{progress.label}</span>
        {progress.detail ? <span className="meta">· {progress.detail}</span> : null}
        <IconChevronDown className="tool-card-caret" aria-hidden="true" />
      </div>

      <div className="tool-card-results agent-progress-results" aria-label={t('agent.summary')}>
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
        {!progress.sourcesCount && !progress.artifactsCount && !progress.latestArtifactID && !progress.diagnosticsRunID ? (
          <div className="row muted">
            <span>{progress.tone === 'working' ? t('agent.noResultsWorking') : t('agent.noResults')}</span>
          </div>
        ) : null}
      </div>

      {progress.pendingPermission ? (
        <div className="agent-progress-permission-actions">
          <Button size="sm" onClick={() => onPermissionDecision(progress.pendingPermission!.requestID, 'approve', 'once')}>
            <IconCircleCheck size={13} />
            {t('agent.allowOnce')}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => onPermissionDecision(progress.pendingPermission!.requestID, 'approve', 'run')}>
            <IconShieldCheck size={13} />
            {t('agent.allowRun')}
          </Button>
          <Button size="sm" variant="outline" onClick={() => onPermissionDecision(progress.pendingPermission!.requestID, 'deny')}>
            <IconX size={13} />
            {t('agent.deny')}
          </Button>
        </div>
      ) : null}
    </div>
  )
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

function progressIcon(tone: ProgressTone) {
  if (tone === 'permission') return IconShieldCheck
  if (tone === 'done') return IconCircleCheck
  if (tone === 'failed') return IconAlertCircle
  return IconLoader2
}

function dotClass(tone: ProgressTone): string {
  if (tone === 'failed') return 'dot-danger'
  if (tone === 'working' || tone === 'permission') return 'dot-warning'
  return 'dot-success'
}
