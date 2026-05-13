import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { analyzeResearchDiagnostics, formatResearchAnalysisMarkdown } from '../harness/researchDiagnostics.js'
import type { LocalRunDiagnostics, SerializedEvent } from '../types.js'

const defaultGoal = '请搜索今天最新的 AI 新闻，收集 2 个可信来源，给我一个中文摘要，并列出来源链接。'
const terminalStatuses = new Set(['completed', 'failed', 'canceled'])
const defaultAllowedPermissionTools = new Set(['browser.open', 'browser.search'])

interface CLIOptions {
  baseURL: string
  token: string
  goal: string
  iterations: number
  outputDir: string
  timeoutMs: number
  failOnWarnings: boolean
  allowedPermissionTools: Set<string>
  cloudBaseURL?: string
  cloudAccessToken?: string
}

interface LocalSessionState {
  connected?: boolean
  cloud_base_url?: string
  updated_at?: string
}

interface CreatedRun {
  id: string
  status: string
}

interface SmokeRunResult {
  runID: string
  diagnosticsPath: string
  analysisPath: string
  analysisJSONPath: string
  passed: boolean
  warnings: number
  errors: number
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2), process.env)
  await ensureLocalHostReady(options)
  await ensureCloudSession(options)
  await mkdir(options.outputDir, { recursive: true })

  const results: SmokeRunResult[] = []
  for (let index = 1; index <= options.iterations; index += 1) {
    // eslint-disable-next-line no-console
    console.log(`\n[research-smoke] iteration ${index}/${options.iterations}`)
    results.push(await runOneSmoke(options, index))
  }

  const failed = results.filter((result) => !result.passed || (options.failOnWarnings && result.warnings > 0))
  // eslint-disable-next-line no-console
  console.log(`\n[research-smoke] finished ${results.length} run(s)`)
  for (const result of results) {
    // eslint-disable-next-line no-console
    console.log(
      `[research-smoke] ${result.passed ? 'PASS' : 'FAIL'} run=${result.runID} errors=${result.errors} warnings=${result.warnings}`,
    )
    // eslint-disable-next-line no-console
    console.log(`  diagnostics: ${result.diagnosticsPath}`)
    // eslint-disable-next-line no-console
    console.log(`  analysis:    ${result.analysisPath}`)
  }

  if (failed.length > 0) {
    process.exitCode = 1
  }
}

async function runOneSmoke(options: CLIOptions, iteration: number): Promise<SmokeRunResult> {
  const created = await createRun(options, options.goal)
  const startedAt = Date.now()
  const seenEventSeqs = new Set<number>()

  for (;;) {
    if (Date.now() - startedAt > options.timeoutMs) {
      await cancelRun(options, created.id).catch(() => undefined)
      throw new Error(`Research smoke timed out after ${options.timeoutMs}ms for run ${created.id}`)
    }

    const stream = await requestText(options, `/local/v1/runs/${created.id}/stream`)
    for (const event of parseLocalEvents(stream)) {
      seenEventSeqs.add(event.seq)
    }

    const diagnostics = await getDiagnostics(options, created.id)
    const pending = diagnostics.permissions.find((permission) => permission.status === 'pending')
    if (pending) {
      const decision = options.allowedPermissionTools.has(pending.tool_name) ? 'approve' : 'deny'
      // eslint-disable-next-line no-console
      console.log(`[research-smoke] ${decision} permission tool=${pending.tool_name} request=${pending.id}`)
      await resolvePermission(options, pending.id, decision)
      await sleep(100)
      continue
    }

    if (terminalStatuses.has(diagnostics.run.status)) {
      return await saveAndAnalyze(options, diagnostics, iteration)
    }

    if (seenEventSeqs.size === 0) {
      await sleep(500)
    }
  }
}

async function saveAndAnalyze(options: CLIOptions, diagnostics: LocalRunDiagnostics, iteration: number): Promise<SmokeRunResult> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const baseName = `${stamp}-iter${iteration}-${diagnostics.run.id}`
  const diagnosticsPath = join(options.outputDir, `${baseName}-diagnostics.json`)
  const analysisPath = join(options.outputDir, `${baseName}-analysis.md`)
  const analysisJSONPath = join(options.outputDir, `${baseName}-analysis.json`)
  const analysis = analyzeResearchDiagnostics(diagnostics)

  await writeFile(diagnosticsPath, `${JSON.stringify(diagnostics, null, 2)}\n`, 'utf8')
  await writeFile(analysisJSONPath, `${JSON.stringify(analysis, null, 2)}\n`, 'utf8')
  await writeFile(analysisPath, formatResearchAnalysisMarkdown(analysis), 'utf8')

  const errors = analysis.findings.filter((finding) => finding.severity === 'error').length
  const warnings = analysis.findings.filter((finding) => finding.severity === 'warning').length
  return {
    runID: diagnostics.run.id,
    diagnosticsPath,
    analysisPath,
    analysisJSONPath,
    passed: analysis.passed,
    errors,
    warnings,
  }
}

async function ensureLocalHostReady(options: CLIOptions): Promise<void> {
  const response = await fetch(`${options.baseURL}/local/v1/health`)
  if (!response.ok) {
    throw new Error(`Local Host health check failed: HTTP ${response.status}`)
  }
}

async function ensureCloudSession(options: CLIOptions): Promise<void> {
  let state = await requestJSON<LocalSessionState>(options, '/local/v1/session')
  if (!state.connected && options.cloudAccessToken) {
    state = await requestJSON<LocalSessionState>(options, '/local/v1/session', {
      method: 'POST',
      body: JSON.stringify({
        cloud_base_url: options.cloudBaseURL,
        access_token: options.cloudAccessToken,
      }),
    })
  }
  if (!state.connected) {
    throw new Error(
      'Local Host has no cloud session. Log in through Electron first, or set JIANDANLY_CLOUD_ACCESS_TOKEN for this smoke command.',
    )
  }
}

async function createRun(options: CLIOptions, goal: string): Promise<CreatedRun> {
  return await requestJSON<CreatedRun>(options, '/local/v1/runs', {
    method: 'POST',
    body: JSON.stringify({ goal }),
  })
}

async function cancelRun(options: CLIOptions, runID: string): Promise<void> {
  await requestJSON(options, `/local/v1/runs/${runID}/cancel`, { method: 'POST' })
}

async function getDiagnostics(options: CLIOptions, runID: string): Promise<LocalRunDiagnostics> {
  return await requestJSON<LocalRunDiagnostics>(options, `/local/v1/runs/${runID}/diagnostics`)
}

async function resolvePermission(options: CLIOptions, requestID: string, decision: 'approve' | 'deny'): Promise<void> {
  await requestJSON(options, `/local/v1/permissions/${requestID}`, {
    method: 'POST',
    body: JSON.stringify({ decision, scope: 'run' }),
  })
}

async function requestJSON<T>(
  options: CLIOptions,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const text = await requestText(options, path, init)
  return JSON.parse(text) as T
}

async function requestText(options: CLIOptions, path: string, init: RequestInit = {}): Promise<string> {
  const response = await fetch(`${options.baseURL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${options.token}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${path}: ${text.slice(0, 500)}`)
  }
  return text
}

function parseLocalEvents(raw: string): SerializedEvent[] {
  const events: SerializedEvent[] = []
  for (const block of raw.split(/\n\n+/)) {
    const dataLine = block.split('\n').find((line) => line.startsWith('data: '))
    if (!dataLine) {
      continue
    }
    const data = dataLine.slice('data: '.length)
    if (data === '[DONE]') {
      continue
    }
    try {
      const parsed = JSON.parse(data) as SerializedEvent
      if (typeof parsed.seq === 'number' && typeof parsed.event_type === 'string') {
        events.push(parsed)
      }
    } catch {
      // Ignore malformed SSE chunks; diagnostics fetch is the source of truth.
    }
  }
  return events
}

function parseOptions(args: string[], env: NodeJS.ProcessEnv): CLIOptions {
  const values = new Map<string, string>()
  const flags = new Set<string>()
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (!arg.startsWith('--')) {
      continue
    }
    const name = arg.slice(2)
    if (name === 'fail-on-warnings') {
      flags.add(name)
      continue
    }
    const value = args[index + 1]
    if (value && !value.startsWith('--')) {
      values.set(name, value)
      index += 1
    }
  }

  const baseURL = trimTrailingSlash(values.get('base-url') ?? env.JIANDANLY_LOCAL_HOST_URL ?? 'http://127.0.0.1:17371')
  const outputDir = resolve(
    values.get('output-dir')
      ?? env.JIANDANLY_RESEARCH_SMOKE_OUTPUT_DIR
      ?? join(process.cwd(), '..', '.tmp', 'agent-research-smoke'),
  )
  return {
    baseURL,
    token: values.get('token') ?? env.JIANDANLY_LOCAL_HOST_TOKEN ?? 'dev-local-token',
    goal: values.get('goal') ?? env.JIANDANLY_RESEARCH_SMOKE_GOAL ?? defaultGoal,
    iterations: positiveInteger(values.get('iterations') ?? env.JIANDANLY_RESEARCH_SMOKE_ITERATIONS, 1),
    outputDir,
    timeoutMs: positiveInteger(values.get('timeout-ms') ?? env.JIANDANLY_RESEARCH_SMOKE_TIMEOUT_MS, 10 * 60 * 1000),
    failOnWarnings: flags.has('fail-on-warnings') || isTruthy(env.JIANDANLY_RESEARCH_SMOKE_FAIL_ON_WARNINGS),
    allowedPermissionTools: parseToolAllowlist(env.JIANDANLY_RESEARCH_SMOKE_ALLOWED_PERMISSION_TOOLS),
    cloudBaseURL: env.JIANDANLY_CLOUD_BASE_URL,
    cloudAccessToken: env.JIANDANLY_CLOUD_ACCESS_TOKEN,
  }
}

function parseToolAllowlist(raw: string | undefined): Set<string> {
  if (!raw?.trim()) {
    return new Set(defaultAllowedPermissionTools)
  }
  return new Set(raw.split(',').map((item) => item.trim()).filter(Boolean))
}

function positiveInteger(raw: string | undefined, fallback: number): number {
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

function isTruthy(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value ?? '').toLowerCase())
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
