import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useI18n } from '@/shared/i18n/i18n'

export function RechargePendingDialog({
  open,
  onOpenChange,
  onComplete,
  checking,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onComplete: () => Promise<void> | void
  checking?: boolean
}) {
  const { t } = useI18n()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="billing-modal recharge-pending-dialog">
        <DialogHeader className="billing-modal-header">
          <DialogTitle>{t('billing.recharge.pendingTitle')}</DialogTitle>
          <DialogDescription>{t('billing.recharge.pendingSubtitle')}</DialogDescription>
        </DialogHeader>

        <div className="billing-modal-body recharge-pending-body">
          <div className="recharge-pending-mark" aria-hidden="true">
            $
          </div>
          <p>{t('billing.recharge.pendingBody')}</p>
        </div>

        <div className="billing-modal-footer">
          <button
            type="button"
            className="settings-inline-button"
            disabled={checking}
            onClick={() => onOpenChange(false)}
          >
            {t('billing.recharge.pendingCancel')}
          </button>
          <button type="button" className="settings-primary-button" disabled={checking} onClick={() => void onComplete()}>
            {checking ? t('billing.recharge.pendingChecking') : t('billing.recharge.pendingComplete')}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
