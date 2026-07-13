import { useEffect, useMemo, useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useI18n, type Translator } from '@/shared/i18n/i18n'
import type { BillingActivity, BillingLLMCall } from '@/shared/api/client'

export type HistoryFilter = 'all' | 'usage' | 'topup'

export function SpendHistoryDialog({
  open,
  onOpenChange,
  fetchActivities,
  initialFilter = 'all',
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  fetchActivities: () => Promise<BillingActivity[]>
  initialFilter?: HistoryFilter
}) {
  const { t, locale } = useI18n()
  const [activities, setActivities] = useState<BillingActivity[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [filter, setFilter] = useState<HistoryFilter>(initialFilter)

  useEffect(() => {
    if (!open) {
      return
    }
    let cancelled = false
    setFilter(initialFilter)
    setActivities(null)
    setFailed(false)
    fetchActivities()
      .then((items) => {
        if (!cancelled) {
          setActivities(items)
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
  }, [open, fetchActivities, initialFilter])

  const filteredActivities = useMemo(() => {
    if (!activities) return []
    if (filter === 'usage') return activities.filter(isUsageActivity)
    if (filter === 'topup') return activities.filter((activity) => !isUsageActivity(activity) && activityDisplayAmount(activity) > 0)
    return activities
  }, [activities, filter])

  const recentSpend = useMemo(
    () => (activities ?? []).reduce((sum, activity) => (
      isUsageActivity(activity) && isWithinRecentWindow(activity) ? sum + activity.settled_credits : sum
    ), 0),
    [activities],
  )
  const exportRows = activities ?? []

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
          ) : activities === null ? (
            <p className="spend-history-empty">{t('billing.history.loading')}</p>
          ) : filteredActivities.length === 0 ? (
            <p className="spend-history-empty">{t('billing.history.empty')}</p>
          ) : (
            <ul className="spend-history-list">
              {filteredActivities.map((activity) => (
                <SpendActivityRow key={activity.id} activity={activity} locale={locale} t={t} />
              ))}
            </ul>
          )}
        </div>

        <div className="billing-modal-footer">
          <span>{t('billing.history.footer')}</span>
          <button
            type="button"
            className="settings-inline-button"
            disabled={!exportRows.length}
            onClick={() => exportActivities(exportRows)}
          >
            {t('billing.history.export')}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function SpendActivityRow({ activity, locale, t }: { activity: BillingActivity; locale: string; t: Translator }) {
  const amount = activityDisplayAmount(activity)
  const positive = amount > 0
  const zero = amount === 0
  return (
    <li className={`spend-history-row${isUsageActivity(activity) ? ' spend-history-row-usage' : ''}`}>
      <span className={`spend-history-icon${positive ? ' positive' : ''}`} aria-hidden="true">
        {positive ? '+' : zero ? '·' : '-'}
      </span>
      <div className="spend-history-main">
        <span className="spend-history-type">{activityTitle(activity, t)}</span>
        <span className="spend-history-desc">{activityDescription(activity, locale, t)}</span>
        {isUsageActivity(activity) ? (
          <div className="spend-history-metrics" aria-label={t('billing.history.breakdownAria')}>
            <span><b>{t('billing.history.reserved')}</b>{formatCredits(activity.reserved_credits)}</span>
            <span><b>{t('billing.history.actual')}</b>{formatCredits(activity.settled_credits)}</span>
            <span><b>{t('billing.history.refunded')}</b>{formatCredits(activity.released_credits)}</span>
          </div>
        ) : null}
      </div>
      <span className={amount < 0 ? 'spend-history-amount negative' : 'spend-history-amount positive'}>
        {amount > 0 ? '+' : ''}
        {formatCredits(amount)}
      </span>
    </li>
  )
}

function isUsageActivity(activity: BillingActivity) {
  return activity.kind === 'usage' || activity.reserved_credits > 0 || activity.settled_credits > 0 || activity.released_credits > 0
}

function isWithinRecentWindow(activity: BillingActivity) {
  const timestamp = Date.parse(activity.updated_at || activity.created_at)
  if (Number.isNaN(timestamp)) {
    return true
  }
  return timestamp >= Date.now() - 30 * 24 * 60 * 60 * 1000
}

function activityDisplayAmount(activity: BillingActivity) {
  if (isUsageActivity(activity)) {
    return -activity.settled_credits
  }
  return activity.transactions.reduce((sum, tx) => sum + tx.amount, 0)
}

function activityTitle(activity: BillingActivity, t: Translator): string {
  if (isUsageActivity(activity)) {
    const call = preferredLLMCall(activity.llm_calls)
    if (call) {
      return `${t('billing.history.usageRun')} · ${call.provider}/${call.model || call.mode}`
    }
    const tool = activity.tool_calls[0]
    if (tool) {
      return `${t('billing.history.usageRun')} · ${tool.tool}`
    }
    return t('billing.history.usageRun')
  }
  const tx = activity.transactions[0]
  return tx ? transactionTypeLabel(tx.type, t) : t('billing.history.accountChange')
}

function activityDescription(activity: BillingActivity, locale: string, t: Translator): string {
  const parts = [formatTimestamp(activity.updated_at || activity.created_at, locale)]
  if (activity.run_id) {
    parts.push(`${t('billing.history.run')} ${shortID(activity.run_id)}`)
  }
  if (activity.llm_calls.length > 0) {
    parts.push(t('billing.history.modelCount', { count: activity.llm_calls.length }))
  }
  if (activity.tool_calls.length > 0) {
    parts.push(t('billing.history.toolCount', { count: activity.tool_calls.length }))
  }
  if (!isUsageActivity(activity)) {
    const desc = activity.transactions.map((tx) => tx.description).find(Boolean)
    if (desc) {
      parts.unshift(desc)
    }
  }
  return parts.join(' · ')
}

function preferredLLMCall(calls: BillingLLMCall[]): BillingLLMCall | undefined {
  return calls.find((call) => call.status === 'done' || call.credits_cost > 0) ?? calls[0]
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
    case 'recharge_grant':
      return t('billing.txType.rechargeGrant')
    case 'recharge_refund':
      return t('billing.txType.rechargeRefund')
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

function shortID(value: string): string {
  if (value.length <= 14) {
    return value
  }
  return `${value.slice(0, 8)}...${value.slice(-4)}`
}

function exportActivities(activities: BillingActivity[]) {
  const rows = [
    [
      'activity_id',
      'kind',
      'run_id',
      'reserved_credits',
      'settled_credits',
      'released_credits',
      'net_credits',
      'models',
      'tools',
      'transaction_ids',
      'created_at',
      'updated_at',
    ],
    ...activities.map((activity) => [
      activity.id,
      activity.kind,
      activity.run_id ?? '',
      String(activity.reserved_credits),
      String(activity.settled_credits),
      String(activity.released_credits),
      String(activity.net_credits),
      activity.llm_calls.map((call) => `${call.provider}/${call.model || call.mode}:${call.status}:${call.credits_cost}`).join('; '),
      activity.tool_calls.map((call) => `${call.tool}/${call.provider}:${call.status}:${call.credits_cost}`).join('; '),
      activity.transactions.map((tx) => tx.id).join('; '),
      activity.created_at,
      activity.updated_at,
    ]),
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
