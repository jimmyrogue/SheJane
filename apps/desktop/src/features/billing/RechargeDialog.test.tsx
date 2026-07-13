import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/shared/i18n/i18n'
import type { BillingCheckoutOptions, WalletBalance } from '@/shared/api/client'
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

const checkoutOptions: BillingCheckoutOptions = {
  currency: 'usd',
  min_amount: 1,
  max_amount: 500,
  credits_per_usd: 1_127_250,
  currency_per_credit: 0.000006,
  usd_cny_rate: 6.7635,
  presets: [
    { amount: 1, credits: 1_127_250 },
    { amount: 10, credits: 11_272_500 },
    { amount: 20, credits: 22_545_000 },
    { amount: 50, credits: 56_362_500 },
  ],
  amount_presets: [
    { amount: 1, credits: 1_127_250 },
    { amount: 10, credits: 11_272_500 },
    { amount: 20, credits: 22_545_000 },
    { amount: 50, credits: 56_362_500 },
  ],
  credit_presets: [
    { amount: 1, credits: 1_127_250 },
    { amount: 5, credits: 5_636_250 },
    { amount: 9, credits: 10_145_250 },
  ],
}

afterEach(cleanup)

function renderDialog(props: Partial<React.ComponentProps<typeof RechargeDialog>> = {}) {
  return render(
    <I18nProvider>
      <RechargeDialog
        open
        onOpenChange={vi.fn()}
        balance={balance}
        checkoutOptions={checkoutOptions}
        onConfirm={vi.fn()}
        {...props}
      />
    </I18nProvider>,
  )
}

describe('RechargeDialog', () => {
  it('shows token-first credit packs and the current balance', () => {
    renderDialog()

    expect(screen.getByRole('dialog', { name: '充值' })).toBeInTheDocument()
    expect(screen.getByText('当前余额 70,000 积分')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '积分包' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('可获得')).toBeInTheDocument()
    expect(screen.getByText('1,127,250')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '112.7万 积分 $1 USD' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '563.6万 积分 $5 USD' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '1014.5万 积分 $9 USD' })).toBeInTheDocument()
    expect(screen.getByText('Stripe Checkout · $1 USD / 1,127,250 积分')).toBeInTheDocument()
  })

  it('updates the checkout amount when a credit pack is selected', () => {
    renderDialog()

    fireEvent.click(screen.getByRole('button', { name: '563.6万 积分 $5 USD' }))
    expect(screen.getByText('5,636,250')).toBeInTheDocument()
    expect(screen.getByText('Stripe Checkout · $5 USD / 5,636,250 积分')).toBeInTheDocument()
  })

  it('derives token-first credit packs when the API omits credit presets', () => {
    renderDialog({ checkoutOptions: { ...checkoutOptions, credit_presets: undefined } })

    expect(screen.getByRole('button', { name: '112.7万 积分 $1 USD' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '563.6万 积分 $5 USD' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '1014.5万 积分 $9 USD' })).toBeInTheDocument()
  })

  it('passes the selected package amount to the checkout callback and closes', async () => {
    const onConfirm = vi.fn(async () => undefined)
    const onOpenChange = vi.fn()
    renderDialog({ onConfirm, onOpenChange })

    fireEvent.click(screen.getByRole('button', { name: '563.6万 积分 $5 USD' }))
    fireEvent.click(screen.getByRole('button', { name: '确认充值' }))
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith({ amount: 5 }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('supports manually entering an integer amount between 1 and 500', async () => {
    const onConfirm = vi.fn(async () => undefined)
    renderDialog({ onConfirm })

    fireEvent.click(screen.getByRole('button', { name: '手动金额' }))
    expect(screen.getByLabelText('金额（USD）')).toHaveValue(20)
    expect(screen.getByText('Stripe Checkout · $20 USD / 22,545,000 积分')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('金额（USD）'), { target: { value: '35' } })
    fireEvent.click(screen.getByRole('button', { name: '确认充值' }))
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith({ amount: 35 }))
  })

  it('requires a valid manually entered amount', () => {
    renderDialog()

    fireEvent.click(screen.getByRole('button', { name: '手动金额' }))
    fireEvent.change(screen.getByLabelText('金额（USD）'), { target: { value: '0' } })
    expect(screen.getByRole('button', { name: '确认充值' })).toBeDisabled()
    expect(screen.getByText('请输入 $1–$500 的整数金额')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('金额（USD）'), { target: { value: '10.5' } })
    expect(screen.getByRole('button', { name: '确认充值' })).toBeDisabled()
  })

  it('does not show fallback credits before checkout options load', () => {
    renderDialog({ checkoutOptions: null })

    expect(screen.getAllByText('读取积分换算中…').length).toBeGreaterThan(0)
    expect(screen.queryByText('50,000 积分')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '确认充值' })).toBeDisabled()
  })
})
