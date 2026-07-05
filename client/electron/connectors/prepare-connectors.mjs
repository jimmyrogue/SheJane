import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { verifyConnectorResources } from './verify-connectors.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const defaultRootDir = here
const defaultManifestPath = join(defaultRootDir, 'lark', 'manifest.json')
const defaultCacheDir = resolve(here, '..', '..', '.cache', 'connectors')

export async function prepareConnectorResources({
  rootDir = defaultRootDir,
  manifestPath = defaultManifestPath,
  cacheDir = defaultCacheDir,
  downloadArchive = downloadArchiveFromURL,
  extractArchive = extractArchiveWithTar,
} = {}) {
  const errors = []
  const manifest = await readManifest(manifestPath, errors)
  if (!manifest) return { ok: false, errors }
  const targets = Array.isArray(manifest.targets) ? manifest.targets : []
  await mkdir(cacheDir, { recursive: true })

  for (const target of targets) {
    if (!target || typeof target !== 'object' || target.required === false) {
      continue
    }
    const relPath = typeof target.path === 'string' ? target.path : ''
    if (!isSafeRelativePath(relPath)) {
      errors.push(`invalid connector binary path: ${relPath || '<empty>'}`)
      continue
    }
    if (await binaryMatchesManifest(rootDir, relPath, target.binarySha256)) {
      continue
    }
    const archiveName = typeof target.archive === 'string' ? target.archive : ''
    const archiveSha256 = typeof target.archiveSha256 === 'string' ? target.archiveSha256.toLowerCase() : ''
    if (!archiveName || !/^[a-f0-9]{64}$/.test(archiveSha256)) {
      errors.push(`invalid archive metadata for ${target.id || relPath || '<unknown>'}`)
      continue
    }
    const archivePath = join(cacheDir, archiveName)
    await downloadArchive(target, archivePath)
    const archiveHash = await sha256File(archivePath)
    if (archiveHash !== archiveSha256) {
      errors.push(`archive checksum mismatch for ${archiveName}: expected ${archiveSha256}, got ${archiveHash}`)
      continue
    }

    const extractDir = await mkdtemp(join(tmpdir(), 'shejane-connector-'))
    try {
      await extractArchive(archivePath, extractDir, target)
      const extractedBinary = await findFileByName(extractDir, basename(relPath))
      if (!extractedBinary) {
        errors.push(`archive did not contain ${basename(relPath)} for ${target.id || relPath}`)
        continue
      }
      const destination = resolve(rootDir, relPath)
      await mkdir(dirname(destination), { recursive: true })
      await copyFile(extractedBinary, destination)
      await chmod(destination, 0o755)
    } finally {
      await rm(extractDir, { recursive: true, force: true })
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors }
  }
  return verifyConnectorResources({ rootDir, manifestPath })
}

async function readManifest(manifestPath, errors) {
  try {
    return JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch (error) {
    errors.push(`cannot read connector manifest: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

async function binaryMatchesManifest(rootDir, relPath, expectedHash) {
  if (!isSafeRelativePath(relPath) || !/^[a-f0-9]{64}$/.test(String(expectedHash || '').toLowerCase())) return false
  const absolutePath = resolve(rootDir, relPath)
  if (!existsSync(absolutePath)) return false
  const fileStat = await stat(absolutePath).catch(() => null)
  return Boolean(fileStat?.isFile()) && (await sha256File(absolutePath)) === String(expectedHash).toLowerCase()
}

function isSafeRelativePath(value) {
  if (!value || isAbsolute(value)) return false
  const normalized = normalize(value)
  return normalized === value && !normalized.startsWith('..') && !relative('.', normalized).startsWith('..')
}

async function downloadArchiveFromURL(target, archivePath) {
  if (typeof target.downloadUrl !== 'string' || !target.downloadUrl) {
    throw new Error(`missing downloadUrl for ${target.id || target.archive || 'connector target'}`)
  }
  const response = await fetch(target.downloadUrl)
  if (!response.ok) {
    throw new Error(`download failed for ${target.archive}: ${response.status} ${response.statusText}`)
  }
  await writeFile(archivePath, Buffer.from(await response.arrayBuffer()))
}

async function extractArchiveWithTar(archivePath, outputDir) {
  await new Promise((resolvePromise, rejectPromise) => {
    const proc = spawn('tar', ['-xf', archivePath, '-C', outputDir], { stdio: 'pipe' })
    let stderr = ''
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    proc.on('error', rejectPromise)
    proc.on('close', (code) => {
      if (code === 0) {
        resolvePromise()
      } else {
        rejectPromise(new Error(`tar failed (${code}): ${stderr.trim()}`))
      }
    })
  })
}

async function findFileByName(root, name) {
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    const entryPath = join(root, entry.name)
    if (entry.isFile() && entry.name === name) return entryPath
    if (entry.isDirectory()) {
      const nested = await findFileByName(entryPath, name)
      if (nested) return nested
    }
  }
  return null
}

async function sha256File(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = await prepareConnectorResources()
    if (!result.ok) {
      for (const error of result.errors) {
        console.error(error)
      }
      process.exit(1)
    }
    console.log('connector resources prepared')
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
