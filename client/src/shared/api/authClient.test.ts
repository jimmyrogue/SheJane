import { describe, expect, it, vi } from 'vitest'
import { createAuthClient } from './authClient'
import type { AuthPayload, JiandanAPI } from './client'

const payload: AuthPayload = {
  access_token: 'electron-token',
  user: {
    id: 'electron-user',
    email: 'electron@example.com',
    name: 'Electron',
    role: 'user',
    status: 'active',
  },
}

describe('createAuthClient', () => {
  it('uses the Electron auth bridge when it is available', async () => {
    const api = mockAPI()
    const bridge = {
      register: vi.fn().mockResolvedValue(payload),
      login: vi.fn().mockResolvedValue(payload),
      refresh: vi.fn().mockResolvedValue(payload),
      logout: vi.fn().mockResolvedValue(undefined),
    }

    const auth = createAuthClient(api, bridge)

    await expect(auth.register({ email: 'electron@example.com', password: 'secret123', name: 'Electron' })).resolves.toEqual(payload)
    await expect(auth.login({ email: 'electron@example.com', password: 'secret123' })).resolves.toEqual(payload)
    await expect(auth.refresh()).resolves.toEqual(payload)
    await expect(auth.logout()).resolves.toBeUndefined()

    expect(bridge.register).toHaveBeenCalledWith({ email: 'electron@example.com', password: 'secret123', name: 'Electron' })
    expect(bridge.login).toHaveBeenCalledWith({ email: 'electron@example.com', password: 'secret123' })
    expect(bridge.refresh).toHaveBeenCalled()
    expect(bridge.logout).toHaveBeenCalled()
    expect(api.register).not.toHaveBeenCalled()
    expect(api.login).not.toHaveBeenCalled()
    expect(api.refresh).not.toHaveBeenCalled()
    expect(api.logout).not.toHaveBeenCalled()
  })

  it('falls back to the web API when the Electron auth bridge is missing', async () => {
    const api = mockAPI()

    const auth = createAuthClient(api, undefined)

    await expect(auth.register({ email: 'web@example.com', password: 'secret123', name: 'Web' })).resolves.toEqual(payload)
    await expect(auth.login({ email: 'web@example.com', password: 'secret123' })).resolves.toEqual(payload)
    await expect(auth.refresh()).resolves.toEqual(payload)
    await expect(auth.logout()).resolves.toBeUndefined()

    expect(api.register).toHaveBeenCalledWith({ email: 'web@example.com', password: 'secret123', name: 'Web' })
    expect(api.login).toHaveBeenCalledWith({ email: 'web@example.com', password: 'secret123' })
    expect(api.refresh).toHaveBeenCalled()
    expect(api.logout).toHaveBeenCalled()
  })
})

function mockAPI() {
  return {
    register: vi.fn().mockResolvedValue(payload),
    login: vi.fn().mockResolvedValue(payload),
    refresh: vi.fn().mockResolvedValue(payload),
    logout: vi.fn().mockResolvedValue(undefined),
  } as unknown as Pick<JiandanAPI, 'register' | 'login' | 'refresh' | 'logout'>
}
