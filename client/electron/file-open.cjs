const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const MAX_OPEN_FILE_BYTES = 200 * 1024 * 1024
const MAX_CACHE_BYTES = 512 * 1024 * 1024

async function materializeFileCopy(root, rawName, rawBytes) {
  const bytes = Buffer.isBuffer(rawBytes)
    ? rawBytes
    : ArrayBuffer.isView(rawBytes)
      ? Buffer.from(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength)
      : Object.prototype.toString.call(rawBytes) === '[object ArrayBuffer]'
        ? Buffer.from(rawBytes)
        : null
  if (!bytes) throw new TypeError('file bytes required')
  if (bytes.byteLength > MAX_OPEN_FILE_BYTES) throw new Error('file is too large to open')

  const name = safeFileName(rawName)
  const digest = crypto.createHash('sha256').update(bytes).digest('hex')
  const directory = path.resolve(root, digest.slice(0, 16))
  const destination = path.join(directory, name)
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 })

  const currentDigest = await fileDigest(destination)
  if (currentDigest !== digest) {
    const temporary = path.join(directory, `.${crypto.randomUUID()}.tmp`)
    try {
      await fs.promises.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 })
      await fs.promises.rename(temporary, destination)
    } finally {
      await fs.promises.rm(temporary, { force: true })
    }
  } else {
    const now = new Date()
    await fs.promises.utimes(destination, now, now)
  }
  await pruneMaterializedFileCopies(root, { keepFile: destination })
  return destination
}

async function pruneMaterializedFileCopies(root, options = {}) {
  const maxBytes = options.maxBytes ?? MAX_CACHE_BYTES
  let entries
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  const cachedFiles = []
  const directories = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const directory = path.join(root, entry.name)
    let directoryEntries
    try {
      directoryEntries = await fs.promises.readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    for (const file of directoryEntries) {
      if (!file.isFile()) continue
      const filePath = path.join(directory, file.name)
      const stat = await fs.promises.stat(filePath)
      cachedFiles.push({ filePath, bytes: stat.size, modifiedAt: stat.mtimeMs })
    }
    directories.push(directory)
  }
  cachedFiles.sort((left, right) => right.modifiedAt - left.modifiedAt)
  let retainedBytes = 0
  for (const item of cachedFiles) {
    if (item.filePath === options.keepFile || retainedBytes + item.bytes <= maxBytes) {
      retainedBytes += item.bytes
      continue
    }
    await fs.promises.rm(item.filePath, { force: true })
  }
  for (const directory of directories) {
    await fs.promises.rmdir(directory).catch((error) => {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTEMPTY') throw error
    })
  }
}

function safeFileName(rawName) {
  const normalized = String(rawName || 'attachment').replaceAll('\\', '/').replaceAll('\0', '')
  const basename = path.posix.basename(normalized)
  return basename && basename !== '.' && basename !== '..' ? basename : 'attachment'
}

async function fileDigest(filePath) {
  try {
    const hash = crypto.createHash('sha256')
    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(filePath)
      stream.on('data', (chunk) => hash.update(chunk))
      stream.on('error', reject)
      stream.on('end', resolve)
    })
    return hash.digest('hex')
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

module.exports = { materializeFileCopy, pruneMaterializedFileCopies, safeFileName }
