import { spawn } from 'node:child_process'
import { lookup } from 'node:dns/promises'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { arch as osArch, platform as osPlatform, release as osRelease } from 'node:os'
import { dirname, relative, resolve, sep } from 'node:path'
import type { LLMToolCall } from '../llm/gateway.js'
import type { LocalRun } from '../types.js'
import { callStdioMCPTool, parseMCPServersConfig, type MCPServerConfig } from './mcpRuntime.js'

export interface ToolExecutionResult {
  ok: boolean
  content: string
  data?: Record<string, unknown>
  errorCode?: string
  recoverable?: boolean
}

export interface BrowserSnapshot {
  url: string
  title: string
  visibleText: string
  links: Array<{ text: string; url: string }>
  forms: Array<{ action: string; fields: string[] }>
  buttons: string[]
}

export interface BrowserAdapter {
  open: (input: { url: string }) => Promise<BrowserSnapshot>
  snapshot: () => Promise<BrowserSnapshot>
  close: () => Promise<void>
}

export interface EnvironmentObservation {
  platform?: string
  arch?: string
  release?: string
  foregroundApp?: string
  windowTitle?: string
  screenPermission?: 'granted' | 'denied' | 'unknown'
}

export interface EnvironmentAdapter {
  observe: () => Promise<EnvironmentObservation>
}

export interface ToolExecutionOptions {
  fetcher?: typeof fetch
  resolveHostname?: (hostname: string) => Promise<string[]>
  opener?: (target: { kind: 'url' | 'file'; target: string }) => Promise<void>
  clipboard?: {
    readText: () => Promise<string>
    writeText: (text: string) => Promise<void>
  }
  browser?: BrowserAdapter
  environment?: EnvironmentAdapter
  tavilyApiKey?: string
  tavilyBaseURL?: string
  mcpAllowlist?: string[]
  mcpServers?: Record<string, MCPServerConfig>
  mcpTimeoutMs?: number
}

export async function executeTool(call: LLMToolCall, run: LocalRun, options: ToolExecutionOptions = {}): Promise<ToolExecutionResult> {
  switch (call.name) {
    case 'time.now':
      return {
        ok: true,
        content: new Date().toISOString(),
        data: {
          iso: new Date().toISOString(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          source: 'time.now',
        },
      }
    case 'fs.list':
      return listWorkspaceDirectory(call, run)
    case 'fs.read':
      return readWorkspaceFile(call, run, 'fs.read')
    case 'fs.search':
      return searchWorkspaceFiles(call, run, 'fs.search')
    case 'fs.write':
      return writeWorkspaceFile(call, run, 'fs.write')
    case 'file.read':
      return readWorkspaceFile(call, run, 'file.read')
    case 'file.search':
      return searchWorkspaceFiles(call, run, 'file.search')
    case 'file.write':
      return writeWorkspaceFile(call, run, 'file.write')
    case 'open.url':
      return openURL(call, options)
    case 'open.file':
      return openWorkspaceFile(call, run, options)
    case 'clipboard.read':
      return readClipboard(options)
    case 'clipboard.write':
      return writeClipboard(call, options)
    case 'task.verify':
      return verifyTask(call, run)
    case 'browser.open':
      return openManagedBrowser(call, options)
    case 'browser.snapshot':
      return snapshotManagedBrowser(call, options)
    case 'browser.close':
      return closeManagedBrowser(options)
    case 'environment.observe':
      return observeEnvironment(options)
    case 'shell.run':
      return runShellCommand(call, run)
    case 'web.fetch':
      return fetchPublicURL(call, options)
    case 'web.search':
      return searchWeb(call, options)
    case 'mcp.call':
      return callMCPTool(call, options)
    default:
      return {
        ok: false,
        content: `Unknown tool: ${call.name}`,
        errorCode: 'unknown_tool',
        recoverable: true,
      }
  }
}

export function pathInsideWorkspace(run: LocalRun, inputPath: unknown): { ok: true; path: string; root: string } | { ok: false; errorCode: string; message: string } {
  if (!run.workspacePath) {
    return { ok: false, errorCode: 'workspace_required', message: 'This tool requires an authorized workspace.' }
  }
  if (typeof inputPath !== 'string' || !inputPath.trim()) {
    return { ok: false, errorCode: 'path_required', message: 'A path is required.' }
  }
  const root = resolve(run.workspacePath)
  const target = resolve(root, inputPath)
  if (target !== root && !target.startsWith(root + sep)) {
    return { ok: false, errorCode: 'path_outside_workspace', message: 'Path is outside the authorized workspace.' }
  }
  return { ok: true, path: target, root }
}

async function listWorkspaceDirectory(call: LLMToolCall, run: LocalRun): Promise<ToolExecutionResult> {
  const checked = pathInsideWorkspace(run, typeof call.arguments.path === 'string' ? call.arguments.path : '.')
  if (!checked.ok) {
    return { ok: false, content: checked.message, errorCode: checked.errorCode, recoverable: true }
  }
  const maxEntries = typeof call.arguments.maxEntries === 'number' ? Math.max(1, Math.min(call.arguments.maxEntries, 500)) : 200
  try {
    const entries = await readdir(checked.path, { withFileTypes: true })
    const listed = entries.slice(0, maxEntries).map((entry) => ({
      name: entry.name,
      path: relative(checked.root, resolve(checked.path, entry.name)),
      type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
    }))
    return {
      ok: true,
      content: JSON.stringify(listed),
      data: {
        source: 'fs.list',
        path: relative(checked.root, checked.path) || '.',
        entries: listed,
        truncated: entries.length > listed.length,
      },
    }
  } catch (error) {
    return {
      ok: false,
      content: error instanceof Error ? error.message : 'Failed to list directory.',
      errorCode: 'fs_list_failed',
      recoverable: true,
    }
  }
}

async function readWorkspaceFile(call: LLMToolCall, run: LocalRun, source: string): Promise<ToolExecutionResult> {
  const checked = pathInsideWorkspace(run, call.arguments.path)
  if (!checked.ok) {
    return { ok: false, content: checked.message, errorCode: checked.errorCode, recoverable: true }
  }
  const maxBytes = typeof call.arguments.maxBytes === 'number' ? Math.max(1, Math.min(call.arguments.maxBytes, 65536)) : 65536
  try {
    const buffer = await readFile(checked.path)
    const truncated = buffer.length > maxBytes
    return {
      ok: true,
      content: buffer.subarray(0, maxBytes).toString('utf8'),
      data: {
        source,
        path: relative(checked.root, checked.path),
        bytes: buffer.length,
        truncated,
      },
    }
  } catch (error) {
    return {
      ok: false,
      content: error instanceof Error ? error.message : 'Failed to read file.',
      errorCode: source === 'fs.read' ? 'fs_read_failed' : 'file_read_failed',
      recoverable: true,
    }
  }
}

async function searchWorkspaceFiles(call: LLMToolCall, run: LocalRun, source: string): Promise<ToolExecutionResult> {
  if (!run.workspacePath) {
    return { ok: false, content: 'This tool requires an authorized workspace.', errorCode: 'workspace_required', recoverable: true }
  }
  const query = typeof call.arguments.query === 'string' ? call.arguments.query : ''
  if (!query.trim()) {
    return { ok: false, content: 'A query is required.', errorCode: 'query_required', recoverable: true }
  }
  const root = resolve(run.workspacePath)
  const start = call.arguments.path ? pathInsideWorkspace(run, call.arguments.path) : { ok: true as const, path: root, root }
  if (!start.ok) {
    return { ok: false, content: start.message, errorCode: start.errorCode, recoverable: true }
  }
  const maxResults = typeof call.arguments.maxResults === 'number' ? Math.max(1, Math.min(call.arguments.maxResults, 100)) : 20
  const results: Array<{ path: string; match: string }> = []
  await walk(start.path, async (filePath) => {
    if (results.length >= maxResults) {
      return
    }
    const rel = relative(root, filePath)
    if (rel.toLowerCase().includes(query.toLowerCase())) {
      results.push({ path: rel, match: 'filename' })
      return
    }
    try {
      const text = (await readFile(filePath)).toString('utf8')
      if (text.toLowerCase().includes(query.toLowerCase())) {
        results.push({ path: rel, match: 'content' })
      }
    } catch {
      // Binary or unreadable files are ignored for MVP search.
    }
  })
  return {
    ok: true,
    content: JSON.stringify(results),
    data: { source, results },
  }
}

async function writeWorkspaceFile(call: LLMToolCall, run: LocalRun, source: string): Promise<ToolExecutionResult> {
  const checked = pathInsideWorkspace(run, call.arguments.path)
  if (!checked.ok) {
    return { ok: false, content: checked.message, errorCode: checked.errorCode, recoverable: true }
  }
  const content = typeof call.arguments.content === 'string' ? call.arguments.content : undefined
  if (content === undefined) {
    return { ok: false, content: 'File content is required.', errorCode: 'content_required', recoverable: true }
  }
  const bytes = Buffer.byteLength(content)
  const maxBytes = 1024 * 1024
  if (bytes > maxBytes) {
    return {
      ok: false,
      content: `File content exceeds the ${maxBytes} byte limit.`,
      errorCode: 'content_too_large',
      recoverable: true,
    }
  }
  try {
    if (call.arguments.createDirs === true) {
      await mkdir(dirname(checked.path), { recursive: true })
    }
    await writeFile(checked.path, content, 'utf8')
    return {
      ok: true,
      content: `Wrote ${bytes} bytes to ${relative(checked.root, checked.path)}.`,
      data: {
        source,
        path: relative(checked.root, checked.path),
        bytes,
      },
    }
  } catch (error) {
    return {
      ok: false,
      content: error instanceof Error ? error.message : 'Failed to write file.',
      errorCode: source === 'fs.write' ? 'fs_write_failed' : 'file_write_failed',
      recoverable: true,
    }
  }
}

async function openURL(call: LLMToolCall, options: ToolExecutionOptions): Promise<ToolExecutionResult> {
  const rawURL = typeof call.arguments.url === 'string' ? call.arguments.url.trim() : ''
  const checked = validateOpenHTTPURL(rawURL)
  if (!checked.ok) {
    return { ok: false, content: checked.message, errorCode: checked.errorCode, recoverable: true }
  }
  try {
    await (options.opener ?? openWithSystemDefault)({ kind: 'url', target: checked.url.href })
    return {
      ok: true,
      content: `Opened URL: ${checked.url.href}`,
      data: { source: 'open.url', url: checked.url.href },
    }
  } catch (error) {
    return {
      ok: false,
      content: error instanceof Error ? error.message : 'Failed to open URL.',
      errorCode: 'open_url_failed',
      recoverable: true,
    }
  }
}

async function openWorkspaceFile(call: LLMToolCall, run: LocalRun, options: ToolExecutionOptions): Promise<ToolExecutionResult> {
  const checked = pathInsideWorkspace(run, call.arguments.path)
  if (!checked.ok) {
    return { ok: false, content: checked.message, errorCode: checked.errorCode, recoverable: true }
  }
  try {
    const stats = await stat(checked.path)
    if (!stats.isFile()) {
      return { ok: false, content: 'Path is not a file.', errorCode: 'path_not_file', recoverable: true }
    }
    await (options.opener ?? openWithSystemDefault)({ kind: 'file', target: checked.path })
    return {
      ok: true,
      content: `Opened file: ${relative(checked.root, checked.path)}`,
      data: { source: 'open.file', path: relative(checked.root, checked.path) },
    }
  } catch (error) {
    return {
      ok: false,
      content: error instanceof Error ? error.message : 'Failed to open file.',
      errorCode: 'open_file_failed',
      recoverable: true,
    }
  }
}

async function readClipboard(options: ToolExecutionOptions): Promise<ToolExecutionResult> {
  try {
    const text = await (options.clipboard ?? defaultClipboard()).readText()
    return {
      ok: true,
      content: text,
      data: { source: 'clipboard.read', characters: text.length },
    }
  } catch (error) {
    return {
      ok: false,
      content: error instanceof Error ? error.message : 'Failed to read clipboard.',
      errorCode: 'clipboard_read_failed',
      recoverable: true,
    }
  }
}

async function writeClipboard(call: LLMToolCall, options: ToolExecutionOptions): Promise<ToolExecutionResult> {
  const text = typeof call.arguments.text === 'string' ? call.arguments.text : undefined
  if (text === undefined) {
    return { ok: false, content: 'Clipboard text is required.', errorCode: 'clipboard_text_required', recoverable: true }
  }
  try {
    await (options.clipboard ?? defaultClipboard()).writeText(text)
    return {
      ok: true,
      content: `Wrote ${text.length} characters to the clipboard.`,
      data: { source: 'clipboard.write', characters: text.length },
    }
  } catch (error) {
    return {
      ok: false,
      content: error instanceof Error ? error.message : 'Failed to write clipboard.',
      errorCode: 'clipboard_write_failed',
      recoverable: true,
    }
  }
}

async function verifyTask(call: LLMToolCall, run: LocalRun): Promise<ToolExecutionResult> {
  const check = typeof call.arguments.check === 'string' ? call.arguments.check : ''
  try {
    if (check === 'file_exists') {
      const checked = pathInsideWorkspace(run, call.arguments.path)
      if (!checked.ok) {
        return { ok: false, content: checked.message, errorCode: checked.errorCode, recoverable: true }
      }
      await stat(checked.path)
      return verificationResult(check, true, `File exists: ${relative(checked.root, checked.path)}`)
    }
    if (check === 'file_contains') {
      const checked = pathInsideWorkspace(run, call.arguments.path)
      if (!checked.ok) {
        return { ok: false, content: checked.message, errorCode: checked.errorCode, recoverable: true }
      }
      const text = typeof call.arguments.text === 'string' ? call.arguments.text : ''
      if (!text) {
        return { ok: false, content: 'Text is required.', errorCode: 'text_required', recoverable: true }
      }
      const content = await readFile(checked.path, 'utf8')
      return verificationResult(check, content.includes(text), `File ${content.includes(text) ? 'contains' : 'does not contain'} requested text.`)
    }
    if (check === 'url_valid') {
      const rawURL = typeof call.arguments.url === 'string' ? call.arguments.url : ''
      const checked = validateOpenHTTPURL(rawURL)
      return verificationResult(check, checked.ok, checked.ok ? `URL is valid: ${checked.url.href}` : checked.message)
    }
    if (check === 'boolean') {
      return verificationResult(check, call.arguments.value === true, call.arguments.value === true ? 'Boolean assertion passed.' : 'Boolean assertion failed.')
    }
    return { ok: false, content: `Unsupported verification check: ${check}`, errorCode: 'unsupported_verification_check', recoverable: true }
  } catch (error) {
    return verificationResult(check, false, error instanceof Error ? error.message : 'Verification failed.')
  }
}

async function openManagedBrowser(call: LLMToolCall, options: ToolExecutionOptions): Promise<ToolExecutionResult> {
  const rawURL = typeof call.arguments.url === 'string' ? call.arguments.url.trim() : ''
  if (!rawURL) {
    return { ok: false, content: 'A URL is required.', errorCode: 'url_required', recoverable: true }
  }
  const checked = await validatePublicHTTPURL(rawURL, options)
  if (!checked.ok) {
    return { ok: false, content: checked.message, errorCode: checked.errorCode, recoverable: true }
  }
  try {
    const snapshot = await browserAdapter(options).open({ url: checked.url.href })
    return browserSnapshotResult('browser.open', snapshot, call.arguments.maxTextCharacters)
  } catch (error) {
    return toolErrorResult(error, 'browser_open_failed', 'Failed to open managed browser page.')
  }
}

async function snapshotManagedBrowser(call: LLMToolCall, options: ToolExecutionOptions): Promise<ToolExecutionResult> {
  try {
    const snapshot = await browserAdapter(options).snapshot()
    return browserSnapshotResult('browser.snapshot', snapshot, call.arguments.maxTextCharacters)
  } catch (error) {
    return toolErrorResult(error, 'browser_snapshot_failed', 'Failed to snapshot managed browser page.')
  }
}

async function closeManagedBrowser(options: ToolExecutionOptions): Promise<ToolExecutionResult> {
  try {
    await browserAdapter(options).close()
    return {
      ok: true,
      content: 'Managed browser page closed.',
      data: { source: 'browser.close' },
    }
  } catch (error) {
    return toolErrorResult(error, 'browser_close_failed', 'Failed to close managed browser page.')
  }
}

async function observeEnvironment(options: ToolExecutionOptions): Promise<ToolExecutionResult> {
  try {
    const observation = await (options.environment ?? defaultEnvironmentAdapter()).observe()
    const data: Record<string, unknown> = {
      source: 'environment.observe',
      platform: observation.platform ?? osPlatform(),
    }
    if (observation.arch) {
      data.arch = observation.arch
    }
    if (observation.release) {
      data.release = observation.release
    }
    if (observation.foregroundApp) {
      data.foreground_app = observation.foregroundApp
    }
    if (observation.windowTitle) {
      data.window_title = observation.windowTitle
    }
    data.screen_permission = observation.screenPermission ?? 'unknown'
    const lines = [
      `Platform: ${data.platform}`,
      observation.arch ? `Architecture: ${observation.arch}` : '',
      observation.release ? `OS release: ${observation.release}` : '',
      observation.foregroundApp ? `Foreground app: ${observation.foregroundApp}` : '',
      observation.windowTitle ? `Window title: ${observation.windowTitle}` : '',
      `Screen permission: ${data.screen_permission}`,
    ].filter(Boolean)
    return {
      ok: true,
      content: lines.join('\n'),
      data,
    }
  } catch (error) {
    return toolErrorResult(error, 'environment_observe_failed', 'Failed to observe local environment.')
  }
}

async function walk(dir: string, onFile: (filePath: string) => Promise<void>): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'build') {
      continue
    }
    const fullPath = resolve(dir, entry.name)
    if (entry.isDirectory()) {
      await walk(fullPath, onFile)
      continue
    }
    if (entry.isFile()) {
      await onFile(fullPath)
    }
  }
}

async function runShellCommand(call: LLMToolCall, run: LocalRun): Promise<ToolExecutionResult> {
  if (!run.workspacePath) {
    return { ok: false, content: 'This tool requires an authorized workspace.', errorCode: 'workspace_required', recoverable: true }
  }
  const command = typeof call.arguments.command === 'string' ? call.arguments.command : ''
  if (!command.trim()) {
    return { ok: false, content: 'A command is required.', errorCode: 'command_required', recoverable: true }
  }
  const cwdCheck = call.arguments.cwd ? pathInsideWorkspace(run, call.arguments.cwd) : { ok: true as const, path: resolve(run.workspacePath), root: resolve(run.workspacePath) }
  if (!cwdCheck.ok) {
    return { ok: false, content: cwdCheck.message, errorCode: cwdCheck.errorCode, recoverable: true }
  }
  const timeoutMs = typeof call.arguments.timeoutMs === 'number' ? Math.max(1000, Math.min(call.arguments.timeoutMs, 120000)) : 30000
  return new Promise<ToolExecutionResult>((resolveResult) => {
    const child = spawn(command, {
      cwd: cwdCheck.path,
      shell: true,
      env: process.env,
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      resolveResult({ ok: false, content: 'Command timed out.', errorCode: 'shell_timeout', recoverable: true })
    }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolveResult({ ok: false, content: error.message, errorCode: 'shell_failed', recoverable: true })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const output = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n')
      resolveResult({
        ok: code === 0,
        content: output,
        errorCode: code === 0 ? undefined : 'shell_nonzero_exit',
        recoverable: true,
        data: {
          exit_code: code,
          stdout: stdout.slice(0, 65536),
          stderr: stderr.slice(0, 65536),
        },
      })
    })
  })
}

async function fetchPublicURL(call: LLMToolCall, options: ToolExecutionOptions): Promise<ToolExecutionResult> {
  const rawURL = typeof call.arguments.url === 'string' ? call.arguments.url.trim() : ''
  if (!rawURL) {
    return { ok: false, content: 'A URL is required.', errorCode: 'url_required', recoverable: true }
  }
  const checked = await validatePublicHTTPURL(rawURL, options)
  if (!checked.ok) {
    return { ok: false, content: checked.message, errorCode: checked.errorCode, recoverable: true }
  }
  const maxBytes = typeof call.arguments.maxBytes === 'number' ? Math.max(1024, Math.min(call.arguments.maxBytes, 262144)) : 65536
  const timeoutMs = 10000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await (options.fetcher ?? fetch)(checked.url.href, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        Accept: 'text/html,text/plain,application/json,application/xml,text/xml;q=0.9,*/*;q=0.1',
        'User-Agent': 'JiandanlyLocalHarness/0.1',
      },
    })
    const finalURL = response.url || checked.url.href
    const finalChecked = await validatePublicHTTPURL(finalURL, options)
    if (!finalChecked.ok) {
      return { ok: false, content: finalChecked.message, errorCode: finalChecked.errorCode, recoverable: true }
    }
    const contentType = response.headers.get('content-type') ?? ''
    if (contentType && !isTextualContentType(contentType)) {
      return {
        ok: false,
        content: `Non-text response is not supported: ${contentType}`,
        errorCode: 'non_text_response',
        recoverable: true,
      }
    }
    const rawText = await readResponseText(response, maxBytes)
    const content = contentType.includes('html') ? extractHTMLText(rawText) : rawText
    return {
      ok: response.ok,
      content: content.slice(0, maxBytes),
      errorCode: response.ok ? undefined : 'http_error',
      recoverable: !response.ok,
      data: {
        url: finalChecked.url.href,
        status: response.status,
        content_type: contentType,
        bytes: Buffer.byteLength(rawText),
        truncated: Buffer.byteLength(rawText) >= maxBytes,
        source: 'web.fetch',
      },
    }
  } catch (error) {
    return {
      ok: false,
      content: error instanceof Error ? error.message : 'Fetch failed.',
      errorCode: 'fetch_failed',
      recoverable: true,
    }
  } finally {
    clearTimeout(timer)
  }
}

async function searchWeb(call: LLMToolCall, options: ToolExecutionOptions): Promise<ToolExecutionResult> {
  const query = typeof call.arguments.query === 'string' ? call.arguments.query.trim() : ''
  if (!query) {
    return { ok: false, content: 'A search query is required.', errorCode: 'query_required', recoverable: true }
  }
  const apiKey = options.tavilyApiKey ?? process.env.TAVILY_API_KEY
  if (!apiKey) {
    return {
      ok: false,
      content: 'web.search is disabled because TAVILY_API_KEY is not configured.',
      errorCode: 'web_search_disabled',
      recoverable: true,
    }
  }
  const maxResults = typeof call.arguments.maxResults === 'number' ? Math.max(1, Math.min(call.arguments.maxResults, 10)) : 5
  const baseURL = (options.tavilyBaseURL ?? process.env.TAVILY_BASE_URL ?? 'https://api.tavily.com').replace(/\/$/, '')
  try {
    const response = await (options.fetcher ?? fetch)(`${baseURL}/search`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        search_depth: 'basic',
        include_answer: true,
        include_raw_content: false,
        max_results: maxResults,
      }),
    })
    if (!response.ok) {
      return { ok: false, content: `Tavily search returned HTTP ${response.status}.`, errorCode: 'web_search_failed', recoverable: true }
    }
    const body = (await response.json()) as {
      answer?: string
      results?: Array<{ title?: string; url?: string; content?: string; score?: number }>
    }
    const results = (body.results ?? []).slice(0, maxResults).map((result) => ({
      title: result.title ?? '',
      url: result.url ?? '',
      content: (result.content ?? '').slice(0, 700),
      score: result.score,
    }))
    const content = [
      body.answer ? `Answer: ${body.answer}` : '',
      ...results.map((result, index) => [`${index + 1}. ${result.title}`, result.url, result.content].filter(Boolean).join('\n')),
    ]
      .filter(Boolean)
      .join('\n\n')
    return {
      ok: true,
      content,
      data: {
        provider: 'tavily',
        results_count: results.length,
        results,
        source: 'web.search',
      },
    }
  } catch (error) {
    return {
      ok: false,
      content: error instanceof Error ? error.message : 'Search failed.',
      errorCode: 'web_search_failed',
      recoverable: true,
    }
  }
}

async function callMCPTool(call: LLMToolCall, options: ToolExecutionOptions): Promise<ToolExecutionResult> {
  const server = typeof call.arguments.server === 'string' ? call.arguments.server.trim() : ''
  const tool = typeof call.arguments.tool === 'string' ? call.arguments.tool.trim() : ''
  if (!server || !tool) {
    return { ok: false, content: 'MCP server and tool are required.', errorCode: 'mcp_tool_required', recoverable: true }
  }
  const mcpTool = `${server}.${tool}`
  const allowlist = options.mcpAllowlist ?? parseCSV(process.env.JIANDANLY_MCP_ALLOWLIST)
  if (!allowlist.includes(mcpTool)) {
    return {
      ok: false,
      content: `MCP tool is not allowlisted: ${mcpTool}`,
      errorCode: 'mcp_tool_not_allowed',
      recoverable: true,
      data: { mcp_tool: mcpTool, allowed: false },
    }
  }
  let servers: Record<string, MCPServerConfig>
  try {
    servers = options.mcpServers ?? parseMCPServersConfig(process.env.JIANDANLY_MCP_SERVERS_JSON)
  } catch {
    return {
      ok: false,
      content: 'MCP server configuration is invalid JSON.',
      errorCode: 'mcp_servers_config_invalid',
      recoverable: true,
      data: { mcp_tool: mcpTool, allowed: true },
    }
  }
  const config = servers[server]
  if (!config) {
    return {
      ok: false,
      content: `MCP tool ${mcpTool} is allowlisted, but no local MCP server is configured for ${server}.`,
      errorCode: 'mcp_runtime_not_configured',
      recoverable: true,
      data: { mcp_tool: mcpTool, allowed: true },
    }
  }
  const input = call.arguments.input && typeof call.arguments.input === 'object' && !Array.isArray(call.arguments.input) ? call.arguments.input : {}
  const result = await callStdioMCPTool({
    server,
    tool,
    input: input as Record<string, unknown>,
    config,
    timeoutMs: options.mcpTimeoutMs,
  })
  return {
    ok: result.ok,
    content: result.content,
    errorCode: result.errorCode,
    recoverable: true,
    data: {
      mcp_tool: mcpTool,
      allowed: true,
      server,
      tool,
      content_types: result.contentTypes,
      is_tool_error: result.isToolError,
    },
  }
}

async function validatePublicHTTPURL(rawURL: string, options: ToolExecutionOptions): Promise<{ ok: true; url: URL } | { ok: false; errorCode: string; message: string }> {
  let url: URL
  try {
    url = new URL(rawURL)
  } catch {
    return { ok: false, errorCode: 'invalid_url', message: 'Invalid URL.' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, errorCode: 'invalid_url_scheme', message: 'Only http and https URLs are supported.' }
  }
  const hostname = url.hostname.toLowerCase()
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    return { ok: false, errorCode: 'ssrf_blocked', message: 'Localhost URLs are blocked.' }
  }
  const ips = isIP(hostname) ? [hostname] : await (options.resolveHostname ?? resolveHostname)(hostname)
  if (ips.length === 0 || ips.some(isBlockedIP)) {
    return { ok: false, errorCode: 'ssrf_blocked', message: 'Private, loopback, link-local, multicast, and reserved network targets are blocked.' }
  }
  return { ok: true, url }
}

async function resolveHostname(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true })
  return records.map((record) => record.address)
}

function isBlockedIP(ip: string): boolean {
  if (ip.includes(':')) {
    const lower = ip.toLowerCase()
    return lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')
  }
  const parts = ip.split('.').map((part) => Number(part))
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) {
    return true
  }
  const [a, b] = parts
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  )
}

function isTextualContentType(contentType: string): boolean {
  const lower = contentType.toLowerCase()
  return lower.startsWith('text/') || lower.includes('json') || lower.includes('xml') || lower.includes('markdown')
}

function validateOpenHTTPURL(rawURL: string): { ok: true; url: URL } | { ok: false; errorCode: string; message: string } {
  if (!rawURL.trim()) {
    return { ok: false, errorCode: 'url_required', message: 'A URL is required.' }
  }
  try {
    const url = new URL(rawURL)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { ok: false, errorCode: 'invalid_url_scheme', message: 'Only http and https URLs can be opened.' }
    }
    return { ok: true, url }
  } catch {
    return { ok: false, errorCode: 'invalid_url', message: 'Invalid URL.' }
  }
}

function verificationResult(check: string, passed: boolean, content: string): ToolExecutionResult {
  return {
    ok: passed,
    content,
    errorCode: passed ? undefined : 'verification_failed',
    recoverable: !passed,
    data: {
      source: 'task.verify',
      check,
      passed,
    },
  }
}

function browserAdapter(options: ToolExecutionOptions): BrowserAdapter {
  if (!options.browser) {
    options.browser = createFetchBrowserAdapter(options)
  }
  return options.browser
}

function createFetchBrowserAdapter(options: ToolExecutionOptions): BrowserAdapter {
  let currentSnapshot: BrowserSnapshot | undefined
  return {
    open: async ({ url }) => {
      currentSnapshot = await fetchBrowserSnapshot(url, options)
      return currentSnapshot
    },
    snapshot: async () => {
      if (!currentSnapshot) {
        throw recoverableToolError('browser_page_required', 'No managed browser page is open.')
      }
      return currentSnapshot
    },
    close: async () => {
      currentSnapshot = undefined
    },
  }
}

async function fetchBrowserSnapshot(url: string, options: ToolExecutionOptions): Promise<BrowserSnapshot> {
  const timeoutMs = 10000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await (options.fetcher ?? fetch)(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        Accept: 'text/html,text/plain,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.1',
        'User-Agent': 'JiandanlyLocalHarness/0.1',
      },
    })
    const finalURL = response.url || url
    const finalChecked = await validatePublicHTTPURL(finalURL, options)
    if (!finalChecked.ok) {
      throw recoverableToolError(finalChecked.errorCode, finalChecked.message)
    }
    const contentType = response.headers.get('content-type') ?? ''
    if (contentType && !isTextualContentType(contentType)) {
      throw recoverableToolError('non_text_response', `Non-text response is not supported: ${contentType}`)
    }
    if (!response.ok) {
      throw recoverableToolError('browser_http_error', `Managed browser page returned HTTP ${response.status}.`)
    }
    const rawText = await readResponseText(response, 262144)
    return parseBrowserSnapshot(rawText, finalChecked.url.href, contentType)
  } finally {
    clearTimeout(timer)
  }
}

function parseBrowserSnapshot(rawText: string, url: string, contentType: string): BrowserSnapshot {
  const isHTML = contentType.toLowerCase().includes('html') || /<html[\s>]/i.test(rawText) || /<body[\s>]/i.test(rawText)
  if (!isHTML) {
    return {
      url,
      title: new URL(url).hostname,
      visibleText: rawText.replace(/\s+/g, ' ').trim(),
      links: [],
      forms: [],
      buttons: [],
    }
  }
  const title = decodeHTML(extractHTMLText(firstMatch(rawText, /<title[^>]*>([\s\S]*?)<\/title>/i) ?? '') || new URL(url).hostname)
  const links = [...rawText.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)]
    .map((match) => {
      const href = attributeValue(match[1] ?? '', 'href')
      if (!href) {
        return undefined
      }
      const resolved = resolveBrowserURL(href, url)
      if (!resolved) {
        return undefined
      }
      return {
        text: decodeHTML(extractHTMLText(match[2] ?? '')).slice(0, 160),
        url: resolved,
      }
    })
    .filter((link): link is { text: string; url: string } => Boolean(link))
    .slice(0, 30)
  const forms = [...rawText.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)]
    .map((match) => {
      const action = resolveBrowserURL(attributeValue(match[1] ?? '', 'action') ?? url, url) ?? url
      const fields = [...(match[2] ?? '').matchAll(/\bname\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)]
        .map((field) => field[1] ?? field[2] ?? field[3] ?? '')
        .filter(Boolean)
        .slice(0, 30)
      return { action, fields }
    })
    .slice(0, 20)
  const buttons = [
    ...[...rawText.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/gi)].map((match) => decodeHTML(extractHTMLText(match[1] ?? ''))),
    ...[...rawText.matchAll(/<input\b([^>]*\btype\s*=\s*(?:"(?:submit|button)"|'(?:submit|button)'|(?:submit|button))[^>]*)>/gi)].map((match) =>
      attributeValue(match[1] ?? '', 'value') ?? 'button'
    ),
  ]
    .filter(Boolean)
    .slice(0, 30)
  return {
    url,
    title,
    visibleText: decodeHTML(extractHTMLText(rawText)),
    links,
    forms,
    buttons,
  }
}

function browserSnapshotResult(source: 'browser.open' | 'browser.snapshot', snapshot: BrowserSnapshot, maxTextCharacters: unknown): ToolExecutionResult {
  const maxText = typeof maxTextCharacters === 'number' ? Math.max(1, Math.min(Math.floor(maxTextCharacters), 60000)) : 6000
  const visibleText = snapshot.visibleText.slice(0, maxText).trim()
  const payload = {
    title: snapshot.title,
    url: snapshot.url,
    visible_text: visibleText,
    text_characters: snapshot.visibleText.length,
    text_truncated: snapshot.visibleText.length > visibleText.length,
    links: snapshot.links,
    forms: snapshot.forms,
    buttons: snapshot.buttons,
  }
  return {
    ok: true,
    content: JSON.stringify(payload),
    data: {
      source,
      url: snapshot.url,
      title: snapshot.title,
      text_characters: snapshot.visibleText.length,
      text_truncated: snapshot.visibleText.length > visibleText.length,
      links_count: snapshot.links.length,
      forms_count: snapshot.forms.length,
      buttons_count: snapshot.buttons.length,
    },
  }
}

function defaultEnvironmentAdapter(): EnvironmentAdapter {
  return {
    observe: async () => ({
      platform: osPlatform(),
      arch: osArch(),
      release: osRelease(),
      foregroundApp: 'unknown',
      windowTitle: 'unknown',
      screenPermission: 'unknown',
    }),
  }
}

function toolErrorResult(error: unknown, fallbackCode: string, fallbackMessage: string): ToolExecutionResult {
  const typed = error as Error & { errorCode?: string; recoverable?: boolean }
  return {
    ok: false,
    content: typed instanceof Error ? typed.message : fallbackMessage,
    errorCode: typed?.errorCode ?? fallbackCode,
    recoverable: typed?.recoverable ?? true,
  }
}

function recoverableToolError(errorCode: string, message: string): Error & { errorCode: string; recoverable: boolean } {
  const error = new Error(message) as Error & { errorCode: string; recoverable: boolean }
  error.errorCode = errorCode
  error.recoverable = true
  return error
}

function firstMatch(input: string, pattern: RegExp): string | undefined {
  return pattern.exec(input)?.[1]
}

function attributeValue(input: string, name: string): string | undefined {
  const match = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(input)
  return match?.[1] ?? match?.[2] ?? match?.[3]
}

function resolveBrowserURL(input: string, baseURL: string): string | undefined {
  try {
    return new URL(input, baseURL).href
  } catch {
    return undefined
  }
}

function decodeHTML(input: string): string {
  return input
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

async function openWithSystemDefault(target: { kind: 'url' | 'file'; target: string }): Promise<void> {
  const platform = process.platform
  if (platform === 'darwin') {
    await runDetached('open', [target.target])
    return
  }
  if (platform === 'win32') {
    await runDetached('cmd', ['/c', 'start', '', target.target])
    return
  }
  await runDetached('xdg-open', [target.target])
}

function defaultClipboard(): NonNullable<ToolExecutionOptions['clipboard']> {
  return {
    readText: async () => {
      if (process.platform === 'darwin') {
        return runForOutput('pbpaste', [])
      }
      if (process.platform === 'win32') {
        return runForOutput('powershell.exe', ['-NoProfile', '-Command', 'Get-Clipboard'])
      }
      return runForOutput('sh', ['-lc', 'command -v wl-paste >/dev/null 2>&1 && wl-paste || xclip -selection clipboard -o'])
    },
    writeText: async (text: string) => {
      if (process.platform === 'darwin') {
        await runWithInput('pbcopy', [], text)
        return
      }
      if (process.platform === 'win32') {
        await runWithInput('powershell.exe', ['-NoProfile', '-Command', 'Set-Clipboard'], text)
        return
      }
      await runWithInput('sh', ['-lc', 'command -v wl-copy >/dev/null 2>&1 && wl-copy || xclip -selection clipboard'], text)
    },
  }
}

async function runDetached(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    child.on('error', reject)
    child.on('spawn', () => {
      child.unref()
      resolvePromise()
    })
  })
}

async function runForOutput(command: string, args: string[]): Promise<string> {
  return new Promise<string>((resolvePromise, reject) => {
    const child = spawn(command, args)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolvePromise(stdout)
        return
      }
      reject(new Error(stderr.trim() || `${command} exited with ${code}`))
    })
  })
}

async function runWithInput(command: string, args: string[], input: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args)
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolvePromise()
        return
      }
      reject(new Error(stderr.trim() || `${command} exited with ${code}`))
    })
    child.stdin.end(input)
  })
}

async function readResponseText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) {
    return response.text()
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    if (!value) {
      continue
    }
    size += value.byteLength
    chunks.push(value)
    if (size >= maxBytes) {
      break
    }
  }
  const merged = new Uint8Array(Math.min(size, maxBytes))
  let offset = 0
  for (const chunk of chunks) {
    const slice = chunk.slice(0, Math.max(0, Math.min(chunk.byteLength, maxBytes - offset)))
    merged.set(slice, offset)
    offset += slice.byteLength
    if (offset >= maxBytes) {
      break
    }
  }
  return new TextDecoder().decode(merged)
}

function extractHTMLText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

function parseCSV(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}
