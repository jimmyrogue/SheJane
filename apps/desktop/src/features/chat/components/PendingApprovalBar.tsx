import { useEffect, useMemo, useState } from 'react'
import { IconCircleCheck, IconEdit, IconShieldCheck, IconX } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/shared/i18n/i18n'
import type { LocalEditedToolAction, LocalPermissionDecision, LocalPermissionScope } from '@/shared/local-host/client'
import type { LocalToolReconciliationDecision } from '@/shared/local-host/client'
import type { PendingApproval } from '../pendingApproval'

export function PendingApprovalBar({
  approval,
  onDecision,
  onReconcile,
}: {
  approval: PendingApproval | null
  onDecision: (
    messageID: string,
    requestID: string,
    decision: LocalPermissionDecision,
    scope?: LocalPermissionScope,
    editedAction?: LocalEditedToolAction,
  ) => void
  onReconcile?: (messageID: string, requestID: string, decision: LocalToolReconciliationDecision) => void
}) {
  const { t } = useI18n()
  const [editing, setEditing] = useState(false)
  const [argumentsJSON, setArgumentsJSON] = useState('')
  useEffect(() => {
    setEditing(false)
    setArgumentsJSON(JSON.stringify(approval?.arguments ?? {}, null, 2))
  }, [approval?.requestID, approval?.arguments])
  const editedArguments = useMemo(() => {
    try {
      const value = JSON.parse(argumentsJSON) as unknown
      return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
    } catch {
      return null
    }
  }, [argumentsJSON])
  if (!approval) {
    return null
  }
  if (approval.kind === 'reconciliation') {
    return (
      <div className="approval-bar" role="region" aria-label={t('agent.reconciliationTitle', { tool: approval.tool })}>
        <div className="approval-bar-copy">
          <span className="approval-bar-title">{t('agent.reconciliationTitle', { tool: approval.tool })}</span>
          <span className="approval-bar-detail">{t('agent.reconciliationDetail')}</span>
        </div>
        <div className="approval-bar-actions">
          <Button size="sm" onClick={() => onReconcile?.(approval.messageID, approval.requestID, 'confirmed_completed')}>
            <IconCircleCheck size={14} />
            {t('agent.reconciliationCompleted')}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => onReconcile?.(approval.messageID, approval.requestID, 'retry_not_executed')}>
            <IconShieldCheck size={14} />
            {t('agent.reconciliationRetry')}
          </Button>
          <Button size="sm" variant="outline" onClick={() => onReconcile?.(approval.messageID, approval.requestID, 'abort')}>
            <IconX size={14} />
            {t('agent.reconciliationAbort')}
          </Button>
        </div>
      </div>
    )
  }
  const decide = (decision: LocalPermissionDecision, scope?: LocalPermissionScope, editedAction?: LocalEditedToolAction) =>
    onDecision(approval.messageID, approval.requestID, decision, scope, editedAction)
  const permissionDetail = approval.source === 'fallback'
    ? t('agent.permissionFallbackDetail')
    : approval.source === 'llm'
      ? t('agent.permissionLlmDetail')
      : t('agent.permissionDetail')

  return (
    <div className="approval-bar" role="region" aria-label={t('agent.waitingApproval', { tool: approval.tool })}>
      <div className="approval-bar-copy">
        <span className="approval-bar-title">{t('agent.waitingApproval', { tool: approval.tool })}</span>
        <span className="approval-bar-detail">{permissionDetail}</span>
      </div>
      <div className="approval-bar-actions">
        <Button size="sm" onClick={() => decide('approve', 'once')}>
          <IconCircleCheck size={14} />
          {t('agent.allowOnce')}
        </Button>
        <Button size="sm" variant="secondary" onClick={() => decide('approve', 'run')}>
          <IconShieldCheck size={14} />
          {t('agent.allowRun')}
        </Button>
        <Button size="sm" variant="outline" onClick={() => setEditing((value) => !value)}>
          <IconEdit size={14} />
          {t('agent.editArguments')}
        </Button>
        <Button size="sm" variant="outline" onClick={() => decide('deny')}>
          <IconX size={14} />
          {t('agent.deny')}
        </Button>
      </div>
      {editing ? (
        <div className="plan-bar-revise">
          <textarea
            className="plan-bar-input"
            value={argumentsJSON}
            rows={4}
            aria-label={t('agent.editArguments')}
            onChange={(event) => setArgumentsJSON(event.target.value)}
          />
          <Button
            size="sm"
            variant="secondary"
            disabled={!editedArguments || !approval.toolName}
            onClick={() => editedArguments && decide('edit', 'once', { name: approval.toolName, args: editedArguments })}
          >
            <IconEdit size={14} />
            {t('agent.editAndAllow')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
