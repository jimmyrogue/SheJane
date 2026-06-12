import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/shared/i18n/i18n'
import type { WalletTransaction } from '@/shared/api/client'
import { SpendHistoryDialog } from './SpendHistoryDialog'

afterEach(cleanup)

function tx(overrides: Partial<WalletTransaction> = {}): WalletTransaction {
  return {
    id: 't1',
    wallet_id: 'w1',
    type: 'usage_settle',
    amount: -12,
    monthly_used_after: 12,
    extra_balance_after: 0,
    description: '模型调用',
    created_at: '2026-06-01T08:00:00Z',
    ...overrides,
  }
}

function renderDialog(fetchTransactions: () => Promise<WalletTransaction[]>) {
  return render(
    <I18nProvider>
      <SpendHistoryDialog open onOpenChange={vi.fn()} fetchTransactions={fetchTransactions} />
    </I18nProvider>,
  )
}

describe('SpendHistoryDialog', () => {
  it('lists transactions with a type label and signed amount', async () => {
    renderDialog(async () => [
      tx({ id: 'a', type: 'usage_settle', amount: -12 }),
      tx({ id: 'b', type: 'subscription_grant', amount: 9000, description: '月度订阅' }),
    ])

    expect(await screen.findByText('消耗')).toBeInTheDocument()
    expect(screen.getByText('订阅发放')).toBeInTheDocument()
    expect(screen.getByText('-12')).toBeInTheDocument()
    expect(screen.getByText('+9,000')).toBeInTheDocument()
    expect(screen.getByText('近 30 天消费')).toBeInTheDocument()
    expect(screen.getByText('导出账单')).toBeInTheDocument()
  })

  it('filters usage and top-up rows', async () => {
    renderDialog(async () => [
      tx({ id: 'a', type: 'usage_settle', amount: -12 }),
      tx({ id: 'b', type: 'subscription_grant', amount: 9000, description: '月度订阅' }),
    ])

    expect(await screen.findByText('消耗')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '充值' }))
    expect(screen.queryByText('消耗')).not.toBeInTheDocument()
    expect(screen.getByText('订阅发放')).toBeInTheDocument()
  })

  it('shows an empty state when there are no transactions', async () => {
    renderDialog(async () => [])
    expect(await screen.findByText('还没有任何消费记录。')).toBeInTheDocument()
  })

  it('shows an error state when the fetch fails', async () => {
    renderDialog(async () => {
      throw new Error('boom')
    })
    await waitFor(() => expect(screen.getByText('消费记录加载失败,请稍后再试。')).toBeInTheDocument())
  })

  it('falls back to the raw type for unknown ledger types', async () => {
    renderDialog(async () => [tx({ id: 'c', type: 'mystery_type', amount: 5 })])
    expect(await screen.findByText('mystery_type')).toBeInTheDocument()
  })
})
