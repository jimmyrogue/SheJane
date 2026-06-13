import { beforeEach, describe, expect, it, vi } from 'vitest'
import { APIError, SheJaneAPI } from './client'
import { runCloudAgentLoop } from '../cloudAgentLoop'

vi.mock('../cloudAgentLoop', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../cloudAgentLoop')>()
  return {
    ...actual,
    runCloudAgentLoop: vi.fn(),
  }
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function jsonResponseWithHeaders(
  body: unknown,
  status: number,
  headers: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

function sseResponse(text: string): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text))
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'X-Request-ID': 'req-header',
    },
  })
}

function authHeader(init: RequestInit | undefined): string | undefined {
  return (init?.headers as Record<string, string> | undefined)?.Authorization
}

describe('SheJaneAPI mid-session token refresh', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.mocked(runCloudAgentLoop).mockReset()
  })

  it('refreshes once and replays the request on a 401', async () => {
    const api = new SheJaneAPI('http://test')
    api.setAccessToken('stale')
    const refresher = vi.fn(async () => {
      api.setAccessToken('fresh')
      return 'fresh'
    })
    api.setTokenRefresher(refresher)

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      if (authHeader(init) === 'Bearer fresh') {
        return jsonResponse({ code: 0, data: { credits: 42 } })
      }
      return jsonResponse({ code: 1, message: '未登录或登录已过期' }, 401)
    })

    await expect(api.balance()).resolves.toEqual({ credits: 42 })
    expect(refresher).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('dedupes a burst of concurrent 401s into a single refresh', async () => {
    const api = new SheJaneAPI('http://test')
    api.setAccessToken('stale')
    let refreshes = 0
    api.setTokenRefresher(async () => {
      refreshes += 1
      api.setAccessToken('fresh')
      return 'fresh'
    })
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) =>
      authHeader(init) === 'Bearer fresh'
        ? jsonResponse({ code: 0, data: { ok: true } })
        : jsonResponse({ code: 1, message: '未登录' }, 401),
    )

    await Promise.all([api.balance(), api.listDocuments(), api.balance()])
    expect(refreshes).toBe(1)
  })

  it('surfaces the 401 (no infinite loop) when refresh is unavailable', async () => {
    const api = new SheJaneAPI('http://test')
    api.setAccessToken('stale')
    api.setTokenRefresher(async () => null)
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ code: 1, message: '登录已过期' }, 401))

    await expect(api.balance()).rejects.toThrow('登录已过期')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('never refreshes for auth endpoints (avoids recursion)', async () => {
    const api = new SheJaneAPI('http://test')
    const refresher = vi.fn(async () => 'fresh')
    api.setTokenRefresher(refresher)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ code: 1, message: 'bad credentials' }, 401),
    )

    await expect(api.login({ email: 'a@b.c', password: 'x' })).rejects.toThrow()
    expect(refresher).not.toHaveBeenCalled()
  })

  it('surfaces 429 metadata including Retry-After seconds', async () => {
    const api = new SheJaneAPI('http://test')
    api.setAccessToken('tok')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponseWithHeaders(
        { code: 1, message: '请求过于频繁' },
        429,
        { 'Retry-After': '45' },
      ),
    )

    await expect(api.balance()).rejects.toMatchObject({
      name: 'APIError',
      message: '请求过于频繁',
      status: 429,
      retryAfterSeconds: 45,
    })
    await expect(api.balance()).rejects.toBeInstanceOf(APIError)
  })

  it('emits model.selected when the LLM stream falls back to another model', async () => {
    const api = new SheJaneAPI('http://test')
    api.setAccessToken('tok')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      sseResponse([
        'event: llm.model_selected',
        'data: {"requested_model":"bad-model","resolved_model_id":"good-model","label":"Good","reason":"上游失败后降级"}',
        '',
        'event: llm.delta',
        'data: {"content_delta":"ok","reasoning_delta":""}',
        '',
        'event: llm.done',
        'data: {"request_id":"req-1","finish_reason":"stop"}',
        '',
        '',
      ].join('\n')),
    )
    const events: string[] = []
    const deltas: string[] = []

    await api.streamAgentLLM(
      {
        runId: 'run-1',
        mode: 'bad-model',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
      },
      {
        onDelta: (delta) => deltas.push(delta),
        onEvent: (event) => {
          events.push(`${event.event_type}:${event.payload?.resolved_model_id}:${event.payload?.reason}`)
        },
      },
    )

    expect(deltas).toEqual(['ok'])
    expect(events).toEqual(['model.selected:good-model:上游失败后降级'])
  })

  it('resolves Auto intent modes before running the web tool loop', async () => {
    const api = new SheJaneAPI('http://test')
    api.setAccessToken('tok')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ code: 0, data: { model_id: 'gpt-4o', label: 'GPT-4o', reason: '能力优先' } }),
    )
    vi.mocked(runCloudAgentLoop).mockResolvedValue({
      requestId: 'req-1',
      creditsCost: 7,
      inputTokens: 11,
      outputTokens: 13,
      steps: 1,
      hitStepCap: false,
    })
    const events: string[] = []

    await api.runCloudToolLoop(
      {
        runId: 'run-web',
        goal: 'keep searching',
        mode: 'auto.smart',
        history: [],
        tools: [],
      },
      {
        onDelta: () => {},
        onEvent: (event) => {
          if (event.event_type === 'model.selected') {
            events.push(`${event.payload?.requested_model}:${event.payload?.requested_label}:${event.payload?.resolved_model_id}:${event.payload?.reason}`)
          }
        },
      },
    )

    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ goal: 'keep searching', intent: 'smart' })
    expect(vi.mocked(runCloudAgentLoop).mock.calls[0][1].mode).toBe('gpt-4o')
    expect(events).toEqual(['auto.smart:更强:gpt-4o:能力优先'])
  })

  it('emits a budget warning when the web tool loop hits its step cap', async () => {
    const api = new SheJaneAPI('http://test')
    api.setAccessToken('tok')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ code: 0, data: { model_id: 'gpt-4o', label: 'GPT-4o', reason: 'default' } }),
    )
    vi.mocked(runCloudAgentLoop).mockResolvedValue({
      requestId: 'req-1',
      creditsCost: 7,
      inputTokens: 11,
      outputTokens: 13,
      steps: 5,
      hitStepCap: true,
    })
    const events: string[] = []

    await api.runCloudToolLoop(
      {
        runId: 'run-web',
        goal: 'keep searching',
        mode: 'auto',
        history: [],
        tools: [],
      },
      {
        onDelta: () => {},
        onEvent: (event) => {
          if (event.event_type === 'run.budget_warning') {
            events.push(`${event.run_id}:${event.payload?.reason}:${event.payload?.max_steps}`)
          }
        },
      },
    )

    expect(events).toEqual(['run-web:max_steps_reached:5'])
  })

  it('passes configured web step caps into the browser tool loop and returns continuation state', async () => {
    const api = new SheJaneAPI('http://test')
    api.setAccessToken('tok')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ code: 0, data: { model_id: 'gpt-4o', label: 'GPT-4o', reason: 'default' } }),
    )
    vi.mocked(runCloudAgentLoop).mockResolvedValue({
      requestId: 'req-cap',
      creditsCost: 7,
      inputTokens: 11,
      outputTokens: 13,
      steps: 9,
      hitStepCap: true,
      continuationMessages: [
        { role: 'user', content: 'keep searching' },
        { role: 'tool', toolCallId: 'call-1', name: 'web.search', content: 'result' },
      ],
    })

    const result = await api.runCloudToolLoop(
      {
        runId: 'run-web',
        goal: 'keep searching',
        mode: 'auto',
        history: [],
        tools: [],
        maxSteps: 9,
      },
      { onDelta: () => {} },
    )

    expect(vi.mocked(runCloudAgentLoop).mock.calls[0][1]).toMatchObject({
      runId: 'run-web',
      maxSteps: 9,
    })
    expect(result).toMatchObject({
      requestId: 'req-cap',
      hitStepCap: true,
      steps: 9,
      maxSteps: 9,
      continuationMessages: [
        { role: 'user', content: 'keep searching' },
        { role: 'tool', toolCallId: 'call-1', name: 'web.search', content: 'result' },
      ],
    })
  })
})
