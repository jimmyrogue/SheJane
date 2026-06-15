import { useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useI18n } from '@/shared/i18n/i18n'
import type { BillingCheckoutCreditOption, BillingCheckoutOptions, WalletBalance } from '@/shared/api/client'

export type RechargeCheckoutInput = {
  amount?: number
  credits?: number
}

const defaultCreditPackages = [100_000, 1_000_000, 5_000_000, 10_000_000]

function formatCredits(value: number): string {
  return Math.max(0, Math.round(value)).toLocaleString()
}

function formatCreditPackage(value: number, locale: string): string {
  if (locale === 'zh' && value >= 10_000) {
    const wan = value / 10_000
    const rounded = Number.isInteger(wan) ? String(wan) : wan.toFixed(1)
    return `${rounded}万`
  }
  if (value >= 1_000_000) {
    const millions = value / 1_000_000
    return `${Number.isInteger(millions) ? millions.toLocaleString() : millions.toFixed(1)}M`
  }
  if (value >= 1_000) {
    const thousands = value / 1_000
    return `${Number.isInteger(thousands) ? thousands.toLocaleString() : thousands.toFixed(1)}K`
  }
  return formatCredits(value)
}

function availableCredits(balance?: WalletBalance | null): number {
  return Math.max(0, (balance?.monthly_remaining ?? 0) + (balance?.extra_credits_balance ?? 0))
}

function creditsForAmount(amount: number, options: BillingCheckoutOptions): number {
  if (!Number.isFinite(amount) || amount <= 0) {
    return 0
  }
  return Math.max(1, Math.round(amount * options.credits_per_usd))
}

function amountForCredits(credits: number, options: BillingCheckoutOptions): number | null {
  if (!Number.isFinite(credits) || credits <= 0) {
    return null
  }
  let amount = 0
  if (
    Number.isFinite(options.currency_per_credit)
    && options.currency_per_credit > 0
    && Number.isFinite(options.usd_cny_rate)
    && (options.usd_cny_rate ?? 0) > 0
  ) {
    amount = Math.ceil((credits * options.currency_per_credit) / (options.usd_cny_rate ?? 1))
  } else if (Number.isFinite(options.credits_per_usd) && options.credits_per_usd > 0) {
    amount = Math.ceil(credits / options.credits_per_usd)
  } else {
    return null
  }
  amount = Math.max(options.min_amount, amount)
  return amount <= options.max_amount ? amount : null
}

function creditPresetsForOptions(options?: BillingCheckoutOptions | null): BillingCheckoutCreditOption[] {
  if (!options) {
    return []
  }
  if (options.credit_presets && options.credit_presets.length > 0) {
    return options.credit_presets
  }
  const seenAmounts = new Set<number>()
  return defaultCreditPackages.flatMap((targetCredits) => {
    const amount = amountForCredits(targetCredits, options)
    if (amount == null || seenAmounts.has(amount)) {
      return []
    }
    seenAmounts.add(amount)
    return [{ credits: creditsForAmount(amount, options), amount }]
  })
}

export function RechargeDialog({
  open,
  onOpenChange,
  balance,
  checkoutOptions,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  balance?: WalletBalance | null
  checkoutOptions?: BillingCheckoutOptions | null
  onConfirm: (input: RechargeCheckoutInput) => Promise<void> | void
}) {
  const { locale, t } = useI18n()
  const [mode, setMode] = useState<'credits' | 'amount'>('credits')
  const [amountInput, setAmountInput] = useState('20')
  const [creditsInput, setCreditsInput] = useState('1000000')
  const [confirming, setConfirming] = useState(false)
  const amount = Number(amountInput)
  const optionsReady = checkoutOptions != null
  const minAmount = checkoutOptions?.min_amount ?? 1
  const maxAmount = checkoutOptions?.max_amount ?? 500
  const amountPresets = checkoutOptions?.amount_presets ?? checkoutOptions?.presets ?? []
  const creditPresets = creditPresetsForOptions(checkoutOptions)
  const selectedCredits = Number(creditsInput)
  const selectedCreditPreset = creditPresets.find((item) => item.credits === selectedCredits)
  const validAmount = optionsReady && Number.isInteger(amount) && amount >= minAmount && amount <= maxAmount
  const validCredits = optionsReady && selectedCreditPreset !== undefined
  const canConfirm = mode === 'credits' ? validCredits : validAmount
  const previewCredits = mode === 'credits'
    ? selectedCreditPreset?.credits ?? 0
    : validAmount && checkoutOptions
      ? creditsForAmount(amount, checkoutOptions)
      : 0
  const previewAmount = mode === 'credits' ? selectedCreditPreset?.amount ?? 0 : amount

  useEffect(() => {
    if (!open || creditPresets.length === 0 || creditPresets.some((item) => String(item.credits) === creditsInput)) {
      return
    }
    const preferred = creditPresets.find((item) => item.credits === 1_000_000) ?? creditPresets[0]
    setCreditsInput(String(preferred.credits))
  }, [creditPresets, creditsInput, open])

  const confirm = async () => {
    if (!canConfirm || !checkoutOptions) {
      return
    }
    setConfirming(true)
    try {
      if (mode === 'credits') {
        if (!selectedCreditPreset) {
          return
        }
        await onConfirm({ amount: selectedCreditPreset.amount })
      } else {
        await onConfirm({ amount })
      }
      onOpenChange(false)
    } finally {
      setConfirming(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="billing-modal recharge-dialog">
        <DialogHeader className="billing-modal-header">
          <DialogTitle>{t('billing.recharge.title')}</DialogTitle>
          <DialogDescription>
            {t('billing.recharge.subtitle', { credits: formatCredits(availableCredits(balance)) })}
          </DialogDescription>
        </DialogHeader>

        <div className="billing-modal-body">
          <section className="recharge-section">
            <div className="billing-section-label">{t('billing.recharge.packageSection')}</div>
            <div className="recharge-mode-toggle" role="group" aria-label={t('billing.recharge.modeAria')}>
              <button
                type="button"
                className={mode === 'credits' ? 'active' : ''}
                aria-pressed={mode === 'credits'}
                onClick={() => setMode('credits')}
              >
                {t('billing.recharge.modeCredits')}
              </button>
              <button
                type="button"
                className={mode === 'amount' ? 'active' : ''}
                aria-pressed={mode === 'amount'}
                onClick={() => setMode('amount')}
              >
                {t('billing.recharge.modeAmount')}
              </button>
            </div>

            {mode === 'credits' ? (
              <div className="recharge-preset-grid recharge-credit-preset-grid" aria-label={t('billing.recharge.creditPresetLabel')}>
                {creditPresets.length > 0 ? (
                  creditPresets.map((item) => (
                    <button
                      key={item.credits}
                      type="button"
                      className={`recharge-preset${selectedCredits === item.credits ? ' selected' : ''}`}
                      aria-label={`${formatCreditPackage(item.credits, locale)} ${t('billing.recharge.creditPreviewUnit')} $${item.amount} USD`}
                      aria-pressed={selectedCredits === item.credits}
                      onClick={() => setCreditsInput(String(item.credits))}
                    >
                      <span className="recharge-preset-amount">{formatCreditPackage(item.credits, locale)} {t('billing.recharge.creditPreviewUnit')}</span>
                      <span className="recharge-preset-credits">${item.amount} USD</span>
                    </button>
                  ))
                ) : (
                  <div className="recharge-empty-state" role="status">
                    {optionsReady ? t('billing.recharge.creditPresetsUnavailable') : t('billing.recharge.optionsLoading')}
                  </div>
                )}
              </div>
            ) : (
              <>
                <label className="recharge-amount-field">
                  <span>{t('billing.recharge.amountLabel')}</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={minAmount}
                    max={maxAmount}
                    step={1}
                    value={amountInput}
                    aria-invalid={optionsReady && !validAmount}
                    disabled={!optionsReady}
                    onChange={(event) => setAmountInput(event.target.value)}
                  />
                </label>
                <div className="recharge-preset-grid" aria-label={t('billing.recharge.presetLabel')}>
                  {amountPresets.map((item) => (
                    <button
                      key={item.amount}
                      type="button"
                      className={`recharge-preset${amountInput === String(item.amount) ? ' selected' : ''}`}
                      aria-label={`$${item.amount} USD ${formatCredits(item.credits)} ${t('billing.recharge.creditPreviewUnit')}`}
                      aria-pressed={amountInput === String(item.amount)}
                      onClick={() => setAmountInput(String(item.amount))}
                    >
                      <span className="recharge-preset-amount">${item.amount}</span>
                      <span className="recharge-preset-credits">{formatCredits(item.credits)} {t('billing.recharge.creditPreviewUnit')}</span>
                    </button>
                  ))}
                </div>
              </>
            )}

            <div className={`recharge-credit-preview${canConfirm ? '' : ' invalid'}`} aria-live="polite">
              <span>{t('billing.recharge.creditPreviewLabel')}</span>
              <strong>{canConfirm ? formatCredits(previewCredits) : '—'}</strong>
              <span>
                {!optionsReady
                  ? t('billing.recharge.optionsLoading')
                  : canConfirm
                  ? t('billing.recharge.creditPreviewUnit')
                  : t('billing.recharge.amountInvalid', { min: minAmount, max: maxAmount })}
              </span>
            </div>
          </section>

          <p className="recharge-note">{t('billing.recharge.note')}</p>
        </div>

        <div className="billing-modal-footer">
          <span>
            {t('billing.recharge.footer', {
              amount: canConfirm ? previewAmount : mode === 'amount' ? amountInput || '0' : '—',
              credits: !optionsReady ? t('billing.recharge.optionsLoading') : canConfirm ? formatCredits(previewCredits) : '—',
            })}
          </span>
          <button type="button" className="settings-primary-button" disabled={confirming || !canConfirm || !optionsReady} onClick={confirm}>
            {confirming ? t('billing.recharge.confirming') : t('billing.recharge.confirm')}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
