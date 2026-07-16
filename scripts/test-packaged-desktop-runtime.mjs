#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { spawn } from 'node:child_process'

const execFileAsync = promisify(execFile)
const appPath = resolve(process.argv[2] || '')
if (process.platform !== 'darwin' || !appPath.endsWith('.app')) {
  throw new Error('usage: node scripts/test-packaged-desktop-runtime.mjs /path/to/App.app')
}

const wait = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds))

async function waitUntil(check, { timeoutMs, failure }) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await check()
    if (value) {
      return value
    }
    await wait(50)
  }
  throw new Error(failure)
}

function processExists(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') {
      return false
    }
    throw error
  }
}

const temporaryRoot = await mkdtemp(join(tmpdir(), 'shejane-packaged-desktop-smoke-'))
const smokeFile = join(temporaryRoot, 'runtime.json')
const quitFile = join(temporaryRoot, 'quit')
const home = join(temporaryRoot, 'home')
const userData = join(temporaryRoot, 'user-data')
const resourcesPath = join(appPath, 'Contents', 'Resources')
const macOSDirectory = join(appPath, 'Contents', 'MacOS')
let appProcess
let daemonPid = 0
let stdout = ''
let stderr = ''

try {
  await access(resourcesPath, constants.R_OK)
  await mkdir(home, { recursive: true })
  await mkdir(userData, { recursive: true })
  const executableNames = (await readdir(macOSDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
  if (executableNames.length !== 1) {
    throw new Error(`packaged app has an ambiguous main executable: ${executableNames.join(', ')}`)
  }
  const executable = join(macOSDirectory, executableNames[0])
  appProcess = spawn(executable, [`--user-data-dir=${userData}`], {
    env: {
      ...process.env,
      HOME: home,
      TMPDIR: temporaryRoot,
      SHEJANE_DESKTOP_SMOKE_FILE: smokeFile,
      SHEJANE_DESKTOP_SMOKE_QUIT_FILE: quitFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  appProcess.stdout.on('data', (chunk) => {
    stdout = `${stdout}${chunk}`.slice(-32_768)
  })
  appProcess.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-32_768)
  })

  const handoff = await waitUntil(
    async () => {
      try {
        return JSON.parse(await readFile(smokeFile, 'utf8'))
      } catch (error) {
        if (error?.code === 'ENOENT' || error instanceof SyntaxError) {
          if (appProcess.exitCode !== null) {
            throw new Error(`packaged app exited before Runtime became ready (${appProcess.exitCode})`)
          }
          return null
        }
        throw error
      }
    },
    { timeoutMs: 60_000, failure: 'packaged app did not publish its Runtime handoff' },
  )
  if (
    handoff.schema !== 1 ||
    typeof handoff.baseURL !== 'string' ||
    !handoff.baseURL.startsWith('http://127.0.0.1:') ||
    typeof handoff.token !== 'string' ||
    handoff.token.length < 32 ||
    resolve(handoff.resourcesPath) !== resolve(resourcesPath) ||
    !Number.isSafeInteger(handoff.daemonPid) ||
    handoff.daemonPid <= 0
  ) {
    throw new Error('packaged app published an invalid Runtime handoff')
  }
  daemonPid = handoff.daemonPid
  const headers = { Authorization: `Bearer ${handoff.token}` }
  const health = await fetch(`${handoff.baseURL}/local/v1/health`, { headers })
  if (!health.ok || (await health.json()).status !== 'ok') {
    throw new Error(`packaged Runtime health failed with HTTP ${health.status}`)
  }
  const plugins = await fetch(`${handoff.baseURL}/local/v1/plugins`, { headers })
  if (!plugins.ok || !Array.isArray((await plugins.json()).plugins)) {
    throw new Error(`packaged Runtime plugin catalog failed with HTTP ${plugins.status}`)
  }

  const manifest = join(resourcesPath, 'sandbox', 'vm-assets', 'manifest.json')
  await access(manifest, constants.R_OK)
  const { stdout: command } = await execFileAsync('/bin/ps', [
    '-p',
    String(daemonPid),
    '-o',
    'command=',
  ])
  if (!command.includes('--managed-worker-vm-assets') || !command.includes(manifest)) {
    throw new Error('normal Desktop startup did not inject the packaged VM asset manifest')
  }

  await writeFile(quitFile, '')
  await waitUntil(
    async () => appProcess.exitCode !== null,
    { timeoutMs: 30_000, failure: 'packaged app did not exit through its normal quit lifecycle' },
  )
  if (appProcess.exitCode !== 0) {
    throw new Error(`packaged app exited with code ${appProcess.exitCode}`)
  }
  await waitUntil(
    async () => !processExists(daemonPid),
    { timeoutMs: 10_000, failure: 'packaged app left its bundled Runtime running after quit' },
  )
  process.stdout.write(`packaged Desktop Runtime smoke passed: ${basename(appPath)}\n`)
} catch (error) {
  if (stdout) {
    process.stderr.write(`packaged app stdout:\n${stdout}\n`)
  }
  if (stderr) {
    process.stderr.write(`packaged app stderr:\n${stderr}\n`)
  }
  throw error
} finally {
  if (appProcess?.exitCode === null) {
    appProcess.kill('SIGKILL')
  }
  if (daemonPid > 0 && processExists(daemonPid)) {
    process.kill(daemonPid, 'SIGKILL')
  }
  await rm(temporaryRoot, { recursive: true, force: true })
}
