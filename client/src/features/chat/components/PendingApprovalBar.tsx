import { IconCircleCheck, IconShieldCheck, IconX } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/shared/i18n/i18n'
import type { LocalPermissionScope } from '@/shared/local-host/client'
import type { PendingApproval } from '../pendingApproval'

export function PendingApprovalBar({
  approval,
  onDecision,
}: {
  approval: PendingApproval | null
  onDecision: (
    messageID: string,
    requestID: string,
    decision: 'approve' | 'deny',
    scope?: LocalPermissionScope,
  ) => void
}) {
  const { t } = useI18n()
  if (!approval) {
    return null
  }
  const decide = (decision: 'approve' | 'deny', scope?: LocalPermissionScope) =>
    onDecision(approval.messageID, approval.requestID, decision, scope)

  return (
    <div className="approval-bar" role="region" aria-label={t('agent.waitingApproval', { tool: approval.tool })}>
      <div className="approval-bar-copy">
        <span className="approval-bar-title">{t('agent.waitingApproval', { tool: approval.tool })}</span>
        <span className="approval-bar-detail">{t('agent.permissionDetail')}</span>
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
        <Button size="sm" variant="outline" onClick={() => decide('deny')}>
          <IconX size={14} />
          {t('agent.deny')}
        </Button>
      </div>
    </div>
  )
}
