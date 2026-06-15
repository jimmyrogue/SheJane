import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { I18nProvider } from '@/shared/i18n/i18n'
import type { BillingActivity, WalletTransaction } from '@/shared/api/client'
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

function activity(overrides: Partial<BillingActivity> = {}): BillingActivity {
  const transactions = overrides.transactions ?? [tx()]
  return {
    id: 'activity-1',
    kind: 'ledger',
    reserved_credits: 0,
    settled_credits: 0,
    released_credits: 0,
    net_credits: 0,
    llm_calls: [],
    tool_calls: [],
    transactions,
    created_at: transactions[0]?.created_at ?? '2026-06-01T08:00:00Z',
    updated_at: transactions[0]?.created_at ?? '2026-06-01T08:00:00Z',
    ...overrides,
  }
}

function renderDialog(
  fetchActivities: () => Promise<BillingActivity[]>,
  props: Partial<ComponentProps<typeof SpendHistoryDialog>> = {},
) {
  return render(
    <I18nProvider>
      <SpendHistoryDialog open onOpenChange={vi.fn()} fetchActivities={fetchActivities} {...props} />
    </I18nProvider>,
  )
}

describe('SpendHistoryDialog', () => {
  it('groups a run with reserved, actual, refund, and summary counts without detailed records', async () => {
    const now = new Date().toISOString()
    renderDialog(async () => [
      activity({
        id: 'run:run_6670d0df3951463ea7af7ec243257941',
        kind: 'usage',
        run_id: 'run_6670d0df3951463ea7af7ec243257941',
        reserved_credits: 22_771,
        settled_credits: 5_847,
        released_credits: 16_924,
        net_credits: 5_847,
        llm_calls: [
          {
            request_id: 'req-claude',
            user_id: 'u1',
            wallet_id: 'w1',
            reservation_id: 'res-claude',
            run_id: 'run_6670d0df3951463ea7af7ec243257941',
            mode: 'claude-opus-4-8',
            scene: 'agent_local',
            model: 'claude-opus-4-8',
            provider: 'anthropic-claude',
            input_tokens: 0,
            output_tokens: 0,
            credits_cost: 0,
            status: 'failed',
            error_message: 'temperature is not supported',
            started_at: '2026-06-14T10:52:31.675404Z',
          },
          {
            request_id: 'req-deepseek',
            user_id: 'u1',
            wallet_id: 'w1',
            reservation_id: 'res-deepseek',
            run_id: 'run_6670d0df3951463ea7af7ec243257941',
            mode: 'deepseek-v4-flash',
            scene: 'agent_local',
            model: 'deepseek-v4-flash',
            provider: 'deepseek-v4',
            input_tokens: 1000,
            output_tokens: 500,
            credits_cost: 5_827,
            status: 'done',
            started_at: '2026-06-14T10:52:31.952557Z',
          },
        ],
        tool_calls: [
          {
            request_id: 'req-tool',
            user_id: 'u1',
            wallet_id: 'w1',
            reservation_id: 'res-tool',
            run_id: 'run_6670d0df3951463ea7af7ec243257941',
            tool_call_id: 'call-search',
            tool: 'web.search',
            provider: 'tavily',
            units: 1,
            credits_cost: 20,
            status: 'done',
            started_at: '2026-06-14T10:52:33Z',
          },
        ],
        transactions: [
          tx({ id: 'reserve', type: 'usage_reserve', amount: -22_451, reservation_id: 'res-deepseek' }),
          tx({ id: 'settle', type: 'usage_settle', amount: -5_827, reservation_id: 'res-deepseek' }),
          tx({ id: 'tool-settle', type: 'usage_settle', amount: -20, reservation_id: 'res-tool' }),
        ],
        created_at: now,
        updated_at: now,
      }),
    ])

    expect(await screen.findByText('对话使用 · deepseek-v4/deepseek-v4-flash')).toBeInTheDocument()
    expect(screen.getByText('近 30 天实际消耗')).toBeInTheDocument()
    expect(screen.getAllByText('5,847')).toHaveLength(2)
    expect(screen.getByText('22,771')).toBeInTheDocument()
    expect(screen.getByText('16,924')).toBeInTheDocument()
    expect(screen.getByText(/2 个模型/)).toBeInTheDocument()
    expect(screen.getByText(/1 个工具/)).toBeInTheDocument()
    expect(screen.queryByText('模型 anthropic-claude/claude-opus-4-8 · 失败')).not.toBeInTheDocument()
    expect(screen.queryByText('模型 deepseek-v4/deepseek-v4-flash · 完成 · 5,827')).not.toBeInTheDocument()
    expect(screen.queryByText('工具 web.search/tavily · 完成 · 20')).not.toBeInTheDocument()
    expect(screen.getByText('-5,847')).toBeInTheDocument()
    expect(screen.getByText('导出账单')).toBeInTheDocument()
  })

  it('counts recent spend from the last 30 days only', async () => {
    const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString()
    renderDialog(async () => [
      activity({
        id: 'run:recent',
        kind: 'usage',
        settled_credits: 12,
        transactions: [tx({ id: 'recent', type: 'usage_settle', amount: -12 })],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }),
      activity({
        id: 'run:old',
        kind: 'usage',
        settled_credits: 99,
        transactions: [tx({ id: 'old', type: 'usage_settle', amount: -99, created_at: oldDate })],
        created_at: oldDate,
        updated_at: oldDate,
      }),
    ])

    expect(await screen.findByText('近 30 天实际消耗')).toBeInTheDocument()
    expect(screen.getAllByText('12')).toHaveLength(2)
    expect(screen.queryByText('111')).not.toBeInTheDocument()
  })

  it('filters usage and top-up rows', async () => {
    renderDialog(async () => [
      activity({
        id: 'run:usage',
        kind: 'usage',
        settled_credits: 12,
        transactions: [tx({ id: 'a', type: 'usage_settle', amount: -12 })],
      }),
      activity({
        id: 'tx:grant',
        transactions: [tx({ id: 'b', type: 'subscription_grant', amount: 9000, description: '月度订阅' })],
      }),
    ])

    expect(await screen.findByText('对话使用')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '充值' }))
    expect(screen.queryByText('对话使用')).not.toBeInTheDocument()
    expect(screen.getByText('订阅发放')).toBeInTheDocument()
  })

  it('can open directly on the top-up filter', async () => {
    renderDialog(async () => [
      activity({
        id: 'run:usage',
        kind: 'usage',
        settled_credits: 12,
        transactions: [tx({ id: 'a', type: 'usage_settle', amount: -12 })],
      }),
      activity({
        id: 'tx:grant',
        transactions: [tx({ id: 'b', type: 'recharge_grant', amount: 9000, description: 'Stripe Checkout credits purchased' })],
      }),
    ], { initialFilter: 'topup' })

    expect(await screen.findByText('充值到账')).toBeInTheDocument()
    expect(screen.queryByText('对话使用')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '充值' })).toHaveAttribute('aria-pressed', 'true')
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
    renderDialog(async () => [activity({ id: 'tx:mystery', transactions: [tx({ id: 'c', type: 'mystery_type', amount: 5 })] })])
    expect(await screen.findByText('mystery_type')).toBeInTheDocument()
  })
})
