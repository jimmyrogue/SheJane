import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { authIPCResult, createElectronAuthHandlers, unwrapAuthIPCResult } = require('../../../electron/auth-bridge.cjs') as {
  authIPCResult: <T>(action: () => Promise<T>, locale?: string) => Promise<{ ok: true, data: T } | { ok: false, error: string }>
  createElectronAuthHandlers: (options: {
    apiBaseURL: string
    cookies: CookieStore
    fetchImpl: typeof fetch
    locale?: string | (() => string)
  }) => {
    login: (input: { email: string; password: string }) => Promise<unknown>
    refresh: () => Promise<unknown>
    logout: () => Promise<void>
  }
  unwrapAuthIPCResult: <T>(result: { ok: true, data: T } | { ok: false, error: string } | T, locale?: string) => T
}

interface CookieStore {
  get: ReturnType<typeof vi.fn>
  set: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
}

const authResponse = {
  code: 0,
  message: 'ok',
  data: {
    access_token: 'access-token',
    user: {
      id: 'user-1',
      email: 'user@example.com',
      name: 'User',
      role: 'user',
      status: 'active',
    },
  },
}

describe('Electron auth bridge helpers', () => {
  it('stores the backend refresh cookie after login without returning it to the renderer', async () => {
    const cookies = mockCookies()
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(authResponse, {
        'Set-Cookie': 'shejane_refresh=refresh-1; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax',
      }),
    )

    const auth = createElectronAuthHandlers({ apiBaseURL: 'http://localhost:8080', cookies, fetchImpl })

    await expect(auth.login({ email: 'user@example.com', password: 'secret123' })).resolves.toEqual(authResponse.data)

    expect(cookies.set).toHaveBeenCalledWith(expect.objectContaining({
      url: 'http://localhost:8080/',
      name: 'shejane_refresh',
      value: 'refresh-1',
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
    }))
    expect(JSON.stringify(authResponse.data)).not.toContain('refresh-1')
  })

  it('sends the saved refresh cookie when refreshing the Electron session', async () => {
    const cookies = mockCookies([{ name: 'shejane_refresh', value: 'refresh-1' }])
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(authResponse))

    const auth = createElectronAuthHandlers({ apiBaseURL: 'http://localhost:8080', cookies, fetchImpl })

    await expect(auth.refresh()).resolves.toEqual(authResponse.data)

    expect(fetchImpl).toHaveBeenCalledWith('http://localhost:8080/api/v1/auth/refresh', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        Cookie: 'shejane_refresh=refresh-1',
      }),
    }))
  })

  it('clears the saved refresh cookie after logout', async () => {
    const cookies = mockCookies([{ name: 'shejane_refresh', value: 'refresh-1' }])
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ code: 0, message: 'ok', data: { logged_out: true } }))

    const auth = createElectronAuthHandlers({ apiBaseURL: 'http://localhost:8080', cookies, fetchImpl })

    await expect(auth.logout()).resolves.toBeUndefined()

    expect(fetchImpl).toHaveBeenCalledWith('http://localhost:8080/api/v1/auth/logout', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        Cookie: 'shejane_refresh=refresh-1',
      }),
    }))
    expect(cookies.remove).toHaveBeenCalledWith('http://localhost:8080/', 'shejane_refresh')
  })

  it('serializes expected auth IPC failures so the main handler does not reject', async () => {
    const result = await authIPCResult(async () => {
      throw new Error('未登录或登录已过期')
    })

    expect(result).toEqual({ ok: false, error: '未登录或登录已过期' })
    expect(() => unwrapAuthIPCResult(result)).toThrow('未登录或登录已过期')
  })

  it('uses desktop locale resources for generic auth failures', async () => {
    const cookies = mockCookies()
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ code: 1, data: null }))
    const auth = createElectronAuthHandlers({ apiBaseURL: 'http://localhost:8080', cookies, fetchImpl, locale: () => 'en-US' })

    await expect(auth.login({ email: 'user@example.com', password: 'secret123' })).rejects.toThrow('Request failed')

    const result = await authIPCResult(async () => {
      throw 'boom'
    }, 'en-US')
    expect(result).toEqual({ ok: false, error: 'Request failed' })
    expect(() => unwrapAuthIPCResult({ ok: false, error: '' }, 'en-US')).toThrow('Request failed')
  })
})

function mockCookies(items: Array<{ name: string; value: string }> = []): CookieStore {
  return {
    get: vi.fn().mockResolvedValue(items),
    set: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  }
}

function jsonResponse(body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  })
}
