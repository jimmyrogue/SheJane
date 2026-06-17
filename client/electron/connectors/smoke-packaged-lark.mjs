import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const clientRoot = resolve(here, '..', '..')

export function defaultAppExecutable({
  platform = process.platform,
  arch = process.arch,
  releaseDir = 'release',
} = {}) {
  if (platform === 'win32') {
    return join(releaseDir, 'win-unpacked', '石间.exe')
  }
  if (platform === 'darwin') {
    const macDir = arch === 'x64' ? 'mac' : `mac-${arch}`
    return join(releaseDir, macDir, '石间.app', 'Contents', 'MacOS', '石间')
  }
  return join(releaseDir, 'linux-unpacked', '石间')
}

export function validateLarkStatus(status, { platform = process.platform } = {}) {
  const errors = []
  const connector = status?.connector || {}
  const connection = status?.connection || {}
  if (connector.available !== true) {
    errors.push('Lark connector is not available')
  }
  if (connector.source !== 'bundled') {
    errors.push(`Lark connector source is ${connector.source || '<empty>'}, expected bundled`)
  }
  const executablePath = String(connector.executable_path || '')
  if (!executablePath) {
    errors.push('Lark connector executable_path is empty')
  }
  const normalizedPath = executablePath.replaceAll('\\', '/')
  if (platform === 'win32' && !normalizedPath.endsWith('/connectors/lark/win32-x64/lark-cli.exe')) {
    errors.push(`Windows Lark connector path is not packaged win32-x64: ${executablePath}`)
  }
  if (platform === 'darwin' && !normalizedPath.includes('/connectors/lark/darwin-')) {
    errors.push(`macOS Lark connector path is not packaged darwin target: ${executablePath}`)
  }
  const allowedStatuses = new Set(['connected', 'needs_auth', 'disconnected', 'error'])
  if (!allowedStatuses.has(connection.status)) {
    errors.push(`Unexpected Lark connection status: ${connection.status || '<empty>'}`)
  }
  if (connection.status === 'error' && !String(connection.last_error_code || '').startsWith('lark_auth_')) {
    errors.push(`Unexpected Lark auth error code: ${connection.last_error_code || '<empty>'}`)
  }
  return errors
}

export function larkProcessBelongsToPackagedResources(line) {
  return /connectors[\\/]+lark[\\/]+(?:win32-x64|darwin-arm64|darwin-x64)[\\/]+lark-cli(?:\.exe)?/i.test(line)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const timeoutMs = Number(args['timeout-ms'] || 90_000)
  const requestTimeoutMs = Number(args['request-timeout-ms'] || 20_000)
  const appPath = resolve(clientRoot, args.app || defaultAppExecutable())
  if (!existsSync(appPath)) {
    throw new Error(`packaged app executable not found: ${appPath}`)
  }

  const tempDir = await mkdtemp(join(tmpdir(), 'shejane-packaged-lark-smoke-'))
  const smokeFile = args['smoke-file'] ? resolve(clientRoot, args['smoke-file']) : join(tempDir, 'handoff.json')
  let appProcess
  try {
    await rm(smokeFile, { force: true })
    appProcess = spawn(appPath, [], {
      cwd: dirname(appPath),
      env: {
        ...process.env,
        SHEJANE_DESKTOP_SMOKE_FILE: smokeFile,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    appProcess.stdout.on('data', (chunk) => process.stdout.write(`[app] ${chunk}`))
    appProcess.stderr.on('data', (chunk) => process.stderr.write(`[app] ${chunk}`))
    appProcess.on('exit', (code, signal) => {
      if (code !== 0 && signal !== 'SIGKILL' && signal !== 'SIGTERM') {
        process.stderr.write(`[app] exited code=${code} signal=${signal}\n`)
      }
    })

    const handoff = await waitForSmokeFile(smokeFile, timeoutMs)
    await assertHealth(handoff, requestTimeoutMs)
    const status = await fetchLocalJSON(handoff, '/local/v1/lark/status', {}, requestTimeoutMs)
    const statusErrors = validateLarkStatus(status)
    if (statusErrors.length > 0) {
      throw new Error(statusErrors.join('\n'))
    }
    const disconnectStatus = await fetchLocalJSON(handoff, '/local/v1/lark/disconnect', {
      method: 'POST',
    }, requestTimeoutMs)
    if (disconnectStatus?.connection?.status !== 'disconnected') {
      throw new Error(`disconnect did not return disconnected: ${JSON.stringify(disconnectStatus)}`)
    }
    const larkProcesses = await listPackagedLarkProcesses()
    if (larkProcesses.length > 0) {
      throw new Error(`packaged lark-cli process still running:\n${larkProcesses.join('\n')}`)
    }
    console.log('packaged Lark connector smoke passed')
  } finally {
    await stopProcessTree(appProcess)
    if (args['keep-smoke-file'] !== 'true') {
      await rm(smokeFile, { force: true })
    }
    await rm(tempDir, { recursive: true, force: true })
  }
}

function parseArgs(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) continue
    const eqIndex = arg.indexOf('=')
    if (eqIndex > 2) {
      parsed[arg.slice(2, eqIndex)] = arg.slice(eqIndex + 1)
      continue
    }
    const key = arg.slice(2)
    const next = argv[index + 1]
    if (next && !next.startsWith('--')) {
      parsed[key] = next
      index += 1
    } else {
      parsed[key] = 'true'
    }
  }
  return parsed
}

async function waitForSmokeFile(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const payload = JSON.parse(await readFile(filePath, 'utf8'))
      if (payload?.baseURL && payload?.token) {
        return payload
      }
    } catch {
      // The app has not written the handoff file yet.
    }
    await delay(250)
  }
  throw new Error(`timed out waiting for smoke handoff file: ${filePath}`)
}

async function assertHealth(handoff, timeoutMs) {
  const response = await fetchWithTimeout(`${handoff.baseURL}/local/v1/health`, {}, timeoutMs)
  if (!response.ok) {
    throw new Error(`local-host health failed: ${response.status}`)
  }
}

async function fetchLocalJSON(handoff, path, init = {}, timeoutMs = 20_000) {
  const response = await fetchWithTimeout(`${handoff.baseURL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${handoff.token}`,
      ...(init.headers || {}),
    },
  }, timeoutMs)
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`${path} failed: ${response.status} ${text}`)
  }
  return text ? JSON.parse(text) : {}
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

async function listPackagedLarkProcesses() {
  const command =
    process.platform === 'win32'
      ? ['powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process -Filter "Name=\'lark-cli.exe\'" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress']]
      : ['ps', ['-axo', 'pid,command']]
  const result = await run(command[0], command[1])
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && larkProcessBelongsToPackagedResources(line))
}

async function stopProcessTree(proc) {
  if (!proc?.pid || proc.exitCode !== null) return
  if (process.platform === 'win32') {
    await run('taskkill', ['/pid', String(proc.pid), '/T', '/F']).catch(() => {})
  } else {
    try {
      process.kill(proc.pid, 'SIGTERM')
    } catch {
      return
    }
    await Promise.race([
      new Promise((resolve) => proc.once('exit', resolve)),
      delay(2000).then(() => {
        try {
          process.kill(proc.pid, 'SIGKILL')
        } catch {
          // Already gone.
        }
      }),
    ])
  }
}

function run(command, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    proc.on('error', rejectPromise)
    proc.on('close', (code) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr })
      } else {
        rejectPromise(new Error(`${command} failed (${code}): ${stderr.trim()}`))
      }
    })
  })
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
