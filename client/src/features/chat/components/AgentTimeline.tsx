import { CheckCircle2, Download, Eye, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import type { LocalPermissionScope } from '@/shared/local-host/client'
import type { AgentTimelineItem, ChatMessage } from '@/shared/local-data/types'

export function AgentTimeline({
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
  const events = message.agentEvents ?? []
  if (!events.length && !(message.runId && onOpenDiagnostics && hasLocalDiagnosticSignal(message))) {
    return null
  }
  return (
    <div className="agent-timeline mt-4 space-y-2">
      {events.map((event, index) => (
        <Card className={cn('timeline-item border-border/70 shadow-none', timelineItemClass(event))} key={`${event.eventId ?? event.type}-${index}`}>
          <CardContent className="flex flex-wrap items-center gap-2 p-3">
            <Badge variant={badgeVariant(event)}>{timelineGroup(event)}</Badge>
            <small className="min-w-0 flex-1 text-sm text-foreground">{event.label}</small>
            {event.sourceUrl ? (
              <a className="timeline-source-link max-w-full truncate text-xs text-primary underline-offset-4 hover:underline" href={event.sourceUrl} target="_blank" rel="noreferrer">
                {event.sourceUrl}
              </a>
            ) : null}
            {event.permissionRequestId && event.type === 'permission.required' && !isPermissionResolved(message, event.permissionRequestId) ? (
              <span className="timeline-actions flex flex-wrap gap-2">
                <Button size="sm" onClick={() => onPermissionDecision(event.permissionRequestId!, 'approve', 'once')}>
                  <CheckCircle2 size={13} />
                  允许一次
                </Button>
                <Button size="sm" variant="secondary" onClick={() => onPermissionDecision(event.permissionRequestId!, 'approve', 'run')}>
                  <CheckCircle2 size={13} />
                  本会话始终允许
                </Button>
                <Button size="sm" variant="outline" onClick={() => onPermissionDecision(event.permissionRequestId!, 'deny')}>
                  <X size={13} />
                  拒绝
                </Button>
              </span>
            ) : null}
            {event.artifactId ? (
              <Button className="timeline-artifact-button" size="sm" variant="ghost" onClick={() => onOpenArtifact(event.artifactId!)}>
                <Eye size={13} />
                查看 artifact
              </Button>
            ) : null}
          </CardContent>
        </Card>
      ))}
      {message.runId && onOpenDiagnostics && hasLocalDiagnosticSignal(message) ? (
        <Button className="timeline-artifact-button" size="sm" variant="outline" title={`查看诊断 ${message.runId}`} onClick={() => onOpenDiagnostics(message.runId!)}>
          <Download size={13} />
          诊断
        </Button>
      ) : null}
    </div>
  )
}

function timelineGroup(event: AgentTimelineItem): string {
  if (event.type.startsWith('permission')) return '权限'
  if (event.type.startsWith('tool')) return '工具'
  if (event.type.startsWith('browser')) return '浏览器'
  if (event.type === 'source.collected') return '来源'
  if (event.type.startsWith('verification')) return '验证'
  if (event.type.startsWith('run')) return '任务'
  if (event.type.startsWith('artifact')) return 'Artifact'
  return '事件'
}

function badgeVariant(event: AgentTimelineItem): 'default' | 'secondary' | 'outline' | 'destructive' {
  if (event.type === 'run.failed' || event.type === 'tool.failed' || event.verificationStatus === 'failed') return 'destructive'
  if (event.type === 'source.collected') return 'default'
  if (event.type.startsWith('permission')) return 'secondary'
  return 'outline'
}

function isPermissionResolved(message: ChatMessage, requestID: string): boolean {
  return Boolean(
    message.agentEvents?.some(
      (event) =>
        event.permissionRequestId === requestID &&
        (event.type === 'permission.resolved' || event.type === 'permission.auto_approved'),
    ),
  )
}

function hasLocalDiagnosticSignal(message: ChatMessage): boolean {
  return message.runOrigin === 'local' && Boolean(message.runId)
}

function timelineItemClass(event: AgentTimelineItem): string {
  if (event.type === 'run.failed' || event.type === 'tool.failed' || event.verificationStatus === 'failed') {
    return 'timeline-error'
  }
  if (event.type === 'source.collected') {
    return 'timeline-source'
  }
  if (event.type === 'permission.required') {
    return 'timeline-permission'
  }
  return ''
}
