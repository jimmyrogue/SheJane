import { describe, expect, it, vi } from 'vitest'
import { uploadWithProgress, UploadAbortError } from './uploadWithProgress'

/**
 * Tiny XMLHttpRequest stub. We only test the contract that matters
 * for the helper (open / setRequestHeader / send / upload.onprogress
 * / onload / onerror / onabort) — not the full XHR spec. jsdom ships
 * a full XMLHttpRequest but it tries to dial real network on send(),
 * which fails in unit tests; this stub keeps everything in-process.
 */
class FakeXHR {
  static instances: FakeXHR[] = []
  upload = { onprogress: null as ((event: { loaded: number; total: number; lengthComputable: boolean }) => void) | null }
  status = 0
  responseText = ''
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  ontimeout: (() => void) | null = null
  method = ''
  url = ''
  headers: Record<string, string> = {}
  body: unknown = undefined
  aborted = false

  constructor() {
    FakeXHR.instances.push(this)
  }
  open(method: string, url: string) {
    this.method = method
    this.url = url
  }
  setRequestHeader(key: string, value: string) {
    this.headers[key] = value
  }
  send(body: unknown) {
    this.body = body
  }
  abort() {
    this.aborted = true
    this.onabort?.()
  }
}

function installFakeXHR() {
  FakeXHR.instances.length = 0
  const original = globalThis.XMLHttpRequest
  ;(globalThis as unknown as { XMLHttpRequest: typeof FakeXHR }).XMLHttpRequest = FakeXHR
  return () => {
    ;(globalThis as unknown as { XMLHttpRequest: typeof FakeXHR | typeof XMLHttpRequest }).XMLHttpRequest = original
  }
}

describe('uploadWithProgress', () => {
  it('forwards method, url, headers, and body to the XHR', async () => {
    const restore = installFakeXHR()
    try {
      const file = new Blob(['hello'], { type: 'text/plain' })
      const promise = uploadWithProgress({
        method: 'PUT',
        url: 'https://example.com/upload',
        headers: { 'Content-Type': 'text/plain', 'x-custom': 'yes' },
        body: file,
      })
      // Simulate server response.
      const xhr = FakeXHR.instances[0]
      xhr.status = 200
      xhr.responseText = ''
      xhr.onload?.()
      const result = await promise
      expect(result).toEqual({ status: 200, ok: true, body: '' })
      expect(xhr.method).toBe('PUT')
      expect(xhr.url).toBe('https://example.com/upload')
      expect(xhr.headers['Content-Type']).toBe('text/plain')
      expect(xhr.headers['x-custom']).toBe('yes')
      expect(xhr.body).toBe(file)
    } finally {
      restore()
    }
  })

  it('emits percentage events while bytes flow', async () => {
    const restore = installFakeXHR()
    try {
      const onProgress = vi.fn()
      const promise = uploadWithProgress({
        method: 'PUT',
        url: 'https://example.com/upload',
        body: 'data',
        onProgress,
      })
      const xhr = FakeXHR.instances[0]
      xhr.upload.onprogress?.({ loaded: 50, total: 200, lengthComputable: true })
      xhr.upload.onprogress?.({ loaded: 200, total: 200, lengthComputable: true })
      xhr.status = 200
      xhr.onload?.()
      await promise
      expect(onProgress).toHaveBeenCalledTimes(2)
      expect(onProgress.mock.calls[0][0]).toEqual({ loaded: 50, total: 200, percent: 25 })
      expect(onProgress.mock.calls[1][0]).toEqual({ loaded: 200, total: 200, percent: 100 })
    } finally {
      restore()
    }
  })

  it('returns NaN percent when the body length is unknown', async () => {
    const restore = installFakeXHR()
    try {
      const onProgress = vi.fn()
      const promise = uploadWithProgress({
        method: 'PUT',
        url: 'https://example.com/upload',
        body: 'data',
        onProgress,
      })
      const xhr = FakeXHR.instances[0]
      xhr.upload.onprogress?.({ loaded: 50, total: 0, lengthComputable: false })
      xhr.status = 200
      xhr.onload?.()
      await promise
      const event = onProgress.mock.calls[0][0] as { total: undefined; percent: number }
      expect(event.total).toBeUndefined()
      expect(Number.isNaN(event.percent)).toBe(true)
    } finally {
      restore()
    }
  })

  it('rejects with UploadAbortError when the signal fires', async () => {
    const restore = installFakeXHR()
    try {
      const controller = new AbortController()
      const promise = uploadWithProgress({
        method: 'PUT',
        url: 'https://example.com/upload',
        body: 'data',
        signal: controller.signal,
      })
      controller.abort()
      await expect(promise).rejects.toBeInstanceOf(UploadAbortError)
      expect(FakeXHR.instances[0].aborted).toBe(true)
    } finally {
      restore()
    }
  })

  it('returns ok=false on non-2xx status without throwing', async () => {
    const restore = installFakeXHR()
    try {
      const promise = uploadWithProgress({
        method: 'PUT',
        url: 'https://example.com/upload',
        body: 'data',
      })
      const xhr = FakeXHR.instances[0]
      xhr.status = 403
      xhr.responseText = 'Forbidden'
      xhr.onload?.()
      const result = await promise
      expect(result).toEqual({ status: 403, ok: false, body: 'Forbidden' })
    } finally {
      restore()
    }
  })
})
