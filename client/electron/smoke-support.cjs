const fs = require('node:fs')
const path = require('node:path')

function writeDesktopSmokeConfig({
  filePath = process.env.SHEJANE_DESKTOP_SMOKE_FILE || '',
  baseURL,
  token,
  resourcesPath,
  daemonPid,
} = {}) {
  if (!filePath) {
    return false
  }
  const payload = {
    schema: 1,
    baseURL: String(baseURL || ''),
    token: String(token || ''),
    resourcesPath: String(resourcesPath || ''),
    daemonPid: Number(daemonPid || 0),
    writtenAt: new Date().toISOString(),
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), { mode: 0o600 })
  return true
}

module.exports = {
  writeDesktopSmokeConfig,
}
