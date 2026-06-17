import { chmod, mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { verifyConnectorResources } from './verify-connectors.mjs'

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function writeManifest(root, targets) {
  const manifestPath = join(root, 'lark', 'manifest.json')
  await mkdir(join(root, 'lark'), { recursive: true })
  await writeFile(
    manifestPath,
    JSON.stringify(
      {
        schema: 1,
        connector: 'lark',
        version: '1.0.53',
        targets,
      },
      null,
      2,
    ),
  )
  return manifestPath
}

describe('verifyConnectorResources', () => {
  it('fails when a required packaged connector executable is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shejane-connectors-'))
    const manifestPath = await writeManifest(root, [
      {
        id: 'win32-x64',
        required: true,
        path: 'lark/win32-x64/lark-cli.exe',
        binarySha256: sha256('windows lark cli'),
      },
    ])

    const result = await verifyConnectorResources({ rootDir: root, manifestPath })

    expect(result.ok).toBe(false)
    expect(result.errors).toContain('missing required connector binary: lark/win32-x64/lark-cli.exe')
  })

  it('fails when a connector binary checksum does not match the manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shejane-connectors-'))
    await mkdir(join(root, 'lark', 'darwin-arm64'), { recursive: true })
    await writeFile(join(root, 'lark', 'darwin-arm64', 'lark-cli'), 'actual binary bytes')
    await chmod(join(root, 'lark', 'darwin-arm64', 'lark-cli'), 0o755)
    const manifestPath = await writeManifest(root, [
      {
        id: 'darwin-arm64',
        required: true,
        path: 'lark/darwin-arm64/lark-cli',
        binarySha256: sha256('different binary bytes'),
      },
    ])

    const result = await verifyConnectorResources({ rootDir: root, manifestPath })

    expect(result.ok).toBe(false)
    expect(result.errors[0]).toContain('checksum mismatch for lark/darwin-arm64/lark-cli')
  })

  it('passes when every required connector binary exists and matches its checksum', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shejane-connectors-'))
    await mkdir(join(root, 'lark', 'win32-x64'), { recursive: true })
    await writeFile(join(root, 'lark', 'win32-x64', 'lark-cli.exe'), 'windows lark cli')
    const manifestPath = await writeManifest(root, [
      {
        id: 'win32-x64',
        required: true,
        path: 'lark/win32-x64/lark-cli.exe',
        binarySha256: sha256('windows lark cli'),
      },
      {
        id: 'darwin-arm64',
        required: false,
        path: 'lark/darwin-arm64/lark-cli',
        binarySha256: sha256('optional mac lark cli'),
      },
    ])

    const result = await verifyConnectorResources({ rootDir: root, manifestPath })

    expect(result).toEqual({ ok: true, errors: [] })
  })

  it('keeps connector build scripts out of packaged extraResources', async () => {
    const config = await readFile(resolve(process.cwd(), 'electron-builder.yml'), 'utf8')

    expect(config).toContain('from: electron/connectors/lark')
    expect(config).not.toContain('from: electron/connectors\n')
  })
})
