import { Download, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import type { AgentRunEvent } from '@/shared/api/sse'
import type { LocalRunDiagnostics } from '@/shared/local-host/client'

export function DiagnosticsPanel({
  diagnostics,
  onClose,
  onExport,
}: {
  diagnostics: LocalRunDiagnostics | null
  onClose: () => void
  onExport: () => void
}) {
  return (
    <Sheet modal={false} open={Boolean(diagnostics)} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="diagnostics-preview w-[min(760px,94vw)] overflow-hidden sm:max-w-[760px]" showOverlay={false}>
        <SheetHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <SheetTitle>任务诊断：{diagnostics?.run.id}</SheetTitle>
              <SheetDescription>{diagnostics?.run.goal || 'Local Harness run'}</SheetDescription>
            </div>
            <div className="diagnostics-actions flex gap-2">
              <Button type="button" size="sm" variant="outline" onClick={onExport}>
                <Download size={14} />
                导出当前诊断
              </Button>
              <Button className="icon-button light" size="icon-sm" variant="ghost" title="关闭诊断" onClick={onClose}>
                <X size={15} />
              </Button>
            </div>
          </div>
        </SheetHeader>
        {diagnostics ? (
          <div className="mt-4 space-y-4">
            <div className="diagnostics-summary flex flex-wrap gap-2">
              <Badge variant="outline">状态 {diagnostics.run.status}</Badge>
              <Badge variant="outline">事件 {diagnostics.events.length}</Badge>
              <Badge variant="outline">权限 {diagnostics.permissions.length}</Badge>
              <Badge variant="outline">Artifact {diagnostics.artifacts.length}</Badge>
            </div>
            {diagnostics.latest_checkpoint ? (
              <small className="diagnostics-checkpoint block rounded-md border bg-muted/40 p-3">
                最新检查点：{diagnostics.latest_checkpoint.id} · {diagnostics.latest_checkpoint.reason} · {diagnostics.latest_checkpoint.messages_count} messages
              </small>
            ) : null}
            <ul className="diagnostics-events max-h-[calc(100vh-260px)] space-y-2 overflow-auto">
              {diagnosticEvents(diagnostics).map((event, index) => (
                <li className="flex gap-2 rounded-md border bg-card p-2 text-sm" key={`${event.id ?? event.event_type}-${index}`}>
                  <code className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs">{event.event_type}</code>
                  <span>{diagnosticEventDetail(event)}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

function diagnosticEvents(diagnostics: LocalRunDiagnostics): AgentRunEvent[] {
  return diagnostics.events.filter((event) =>
    ['tool.failed', 'run.failed', 'permission.required', 'permission.resolved', 'source.collected', 'verification.completed'].includes(event.event_type),
  )
}

function diagnosticEventDetail(event: AgentRunEvent): string {
  const payload = event.payload ?? {}
  const parts = [
    stringValue(payload.title),
    stringValue(payload.url),
    stringValue(payload.tool),
    stringValue(payload.error_code),
    stringValue(payload.status),
  ].filter(Boolean)
  return parts.join(' · ') || JSON.stringify(payload)
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
