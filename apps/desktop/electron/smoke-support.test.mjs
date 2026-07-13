import { mkdtemp, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { writeDesktopSmokeConfig } = require('./smoke-support.cjs')

describe('desktop smoke support', () => {
  it('does not write anything unless an explicit smoke file is provided', () => {
    expect(
      writeDesktopSmokeConfig({
        baseURL: 'http://127.0.0.1:17371',
        token: 'secret-token',
        resourcesPath: '/tmp/resources',
        daemonPid: 123,
      }),
    ).toBe(false)
  })

  it('writes the local-host smoke handoff file for packaged app tests', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shejane-smoke-support-'))
    const filePath = join(dir, 'handoff.json')

    expect(
      writeDesktopSmokeConfig({
        filePath,
        baseURL: 'http://127.0.0.1:34567',
        token: 'secret-token',
        resourcesPath: '/tmp/resources',
        daemonPid: 456,
      }),
    ).toBe(true)

    expect(existsSync(filePath)).toBe(true)
    const payload = JSON.parse(await readFile(filePath, 'utf8'))
    expect(payload).toMatchObject({
      schema: 1,
      baseURL: 'http://127.0.0.1:34567',
      token: 'secret-token',
      resourcesPath: '/tmp/resources',
      daemonPid: 456,
    })
    expect(payload.writtenAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})
