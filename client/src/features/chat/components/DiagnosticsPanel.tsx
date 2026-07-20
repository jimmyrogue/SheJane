import { IconGitBranch, IconDownload, IconX } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { useI18n } from '@/shared/i18n/i18n'
import type { AgentRunEvent } from '@shejane/runtime-sdk'
import type { LocalRunDiagnostics } from '@/runtime/client'

type Translate = ReturnType<typeof useI18n>['t']
type TranslationKey = Parameters<Translate>[0]
type DiagnosticsHandoff = LocalRunDiagnostics['handoff']
type DiagnosticsFailure = NonNullable<DiagnosticsHandoff['failure']>

const NEXT_ACTION_TRANSLATION_KEYS = new Map<string, TranslationKey>([
  ['Review the final answer and any listed artifacts.', 'diagnostics.nextAction.reviewArtifacts'],
  ['Approve or deny pending permission requests to continue the run.', 'diagnostics.nextAction.resolvePermission'],
  ['Answer the pending question to continue the run.', 'diagnostics.nextAction.answerQuestion'],
  ['Reconnect to the stream or wait for the run to reach a terminal state.', 'diagnostics.nextAction.waitForTerminal'],
  ['Inspect blockers and recent failed events before retrying.', 'diagnostics.nextAction.inspectBeforeRetry'],
  ['Start a new run if the goal still needs work.', 'diagnostics.nextAction.startNewRun'],
  ['Inspect recent events before resuming work.', 'diagnostics.nextAction.inspectRecentEvents'],
  [
    'Call task.progress with current acceptance criteria, decisions, risks, and next actions.',
    'diagnostics.nextAction.callTaskProgress',
  ],
  ['Refresh task.progress before handing off or resuming this run.', 'diagnostics.nextAction.refreshTaskProgress'],
  ['Fix the failing verification, then rerun task.verify before final handoff.', 'diagnostics.nextAction.fixVerification'],
])

export function DiagnosticsPanel({
  diagnostics,
  onClose,
  onExport,
  onForkCheckpoint,
  checkpointForking = false,
}: {
  diagnostics: LocalRunDiagnostics | null
  onClose: () => void
  onExport: () => void
  onForkCheckpoint?: (runID: string, checkpointID: string) => void
  checkpointForking?: boolean
}) {
  const { t } = useI18n()
  const handoffNextActions = diagnostics?.handoff ? localizedNextActions(t, diagnostics.handoff) : []
  const blockers = diagnostics?.handoff ? userFacingBlockers(diagnostics.handoff) : []
  const visibleEvents = diagnostics ? diagnosticEvents(diagnostics) : []
  const verificationFailed = diagnostics?.handoff.verification?.status === 'failed'
  const needsAttention = Boolean(diagnostics?.handoff.failure || verificationFailed || blockers.length)

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
          <div className="diagnostics-body flex-1 overflow-auto">
            <section className={`diagnostics-outcome is-${diagnostics.run.status}`}>
              <span className="diagnostics-outcome-mark" aria-hidden="true" />
              <div>
                <h3>{runStatusLabel(t, diagnostics.run.status)}</h3>
                {diagnostics.handoff.verification?.status === 'passed' ? (
                  <p>{t('diagnostics.verificationPassed')}</p>
                ) : null}
              </div>
            </section>

            {needsAttention ? (
              <section className="diagnostics-attention diagnostics-primary-section">
                <h3>{t('diagnostics.attention')}</h3>
                {diagnostics.handoff.failure ? (
                  <div className="diagnostics-problem">
                    <strong>{failureCategoryLabel(t, diagnostics.handoff.failure.category)}</strong>
                    <span>{failureActionKindLabel(t, diagnostics.handoff.failure.action_kind)}</span>
                    <p>{failureActionLabel(t, diagnostics.handoff.failure)}</p>
                  </div>
                ) : null}
                {verificationFailed && diagnostics.handoff.verification ? (
                  <div className="diagnostics-problem">
                    <strong>{t('diagnostics.verificationFailed')}</strong>
                    {diagnostics.handoff.verification.reason ? <p>{diagnostics.handoff.verification.reason}</p> : null}
                  </div>
                ) : null}
                <HandoffList values={blockers} />
              </section>
            ) : null}

            {handoffNextActions.length && (needsAttention || diagnostics.run.status !== 'completed') ? (
              <section className="diagnostics-next diagnostics-primary-section">
                <h3>{t('diagnostics.nextActions')}</h3>
                <HandoffList values={handoffNextActions} />
              </section>
            ) : null}

            <details className="diagnostics-technical">
              <summary>
                <span>{t('diagnostics.technicalDetails')}</span>
                <small>
                  {t('diagnostics.activitySummary', {
                    events: diagnostics.events.length,
                    permissions: diagnostics.permissions.length,
                    artifacts: diagnostics.artifacts.length,
                  })}
                </small>
              </summary>
              <div className="diagnostics-technical-body">
                <div className="diagnostics-run-id">
                  <span>{t('diagnostics.runId')}</span>
                  <code>{diagnostics.run.id}</code>
                </div>
                {diagnostics.latest_checkpoint ? (
                  <div className="diagnostics-checkpoint diagnostics-section-row">
                    <small>
                      {t('diagnostics.checkpoint', {
                        id: diagnostics.latest_checkpoint.id,
                        reason: diagnostics.latest_checkpoint.reason,
                        count: diagnostics.latest_checkpoint.messages_count,
                      })}
                    </small>
                    {onForkCheckpoint ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={checkpointForking}
                        onClick={() => onForkCheckpoint(diagnostics.run.id, diagnostics.latest_checkpoint!.id)}
                      >
                        <IconGitBranch size={14} />
                        {t('diagnostics.retryFromCheckpoint')}
                      </Button>
                    ) : null}
                  </div>
                ) : null}
                {visibleEvents.length ? (
                  <section className="diagnostics-events-section">
                    <h4>{t('diagnostics.keyEvents')}</h4>
                    <ul className="diagnostics-events">
                      {visibleEvents.map((event, index) => (
                        <li className="diagnostics-event" key={`${event.id ?? event.event_type}-${index}`}>
                          <code>{event.event_type}</code>
                          <span>{diagnosticEventDetail(event)}</span>
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}
              </div>
            </details>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

function runStatusLabel(t: Translate, status: LocalRunDiagnostics['run']['status']) {
  if (status === 'completed') return t('diagnostics.status.completed')
  if (status === 'failed') return t('diagnostics.status.failed')
  if (status === 'canceled') return t('diagnostics.status.canceled')
  if (status === 'waiting_permission') return t('diagnostics.status.waitingPermission')
  if (status === 'waiting_input') return t('diagnostics.status.waitingInput')
  if (status === 'cleanup_required') return t('diagnostics.status.cleanupRequired')
  if (status === 'queued') return t('diagnostics.status.queued')
  return t('diagnostics.status.running')
}

function failureCategoryLabel(
  t: Translate,
  category: DiagnosticsFailure['category'],
) {
  return t(`diagnostics.failureCategory.${category}`)
}

function failureActionLabel(
  t: Translate,
  failure: DiagnosticsFailure,
) {
  const localized = t(`diagnostics.failureAction.${failure.category}`)
  return localized || failure.suggested_action
}

function failureActionKindLabel(
  t: Translate,
  actionKind: DiagnosticsFailure['action_kind'],
) {
  return t(`diagnostics.failureActionKind.${actionKind}`)
}

function failureActionKindClass(actionKind: DiagnosticsFailure['action_kind']) {
  return actionKind === 'retry' || actionKind === 'inspect' ? '' : 'is-critical'
}

function localizedNextActions(t: Translate, handoff: DiagnosticsHandoff) {
  const values: string[] = []
  const failureSuggestedAction = handoff.failure?.suggested_action
  for (const value of handoff.next_actions ?? []) {
    if (
      (failureSuggestedAction && value === failureSuggestedAction)
      || value === 'Review the final answer and any listed artifacts.'
      || value.startsWith('Call task.progress')
      || value.startsWith('Refresh task.progress')
    ) {
      continue
    }
    const translationKey = NEXT_ACTION_TRANSLATION_KEYS.get(value)
    const localized = translationKey ? t(translationKey) : value
    if (!values.includes(localized)) {
      values.push(localized)
    }
  }
  return values
}

function userFacingBlockers(handoff: DiagnosticsHandoff) {
  return (handoff.blockers ?? []).filter((value) => !value.toLowerCase().includes('progress ledger'))
}

function HandoffList({ values }: { values?: string[] }) {
  if (!values?.length) return null
  return (
    <div className="diagnostics-list-group">
      <ul>
        {values.map((value, index) => (
          <li key={`${value}-${index}`}>
            {value}
          </li>
        ))}
      </ul>
    </div>
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
