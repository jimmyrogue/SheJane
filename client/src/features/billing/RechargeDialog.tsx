import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useI18n } from '@/shared/i18n/i18n'
import type { WalletBalance } from '@/shared/api/client'

const presetAmounts = [10, 20, 50]

function formatCredits(value: number): string {
  return Math.max(0, Math.round(value)).toLocaleString()
}

function availableCredits(balance?: WalletBalance | null): number {
  return Math.max(0, (balance?.monthly_remaining ?? 0) + (balance?.extra_credits_balance ?? 0))
}

export function RechargeDialog({
  open,
  onOpenChange,
  balance,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  balance?: WalletBalance | null
  onConfirm: (amount: number) => Promise<void> | void
}) {
  const { t } = useI18n()
  const [amountInput, setAmountInput] = useState('20')
  const [confirming, setConfirming] = useState(false)
  const amount = Number(amountInput)
  const validAmount = Number.isInteger(amount) && amount >= 5 && amount <= 500

  const confirm = async () => {
    if (!validAmount) {
      return
    }
    setConfirming(true)
    try {
      await onConfirm(amount)
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
            <div className="billing-section-label">{t('billing.recharge.amountSection')}</div>
            <label className="recharge-amount-field">
              <span>{t('billing.recharge.amountLabel')}</span>
              <input
                type="number"
                inputMode="numeric"
                min={5}
                max={500}
                step={1}
                value={amountInput}
                aria-invalid={!validAmount}
                onChange={(event) => setAmountInput(event.target.value)}
              />
            </label>
            <div className="recharge-preset-grid" aria-label={t('billing.recharge.presetLabel')}>
              {presetAmounts.map((item) => (
                <button
                  key={item}
                  type="button"
                  className={`recharge-preset${amountInput === String(item) ? ' selected' : ''}`}
                  aria-pressed={amountInput === String(item)}
                  onClick={() => setAmountInput(String(item))}
                >
                  ${item}
                </button>
              ))}
            </div>
          </section>

          <p className="recharge-note">{t('billing.recharge.note')}</p>
        </div>

        <div className="billing-modal-footer">
          <span>
            {t('billing.recharge.footer', {
              amount: validAmount ? amount : amountInput || '0',
            })}
          </span>
          <button type="button" className="settings-primary-button" disabled={confirming || !validAmount} onClick={confirm}>
            {confirming ? t('billing.recharge.confirming') : t('billing.recharge.confirm')}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
