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
  const progress = deriveAgentProgress(message)
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

      <div className="tool-card-results agent-progress-results" aria-label="任务摘要">
        {progress.sourcesCount > 0 ? (
          <div className="row">
            <span>已收集 {progress.sourcesCount} 个来源</span>
            <Badge variant="outline">source</Badge>
          </div>
        ) : null}
        {progress.artifactsCount > 0 ? (
          <div className="row">
            <span>生成 {progress.artifactsCount} 个 Artifact</span>
            <Badge variant="outline">artifact</Badge>
          </div>
        ) : null}
        {progress.latestArtifactID ? (
          <Button className="agent-progress-action" size="sm" variant="ghost" onClick={() => onOpenArtifact(progress.latestArtifactID!)}>
            <IconEye size={13} />
            查看 artifact
          </Button>
        ) : null}
        {progress.diagnosticsRunID && onOpenDiagnostics ? (
          <Button
            className="agent-progress-action"
            size="sm"
            variant="outline"
            title={`查看诊断 ${progress.diagnosticsRunID}`}
            onClick={() => onOpenDiagnostics(progress.diagnosticsRunID!)}
          >
            <IconDownload size={13} />
            诊断
          </Button>
        ) : null}
        {!progress.sourcesCount && !progress.artifactsCount && !progress.latestArtifactID && !progress.diagnosticsRunID ? (
          <div className="row muted">
            <span>{progress.tone === 'working' ? '正在执行，完成后会在这里显示结果。' : '没有额外结果。'}</span>
          </div>
        ) : null}
      </div>

      {progress.pendingPermission ? (
        <div className="agent-progress-permission-actions">
          <Button size="sm" onClick={() => onPermissionDecision(progress.pendingPermission!.requestID, 'approve', 'once')}>
            <IconCircleCheck size={13} />
            允许一次
          </Button>
          <Button size="sm" variant="secondary" onClick={() => onPermissionDecision(progress.pendingPermission!.requestID, 'approve', 'run')}>
            <IconShieldCheck size={13} />
            本会话始终允许
          </Button>
          <Button size="sm" variant="outline" onClick={() => onPermissionDecision(progress.pendingPermission!.requestID, 'deny')}>
            <IconX size={13} />
            拒绝
          </Button>
        </div>
      ) : null}
    </div>
  )
}

export function deriveAgentProgress(message: ChatMessage): AgentProgressState | null {
  const events = message.agentEvents ?? []
  const pendingPermission = findPendingPermission(events)
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
      label: `等待批准：${pendingPermission.tool}`,
      detail: '你可以只允许这一次，或在当前会话中始终允许同类操作。',
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
      label: latestFailure?.label || message.content || '任务失败',
      detail: sourcesCount || artifacts.length ? '已保留可用来源和诊断信息。' : undefined,
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
      label: latestCompletion?.label || '任务完成',
      detail: completionDetail(sourcesCount, artifacts.length),
      sourcesCount,
      artifactsCount: artifacts.length,
      latestArtifactID,
      diagnosticsRunID,
    }
  }

  const latestActive = [...events].reverse().find((event) => isProgressEvent(event))
  return {
    tone: 'working',
    label: latestActive ? activeLabel(latestActive) : defaultWorkingLabel(message),
    detail: activeDetail(latestActive, sourcesCount),
    sourcesCount,
    artifactsCount: artifacts.length,
    latestArtifactID,
    diagnosticsRunID,
  }
}

function findPendingPermission(events: AgentTimelineItem[]): PendingPermission | undefined {
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
        tool: event.permissionTool || event.label.replace(/^需要权限：/u, '') || '本地操作',
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

function activeLabel(event: AgentTimelineItem): string {
  if (event.type === 'tool.requested' || event.type === 'tool.started') {
    return event.label.replace(/^调用工具：/u, '正在').replace(/^工具开始：/u, '正在')
  }
  if (event.type === 'tool.completed') {
    return event.label.replace(/^工具完成：/u, '已完成')
  }
  if (event.type === 'browser.observed') {
    return event.label.replace(/^观察网页：/u, '已观察网页：')
  }
  if (event.type === 'source.collected') {
    return '正在整理来源'
  }
  if (event.type === 'verification.completed') {
    return event.verificationStatus === 'failed' ? event.label : '正在验证结果'
  }
  if (event.type === 'skill.selected') {
    return '正在选择处理方式'
  }
  if (event.type === 'ui.action.requested') {
    return event.label.replace(/^请求操作：/u, '准备')
  }
  if (event.type === 'ui.action.completed') {
    return event.label.replace(/^操作完成：/u, '已完成')
  }
  return event.label || '正在处理'
}

function activeDetail(event: AgentTimelineItem | undefined, sourcesCount: number): string | undefined {
  if (!event) {
    return undefined
  }
  if (sourcesCount > 0 && ['source.collected', 'browser.observed', 'tool.completed'].includes(event.type)) {
    return '已有可用来源，正在判断是否还需要继续查证。'
  }
  if (event.type === 'run.budget_warning') {
    return '任务仍在继续，必要时会整理已有结果。'
  }
  return undefined
}

function completionDetail(sourcesCount: number, artifactsCount: number): string | undefined {
  if (sourcesCount > 0) {
    return `已基于 ${sourcesCount} 个来源完成回答。`
  }
  if (artifactsCount > 0) {
    return `已生成 ${artifactsCount} 个可查看结果。`
  }
  return undefined
}

function defaultWorkingLabel(message: ChatMessage): string {
  if (message.status === 'waiting_permission') {
    return '等待你批准本地操作'
  }
  return '正在思考'
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
