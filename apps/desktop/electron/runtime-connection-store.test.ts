import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  createRuntimeConnectionUpdateGate,
  normalizeExternalRuntimeURL,
  normalizeRuntimeToken,
  readRuntimeConnection,
  writeRuntimeConnection,
} = require('./runtime-connection-store.cjs') as {
  createRuntimeConnectionUpdateGate: () => {
    begin(): { signal: AbortSignal, assertCurrent(): void }
  }
  normalizeExternalRuntimeURL: (value: string) => string
  normalizeRuntimeToken: (value: unknown) => string
  readRuntimeConnection: (filePath: string, storage: typeof fakeStorage) => RuntimeConnection
  writeRuntimeConnection: (filePath: string, storage: typeof fakeStorage, value: RuntimeConnection) => void
}

type RuntimeConnection =
  | { mode: 'bundled' }
  | { mode: 'external-local', baseURL: string, token: string }

const fakeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(`encrypted:${value}`, 'utf8'),
  decryptString: (value: Buffer) => value.toString('utf8').replace(/^encrypted:/, ''),
}

const tempRoots: string[] = []

function tempConfigPath() {
  const root = mkdtempSync(join(tmpdir(), 'shejane-runtime-'))
  tempRoots.push(root)
  return join(root, 'runtime-connection.json')
}

describe('Electron Runtime connection store', () => {
  afterEach(() => {
    tempRoots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
  })

  it('accepts only origin-only loopback HTTP addresses', () => {
    expect(normalizeExternalRuntimeURL('http://localhost:17371/')).toBe('http://localhost:17371')
    expect(normalizeExternalRuntimeURL('http://127.0.0.1:9000')).toBe('http://127.0.0.1:9000')
    expect(() => normalizeExternalRuntimeURL('https://runtime.example.com')).toThrow('loopback')
    expect(() => normalizeExternalRuntimeURL('http://localhost:17371/path')).toThrow('origin')
    expect(() => normalizeExternalRuntimeURL('http://user:secret@localhost:17371')).toThrow('credentials')
  })

  it('rejects oversized tokens before they can be used in a request', () => {
    expect(() => normalizeRuntimeToken('x'.repeat(4097))).toThrow('too long')
  })

  it('lets the latest connection update supersede an in-flight request', () => {
    const gate = createRuntimeConnectionUpdateGate()
    const first = gate.begin()
    const second = gate.begin()

    expect(first.signal.aborted).toBe(true)
    expect(() => first.assertCurrent()).toThrow('superseded')
    expect(() => second.assertCurrent()).not.toThrow()
  })

  it('encrypts the token and restores the external connection', () => {
    const filePath = tempConfigPath()
    const connection: RuntimeConnection = {
      mode: 'external-local',
      baseURL: 'http://127.0.0.1:17371',
      token: 'pairing-secret',
    }

    writeRuntimeConnection(filePath, fakeStorage, connection)

    expect(readFileSync(filePath, 'utf8')).not.toContain('pairing-secret')
    if (process.platform !== 'win32') {
      expect(statSync(filePath).mode & 0o777).toBe(0o600)
    }
    expect(readRuntimeConnection(filePath, fakeStorage)).toEqual(connection)
  })

  it('uses bundled mode when the saved override is removed', () => {
    const filePath = tempConfigPath()
    writeRuntimeConnection(filePath, fakeStorage, {
      mode: 'external-local',
      baseURL: 'http://127.0.0.1:17371',
      token: 'pairing-secret',
    })

    writeRuntimeConnection(filePath, fakeStorage, { mode: 'bundled' })

    expect(readRuntimeConnection(filePath, fakeStorage)).toEqual({ mode: 'bundled' })
  })

  it('refuses the insecure Linux basic-text safeStorage backend', () => {
    const filePath = tempConfigPath()
    const insecureStorage = {
      ...fakeStorage,
      getSelectedStorageBackend: () => 'basic_text',
    }

    expect(() => writeRuntimeConnection(filePath, insecureStorage, {
      mode: 'external-local',
      baseURL: 'http://127.0.0.1:17371',
      token: 'pairing-secret',
    })).toThrow('encryption is unavailable')
  })
})
