import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { stopRuntimeProcess, waitForRuntimeReady } = require('./local-runtime-process.cjs') as {
  waitForRuntimeReady: (options: {
    baseURL: string
    token: string
    fetchImpl: typeof fetch
    timeoutMs?: number
    pollMs?: number
    requestTimeoutMs?: number
    delay?: (ms: number) => Promise<void>
    signal?: AbortSignal
  }) => Promise<boolean>
  stopRuntimeProcess: (
    child: EventEmitter & { pid: number, exitCode: number | null, kill: (signal: string) => boolean },
    options: {
      graceMs?: number
      forceExitMs?: number
      delay?: (ms: number) => Promise<void>
      forceKill: (pid: number) => void | Promise<void>
    },
  ) => Promise<void>
}

function runtimeProcess(kill: (signal: string) => boolean) {
  return Object.assign(new EventEmitter(), { pid: 42, exitCode: null, kill })
}

describe('Electron local Runtime process lifecycle', () => {
  it('waits for the authenticated Runtime protocol and required capabilities', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'ok' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        protocol_version: 1,
        capabilities: ['agent.run', 'agent.stream'],
      }), { status: 200 }))

    await expect(waitForRuntimeReady({
      baseURL: 'http://127.0.0.1:17371',
      token: 'pairing-token',
      fetchImpl,
      timeoutMs: 100,
      pollMs: 1,
      delay: async () => undefined,
    })).resolves.toBe(true)
    expect(fetchImpl).toHaveBeenLastCalledWith(
      'http://127.0.0.1:17371/local/v1/runtime',
      expect.objectContaining({
        headers: { Authorization: 'Bearer pairing-token' },
        signal: expect.any(AbortSignal),
      }),
    )
  })

  it('lets the Runtime exit gracefully before the deadline', async () => {
    const forceKill = vi.fn()
    const child = runtimeProcess((signal) => {
      expect(signal).toBe('SIGTERM')
      child.emit('exit', 0, signal)
      return true
    })

    await stopRuntimeProcess(child, {
      forceKill,
      delay: async () => undefined,
    })

    expect(forceKill).not.toHaveBeenCalled()
  })

  it('aborts a hung readiness request at the overall deadline', async () => {
    vi.useFakeTimers()
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    }))

    const ready = waitForRuntimeReady({
      baseURL: 'http://127.0.0.1:17371',
      token: 'pairing-token',
      fetchImpl: fetchImpl as typeof fetch,
      timeoutMs: 20,
      requestTimeoutMs: 20,
      pollMs: 1,
    })
    await vi.advanceTimersByTimeAsync(20)

    await expect(ready).resolves.toBe(false)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('force-kills a Runtime that misses the graceful deadline', async () => {
    const forceKill = vi.fn()
    const child = runtimeProcess(() => true)
    forceKill.mockImplementation(() => {
      child.emit('exit', null, 'SIGKILL')
    })

    await stopRuntimeProcess(child, {
      forceKill,
      graceMs: 1,
      delay: async () => undefined,
    })

    expect(forceKill).toHaveBeenCalledWith(42)
  })

  it('falls back to a confirmed force kill when SIGTERM cannot be sent', async () => {
    const forceKill = vi.fn()
    const child = runtimeProcess(() => {
      throw new Error('SIGTERM unavailable')
    })
    forceKill.mockImplementation(() => {
      child.emit('exit', null, 'SIGKILL')
    })

    await stopRuntimeProcess(child, {
      forceKill,
      delay: async () => undefined,
    })

    expect(forceKill).toHaveBeenCalledWith(42)
  })

  it('reports a failed force kill instead of silently confirming shutdown', async () => {
    const child = runtimeProcess(() => true)

    await expect(stopRuntimeProcess(child, {
      forceKill: async () => {
        throw new Error('taskkill failed')
      },
      graceMs: 1,
      delay: async () => undefined,
    })).rejects.toThrow('taskkill failed')
  })

  it('requires an exit event after the force-kill command completes', async () => {
    const child = runtimeProcess(() => true)

    await expect(stopRuntimeProcess(child, {
      forceKill: async () => undefined,
      graceMs: 1,
      forceExitMs: 1,
      delay: async () => undefined,
    })).rejects.toThrow('did not exit after force kill')
  })
})
