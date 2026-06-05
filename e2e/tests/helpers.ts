import type { Page, Route } from '@playwright/test'

export const clientURL = process.env.E2E_CLIENT_URL ?? `http://127.0.0.1:${process.env.E2E_CLIENT_PORT ?? '55173'}`
export const adminURL = process.env.E2E_ADMIN_URL ?? `http://127.0.0.1:${process.env.E2E_ADMIN_PORT ?? '55174'}`

export interface RecordedRequest {
  url: string
  method: string
  body?: string
}

export interface MockState {
  requests: RecordedRequest[]
  localWorkspaces: Array<{ id: string; path: string; label: string }>
}

const balance = {
  id: 'wallet-1',
  plan_code: 'free_trial',
  monthly_credit_limit: 10000,
  monthly_credits_used: 20,
  monthly_remaining: 9980,
  extra_credits_balance: 0,
  period_end: '2026-06-10T00:00:00Z',
  status: 'active',
}

export async function installClientMocks(page: Page, options: { localHost?: boolean; recentRun?: boolean } = {}): Promise<MockState> {
  const state: MockState = { requests: [], localWorkspaces: [] }

  if (options.localHost) {
    await page.addInitScript({
      content: `
        window.shejaneDesktop = {
          platform: 'darwin',
          localHost: {
            baseURL: 'http://127.0.0.1:17371',
            token: 'local-token'
          },
          selectWorkspaceDirectory: async () => '/tmp/picked-workspace'
        };
      `,
    })
  }

  await page.route('**/api/v1/**', async (route) => {
    await handleAPI(route, state, 'user')
  })
  await page.route('https://s3.example.com/upload', async (route) => {
    state.requests.push({ url: route.request().url(), method: route.request().method(), body: route.request().postData() ?? undefined })
    await route.fulfill({ status: 200, headers: corsHeaders() })
  })
  await page.route('**/local/v1/**', async (route) => {
    await handleLocalHost(route, state, options)
  })

  return state
}

export async function installAdminMocks(page: Page, role: 'admin' | 'user' = 'admin'): Promise<MockState> {
  const state: MockState = { requests: [] }
  await page.route('**/api/v1/**', async (route) => {
    await handleAPI(route, state, role)
  })
  return state
}

async function handleAPI(route: Route, state: MockState, role: 'admin' | 'user'): Promise<void> {
  const request = route.request()
  const url = request.url()
  state.requests.push({ url, method: request.method(), body: request.postData() ?? undefined })
  if (request.method() === 'OPTIONS') {
    await route.fulfill({ status: 204, headers: corsHeaders(route) })
    return
  }

  if (url.endsWith('/api/v1/auth/refresh')) {
    await json(route, { code: 40001, message: '未登录', data: null }, 401)
    return
  }
  if (url.endsWith('/api/v1/auth/register') || url.endsWith('/api/v1/auth/login')) {
    await json(route, {
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
    return
  }
  if (url.endsWith('/api/v1/auth/logout')) {
    await json(route, { code: 0, message: 'ok', data: { logged_out: true } })
    return
  }
  if (url.endsWith('/api/v1/billing/balance')) {
    await json(route, { code: 0, message: 'ok', data: balance })
    return
  }
  if (url.endsWith('/api/v1/documents')) {
    await json(route, {
      code: 0,
      message: 'ok',
      data: [
        {
          id: 'doc-ready',
          user_id: `${role}-1`,
          original_name: 'roadmap.pdf',
          content_type: 'application/pdf',
          size_bytes: 1024,
          status: 'ready',
          source_object_key: 'documents/user/doc-ready/source.pdf',
          text_object_key: 'documents/user/doc-ready/extracted.txt',
          expires_at: '2026-05-17T00:00:00Z',
          created_at: '2026-05-10T00:00:00Z',
          updated_at: '2026-05-10T00:00:00Z',
        },
      ],
    })
    return
  }
  if (url.endsWith('/api/v1/documents/uploads')) {
    await json(route, {
      code: 0,
      message: 'ok',
      data: {
        document: {
          id: 'doc-upload',
          user_id: `${role}-1`,
          original_name: 'brief.docx',
          content_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          size_bytes: 5,
          status: 'uploading',
          source_object_key: 'documents/user/doc-upload/source.docx',
          expires_at: '2026-05-17T00:00:00Z',
          created_at: '2026-05-10T00:00:00Z',
          updated_at: '2026-05-10T00:00:00Z',
        },
        upload: {
          method: 'PUT',
          url: 'https://s3.example.com/upload',
          headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
          expires_at: '2026-05-10T01:00:00Z',
        },
      },
    })
    return
  }
  if (url.endsWith('/api/v1/documents/doc-upload/complete')) {
    await json(route, {
      code: 0,
      message: 'ok',
      data: {
        id: 'doc-upload',
        user_id: `${role}-1`,
        original_name: 'brief.docx',
        content_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        size_bytes: 5,
        status: 'ready',
        source_object_key: 'documents/user/doc-upload/source.docx',
        text_object_key: 'documents/user/doc-upload/extracted.txt',
        expires_at: '2026-05-17T00:00:00Z',
        created_at: '2026-05-10T00:00:00Z',
        updated_at: '2026-05-10T00:00:00Z',
      },
    })
    return
  }
  if (url.endsWith('/api/v1/chat/completions')) {
    await sse(route, 'data: {"choices":[{"delta":{"content":"普通回答"}}]}\n\ndata: [DONE]\n\n')
    return
  }
  if (url.endsWith('/api/v1/agent/runs')) {
    const body = safeJSON(route.request().postData() ?? '{}') as {
      attachments?: Array<unknown>
      goal?: string
    }
    const hasAttachments = Boolean(body.attachments?.length)
    const runID = hasAttachments ? 'run-doc' : 'run-chat'
    await json(route, {
      code: 0,
      message: 'ok',
      data: {
        id: runID,
        user_id: `${role}-1`,
        origin: 'cloud',
        status: 'queued',
        mode: 'fast',
        goal_summary: hasAttachments ? '用户任务（12 字，含附件 1 个）' : body.goal ?? '普通对话',
        expires_at: '2026-05-17T00:00:00Z',
        created_at: '2026-05-10T00:00:00Z',
        updated_at: '2026-05-10T00:00:00Z',
      },
    }, 201)
    return
  }
  if (url.endsWith('/api/v1/agent/runs/run-chat/stream')) {
    await agentSSE(route, [
      { event_type: 'llm.delta', payload: { content: '普通回答' } },
      { event_type: 'run.completed', payload: { request_id: 'req-chat-1', credits_cost: 12 } },
    ], 'run-chat')
    return
  }
  if (url.endsWith('/api/v1/agent/runs/run-doc/stream')) {
    await agentSSE(route, [
      { event_type: 'skill.selected', payload: { skill: 'document-analysis' } },
      { event_type: 'tool.completed', payload: { tool: 'document.read' } },
      { event_type: 'llm.delta', payload: { content: '文档回答' } },
      { event_type: 'run.completed', payload: { request_id: 'req-doc-1', credits_cost: 18 } },
    ])
    return
  }

  await handleAdminAPI(route, role)
}

async function handleAdminAPI(route: Route, role: 'admin' | 'user'): Promise<void> {
  const url = route.request().url()
  if (role !== 'admin' && url.includes('/api/v1/admin/')) {
    await json(route, { code: 40301, message: '无管理员权限', data: null }, 403)
    return
  }
  if (url.endsWith('/api/v1/admin/overview')) {
    await json(route, { code: 0, message: 'ok', data: { users_total: 2, active_users: 2, disabled_users: 0, llm_calls_total: 3, llm_calls_failed: 0, credits_cost_total: 1200, orders_total: 1 } })
    return
  }
  if (url.endsWith('/api/v1/admin/users')) {
    await json(route, { code: 0, message: 'ok', data: [{ user: { id: 'admin-1', email: 'admin@example.com', name: 'Admin', role: 'admin', status: 'active', created_at: '2026-05-10T00:00:00Z' }, wallet: balance, calls_count: 3, credits_cost: 1200 }] })
    return
  }
  if (url.endsWith('/api/v1/admin/users/admin-1')) {
    await json(route, { code: 0, message: 'ok', data: { user: { id: 'admin-1', email: 'admin@example.com', name: 'Admin', role: 'admin', status: 'active', created_at: '2026-05-10T00:00:00Z' }, wallet: balance, calls: [], orders: [], transactions: [] } })
    return
  }
  if (url.endsWith('/api/v1/admin/users/admin-1/credits/adjust')) {
    await json(route, { code: 0, message: 'ok', data: { ...balance, extra_credits_balance: 100 } })
    return
  }
  if (url.endsWith('/api/v1/admin/llm-calls')) {
    await json(route, { code: 0, message: 'ok', data: [{ request_id: 'req-1', user_id: 'user-1', user_email: 'user@example.com', mode: 'fast', scene: 'agent', model: 'deepseek-v4-flash', provider: 'deepseek', input_tokens: 12, output_tokens: 18, credits_cost: 30, status: 'completed', started_at: '2026-05-10T00:00:00Z' }] })
    return
  }
  if (url.endsWith('/api/v1/admin/tool-calls')) {
    await json(route, { code: 0, message: 'ok', data: [{ request_id: 'tool-req-1', user_id: 'user-1', user_email: 'user@example.com', wallet_id: 'wallet-1', reservation_id: 'res-1', run_id: 'run_1', tool_call_id: 'call-search-1', tool: 'web.search', provider: 'tavily', units: 1, credits_cost: 20, status: 'done', started_at: '2026-05-10T00:00:00Z', finished_at: '2026-05-10T00:00:01Z' }] })
    return
  }
  if (url.endsWith('/api/v1/admin/orders')) {
    await json(route, { code: 0, message: 'ok', data: [{ id: 'order_1', wallet_id: 'wallet-1', user_id: 'admin-1', user_email: 'admin@example.com', type: 'subscription', amount_cny: 3900, status: 'pending', checkout_url: '', stripe_checkout_session_id: 'cs_test_1', stripe_subscription_id: 'sub_test_123', plan_code: 'pro', wallet_status: 'active', idempotency_key: 'order-key', created_at: '2026-05-10T00:00:00Z' }] })
    return
  }
  if (url.endsWith('/api/v1/admin/providers')) {
    await json(route, { code: 0, message: 'ok', data: [{ mode: 'fast', provider: 'deepseek', kind: 'deepseek-v4', base_url: 'https://api.deepseek.com', model: 'deepseek-v4-flash', mock: false, api_key_configured: true }] })
    return
  }
  if (url.endsWith('/api/v1/admin/agent-runs')) {
    await json(route, { code: 0, message: 'ok', data: [{ id: 'run_1', user_id: 'user-1', user_email: 'user@example.com', origin: 'cloud', status: 'completed', mode: 'fast', goal_summary: '用户任务（18 字）', expires_at: '2026-05-17T00:00:00Z', created_at: '2026-05-10T00:00:00Z', updated_at: '2026-05-10T00:00:00Z' }] })
    return
  }
  if (url.endsWith('/api/v1/admin/audit-logs')) {
    await json(route, { code: 0, message: 'ok', data: [{ id: 'audit-1', actor_user_id: 'admin-1', action: 'admin.user_status_update', target_type: 'user', target_id: 'user-1', metadata: '{}', created_at: '2026-05-10T00:00:00Z' }] })
    return
  }
  await json(route, { code: 404, message: `Unhandled admin mock: ${url}`, data: null }, 404)
}

async function handleLocalHost(route: Route, state: MockState, options: { recentRun?: boolean }): Promise<void> {
  const request = route.request()
  const url = request.url()
  state.requests.push({ url, method: request.method(), body: request.postData() ?? undefined })
  if (request.method() === 'OPTIONS') {
    await route.fulfill({ status: 204, headers: corsHeaders(route) })
    return
  }
  if (url.endsWith('/local/v1/health')) {
    await rawJSON(route, { status: 'ok', mode: 'daemon', worker: 'user' })
    return
  }
  if (url.endsWith('/local/v1/session') && request.method() === 'POST') {
    await rawJSON(route, {
      connected: true,
      cloud_base_url: 'http://localhost:8080',
      auth: 'bearer',
      updated_at: '2026-05-11T00:00:00Z',
    })
    return
  }
  if (url.endsWith('/local/v1/session') && request.method() === 'DELETE') {
    await rawJSON(route, { connected: false })
    return
  }
  if (url.endsWith('/local/v1/workspaces/diagnose')) {
    const body = safeJSON(request.postData() ?? '{}') as { path?: string }
    const workspace = state.localWorkspaces.find((item) => item.path === body.path)
    await rawJSON(route, {
      path: body.path,
      exists: true,
      is_directory: true,
      authorized: Boolean(workspace),
      reason: workspace ? 'authorized' : 'not_authorized',
      workspace,
    })
    return
  }
  if (url.endsWith('/local/v1/workspaces') && request.method() === 'POST') {
    const body = safeJSON(request.postData() ?? '{}') as { path?: string }
    const path = body.path ?? ''
    const workspace = {
      id: `workspace-${state.localWorkspaces.length + 1}`,
      path,
      label: path.split('/').filter(Boolean).at(-1) ?? path,
    }
    state.localWorkspaces = [workspace, ...state.localWorkspaces.filter((item) => item.path !== path)]
    await rawJSON(route, { ...workspace, created_at: '2026-05-11T00:00:00Z', last_used_at: '2026-05-11T00:00:00Z' }, 201)
    return
  }
  if (url.endsWith('/local/v1/workspaces')) {
    await rawJSON(route, { workspaces: state.localWorkspaces })
    return
  }
  if (url.endsWith('/local/v1/runs') && request.method() === 'POST') {
    await rawJSON(route, { id: 'local-run', goal: '运行本地检查', status: 'queued', created_at: '2026-05-11T00:00:00Z', updated_at: '2026-05-11T00:00:00Z' }, 201)
    return
  }
  if (url.endsWith('/local/v1/runs')) {
    await rawJSON(route, {
      runs: options.recentRun
        ? [{ id: 'recover-run', goal: 'Resume workspace scan', status: 'running', created_at: '2026-05-11T00:00:00Z', updated_at: '2026-05-11T00:00:01Z', events_count: 2 }]
        : [],
    })
    return
  }
  if (url.endsWith('/local/v1/runs/local-run/stream')) {
    const permissionApproved = state.requests.some((entry) => entry.url.endsWith('/local/v1/permissions/perm-shell'))
    await localAgentSSE(route, permissionApproved
      ? [
          { id: 'local-event-1', event_type: 'permission.required', payload: { request_id: 'perm-shell', tool: 'shell.run' } },
          { id: 'local-event-2', event_type: 'permission.resolved', payload: { request_id: 'perm-shell', decision: 'approve', tool: 'shell.run' } },
          { id: 'local-event-3', event_type: 'artifact.created', payload: { artifact_id: 'artifact-shell', title: 'shell output', tool: 'shell.run' } },
          { id: 'local-event-4', event_type: 'source.collected', payload: { title: 'Example Source', url: 'https://example.com/source', artifact_id: 'artifact-shell', tool: 'browser.read' } },
          { id: 'local-event-5', event_type: 'verification.completed', payload: { tool: 'shell.run', status: 'passed' } },
          { id: 'local-event-6', event_type: 'llm.delta', payload: { content: '本地执行完成' } },
          { id: 'local-event-7', event_type: 'run.completed', payload: { final: '本地执行完成' } },
        ]
      : [
          { id: 'local-event-1', event_type: 'permission.required', payload: { request_id: 'perm-shell', tool: 'shell.run' } },
          { id: 'local-event-3', event_type: 'artifact.created', payload: { artifact_id: 'artifact-shell', title: 'shell output', tool: 'shell.run' } },
        ], 'local-run')
    return
  }
  if (url.endsWith('/local/v1/permissions/perm-shell')) {
    await rawJSON(route, { status: 'recorded' }, 202)
    return
  }
  if (url.endsWith('/local/v1/artifacts/artifact-shell')) {
    await rawJSON(route, { id: 'artifact-shell', title: 'shell output', content: 'artifact preview content', tool_name: 'shell.run', created_at: '2026-05-11T00:00:00Z' })
    return
  }
  if (url.endsWith('/local/v1/runs/local-run/diagnostics')) {
    await rawJSON(route, {
      schema_version: 1,
      exported_at: '2026-05-11T00:00:03Z',
      run: { id: 'local-run', goal: '运行本地检查', status: 'completed', created_at: '2026-05-11T00:00:00Z', updated_at: '2026-05-11T00:00:03Z' },
      events: [
        { id: 'diag-event-1', event_type: 'source.collected', payload: { title: 'Example Source', url: 'https://example.com/source' } },
        { id: 'diag-event-2', event_type: 'verification.completed', payload: { tool: 'browser.verify', status: 'passed' } },
        { id: 'diag-event-3', event_type: 'tool.failed', payload: { tool: 'browser.open', error_code: 'browser_http_error' } },
      ],
      permissions: [{ id: 'perm-shell', run_id: 'local-run', tool_call_id: 'call-shell', tool_name: 'shell.run', arguments: { command: 'printf ok' }, status: 'approved', scope: 'once', created_at: '2026-05-11T00:00:01Z', resolved_at: '2026-05-11T00:00:02Z' }],
      artifacts: [{ id: 'artifact-shell', run_id: 'local-run', kind: 'tool_output', title: 'shell output', content_type: 'text/plain', bytes: 22, tool_name: 'shell.run', created_at: '2026-05-11T00:00:02Z' }],
      latest_checkpoint: { id: 'checkpoint-local', step: 2, reason: 'permission_resolved', messages_count: 4 },
    })
    return
  }
  if (url.endsWith('/local/v1/runs/recover-run/stream')) {
    await localAgentSSE(route, [
      { id: 'recover-event-1', event_type: 'checkpoint.resumed', payload: { checkpoint_id: 'checkpoint-1', reason: 'test_resume' } },
      { id: 'recover-event-2', event_type: 'llm.delta', payload: { content: '恢复后的本地结果' } },
      { id: 'recover-event-3', event_type: 'run.completed', payload: { final: '恢复后的本地结果' } },
    ], 'recover-run')
    return
  }
  if (url.endsWith('/local/v1/runs/recover-run/diagnostics')) {
    await rawJSON(route, { schema_version: 1, exported_at: '2026-05-11T00:00:02Z', run: { id: 'recover-run', goal: 'Resume workspace scan', status: 'running' }, events: [], permissions: [], artifacts: [], latest_checkpoint: { id: 'checkpoint-1', step: 1, reason: 'test_resume', messages_count: 3 } })
    return
  }
  await rawJSON(route, { error: `Unhandled local mock: ${url}` }, 404)
}

export function requestWasMade(state: MockState, urlPart: string): boolean {
  return state.requests.some((request) => request.url.includes(urlPart))
}

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await rawJSON(route, body, status)
}

async function rawJSON(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    headers: { ...corsHeaders(route), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function sse(route: Route, body: string): Promise<void> {
  await route.fulfill({
    status: 200,
    headers: { ...corsHeaders(route), 'Content-Type': 'text/event-stream', 'X-Request-ID': 'req-e2e' },
    body,
  })
}

async function agentSSE(route: Route, events: Array<{ event_type: string; payload: Record<string, unknown> }>, runID = 'run-doc'): Promise<void> {
  await localAgentSSE(route, events.map((event, index) => ({ id: `event-${index}`, ...event })), runID, 'agent.event')
}

function safeJSON(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return {}
  }
}

async function localAgentSSE(route: Route, events: Array<{ id: string; event_type: string; payload: Record<string, unknown> }>, runID: string, eventName = 'local.event'): Promise<void> {
  const body = `${events
    .map((event, index) => `event: ${eventName}\ndata: ${JSON.stringify({ id: event.id, run_id: runID, seq: index + 1, created_at: '2026-05-10T00:00:00Z', ...event })}`)
    .join('\n\n')}\n\ndata: [DONE]\n\n`
  await sse(route, body)
}

function corsHeaders(route?: Route): Record<string, string> {
  const origin = route?.request().headers().origin ?? '*'
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-SheJane-Local-Token',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS, PUT',
  }
}
