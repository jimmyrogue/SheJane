import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { installLocalRuntimeAuthorization } = require('./runtime-auth.cjs') as {
  installLocalRuntimeAuthorization: (
    webRequest: {
      onBeforeSendHeaders: (
        filter: { urls: string[] },
        listener: (
          details: { requestHeaders: Record<string, string> },
          callback: (result: { requestHeaders: Record<string, string> }) => void,
        ) => void,
      ) => void
    },
    connection: { baseURL: string, token: string },
  ) => void
}

describe('Electron local Runtime authorization', () => {
  it('keeps the pairing token in the main-process request session', () => {
    const onBeforeSendHeaders = vi.fn()
    installLocalRuntimeAuthorization({ onBeforeSendHeaders }, {
      baseURL: 'http://127.0.0.1:17371',
      token: 'root-token',
    })

    expect(onBeforeSendHeaders).toHaveBeenCalledWith(
      { urls: ['http://127.0.0.1:17371/*'] },
      expect.any(Function),
    )
    const listener = onBeforeSendHeaders.mock.calls[0][1]
    const callback = vi.fn()
    listener({ requestHeaders: { Accept: 'application/json' } }, callback)
    expect(callback).toHaveBeenCalledWith({
      requestHeaders: {
        Accept: 'application/json',
        Authorization: 'Bearer root-token',
      },
    })
  })
})
