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

  it('renders overview first and switches feature tabs independently', async () => {
    mockFetch('admin')

    render(<App />)
    fireEvent.change(await screen.findByLabelText('邮箱'), { target: { value: 'admin@example.com' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByText('登录'))

    expect(await screen.findByText('运营概览')).toBeInTheDocument()
    expect((await screen.findAllByText('admin@example.com')).length).toBeGreaterThan(0)
    expect(screen.queryByText((content) => content.includes('order_1'))).not.toBeInTheDocument()
    expect(screen.queryByText((content) => content.includes('deepseek-v4-flash'))).not.toBeInTheDocument()

    selectAdminTab('订单')
    expect(await screen.findByText((content) => content.includes('order_1'))).toBeInTheDocument()
    expect(screen.queryByText('运营概览')).not.toBeInTheDocument()

    selectAdminTab('模型')
    expect(await screen.findByText((content) => content.includes('deepseek-v4-flash'))).toBeInTheDocument()
    expect(screen.queryByText((content) => content.includes('order_1'))).not.toBeInTheDocument()

    selectAdminTab('Agent')
    expect(await screen.findByText((content) => content.includes('run_1'))).toBeInTheDocument()
    expect(screen.queryByText((content) => content.includes('deepseek-v4-flash'))).not.toBeInTheDocument()

    selectAdminTab('工具')
    expect(await screen.findByText('web.search')).toBeInTheDocument()
    expect(await screen.findByText((content) => content.includes('tavily'))).toBeInTheDocument()
  })

  it('renders a dedicated admin shell with a refresh action', async () => {
    const calls = mockFetch('admin')

    render(<App />)
    fireEvent.change(await screen.findByLabelText('邮箱'), { target: { value: 'admin@example.com' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByText('登录'))

    expect(await screen.findByRole('heading', { name: '管理后台' })).toBeInTheDocument()
    const overviewCallsBeforeRefresh = calls.filter((call) => call.url.endsWith('/api/v1/admin/overview')).length
    fireEvent.click(screen.getByRole('button', { name: '刷新数据' }))
    expect(await screen.findByText('数据已刷新')).toBeInTheDocument()
    const overviewCallsAfterRefresh = calls.filter((call) => call.url.endsWith('/api/v1/admin/overview')).length
    expect(overviewCallsAfterRefresh).toBeGreaterThan(overviewCallsBeforeRefresh)
  })

  it('validates credit adjustment before calling the admin API', async () => {
    const calls = mockFetch('admin')

    render(<App />)
    fireEvent.change(await screen.findByLabelText('邮箱'), { target: { value: 'admin@example.com' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByText('登录'))
    await screen.findByText('运营概览')
    selectAdminTab('用户')

    // The list is a table; click a user row to open the detail dialog.
    fireEvent.click(await screen.findByRole('button', { name: 'admin@example.com' }))

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

  it('shows subscription ids in orders and renders audit logs read-only', async () => {
    mockFetch('admin')

    render(<App />)
    fireEvent.change(await screen.findByLabelText('邮箱'), { target: { value: 'admin@example.com' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByText('登录'))
    await screen.findByText('运营概览')

    selectAdminTab('订单')
    expect(await screen.findByText((content) => content.includes('sub_test_123'))).toBeInTheDocument()

    selectAdminTab('审计')
    expect(await screen.findByText('admin.user_status_update')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /删除|修改|重试/ })).not.toBeInTheDocument()
  })

  it('renders agent runs as a read-only operations view', async () => {
    mockFetch('admin')

    render(<App />)
    fireEvent.change(await screen.findByLabelText('邮箱'), { target: { value: 'admin@example.com' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByText('登录'))
    await screen.findByText('运营概览')

    selectAdminTab('Agent')
    expect(await screen.findByText((content) => content.includes('run_1'))).toBeInTheDocument()
    expect(screen.getByText('用户任务（18 字）')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /取消|重试|删除/ })).not.toBeInTheDocument()
  })

  it('shows wallet transactions inside the run trace dialog', async () => {
    mockFetch('admin')

    render(<App />)
    fireEvent.change(await screen.findByLabelText('邮箱'), { target: { value: 'admin@example.com' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByText('登录'))
    await screen.findByText('运营概览')

    selectAdminTab('Agent')
    fireEvent.click(await screen.findByRole('button', { name: '追踪' }))

    expect(await screen.findByText('Run Trace')).toBeInTheDocument()
    expect(await screen.findByText((content) => content.includes('usage_settle'))).toBeInTheDocument()
  })

  it('creates chat models with an arbitrary model id instead of fixed fast/deep slots', async () => {
    const calls = mockFetch('admin')

    render(<App />)
    fireEvent.change(await screen.findByLabelText('邮箱'), { target: { value: 'admin@example.com' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByText('登录'))
    await screen.findByText('运营概览')

    selectAdminTab('模型')
    fireEvent.click(await screen.findByText('新增模型'))

    const modelID = await screen.findByLabelText('模型 ID')
    expect(screen.getByText('常用模板')).toBeInTheDocument()
    expect(screen.queryByText('chat.fast · 快速对话模型')).not.toBeInTheDocument()
    expect(screen.queryByText('chat.deep · 深度对话模型')).not.toBeInTheDocument()

    fireEvent.change(modelID, { target: { value: 'gpt-4o' } })
    fireEvent.change(screen.getByLabelText('显示名'), { target: { value: 'GPT-4o' } })
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://api.openai.com/v1' } })
    fireEvent.change(screen.getByLabelText('上游模型名'), { target: { value: 'gpt-4o' } })
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-test' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    expect(await screen.findByText('模型配置已保存并即时生效')).toBeInTheDocument()
    const createCall = calls.find((call) => call.url.endsWith('/api/v1/admin/model-configs') && call.init?.method === 'POST')
    expect(createCall).toBeTruthy()
    expect(JSON.parse(String(createCall?.init?.body))).toMatchObject({
      slot: 'gpt-4o',
      capability: 'chat',
      display_name: 'GPT-4o',
      model_name: 'gpt-4o',
      input_credit_multiplier: 1,
      output_credit_multiplier: 1,
    })
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

function selectAdminTab(name: string) {
  // Navigation lives only in the sidebar now (the duplicated in-content tab
  // bar was removed); click the sidebar menu button.
  const item = screen.getByRole('button', { name })
  fireEvent.pointerDown(item)
  fireEvent.mouseDown(item)
  fireEvent.click(item)
}

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
    if (url.split('?')[0].endsWith('/api/v1/admin/users')) {
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
    if (url.split('?')[0].endsWith('/api/v1/admin/tool-calls')) {
      return jsonResponse({
        code: 0,
        message: 'ok',
        data: [
          {
            request_id: 'tool_req_1',
            user_id: 'admin-1',
            user_email: 'admin@example.com',
            wallet_id: 'wallet-1',
            reservation_id: 'res-1',
            run_id: 'run_1',
            tool_call_id: 'call-search-1',
            tool: 'web.search',
            provider: 'tavily',
            units: 1,
            credits_cost: 20,
            status: 'done',
            started_at: '2026-05-10T00:00:00Z',
            finished_at: '2026-05-10T00:00:01Z',
          },
        ],
      })
    }
    if (url.split('?')[0].endsWith('/api/v1/admin/orders')) {
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
            stripe_subscription_id: 'sub_test_123',
            plan_code: 'pro',
            wallet_status: 'active',
            idempotency_key: 'order-key',
            created_at: '2026-05-10T00:00:00Z',
          },
        ],
      })
    }
    if (url.endsWith('/api/v1/admin/agent-runs')) {
      return jsonResponse({
        code: 0,
        message: 'ok',
        data: [
          {
            id: 'run_1',
            user_id: 'user-1',
            user_email: 'user@example.com',
            origin: 'cloud',
            status: 'completed',
            mode: 'fast',
            goal_summary: '用户任务（18 字）',
            client_conversation_id: 'conv-1',
            client_message_id: 'msg-1',
            attachments: [],
            expires_at: '2026-05-17T00:00:00Z',
            created_at: '2026-05-10T00:00:00Z',
            updated_at: '2026-05-10T00:01:00Z',
          },
        ],
      })
    }
    if (url.endsWith('/api/v1/admin/agent-runs/run_1/trace')) {
      return jsonResponse({
        code: 0,
        message: 'ok',
        data: {
          run: {
            id: 'run_1',
            user_id: 'user-1',
            user_email: 'user@example.com',
            origin: 'cloud',
            status: 'completed',
            mode: 'fast',
            goal_summary: '用户任务（18 字）',
            expires_at: '2026-05-17T00:00:00Z',
            created_at: '2026-05-10T00:00:00Z',
            updated_at: '2026-05-10T00:01:00Z',
          },
          events: [
            {
              id: 'evt-1',
              run_id: 'run_1',
              seq: 1,
              event_type: 'run.completed',
              payload: {},
              created_at: '2026-05-10T00:01:00Z',
            },
          ],
          llm_calls: [],
          tool_calls: [],
          wallet_transactions: [
            {
              id: 'tx-1',
              wallet_id: 'wallet-1',
              reservation_id: 'res-1',
              type: 'usage_settle',
              amount: -8,
              monthly_used_after: 8,
              extra_balance_after: 0,
              description: 'settled actual model usage',
              idempotency_key: 'res-1:usage_settle',
              created_at: '2026-05-10T00:01:00Z',
            },
          ],
        },
      })
    }
    if (url.split('?')[0].endsWith('/api/v1/admin/audit-logs')) {
      return jsonResponse({
        code: 0,
        message: 'ok',
        data: [
          {
            id: 'audit_1',
            actor_user_id: 'admin-1',
            action: 'admin.user_status_update',
            target_type: 'user',
            target_id: 'user-1',
            metadata: '{"status":"disabled","reason":"support"}',
            created_at: '2026-05-10T00:00:00Z',
          },
        ],
      })
    }
    if (url.split('?')[0].endsWith('/api/v1/admin/model-configs')) {
      return jsonResponse({
        code: 0,
        message: 'ok',
        data: [
          {
            id: 'mc_1',
            slot: 'chat.fast',
            capability: 'chat',
            provider_kind: 'deepseek-v4',
            display_name: 'deepseek-fast',
            base_url: 'https://api.deepseek.com',
            model_name: 'deepseek-v4-flash',
            credit_multiplier: 1,
            input_credit_multiplier: 0.1,
            output_credit_multiplier: 0.1,
            cached_input_credit_multiplier: 0,
            cache_write_credit_multiplier: 0.1,
            price_per_call_cny: 0,
            enabled: true,
            params: {},
            api_key_configured: true,
            updated_at: '2026-05-10T00:00:00Z',
          },
        ],
      })
    }
    if (url.endsWith('/api/v1/admin/settings/credit-rate')) {
      return jsonResponse({
        code: 0,
        message: 'ok',
        data: { markup_factor: 1.15, currency_per_credit: 0.0001, currency: 'cny', configured: true },
      })
    }
    if (url.endsWith('/api/v1/admin/settings/billing-levers')) {
      return jsonResponse({
        code: 0,
        message: 'ok',
        data: {
          tavily_search_credits: 20,
          e2b_code_exec_base_credits: 5,
          e2b_code_exec_per_second_credits: 1,
          configured: true,
        },
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
