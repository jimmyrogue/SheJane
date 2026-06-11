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
})
