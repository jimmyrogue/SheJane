import type { Page, Route } from '@playwright/test'

export const clientURL = process.env.E2E_CLIENT_URL ?? `http://127.0.0.1:${process.env.E2E_CLIENT_PORT ?? '55173'}`

export interface RecordedRequest {
  url: string
  method: string
  body?: string
}

export interface MockState {
  requests: RecordedRequest[]
  localWorkspaces: Array<{ id: string; path: string; label: string }>
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
            session: 'desktop',
            ready: true
          },
          selectWorkspaceDirectory: async () => '/tmp/picked-workspace'
        };
      `,
    })
  }

  await page.route('**/api/v1/**', async (route) => {
    const request = route.request()
    state.requests.push({ url: request.url(), method: request.method(), body: request.postData() ?? undefined })
    await rawJSON(route, { error: 'Desktop must not call optional Cloud' }, 503)
  })
  await page.route('**/local/v1/**', async (route) => {
    await handleLocalHost(route, state, options)
  })

  return state
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
  if (url.endsWith('/local/v1/runtime')) {
    await rawJSON(route, {
      protocol_version: 1,
      runtime_version: 'e2e',
      capabilities: ['agent.run', 'agent.stream', 'hitl', 'workspace.files'],
      model_provider_configured: true,
    })
    return
  }
  if (url.endsWith('/local/v1/models')) {
    await rawJSON(route, {
      models: [{
        spec: 'local:ollama:qwen3:8b',
        model_id: 'qwen3:8b',
        display_name: 'Qwen 3 8B',
        provider_id: 'ollama',
        provider_name: 'Local Ollama',
        tool_calling: true,
        streaming: true,
        max_input_tokens: 32768,
        available: true,
      }],
    })
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
  if (url.endsWith('/local/v1/commands') && request.method() === 'POST') {
    const body = safeJSON(request.postData() ?? '{}') as {
      type?: string
      command_id?: string
      permission_id?: string
      decision?: string
      scope?: string
    }
    if (body.type === 'permission.resolve') {
      await rawJSON(route, {
        type: body.type,
        command_id: body.command_id,
        permission_id: body.permission_id,
        run_id: 'local-run',
        resolved: true,
        decision: body.decision,
        scope: body.scope,
        resumed: true,
      })
      return
    }
  }
  if (url.endsWith('/local/v1/runs/local-run/stream')) {
    const permissionApproved = state.requests.some((entry) =>
      entry.url.endsWith('/local/v1/commands') &&
      (safeJSON(entry.body ?? '{}') as { type?: string }).type === 'permission.resolve')
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

async function rawJSON(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    headers: { ...corsHeaders(route), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function safeJSON(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return {}
  }
}

async function localAgentSSE(route: Route, events: Array<{ id: string; event_type: string; payload: Record<string, unknown> }>, runID: string): Promise<void> {
  const body = `${events
    .map((event, index) => `event: local.event\ndata: ${JSON.stringify({ id: event.id, run_id: runID, seq: index + 1, created_at: '2026-05-10T00:00:00Z', ...event })}`)
    .join('\n\n')}\n\ndata: [DONE]\n\n`
  await route.fulfill({
    status: 200,
    headers: { ...corsHeaders(route), 'Content-Type': 'text/event-stream', 'X-Request-ID': 'req-e2e' },
    body,
  })
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
