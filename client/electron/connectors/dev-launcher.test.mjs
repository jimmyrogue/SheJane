import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

async function readRepoScript(name) {
  return readFile(resolve(process.cwd(), '..', 'scripts', name), 'utf8')
}

describe('dev launcher connector resources', () => {
  it('forwards the Electron connector resource root to the dev daemon', async () => {
    const script = await readRepoScript('dev-electron.sh')

    expect(script).toContain('SHEJANE_LOCAL_DESKTOP_RESOURCES_PATH=${ROOT_DIR}/client/electron')
  })

  it('preserves the same connector resource root when restarting only the daemon', async () => {
    const script = await readRepoScript('restart-daemon.sh')

    expect(script).toContain('SHEJANE_LOCAL_DESKTOP_RESOURCES_PATH=${ROOT_DIR}/client/electron')
  })
})
