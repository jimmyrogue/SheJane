import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { executeTool } from './executor.js'
import type { LocalRun } from '../types.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs.length = 0
})

describe('universal tool primitives', () => {
  it('lists, reads, searches, and writes only inside the authorized workspace', async () => {
    const workspace = await tempWorkspace()
    await mkdir(join(workspace, 'reports'))
    await writeFile(join(workspace, 'reports', 'summary.txt'), 'Jiandanly office summary', 'utf8')
    const run = localRun(workspace)

    await expect(executeTool({ id: 'list', name: 'fs.list', arguments: { path: 'reports' } }, run)).resolves.toMatchObject({
      ok: true,
      data: {
        source: 'fs.list',
        path: 'reports',
        entries: [expect.objectContaining({ name: 'summary.txt', type: 'file' })],
      },
    })
    await expect(executeTool({ id: 'read', name: 'fs.read', arguments: { path: 'reports/summary.txt' } }, run)).resolves.toMatchObject({
      ok: true,
      content: 'Jiandanly office summary',
      data: expect.objectContaining({ source: 'fs.read' }),
    })
    await expect(executeTool({ id: 'search', name: 'fs.search', arguments: { query: 'office' } }, run)).resolves.toMatchObject({
      ok: true,
      data: expect.objectContaining({
        source: 'fs.search',
        results: [expect.objectContaining({ path: 'reports/summary.txt', match: 'content' })],
      }),
    })
    await expect(executeTool({ id: 'write', name: 'fs.write', arguments: { path: 'reports/generated.txt', content: 'done' } }, run)).resolves.toMatchObject({
      ok: true,
      data: expect.objectContaining({ source: 'fs.write', path: 'reports/generated.txt' }),
    })
    await expect(readFile(join(workspace, 'reports', 'generated.txt'), 'utf8')).resolves.toBe('done')

    const outside = await tempWorkspace()
    await expect(executeTool({ id: 'outside', name: 'fs.list', arguments: { path: outside } }, run)).resolves.toMatchObject({
      ok: false,
      errorCode: 'path_outside_workspace',
    })
  })

  it('opens URLs and files through injected adapters with validation', async () => {
    const workspace = await tempWorkspace()
    await writeFile(join(workspace, 'brief.txt'), 'open me', 'utf8')
    const opened: Array<{ kind: string; target: string }> = []
    const run = localRun(workspace)

    await expect(
      executeTool({ id: 'url', name: 'open.url', arguments: { url: 'https://example.com/docs' } }, run, {
        opener: async (target) => {
          opened.push(target)
        },
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: { source: 'open.url', url: 'https://example.com/docs' },
    })
    await expect(
      executeTool({ id: 'file', name: 'open.file', arguments: { path: 'brief.txt' } }, run, {
        opener: async (target) => {
          opened.push(target)
        },
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: expect.objectContaining({ source: 'open.file', path: 'brief.txt' }),
    })
    expect(opened).toMatchObject([
      { kind: 'url', target: 'https://example.com/docs' },
      { kind: 'file', target: join(workspace, 'brief.txt') },
    ])

    await expect(executeTool({ id: 'bad-url', name: 'open.url', arguments: { url: 'file:///etc/passwd' } }, run)).resolves.toMatchObject({
      ok: false,
      errorCode: 'invalid_url_scheme',
    })
    await expect(executeTool({ id: 'bad-file', name: 'open.file', arguments: { path: '../secret.txt' } }, run)).resolves.toMatchObject({
      ok: false,
      errorCode: 'path_outside_workspace',
    })
  })

  it('reads and writes clipboard text through an injected adapter', async () => {
    let clipboard = 'initial clipboard'
    const run = localRun(await tempWorkspace())
    const clipboardAdapter = {
      readText: async () => clipboard,
      writeText: async (text: string) => {
        clipboard = text
      },
    }

    await expect(executeTool({ id: 'read-clipboard', name: 'clipboard.read', arguments: {} }, run, { clipboard: clipboardAdapter })).resolves.toMatchObject({
      ok: true,
      content: 'initial clipboard',
      data: { source: 'clipboard.read', characters: 17 },
    })
    await expect(
      executeTool({ id: 'write-clipboard', name: 'clipboard.write', arguments: { text: 'next clipboard' } }, run, { clipboard: clipboardAdapter }),
    ).resolves.toMatchObject({
      ok: true,
      data: { source: 'clipboard.write', characters: 14 },
    })
    expect(clipboard).toBe('next clipboard')
  })

  it('verifies files, content, URLs, and boolean assertions', async () => {
    const workspace = await tempWorkspace()
    await writeFile(join(workspace, 'done.txt'), 'final answer is ready', 'utf8')
    const run = localRun(workspace)

    await expect(executeTool({ id: 'exists', name: 'task.verify', arguments: { check: 'file_exists', path: 'done.txt' } }, run)).resolves.toMatchObject({
      ok: true,
      data: { source: 'task.verify', check: 'file_exists', passed: true },
    })
    await expect(
      executeTool({ id: 'contains', name: 'task.verify', arguments: { check: 'file_contains', path: 'done.txt', text: 'ready' } }, run),
    ).resolves.toMatchObject({
      ok: true,
      data: { source: 'task.verify', check: 'file_contains', passed: true },
    })
    await expect(executeTool({ id: 'url', name: 'task.verify', arguments: { check: 'url_valid', url: 'https://example.com' } }, run)).resolves.toMatchObject({
      ok: true,
      data: { source: 'task.verify', check: 'url_valid', passed: true },
    })
    await expect(executeTool({ id: 'bool', name: 'task.verify', arguments: { check: 'boolean', value: false } }, run)).resolves.toMatchObject({
      ok: false,
      errorCode: 'verification_failed',
      recoverable: true,
      data: { source: 'task.verify', check: 'boolean', passed: false },
    })
  })
})

describe('memory.search tool (Phase 6)', () => {
  const run = localRun('')

  function memoryEntry(title: string, body: string) {
    return {
      id: `mem_${title}`,
      kind: 'topic' as const,
      title,
      summary: `${title} summary`,
      content: body,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
  }

  it('formats matching memory entries and echoes them in data.matches', async () => {
    const result = await executeTool(
      { id: 'mem', name: 'memory.search', arguments: { query: 'package manager' } },
      run,
      { memory: { search: () => [memoryEntry('Package manager', 'User prefers pnpm')] } },
    )
    expect(result).toMatchObject({
      ok: true,
      data: { source: 'memory.search', query: 'package manager', count: 1 },
    })
    expect(result.content).toContain('Package manager')
    expect(result.content).toContain('User prefers pnpm')
    expect(result.data?.matches).toEqual([
      { title: 'Package manager', summary: 'Package manager summary', content: 'User prefers pnpm' },
    ])
  })

  it('clamps the requested limit to a sane range before querying memory', async () => {
    let receivedLimit = -1
    await executeTool(
      { id: 'mem', name: 'memory.search', arguments: { query: 'anything', limit: 999 } },
      run,
      { memory: { search: (_q, limit) => { receivedLimit = limit; return [] } } },
    )
    expect(receivedLimit).toBe(10)
  })

  it('returns an empty ok result when memory has no match', async () => {
    const result = await executeTool(
      { id: 'mem', name: 'memory.search', arguments: { query: 'unknown topic' } },
      run,
      { memory: { search: () => [] } },
    )
    expect(result).toMatchObject({ ok: true, data: { source: 'memory.search', count: 0 } })
    expect(result.content).toContain('No matching long-term memory found.')
  })

  it('is a safe no-op when no memory adapter is wired (recall off / defensive)', async () => {
    const result = await executeTool(
      { id: 'mem', name: 'memory.search', arguments: { query: 'anything' } },
      run,
      {},
    )
    expect(result).toMatchObject({ ok: true, data: { source: 'memory.search', count: 0 } })
  })

  it('rejects a blank query', async () => {
    const result = await executeTool(
      { id: 'mem', name: 'memory.search', arguments: { query: '   ' } },
      run,
      { memory: { search: () => [memoryEntry('Should not', 'be reached')] } },
    )
    expect(result).toMatchObject({ ok: false, errorCode: 'query_required' })
  })
})

async function tempWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'jiandanly-primitives-'))
  tempDirs.push(dir)
  return dir
}

function localRun(workspacePath: string): LocalRun {
  return {
    id: 'run-primitives',
    goal: 'Use universal primitives.',
    workspacePath,
    status: 'running',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}
