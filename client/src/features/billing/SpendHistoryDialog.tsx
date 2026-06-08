import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useI18n, type Translator } from '@/shared/i18n/i18n'
import type { WalletTransaction } from '@/shared/api/client'

/** Read-only credit-ledger history. Opened from the account menu; fetches
 *  the user's wallet transactions on open and lists them newest-first with a
 *  type label, signed amount, and timestamp. v1 shows raw ledger rows
 *  (reserve/settle/release appear separately) — collapsing per request_id is
 *  a future refinement. */
export function SpendHistoryDialog({
  open,
  onOpenChange,
  fetchTransactions,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  fetchTransactions: () => Promise<WalletTransaction[]>
}) {
  const { t, locale } = useI18n()
  const [transactions, setTransactions] = useState<WalletTransaction[] | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!open) {
      return
    }
    let cancelled = false
    setTransactions(null)
    setFailed(false)
    fetchTransactions()
      .then((items) => {
        if (!cancelled) {
          setTransactions(items)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFailed(true)
        }
      })
    return () => {
      cancelled = true
    }
  }, [open, fetchTransactions])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="spend-history-dialog">
        <DialogHeader>
          <DialogTitle>{t('billing.history.title')}</DialogTitle>
          <DialogDescription>{t('billing.history.subtitle')}</DialogDescription>
        </DialogHeader>
        {failed ? (
          <p className="spend-history-empty">{t('billing.history.error')}</p>
        ) : transactions === null ? (
          <p className="spend-history-empty">{t('billing.history.loading')}</p>
        ) : transactions.length === 0 ? (
          <p className="spend-history-empty">{t('billing.history.empty')}</p>
        ) : (
          <ul className="spend-history-list">
            {transactions.map((tx) => (
              <li key={tx.id} className="spend-history-row">
                <div className="spend-history-main">
                  <span className="spend-history-type">{transactionTypeLabel(tx.type, t)}</span>
                  {tx.description ? <span className="spend-history-desc">{tx.description}</span> : null}
                </div>
                <div className="spend-history-side">
                  <span className={tx.amount < 0 ? 'spend-history-amount negative' : 'spend-history-amount positive'}>
                    {tx.amount > 0 ? '+' : ''}
                    {tx.amount}
                  </span>
                  <span className="spend-history-time">{formatTimestamp(tx.created_at, locale)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  )
}

function transactionTypeLabel(type: string, t: Translator): string {
  switch (type) {
    case 'usage_settle':
      return t('billing.txType.usageSettle')
    case 'usage_reserve':
      return t('billing.txType.usageReserve')
    case 'usage_release':
      return t('billing.txType.usageRelease')
    case 'subscription_grant':
      return t('billing.txType.subscriptionGrant')
    case 'subscription_revoke':
      return t('billing.txType.subscriptionRevoke')
    case 'admin_adjust':
      return t('billing.txType.adminAdjust')
    case 'signup_grant':
      return t('billing.txType.signupGrant')
    default:
      return type
  }
}

function formatTimestamp(iso: string, locale: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) {
    return iso
  }
  return date.toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}
