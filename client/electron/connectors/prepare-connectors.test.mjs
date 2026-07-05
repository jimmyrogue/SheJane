import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { prepareConnectorResources } from './prepare-connectors.mjs'
import { verifyConnectorResources } from './verify-connectors.mjs'

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function writeManifest(root, target) {
  const manifestPath = join(root, 'lark', 'manifest.json')
  await mkdir(join(root, 'lark'), { recursive: true })
  await writeFile(
    manifestPath,
    JSON.stringify(
      {
        schema: 1,
        connector: 'lark',
        version: '1.0.53',
        targets: [target],
      },
      null,
      2,
    ),
  )
  return manifestPath
}

describe('prepareConnectorResources', () => {
  it('downloads, verifies, extracts, and installs a missing required connector binary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shejane-connectors-'))
    const binaryBytes = 'windows lark cli'
    const archiveBytes = 'official release archive'
    const manifestPath = await writeManifest(root, {
      id: 'win32-x64',
      required: true,
      path: 'lark/win32-x64/lark-cli.exe',
      archive: 'lark-cli-1.0.53-windows-amd64.zip',
      downloadUrl: 'https://example.test/lark-cli.zip',
      archiveSha256: sha256(archiveBytes),
      binarySha256: sha256(binaryBytes),
    })

    const result = await prepareConnectorResources({
      rootDir: root,
      manifestPath,
      downloadArchive: async (_target, archivePath) => {
        await writeFile(archivePath, archiveBytes)
      },
      extractArchive: async (_archivePath, outputDir, target) => {
        await mkdir(outputDir, { recursive: true })
        await writeFile(join(outputDir, basename(target.path)), binaryBytes)
      },
    })

    expect(result).toEqual({ ok: true, errors: [] })
    await expect(readFile(join(root, 'lark', 'win32-x64', 'lark-cli.exe'), 'utf8')).resolves.toBe(binaryBytes)
    await expect(verifyConnectorResources({ rootDir: root, manifestPath })).resolves.toEqual({ ok: true, errors: [] })
  })

  it('fails before installing when the downloaded archive checksum does not match', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shejane-connectors-'))
    const manifestPath = await writeManifest(root, {
      id: 'darwin-arm64',
      required: true,
      path: 'lark/darwin-arm64/lark-cli',
      archive: 'lark-cli-1.0.53-darwin-arm64.tar.gz',
      downloadUrl: 'https://example.test/lark-cli.tar.gz',
      archiveSha256: sha256('expected archive'),
      binarySha256: sha256('darwin lark cli'),
    })

    const result = await prepareConnectorResources({
      rootDir: root,
      manifestPath,
      downloadArchive: async (_target, archivePath) => {
        await writeFile(archivePath, 'tampered archive')
      },
      extractArchive: async () => {
        throw new Error('extract should not run')
      },
    })

    expect(result.ok).toBe(false)
    expect(result.errors[0]).toContain('archive checksum mismatch for lark-cli-1.0.53-darwin-arm64.tar.gz')
  })

  it('rejects traversal target paths before downloading or copying', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shejane-connectors-'))
    const outside = resolve(dirname(root), 'outside-lark-cli')
    const manifestPath = await writeManifest(root, {
      id: 'darwin-arm64',
      required: true,
      path: '../outside-lark-cli',
      archive: 'lark-cli-1.0.53-darwin-arm64.tar.gz',
      downloadUrl: 'https://example.test/lark-cli.tar.gz',
      archiveSha256: sha256('official archive'),
      binarySha256: sha256('darwin lark cli'),
    })

    const result = await prepareConnectorResources({
      rootDir: root,
      manifestPath,
      downloadArchive: async () => {
        throw new Error('download should not run')
      },
      extractArchive: async () => {
        throw new Error('extract should not run')
      },
    })

    expect(result.ok).toBe(false)
    expect(result.errors[0]).toContain('invalid connector binary path')
    await expect(readFile(outside, 'utf8')).rejects.toThrow()
  })
})
