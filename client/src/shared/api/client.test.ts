import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SheJaneAPI } from './client'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function authHeader(init: RequestInit | undefined): string | undefined {
  return (init?.headers as Record<string, string> | undefined)?.Authorization
}

describe('SheJaneAPI mid-session token refresh', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
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
})
