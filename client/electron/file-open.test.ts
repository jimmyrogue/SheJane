import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { materializeFileCopy, pruneMaterializedFileCopies } = require('./file-open.cjs') as {
  materializeFileCopy: (root: string, name: string, bytes: Uint8Array) => Promise<string>
  pruneMaterializedFileCopies: (root: string, options: { maxBytes: number }) => Promise<void>
}

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('materializeFileCopy', () => {
  it('creates an extension-preserving copy without allowing path traversal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shejane-open-test-'))
    roots.push(root)
    const body = new TextEncoder().encode('immutable snapshot')

    const opened = await materializeFileCopy(root, '../../report.pdf', body)

    expect(opened.startsWith(root)).toBe(true)
    expect(opened.endsWith('/report.pdf')).toBe(true)
    expect(readFileSync(opened, 'utf8')).toBe('immutable snapshot')
  })

  it('repairs a previously edited presentation copy from the immutable bytes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shejane-open-test-'))
    roots.push(root)
    const body = new TextEncoder().encode('runtime snapshot')
    const opened = await materializeFileCopy(root, 'deck.pptx', body)
    writeFileSync(opened, 'changed by native app')

    const reopened = await materializeFileCopy(root, 'deck.pptx', body)

    expect(reopened).toBe(opened)
    expect(readFileSync(reopened, 'utf8')).toBe('runtime snapshot')
  })

  it('prunes older materialized copies when the bounded cache is full', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shejane-open-test-'))
    roots.push(root)
    const older = await materializeFileCopy(root, 'older.pdf', new TextEncoder().encode('older'))
    await new Promise(resolve => setTimeout(resolve, 5))
    const newer = await materializeFileCopy(root, 'newer.pdf', new TextEncoder().encode('newer'))

    await pruneMaterializedFileCopies(root, { maxBytes: 5 })

    expect(() => readFileSync(older)).toThrow()
    expect(readFileSync(newer, 'utf8')).toBe('newer')
  })

  it('refreshes a cache hit so LRU pruning retains the recently opened copy', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shejane-open-test-'))
    roots.push(root)
    const olderBody = new TextEncoder().encode('11111')
    const newerBody = new TextEncoder().encode('22222')
    const older = await materializeFileCopy(root, 'older.pdf', olderBody)
    await new Promise(resolve => setTimeout(resolve, 5))
    const newer = await materializeFileCopy(root, 'newer.pdf', newerBody)
    await new Promise(resolve => setTimeout(resolve, 5))
    await materializeFileCopy(root, 'older.pdf', olderBody)

    await pruneMaterializedFileCopies(root, { maxBytes: 5 })

    expect(readFileSync(older, 'utf8')).toBe('11111')
    expect(() => readFileSync(newer)).toThrow()
  })
})
