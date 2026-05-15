import { IconDownload, IconX } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { useI18n } from '@/shared/i18n/i18n'
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
  const { t } = useI18n()

  return (
    <Sheet modal={false} open={Boolean(diagnostics)} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        className="diagnostics-preview flex w-[min(760px,94vw)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[760px]"
        showOverlay={false}
        showCloseButton={false}
      >
        <SheetHeader className="shrink-0 gap-3 border-b p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <SheetTitle className="truncate" title={diagnostics?.run.id}>
                {t('diagnostics.title', { id: diagnostics?.run.id })}
              </SheetTitle>
              <SheetDescription className="truncate">
                {diagnostics?.run.goal || t('diagnostics.defaultGoal')}
              </SheetDescription>
            </div>
            <div className="diagnostics-actions flex shrink-0 items-center gap-2">
              <Button type="button" size="sm" variant="outline" onClick={onExport}>
                <IconDownload size={14} />
                {t('diagnostics.export')}
              </Button>
              <Button
                className="icon-button light"
                size="icon-sm"
                variant="ghost"
                title={t('diagnostics.close')}
                onClick={onClose}
              >
                <IconX size={15} />
              </Button>
            </div>
          </div>
        </SheetHeader>
        {diagnostics ? (
          <div className="flex-1 space-y-4 overflow-auto p-4">
            <div className="diagnostics-summary flex flex-wrap gap-2">
              <Badge variant="outline">{t('diagnostics.status', { status: diagnostics.run.status })}</Badge>
              <Badge variant="outline">{t('diagnostics.events', { count: diagnostics.events.length })}</Badge>
              <Badge variant="outline">{t('diagnostics.permissions', { count: diagnostics.permissions.length })}</Badge>
              <Badge variant="outline">{t('diagnostics.artifacts', { count: diagnostics.artifacts.length })}</Badge>
            </div>
            {diagnostics.latest_checkpoint ? (
              <small className="diagnostics-checkpoint block rounded-md border bg-muted/40 p-3">
                {t('diagnostics.checkpoint', {
                  id: diagnostics.latest_checkpoint.id,
                  reason: diagnostics.latest_checkpoint.reason,
                  count: diagnostics.latest_checkpoint.messages_count,
                })}
              </small>
            ) : null}
            <ul className="diagnostics-events space-y-2">
              {diagnosticEvents(diagnostics).map((event, index) => (
                <li
                  className="flex items-start gap-2 rounded-md border bg-card p-2 text-sm"
                  key={`${event.id ?? event.event_type}-${index}`}
                >
                  <code className="mt-0.5 shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs">{event.event_type}</code>
                  <span className="min-w-0 break-words">{diagnosticEventDetail(event)}</span>
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
