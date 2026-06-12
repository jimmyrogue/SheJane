import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/shared/i18n/i18n'
import type { WalletBalance } from '@/shared/api/client'
import { RechargeDialog } from './RechargeDialog'

const balance: WalletBalance = {
  id: 'w1',
  plan_code: 'payg',
  monthly_credit_limit: 0,
  monthly_credits_used: 0,
  monthly_remaining: 1000,
  extra_credits_balance: 69000,
  period_end: '',
  status: 'active',
}

afterEach(cleanup)

function renderDialog(props: Partial<React.ComponentProps<typeof RechargeDialog>> = {}) {
  return render(
    <I18nProvider>
      <RechargeDialog
        open
        onOpenChange={vi.fn()}
        balance={balance}
        onConfirm={vi.fn()}
        {...props}
      />
    </I18nProvider>,
  )
}

describe('RechargeDialog', () => {
  it('shows packages, balance, and the selected package footer', () => {
    renderDialog()

    expect(screen.getByRole('dialog', { name: '充值' })).toBeInTheDocument()
    expect(screen.getByText('当前余额 70,000 积分')).toBeInTheDocument()
    expect(screen.getByText('120,000 积分')).toBeInTheDocument()
    expect(screen.getByText('实付 ¥100 到账 120,000 积分')).toBeInTheDocument()
  })

  it('updates the footer when another package is selected', () => {
    renderDialog()

    fireEvent.click(screen.getByRole('button', { name: /300,000 积分/ }))
    expect(screen.getByText('实付 ¥240 到账 300,000 积分')).toBeInTheDocument()
  })

  it('confirms through the existing checkout callback and closes', async () => {
    const onConfirm = vi.fn(async () => undefined)
    const onOpenChange = vi.fn()
    renderDialog({ onConfirm, onOpenChange })

    fireEvent.click(screen.getByRole('button', { name: '确认充值' }))
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
