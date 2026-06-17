import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const defaultRootDir = here
const defaultManifestPath = join(defaultRootDir, 'lark', 'manifest.json')

export async function verifyConnectorResources({
  rootDir = defaultRootDir,
  manifestPath = defaultManifestPath,
} = {}) {
  const errors = []
  const manifest = await readManifest(manifestPath, errors)
  if (!manifest) {
    return { ok: false, errors }
  }
  const targets = Array.isArray(manifest.targets) ? manifest.targets : []
  if (targets.length === 0) {
    errors.push('connector manifest has no targets')
    return { ok: false, errors }
  }

  for (const target of targets) {
    if (!target || typeof target !== 'object') {
      errors.push('connector manifest target must be an object')
      continue
    }
    if (target.required === false) {
      continue
    }
    const relPath = typeof target.path === 'string' ? target.path : ''
    if (!isSafeRelativePath(relPath)) {
      errors.push(`invalid connector binary path: ${relPath || '<empty>'}`)
      continue
    }
    const absolutePath = resolve(rootDir, relPath)
    if (!existsSync(absolutePath)) {
      errors.push(`missing required connector binary: ${relPath}`)
      continue
    }
    const fileStat = await stat(absolutePath).catch(() => null)
    if (!fileStat?.isFile()) {
      errors.push(`connector binary is not a file: ${relPath}`)
      continue
    }
    const expectedHash = typeof target.binarySha256 === 'string' ? target.binarySha256.toLowerCase() : ''
    if (!/^[a-f0-9]{64}$/.test(expectedHash)) {
      errors.push(`invalid binarySha256 for ${relPath}`)
      continue
    }
    const actualHash = sha256(await readFile(absolutePath))
    if (actualHash !== expectedHash) {
      errors.push(`checksum mismatch for ${relPath}: expected ${expectedHash}, got ${actualHash}`)
    }
  }

  return { ok: errors.length === 0, errors }
}

async function readManifest(manifestPath, errors) {
  try {
    return JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch (error) {
    errors.push(`cannot read connector manifest: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

function isSafeRelativePath(value) {
  if (!value || isAbsolute(value)) return false
  const normalized = normalize(value)
  return normalized === value && !normalized.startsWith('..') && !relative('.', normalized).startsWith('..')
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await verifyConnectorResources()
  if (!result.ok) {
    for (const error of result.errors) {
      console.error(error)
    }
    process.exit(1)
  }
  console.log('connector resources verified')
}
