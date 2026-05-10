import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'

const balance = {
  id: 'wallet-1',
  plan_code: 'free_trial',
  monthly_credit_limit: 10000,
  monthly_credits_used: 0,
  monthly_remaining: 10000,
  extra_credits_balance: 0,
  period_end: '2026-06-10T00:00:00Z',
  status: 'active',
}

describe('admin web app', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('renders overview, users, orders, and providers for admins after login', async () => {
    mockFetch('admin')

    render(<App />)
    fireEvent.change(await screen.findByLabelText('邮箱'), { target: { value: 'admin@example.com' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByText('登录'))

    expect(await screen.findByText('运营概览')).toBeInTheDocument()
    expect((await screen.findAllByText('admin@example.com')).length).toBeGreaterThan(0)
    expect(await screen.findByText((content) => content.includes('order_1'))).toBeInTheDocument()
    expect(await screen.findByText((content) => content.includes('deepseek-v4-flash'))).toBeInTheDocument()
  })

  it('validates credit adjustment before calling the admin API', async () => {
    const calls = mockFetch('admin')

    render(<App />)
    fireEvent.change(await screen.findByLabelText('邮箱'), { target: { value: 'admin@example.com' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByText('登录'))
    await screen.findByText('运营概览')

    const adjustButton = await screen.findByText('调整额度')
    fireEvent.click(adjustButton)
    expect(await screen.findByText('额度调整不能为 0')).toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText('额外额度调整，例如 1000 或 -500'), { target: { value: '100' } })
    fireEvent.click(adjustButton)
    expect(await screen.findByText('请填写操作原因')).toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText('操作原因'), { target: { value: 'manual grant' } })
    fireEvent.click(adjustButton)
    expect(await screen.findByText('额外额度已调整')).toBeInTheDocument()
    expect(calls.some((call) => call.url.endsWith('/api/v1/admin/users/admin-1/credits/adjust'))).toBe(true)
  })

  it('blocks non-admin users from loading admin data', async () => {
    const calls = mockFetch('user')

    render(<App />)
    fireEvent.change(await screen.findByLabelText('邮箱'), { target: { value: 'user@example.com' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByText('登录'))

    expect(await screen.findByText('无管理员权限')).toBeInTheDocument()
    expect(calls.some((call) => call.url.includes('/api/v1/admin/'))).toBe(false)
  })
})

function mockFetch(role: 'admin' | 'user') {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input)
    calls.push({ url, init })
    if (url.endsWith('/api/v1/auth/refresh')) {
      return jsonResponse({ code: 40001, message: '未登录', data: null }, 401)
    }
    if (url.endsWith('/api/v1/auth/login')) {
      return jsonResponse({
        code: 0,
        message: 'ok',
        data: {
          access_token: `${role}-token`,
          user: {
            id: `${role}-1`,
            email: `${role}@example.com`,
            name: role,
            role,
            status: 'active',
          },
        },
      })
    }
    if (url.endsWith('/api/v1/auth/logout')) {
      return jsonResponse({ code: 0, message: 'ok', data: { logged_out: true } })
    }
    if (url.endsWith('/api/v1/admin/overview')) {
      return jsonResponse({
        code: 0,
        message: 'ok',
        data: {
          users_total: 2,
          active_users: 2,
          disabled_users: 0,
          llm_calls_total: 3,
          llm_calls_failed: 0,
          credits_cost_total: 1200,
          orders_total: 1,
        },
      })
    }
    if (url.endsWith('/api/v1/admin/users')) {
      return jsonResponse({
        code: 0,
        message: 'ok',
        data: [
          {
            user: {
              id: 'admin-1',
              email: 'admin@example.com',
              name: 'Admin',
              role: 'admin',
              status: 'active',
              created_at: '2026-05-10T00:00:00Z',
            },
            wallet: balance,
            calls_count: 3,
            credits_cost: 1200,
          },
        ],
      })
    }
    if (url.endsWith('/api/v1/admin/users/admin-1')) {
      return jsonResponse({
        code: 0,
        message: 'ok',
        data: {
          user: {
            id: 'admin-1',
            email: 'admin@example.com',
            name: 'Admin',
            role: 'admin',
            status: 'active',
            created_at: '2026-05-10T00:00:00Z',
          },
          wallet: balance,
          calls: [],
          orders: [],
          transactions: [],
        },
      })
    }
    if (url.endsWith('/api/v1/admin/users/admin-1/credits/adjust')) {
      return jsonResponse({ code: 0, message: 'ok', data: { ...balance, extra_credits_balance: 100 } })
    }
    if (url.endsWith('/api/v1/admin/llm-calls')) {
      return jsonResponse({ code: 0, message: 'ok', data: [] })
    }
    if (url.endsWith('/api/v1/admin/orders')) {
      return jsonResponse({
        code: 0,
        message: 'ok',
        data: [
          {
            id: 'order_1',
            wallet_id: 'wallet-1',
            user_id: 'admin-1',
            user_email: 'admin@example.com',
            type: 'subscription',
            amount_cny: 3900,
            status: 'pending',
            checkout_url: '',
            stripe_checkout_session_id: 'cs_test_1',
            idempotency_key: 'order-key',
            created_at: '2026-05-10T00:00:00Z',
          },
        ],
      })
    }
    if (url.endsWith('/api/v1/admin/providers')) {
      return jsonResponse({
        code: 0,
        message: 'ok',
        data: [
          {
            mode: 'fast',
            provider: 'deepseek-fast',
            base_url: 'https://api.deepseek.com',
            model: 'deepseek-v4-flash',
            mock: false,
            api_key_configured: true,
          },
        ],
      })
    }
    throw new Error(`Unexpected fetch ${url}`)
  })
  return calls
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
