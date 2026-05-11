import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { SQLiteLocalHostStore } from './sqliteStore.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs.length = 0
})

describe('SQLiteLocalHostStore phase 2.5 persistence', () => {
  it('persists artifacts, checkpoints, and local memory across store restarts', async () => {
    const dir = await tempDir()
    const dbPath = join(dir, 'local-host.sqlite')
    const store = new SQLiteLocalHostStore(dbPath)
    const run = store.createRun({ goal: 'Persist phase 2.5 state.' })
    const artifact = store.createArtifact({
      runId: run.id,
      kind: 'tool_output',
      title: 'shell output',
      content: 'long local output',
      contentType: 'text/plain',
      toolCallId: 'call-1',
      toolName: 'shell.run',
      metadata: { exit_code: 0 },
    })
    const checkpoint = store.createCheckpoint({
      runId: run.id,
      step: 2,
      reason: 'test_checkpoint',
      messages: [
        { role: 'system', content: 'policy' },
        { role: 'user', content: 'Persist phase 2.5 state.' },
      ],
    })
    const memory = store.upsertMemory({
      kind: 'topic',
      title: 'Phase 2.5',
      summary: 'Artifacts and checkpoints are local durable state.',
      content: 'Use SQLite as local execution truth.',
    })
    store.close()

    const reopened = new SQLiteLocalHostStore(dbPath)
    expect(reopened.getArtifact(artifact.id)).toMatchObject({
      id: artifact.id,
      content: 'long local output',
      metadata: { exit_code: 0 },
    })
    expect(reopened.latestCheckpoint(run.id)).toMatchObject({
      id: checkpoint.id,
      reason: 'test_checkpoint',
      messages: expect.arrayContaining([expect.objectContaining({ role: 'user' })]),
    })
    expect(reopened.searchMemoryTopics('phase checkpoint sqlite', 3)).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: memory.id })]),
    )
    reopened.close()
  })
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'jiandanly-sqlite-store-'))
  tempDirs.push(dir)
  return dir
}
