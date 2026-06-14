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
  it('shows USD amount controls and the current balance', () => {
    renderDialog()

    expect(screen.getByRole('dialog', { name: '充值' })).toBeInTheDocument()
    expect(screen.getByText('当前余额 70,000 积分')).toBeInTheDocument()
    expect(screen.getByLabelText('金额（USD）')).toHaveValue(20)
    expect(screen.getByRole('button', { name: '$10' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '$20' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '$50' })).toBeInTheDocument()
    expect(screen.getByText('Stripe Checkout · $20 USD')).toBeInTheDocument()
  })

  it('updates the amount when a preset is selected', () => {
    renderDialog()

    fireEvent.click(screen.getByRole('button', { name: '$50' }))
    expect(screen.getByLabelText('金额（USD）')).toHaveValue(50)
    expect(screen.getByText('Stripe Checkout · $50 USD')).toBeInTheDocument()
  })

  it('passes the selected integer amount to the checkout callback and closes', async () => {
    const onConfirm = vi.fn(async () => undefined)
    const onOpenChange = vi.fn()
    renderDialog({ onConfirm, onOpenChange })

    fireEvent.change(screen.getByLabelText('金额（USD）'), { target: { value: '35' } })
    fireEvent.click(screen.getByRole('button', { name: '确认充值' }))
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(35))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('requires an integer amount between 5 and 500', () => {
    renderDialog()

    fireEvent.change(screen.getByLabelText('金额（USD）'), { target: { value: '4' } })
    expect(screen.getByRole('button', { name: '确认充值' })).toBeDisabled()

    fireEvent.change(screen.getByLabelText('金额（USD）'), { target: { value: '10.5' } })
    expect(screen.getByRole('button', { name: '确认充值' })).toBeDisabled()
  })
})
