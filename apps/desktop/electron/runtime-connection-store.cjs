const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

function credentialEncryptionAvailable(safeStorage) {
  return safeStorage.isEncryptionAvailable() &&
    safeStorage.getSelectedStorageBackend?.() !== 'basic_text'
}

function normalizeRuntimeToken(value) {
  const token = typeof value === 'string' ? value.trim() : ''
  if (!token) {
    throw new Error('Runtime token is required')
  }
  if (token.length > 4096) {
    throw new Error('Runtime token is too long')
  }
  return token
}

function createRuntimeConnectionUpdateGate() {
  let generation = 0
  let activeController
  return {
    begin() {
      activeController?.abort()
      const controller = new AbortController()
      const requestGeneration = ++generation
      activeController = controller
      return {
        signal: controller.signal,
        assertCurrent() {
          if (requestGeneration !== generation) {
            throw new Error('Runtime connection update was superseded')
          }
          if (activeController === controller) {
            activeController = undefined
          }
        },
      }
    },
  }
}

function normalizeExternalRuntimeURL(value) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 2048) {
    throw new Error('Runtime URL is required')
  }

  let parsed
  try {
    parsed = new URL(value.trim())
  } catch {
    throw new Error('Runtime URL is invalid')
  }
  if (parsed.username || parsed.password) {
    throw new Error('Runtime URL credentials are not allowed')
  }
  if (parsed.protocol !== 'http:') {
    throw new Error('External local Runtime must use loopback HTTP')
  }
  if (!['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname.toLowerCase())) {
    throw new Error('External local Runtime must use a loopback address')
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('Runtime URL must contain only an origin')
  }
  return parsed.origin
}

function readRuntimeConnection(filePath, safeStorage) {
  let raw
  try {
    raw = fs.readFileSync(filePath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { mode: 'bundled' }
    }
    throw error
  }

  const saved = JSON.parse(raw)
  if (saved?.mode !== 'external-local' || typeof saved.encryptedToken !== 'string') {
    throw new Error('Saved Runtime connection is invalid')
  }
  if (!credentialEncryptionAvailable(safeStorage)) {
    throw new Error('System credential encryption is unavailable')
  }
  const token = normalizeRuntimeToken(
    safeStorage.decryptString(Buffer.from(saved.encryptedToken, 'base64')),
  )
  return {
    mode: 'external-local',
    baseURL: normalizeExternalRuntimeURL(saved.baseURL),
    token,
  }
}

function writeRuntimeConnection(filePath, safeStorage, connection) {
  if (connection?.mode === 'bundled') {
    fs.rmSync(filePath, { force: true })
    return
  }
  if (connection?.mode !== 'external-local') {
    throw new Error('Runtime connection mode is invalid')
  }
  const token = normalizeRuntimeToken(connection.token)
  if (!credentialEncryptionAvailable(safeStorage)) {
    throw new Error('System credential encryption is unavailable')
  }

  const saved = JSON.stringify({
    mode: 'external-local',
    baseURL: normalizeExternalRuntimeURL(connection.baseURL),
    encryptedToken: safeStorage.encryptString(token).toString('base64'),
  })
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tempPath = `${filePath}.${crypto.randomUUID()}.tmp`
  try {
    fs.writeFileSync(tempPath, saved, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    fs.renameSync(tempPath, filePath)
    fs.chmodSync(filePath, 0o600)
  } catch (error) {
    fs.rmSync(tempPath, { force: true })
    throw error
  }
}

module.exports = {
  createRuntimeConnectionUpdateGate,
  normalizeExternalRuntimeURL,
  normalizeRuntimeToken,
  readRuntimeConnection,
  writeRuntimeConnection,
}
