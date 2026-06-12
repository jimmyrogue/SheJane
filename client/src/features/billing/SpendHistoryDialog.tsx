import { useEffect, useMemo, useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useI18n, type Translator } from '@/shared/i18n/i18n'
import type { WalletTransaction } from '@/shared/api/client'

type HistoryFilter = 'all' | 'usage' | 'topup'

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
  const [filter, setFilter] = useState<HistoryFilter>('all')

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

  const filteredTransactions = useMemo(() => {
    if (!transactions) return []
    if (filter === 'usage') return transactions.filter((tx) => tx.amount < 0)
    if (filter === 'topup') return transactions.filter((tx) => tx.amount > 0)
    return transactions
  }, [transactions, filter])

  const recentSpend = useMemo(
    () => (transactions ?? []).reduce((sum, tx) => (tx.amount < 0 ? sum + Math.abs(tx.amount) : sum), 0),
    [transactions],
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="billing-modal spend-history-dialog">
        <DialogHeader className="billing-modal-header">
          <DialogTitle>{t('billing.history.title')}</DialogTitle>
          <DialogDescription>{t('billing.history.subtitle')}</DialogDescription>
        </DialogHeader>

        <div className="billing-modal-body">
          <div className="spend-history-summary">
            <div>
              <div className="billing-section-label">{t('billing.history.recentSpend')}</div>
              <div className="spend-history-total">{formatCredits(recentSpend)}</div>
            </div>
            <div className="spend-history-filter" role="group" aria-label={t('billing.history.filterAria')}>
              {(['all', 'usage', 'topup'] as const).map((item) => (
                <button
                  key={item}
                  type="button"
                  className={filter === item ? 'active' : ''}
                  aria-pressed={filter === item}
                  onClick={() => setFilter(item)}
                >
                  {t(`billing.history.filter.${item}`)}
                </button>
              ))}
            </div>
          </div>

          {failed ? (
            <p className="spend-history-empty">{t('billing.history.error')}</p>
          ) : transactions === null ? (
            <p className="spend-history-empty">{t('billing.history.loading')}</p>
          ) : filteredTransactions.length === 0 ? (
            <p className="spend-history-empty">{t('billing.history.empty')}</p>
          ) : (
            <ul className="spend-history-list">
              {filteredTransactions.map((tx) => (
                <li key={tx.id} className="spend-history-row">
                  <span className={`spend-history-icon${tx.amount > 0 ? ' positive' : ''}`} aria-hidden="true">
                    {tx.amount > 0 ? '+' : '-'}
                  </span>
                  <div className="spend-history-main">
                    <span className="spend-history-type">{transactionTypeLabel(tx.type, t)}</span>
                    <span className="spend-history-desc">
                      {tx.description
                        ? `${tx.description} · ${formatTimestamp(tx.created_at, locale)}`
                        : formatTimestamp(tx.created_at, locale)}
                    </span>
                  </div>
                  <span className={tx.amount < 0 ? 'spend-history-amount negative' : 'spend-history-amount positive'}>
                    {tx.amount > 0 ? '+' : ''}
                    {formatCredits(tx.amount)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="billing-modal-footer">
          <span>{t('billing.history.footer')}</span>
          <button
            type="button"
            className="settings-inline-button"
            disabled={!transactions?.length}
            onClick={() => exportTransactions(transactions ?? [])}
          >
            {t('billing.history.export')}
          </button>
        </div>
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

function formatCredits(value: number): string {
  const sign = value < 0 ? '-' : ''
  return `${sign}${Math.abs(Math.round(value)).toLocaleString()}`
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

function exportTransactions(transactions: WalletTransaction[]) {
  const rows = [
    ['id', 'type', 'amount', 'description', 'created_at'],
    ...transactions.map((tx) => [tx.id, tx.type, String(tx.amount), tx.description, tx.created_at]),
  ]
  const csv = rows.map((row) => row.map(csvCell).join(',')).join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `shejane-billing-${new Date().toISOString().slice(0, 10)}.csv`
  link.click()
  URL.revokeObjectURL(url)
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}
