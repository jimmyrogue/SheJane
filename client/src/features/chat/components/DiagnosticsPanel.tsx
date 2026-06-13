import { IconGitBranch, IconDownload, IconX } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { useI18n } from '@/shared/i18n/i18n'
import type { AgentRunEvent } from '@/shared/api/sse'
import type { LocalRunDiagnostics } from '@/shared/local-host/client'

type Translate = ReturnType<typeof useI18n>['t']
type TranslationKey = Parameters<Translate>[0]
type DiagnosticsHandoff = LocalRunDiagnostics['handoff']
type DiagnosticsFailure = NonNullable<DiagnosticsHandoff['failure']>
type BadgeVariant = 'secondary' | 'outline' | 'destructive'

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
}: {
  diagnostics: LocalRunDiagnostics | null
  onClose: () => void
  onExport: () => void
  onForkCheckpoint?: (runID: string, checkpointID: string) => void
}) {
  const { t } = useI18n()
  const handoffNextActions = diagnostics?.handoff ? localizedNextActions(t, diagnostics.handoff) : []

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
              <section className="diagnostics-checkpoint flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/40 p-3 text-sm">
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
                    onClick={() => onForkCheckpoint(diagnostics.run.id, diagnostics.latest_checkpoint!.id)}
                  >
                    <IconGitBranch size={14} />
                    {t('diagnostics.retryFromCheckpoint')}
                  </Button>
                ) : null}
              </section>
            ) : null}
            {diagnostics.handoff ? (
              <section className="diagnostics-handoff space-y-2 rounded-md border bg-muted/30 p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{t('diagnostics.handoff')}</span>
                  <Badge
                    variant={
                      diagnostics.handoff.ledger_state === 'missing' || diagnostics.handoff.ledger_state === 'stale'
                        ? 'destructive'
                        : 'secondary'
                    }
                  >
                    {ledgerStateLabel(t, diagnostics.handoff.ledger_state)}
                  </Badge>
                </div>
                <p className="text-muted-foreground">{diagnostics.handoff.headline}</p>
                {diagnostics.handoff.verification ? (
                  <div className="space-y-1 rounded-md border bg-card p-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-medium uppercase text-muted-foreground">{t('diagnostics.verification')}</span>
                      <Badge variant={diagnostics.handoff.verification.status === 'failed' ? 'destructive' : 'secondary'}>
                        {verificationStatusLabel(t, diagnostics.handoff.verification.status)}
                      </Badge>
                      {diagnostics.handoff.verification.pass_count !== null && diagnostics.handoff.verification.pass_count !== undefined ? (
                        <Badge variant="outline">
                          {t('diagnostics.verificationPassCount', { count: diagnostics.handoff.verification.pass_count })}
                        </Badge>
                      ) : null}
                      {diagnostics.handoff.verification.fail_count !== null && diagnostics.handoff.verification.fail_count !== undefined ? (
                        <Badge variant="outline">
                          {t('diagnostics.verificationFailCount', { count: diagnostics.handoff.verification.fail_count })}
                        </Badge>
                      ) : null}
                    </div>
                    {diagnostics.handoff.verification.reason ? (
                      <p className="break-words text-muted-foreground">{diagnostics.handoff.verification.reason}</p>
                    ) : null}
                  </div>
                ) : null}
                {diagnostics.handoff.failure ? (
                  <div className="space-y-1 rounded-md border bg-card p-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-medium uppercase text-muted-foreground">{t('diagnostics.failure')}</span>
                      <Badge variant={diagnostics.handoff.failure.retryable ? 'secondary' : 'outline'}>
                        {failureCategoryLabel(t, diagnostics.handoff.failure.category)}
                      </Badge>
                      <Badge variant={failureActionKindVariant(diagnostics.handoff.failure.action_kind)}>
                        {failureActionKindLabel(t, diagnostics.handoff.failure.action_kind)}
                      </Badge>
                    </div>
                    <p className="break-words text-muted-foreground">{failureActionLabel(t, diagnostics.handoff.failure)}</p>
                  </div>
                ) : null}
                <HandoffList label={t('diagnostics.blockers')} values={diagnostics.handoff.blockers} />
                <HandoffList label={t('diagnostics.nextActions')} values={handoffNextActions} />
                <HandoffList label={t('diagnostics.recentEvents')} values={diagnostics.handoff.recent_event_types} />
              </section>
            ) : null}
            {diagnostics.reflection ? (
              <section className="diagnostics-reflection space-y-2 rounded-md border bg-card p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{t('diagnostics.reflection')}</span>
                  {diagnostics.reflection.ai_messages !== null && diagnostics.reflection.ai_messages !== undefined ? (
                    <Badge variant="outline">{t('diagnostics.reflectionAiMessages', { count: diagnostics.reflection.ai_messages })}</Badge>
                  ) : null}
                  {diagnostics.reflection.tool_results !== null && diagnostics.reflection.tool_results !== undefined ? (
                    <Badge variant="outline">{t('diagnostics.reflectionToolResults', { count: diagnostics.reflection.tool_results })}</Badge>
                  ) : null}
                  {diagnostics.reflection.final_answer_chars !== null && diagnostics.reflection.final_answer_chars !== undefined ? (
                    <Badge variant="outline">{t('diagnostics.reflectionFinalAnswerChars', { count: diagnostics.reflection.final_answer_chars })}</Badge>
                  ) : null}
                </div>
                {diagnostics.reflection.critic ? (
                  <div className="space-y-1 rounded-md border bg-muted/30 p-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-medium uppercase text-muted-foreground">{t('diagnostics.reflectionCritic')}</span>
                      {diagnostics.reflection.critic.coverage !== null && diagnostics.reflection.critic.coverage !== undefined ? (
                        <Badge variant="outline">{t('diagnostics.reflectionCoverage', { score: diagnostics.reflection.critic.coverage })}</Badge>
                      ) : null}
                      {diagnostics.reflection.critic.clarity !== null && diagnostics.reflection.critic.clarity !== undefined ? (
                        <Badge variant="outline">{t('diagnostics.reflectionClarity', { score: diagnostics.reflection.critic.clarity })}</Badge>
                      ) : null}
                      {diagnostics.reflection.critic.grounding !== null && diagnostics.reflection.critic.grounding !== undefined ? (
                        <Badge variant="outline">{t('diagnostics.reflectionGrounding', { score: diagnostics.reflection.critic.grounding })}</Badge>
                      ) : null}
                    </div>
                    <HandoffList label={t('diagnostics.reflectionNotes')} values={diagnostics.reflection.critic.notes ?? []} />
                    {diagnostics.reflection.critic.raw ? (
                      <p className="break-words text-muted-foreground">{diagnostics.reflection.critic.raw}</p>
                    ) : null}
                  </div>
                ) : null}
              </section>
            ) : null}
            {diagnostics.feature_ledger ? (
              <section className="diagnostics-feature-ledger space-y-2 rounded-md border bg-card p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{t('diagnostics.featureLedger')}</span>
                  <Badge variant="outline">{diagnostics.feature_ledger.status}</Badge>
                </div>
                <p className="text-muted-foreground">{diagnostics.feature_ledger.summary}</p>
                <HandoffList label={t('diagnostics.acceptanceCriteria')} values={diagnostics.feature_ledger.acceptance_criteria} />
                <HandoffList label={t('diagnostics.decisions')} values={diagnostics.feature_ledger.decisions} />
                <HandoffList label={t('diagnostics.filesTouched')} values={diagnostics.feature_ledger.files_touched} />
                <HandoffList label={t('diagnostics.validationCommands')} values={diagnostics.feature_ledger.validation_commands} />
                <HandoffList label={t('diagnostics.unresolvedRisks')} values={diagnostics.feature_ledger.unresolved_risks} />
              </section>
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

function ledgerStateLabel(t: Translate, state: LocalRunDiagnostics['handoff']['ledger_state']) {
  if (state === 'fresh') {
    return t('diagnostics.ledgerFresh')
  }
  if (state === 'not_required') {
    return t('diagnostics.ledgerNotRequired')
  }
  if (state === 'stale') {
    return t('diagnostics.ledgerStale')
  }
  return t('diagnostics.ledgerMissing')
}

function verificationStatusLabel(
  t: Translate,
  status: NonNullable<LocalRunDiagnostics['handoff']['verification']>['status'],
) {
  return status === 'passed' ? t('diagnostics.verificationPassed') : t('diagnostics.verificationFailed')
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

function failureActionKindVariant(actionKind: DiagnosticsFailure['action_kind']): BadgeVariant {
  if (actionKind === 'retry') {
    return 'secondary'
  }
  if (actionKind === 'operator_action') {
    return 'destructive'
  }
  return 'outline'
}

function localizedNextActions(t: Translate, handoff: DiagnosticsHandoff) {
  const values: string[] = []
  const failureSuggestedAction = handoff.failure?.suggested_action
  for (const value of handoff.next_actions ?? []) {
    if (failureSuggestedAction && value === failureSuggestedAction) {
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

function HandoffList({ label, values }: { label: string; values?: string[] }) {
  if (!values?.length) return null
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium uppercase text-muted-foreground">{label}</div>
      <ul className="space-y-1">
        {values.map((value, index) => (
          <li className="break-words" key={`${value}-${index}`}>
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
