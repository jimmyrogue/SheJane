import { useMemo, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useI18n } from '@/shared/i18n/i18n'
import type { WalletBalance } from '@/shared/api/client'

type PayMethod = 'wechat' | 'alipay'

interface RechargePackage {
  id: string
  credits: number
  price: number
  bonus?: number
}

const rechargePackages: RechargePackage[] = [
  { id: 'p1', credits: 50_000, price: 50 },
  { id: 'p2', credits: 120_000, price: 100, bonus: 20_000 },
  { id: 'p3', credits: 300_000, price: 240, bonus: 60_000 },
  { id: 'p4', credits: 650_000, price: 500, bonus: 150_000 },
]

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
  onConfirm: () => Promise<void> | void
}) {
  const { t } = useI18n()
  const [selectedPackageID, setSelectedPackageID] = useState('p2')
  const [payMethod, setPayMethod] = useState<PayMethod>('wechat')
  const [confirming, setConfirming] = useState(false)
  const selectedPackage = useMemo(
    () => rechargePackages.find((item) => item.id === selectedPackageID) ?? rechargePackages[1],
    [selectedPackageID],
  )

  const confirm = async () => {
    setConfirming(true)
    try {
      await onConfirm()
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
            <div className="recharge-package-grid">
              {rechargePackages.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`recharge-package${selectedPackageID === item.id ? ' selected' : ''}`}
                  aria-pressed={selectedPackageID === item.id}
                  onClick={() => setSelectedPackageID(item.id)}
                >
                  <span className="recharge-package-credits">
                    {t('billing.recharge.credits', { credits: formatCredits(item.credits) })}
                  </span>
                  <span className="recharge-package-price">¥{item.price}</span>
                  {item.bonus ? (
                    <span className="recharge-package-bonus">
                      {t('billing.recharge.bonus', { bonus: formatCredits(item.bonus) })}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          </section>

          <section className="recharge-section">
            <div className="billing-section-label">{t('billing.recharge.paySection')}</div>
            <div className="recharge-pay-grid">
              {(['wechat', 'alipay'] as const).map((method) => (
                <button
                  key={method}
                  type="button"
                  className={`recharge-pay-option${payMethod === method ? ' selected' : ''}`}
                  aria-pressed={payMethod === method}
                  onClick={() => setPayMethod(method)}
                >
                  <span className="recharge-pay-glyph">{method === 'wechat' ? '微' : '支'}</span>
                  <span>{t(`billing.recharge.pay.${method}`)}</span>
                  <span className="recharge-pay-radio" aria-hidden="true" />
                </button>
              ))}
            </div>
          </section>

          <p className="recharge-note">{t('billing.recharge.note')}</p>
        </div>

        <div className="billing-modal-footer">
          <span>
            {t('billing.recharge.footer', {
              price: selectedPackage.price,
              credits: formatCredits(selectedPackage.credits),
            })}
          </span>
          <button type="button" className="settings-primary-button" disabled={confirming} onClick={confirm}>
            {confirming ? t('billing.recharge.confirming') : t('billing.recharge.confirm')}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
