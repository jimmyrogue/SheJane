import { spawn } from 'node:child_process'
import { lookup } from 'node:dns/promises'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { arch as osArch, platform as osPlatform, release as osRelease } from 'node:os'
import { dirname, relative, resolve, sep } from 'node:path'
import type { LLMToolCall } from '../llm/gateway.js'
import type { LocalMemoryEntry, LocalRun } from '../types.js'
import { callStdioMCPTool, parseMCPServersConfig, type MCPServerConfig } from './mcpRuntime.js'

type PlaywrightModule = typeof import('playwright')
type PlaywrightBrowser = Awaited<ReturnType<PlaywrightModule['chromium']['launch']>>
type PlaywrightContext = Awaited<ReturnType<PlaywrightBrowser['newContext']>>
type PlaywrightPage = Awaited<ReturnType<PlaywrightContext['newPage']>>

export interface ToolExecutionResult {
  ok: boolean
  content: string
  data?: Record<string, unknown>
  errorCode?: string
  recoverable?: boolean
  usage?: Record<string, unknown>
  artifact?: {
    title: string
    content: string
    contentType: string
    metadata?: Record<string, unknown>
  }
}

export interface CloudToolExecuteRequest {
  runId: string
  toolCallId: string
  tool: string
  arguments: Record<string, unknown>
  idempotencyKey: string
}

export interface CloudToolCapabilities {
  tools: Record<string, { configured: boolean; provider?: string; credits_cost?: number; requires_auth?: boolean }>
}

export interface CloudToolGateway {
  capabilities: () => Promise<CloudToolCapabilities>
  execute: (request: CloudToolExecuteRequest) => Promise<ToolExecutionResult>
}

export interface BrowserElement {
  ref: string
  role: string
  name: string
  text?: string
  tag?: string
  href?: string
}

export interface BrowserScreenshot {
  content: string
  contentType: string
  bytes: number
  title: string
}

export type BrowserObservationStatus = 'usable' | 'empty' | 'http_error' | 'blocked' | 'login_required' | 'captcha_like'

export interface BrowserSnapshot {
  url: string
  title: string
  description?: string
  visibleText: string
  httpStatus?: number
  links: Array<{ text: string; url: string }>
  forms: Array<{ action: string; fields: string[] }>
  buttons: string[]
  elements?: BrowserElement[]
}

export interface BrowserAdapter {
  open: (input: { url: string }) => Promise<BrowserSnapshot>
  search: (input: { query: string; url: string }) => Promise<BrowserSnapshot>
  snapshot: () => Promise<BrowserSnapshot>
  screenshot: (input?: { fullPage?: boolean }) => Promise<BrowserScreenshot>
  click: (input: { ref: string }) => Promise<BrowserSnapshot>
  type: (input: { ref: string; text: string }) => Promise<BrowserSnapshot>
  scroll: (input: { direction?: string; amount?: number }) => Promise<BrowserSnapshot>
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
  browserEngine?: 'playwright' | 'fetch' | 'cloakbrowser'
  browserHeadless?: boolean
  browserTimeoutMs?: number
  browserSearchURL?: string
  browserViewport?: { width: number; height: number }
  browserObservationCounts?: Map<string, number>
  allowProxyFakeIPs?: boolean
  environment?: EnvironmentAdapter
  cloudToolGateway?: CloudToolGateway
  cloudToolCapabilities?: CloudToolCapabilities
  mcpAllowlist?: string[]
  mcpServers?: Record<string, MCPServerConfig>
  mcpTimeoutMs?: number
  /**
   * Read-only window onto the user's long-term memory. The runner injects an
   * adapter that prunes expired entries, runs the keyword search, then slides
   * the expiry of the hits forward (Phase 6 TTL). Absent => memory.search is a
   * no-op returning an empty result (feature off).
   */
  memory?: {
    search: (query: string, limit: number) => LocalMemoryEntry[]
  }
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
    case 'memory.search':
      return searchMemory(call, options)
    case 'browser.open':
      return openManagedBrowser(call, options)
    case 'browser.search':
      return searchManagedBrowser(call, options)
    case 'browser.snapshot':
      return snapshotManagedBrowser(call, options)
    case 'browser.read':
      return readManagedBrowser(call, options)
    case 'browser.verify':
      return verifyManagedBrowser(call, options)
    case 'browser.screenshot':
      return screenshotManagedBrowser(call, options)
    case 'browser.click':
      return clickManagedBrowser(call, options)
    case 'browser.type':
      return typeManagedBrowser(call, options)
    case 'browser.scroll':
      return scrollManagedBrowser(call, options)
    case 'browser.close':
      return closeManagedBrowser(options)
    case 'environment.observe':
      return observeEnvironment(options)
    case 'shell.run':
      return runShellCommand(call, run)
    case 'web.fetch':
      return fetchPublicURL(call, options)
    case 'web.search':
      return searchWeb(call, run, options)
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

async function searchMemory(call: LLMToolCall, options: ToolExecutionOptions): Promise<ToolExecutionResult> {
  const query = typeof call.arguments.query === 'string' ? call.arguments.query.trim() : ''
  if (!query) {
    return { ok: false, content: 'A query is required.', errorCode: 'query_required', recoverable: true }
  }
  const limit =
    typeof call.arguments.limit === 'number' && Number.isFinite(call.arguments.limit)
      ? Math.max(1, Math.min(Math.floor(call.arguments.limit), 10))
      : 5
  let entries: LocalMemoryEntry[] = []
  try {
    entries = options.memory ? options.memory.search(query, limit) : []
  } catch (error) {
    return {
      ok: false,
      content: error instanceof Error ? error.message : 'Memory search failed.',
      errorCode: 'memory_search_failed',
      recoverable: true,
    }
  }
  if (entries.length === 0) {
    return {
      ok: true,
      content: 'No matching long-term memory found.',
      data: { source: 'memory.search', query, count: 0, matches: [] },
    }
  }
  const matches = entries.map((entry) => ({ title: entry.title, summary: entry.summary, content: entry.content }))
  const content = entries
    .map((entry) => `## ${entry.title}\n${entry.summary}\n${entry.content}`)
    .join('\n\n')
  return {
    ok: true,
    content,
    data: { source: 'memory.search', query, count: entries.length, matches },
  }
}

async function openManagedBrowser(call: LLMToolCall, options: ToolExecutionOptions): Promise<ToolExecutionResult> {
  const rawURL = typeof call.arguments.url === 'string' ? call.arguments.url.trim() : ''
  if (!rawURL) {
    return { ok: false, content: 'A URL is required.', errorCode: 'url_required', recoverable: true }
  }
  const checked = await validatePublicHTTPURL(rawURL, options)
  if (!checked.ok) {
    return blockedBrowserObservation('browser.open', checked.message, checked.errorCode, { url: rawURL })
  }
  const duplicate = browserDuplicateObservation(options, 'browser.open', duplicateURLKey(checked.url))
  if (duplicate) {
    return duplicate
  }
  try {
    const snapshot = await browserAdapter(options).open({ url: checked.url.href })
    return browserSnapshotResult('browser.open', snapshot, call.arguments.maxTextCharacters)
  } catch (error) {
    return toolErrorResult(error, 'browser_open_failed', 'Failed to open managed browser page.')
  }
}

async function searchManagedBrowser(call: LLMToolCall, options: ToolExecutionOptions): Promise<ToolExecutionResult> {
  const query = typeof call.arguments.query === 'string' ? call.arguments.query.trim() : ''
  if (!query) {
    return { ok: false, content: 'A search query is required.', errorCode: 'query_required', recoverable: true }
  }
  const searchURL = buildBrowserSearchURL(query, options)
  const checked = await validatePublicHTTPURL(searchURL, options)
  if (!checked.ok) {
    return blockedBrowserObservation('browser.search', checked.message, checked.errorCode, { query, url: searchURL })
  }
  const duplicate = browserDuplicateObservation(options, 'browser.search', duplicateQueryKey(query))
  if (duplicate) {
    return duplicate
  }
  try {
    const snapshot = await browserAdapter(options).search({ query, url: checked.url.href })
    return browserSnapshotResult('browser.search', snapshot, call.arguments.maxTextCharacters)
  } catch (error) {
    return toolErrorResult(error, 'browser_search_failed', 'Failed to search with managed browser.')
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

async function readManagedBrowser(call: LLMToolCall, options: ToolExecutionOptions): Promise<ToolExecutionResult> {
  try {
    const snapshot = await browserAdapter(options).snapshot()
    return browserReadResult(snapshot, call.arguments.maxTextCharacters)
  } catch (error) {
    return toolErrorResult(error, 'browser_read_failed', 'Failed to read managed browser page.')
  }
}

async function verifyManagedBrowser(call: LLMToolCall, options: ToolExecutionOptions): Promise<ToolExecutionResult> {
  try {
    const adapter = browserAdapter(options)
    const snapshot = await adapter.snapshot()
    const screenshot = call.arguments.includeScreenshot === true
      ? await adapter.screenshot({ fullPage: true })
      : undefined
    return browserVerifyResult(snapshot, {
      expectText: typeof call.arguments.expectText === 'string' ? call.arguments.expectText.trim() : '',
      requireUsable: call.arguments.requireUsable !== false,
      screenshot,
    })
  } catch (error) {
    return toolErrorResult(error, 'browser_verify_failed', 'Failed to verify managed browser page.')
  }
}

async function screenshotManagedBrowser(call: LLMToolCall, options: ToolExecutionOptions): Promise<ToolExecutionResult> {
  try {
    const screenshot = await browserAdapter(options).screenshot({ fullPage: call.arguments.fullPage === true })
    return {
      ok: true,
      content: `Screenshot captured: ${screenshot.title} (${screenshot.bytes} bytes).`,
      data: {
        source: 'browser.screenshot',
        title: screenshot.title,
        content_type: screenshot.contentType,
        bytes: screenshot.bytes,
      },
      artifact: {
        title: screenshot.title,
        content: screenshot.content,
        contentType: screenshot.contentType,
        metadata: {
          source: 'browser.screenshot',
          bytes: screenshot.bytes,
        },
      },
    }
  } catch (error) {
    return toolErrorResult(error, 'browser_screenshot_failed', 'Failed to capture managed browser screenshot.')
  }
}

async function clickManagedBrowser(call: LLMToolCall, options: ToolExecutionOptions): Promise<ToolExecutionResult> {
  const ref = typeof call.arguments.ref === 'string' ? call.arguments.ref.trim() : ''
  if (!ref) {
    return { ok: false, content: 'A browser element ref is required.', errorCode: 'browser_ref_required', recoverable: true }
  }
  try {
    const snapshot = await browserAdapter(options).click({ ref })
    const checked = await validatePublicHTTPURL(snapshot.url, options)
    if (!checked.ok) {
      return { ok: false, content: checked.message, errorCode: checked.errorCode, recoverable: true }
    }
    return browserSnapshotResult('browser.click', snapshot, call.arguments.maxTextCharacters)
  } catch (error) {
    return toolErrorResult(error, 'browser_click_failed', 'Failed to click managed browser element.')
  }
}

async function typeManagedBrowser(call: LLMToolCall, options: ToolExecutionOptions): Promise<ToolExecutionResult> {
  const ref = typeof call.arguments.ref === 'string' ? call.arguments.ref.trim() : ''
  const text = typeof call.arguments.text === 'string' ? call.arguments.text : ''
  if (!ref) {
    return { ok: false, content: 'A browser element ref is required.', errorCode: 'browser_ref_required', recoverable: true }
  }
  if (!text) {
    return { ok: false, content: 'Text is required.', errorCode: 'text_required', recoverable: true }
  }
  try {
    const snapshot = await browserAdapter(options).type({ ref, text })
    return browserSnapshotResult('browser.type', snapshot, call.arguments.maxTextCharacters)
  } catch (error) {
    return toolErrorResult(error, 'browser_type_failed', 'Failed to type into managed browser element.')
  }
}

async function scrollManagedBrowser(call: LLMToolCall, options: ToolExecutionOptions): Promise<ToolExecutionResult> {
  try {
    const snapshot = await browserAdapter(options).scroll({
      direction: typeof call.arguments.direction === 'string' ? call.arguments.direction : 'down',
      amount: typeof call.arguments.amount === 'number' ? call.arguments.amount : undefined,
    })
    return browserSnapshotResult('browser.scroll', snapshot, call.arguments.maxTextCharacters)
  } catch (error) {
    return toolErrorResult(error, 'browser_scroll_failed', 'Failed to scroll managed browser page.')
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
    if (!response.ok) {
      const preview = content.replace(/\s+/g, ' ').trim().slice(0, 80)
      return {
        ok: false,
        content: JSON.stringify({
          error: `HTTP ${response.status} ${response.statusText || ''}`.trim(),
          url: finalChecked.url.href,
          status: response.status,
          content_preview: preview,
          content_characters: content.length,
          truncated: Buffer.byteLength(rawText) >= maxBytes,
        }),
        errorCode: 'http_error',
        recoverable: true,
        data: {
          url: finalChecked.url.href,
          status: response.status,
          content_type: contentType,
          bytes: Buffer.byteLength(rawText),
          truncated: Buffer.byteLength(rawText) >= maxBytes,
          source: 'web.fetch',
        },
      }
    }
    return {
      ok: true,
      content: content.slice(0, maxBytes),
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

async function searchWeb(call: LLMToolCall, run: LocalRun, options: ToolExecutionOptions): Promise<ToolExecutionResult> {
  const query = typeof call.arguments.query === 'string' ? call.arguments.query.trim() : ''
  if (!query) {
    return { ok: false, content: 'A search query is required.', errorCode: 'query_required', recoverable: true }
  }
  if (!options.cloudToolGateway) {
    return {
      ok: false,
      content: 'web.search requires an active cloud session because paid search providers are executed by the Cloud Tool Gateway.',
      errorCode: 'cloud_session_required',
      recoverable: true,
      data: {
        source: 'web.search',
      },
    }
  }
  const maxResults = typeof call.arguments.maxResults === 'number' ? Math.max(1, Math.min(call.arguments.maxResults, 10)) : 5
  try {
    const result = await options.cloudToolGateway.execute({
      runId: run.id,
      toolCallId: call.id,
      tool: 'web.search',
      arguments: {
        query,
        maxResults,
      },
      idempotencyKey: `${run.id}:${call.id}:web.search`,
    })
    return {
      ...result,
      data: {
        source: 'web.search',
        ...(result.data ?? {}),
      },
    }
  } catch (error) {
    return {
      ok: false,
      content: error instanceof Error ? error.message : 'Search failed.',
      errorCode: 'cloud_tool_gateway_failed',
      recoverable: true,
      data: {
        source: 'web.search',
      },
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
  let ips: string[]
  try {
    ips = isIP(hostname) ? [hostname] : await (options.resolveHostname ?? resolveHostname)(hostname)
  } catch (error) {
    return {
      ok: false,
      errorCode: 'dns_resolution_failed',
      message: `DNS resolution failed for ${hostname}: ${error instanceof Error ? error.message : 'unknown error'}`,
    }
  }
  const allowFakeIPs = allowProxyFakeIPs(options)
  if (ips.length === 0 || ips.some((ip) => isBlockedIP(ip, allowFakeIPs))) {
    return {
      ok: false,
      errorCode: 'ssrf_blocked',
      message: `Private, loopback, link-local, multicast, and reserved network targets are blocked for ${hostname}. resolved_ips=${ips.join(',') || 'none'}`,
    }
  }
  return { ok: true, url }
}

async function resolveHostname(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true })
  return records.map((record) => record.address)
}

function isBlockedIP(ip: string, allowProxyFakeIPs = false): boolean {
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
    (!allowProxyFakeIPs && a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  )
}

function allowProxyFakeIPs(options: ToolExecutionOptions): boolean {
  if (typeof options.allowProxyFakeIPs === 'boolean') {
    return options.allowProxyFakeIPs
  }
  return (process.env.JIANDANLY_ALLOW_PROXY_FAKE_IPS ?? 'true').toLowerCase() !== 'false'
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
    const engine = (options.browserEngine ?? process.env.JIANDANLY_BROWSER_ENGINE ?? 'playwright').toLowerCase()
    if (engine === 'fetch') {
      options.browser = createFetchBrowserAdapter(options)
    } else if (engine === 'playwright') {
      options.browser = createPlaywrightBrowserAdapter(options)
    } else if (engine === 'cloakbrowser') {
      throw recoverableToolError('browser_engine_unavailable', 'CloakBrowser is reserved as a future optional engine and is not bundled in this phase.')
    } else {
      throw recoverableToolError('browser_engine_unsupported', `Unsupported browser engine: ${engine}`)
    }
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
    search: async ({ url }) => {
      currentSnapshot = await fetchBrowserSnapshot(url, options)
      return currentSnapshot
    },
    snapshot: async () => {
      if (!currentSnapshot) {
        throw recoverableToolError('browser_page_required', 'No managed browser page is open.')
      }
      return currentSnapshot
    },
    screenshot: async () => {
      throw recoverableToolError('browser_action_unavailable', 'The fetch-backed browser adapter cannot capture screenshots.')
    },
    click: async () => {
      throw recoverableToolError('browser_action_unavailable', 'The fetch-backed browser adapter cannot click page elements.')
    },
    type: async () => {
      throw recoverableToolError('browser_action_unavailable', 'The fetch-backed browser adapter cannot type into page elements.')
    },
    scroll: async () => {
      throw recoverableToolError('browser_action_unavailable', 'The fetch-backed browser adapter cannot scroll pages.')
    },
    close: async () => {
      currentSnapshot = undefined
    },
  }
}

function createPlaywrightBrowserAdapter(options: ToolExecutionOptions): BrowserAdapter {
  let browser: PlaywrightBrowser | undefined
  let context: PlaywrightContext | undefined
  let page: PlaywrightPage | undefined
  const timeoutMs = browserTimeoutMs(options)

  const ensurePage = async (): Promise<PlaywrightPage> => {
    if (page && !page.isClosed()) {
      return page
    }
    const { chromium } = await import('playwright')
    browser = browser ?? (await chromium.launch({ headless: browserHeadless(options) }))
    context = context ?? (await browser.newContext({ viewport: browserViewport(options) }))
    page = await context.newPage()
    page.setDefaultTimeout(timeoutMs)
    page.setDefaultNavigationTimeout(timeoutMs)
    return page
  }

  const currentPage = (): PlaywrightPage => {
    if (!page || page.isClosed()) {
      throw recoverableToolError('browser_page_required', 'No managed browser page is open.')
    }
    return page
  }

  const snapshot = async (): Promise<BrowserSnapshot> => snapshotPlaywrightPage(currentPage())

  return {
    open: async ({ url }) => {
      const checked = await validatePublicHTTPURL(url, options)
      if (!checked.ok) {
        throw recoverableToolError(checked.errorCode, checked.message)
      }
      const targetPage = await ensurePage()
      const response = await targetPage.goto(checked.url.href, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
      await settlePlaywrightPage(targetPage, timeoutMs)
      return snapshotPlaywrightPage(targetPage, response?.status())
    },
    search: async ({ url }) => {
      const checked = await validatePublicHTTPURL(url, options)
      if (!checked.ok) {
        throw recoverableToolError(checked.errorCode, checked.message)
      }
      const targetPage = await ensurePage()
      const response = await targetPage.goto(checked.url.href, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
      await settlePlaywrightPage(targetPage, timeoutMs)
      return snapshotPlaywrightPage(targetPage, response?.status())
    },
    snapshot,
    screenshot: async ({ fullPage } = {}) => {
      const targetPage = currentPage()
      const buffer = await targetPage.screenshot({ fullPage: fullPage === true, type: 'png', timeout: timeoutMs })
      const title = (await targetPage.title().catch(() => 'Browser page')) || 'Browser page'
      return {
        content: buffer.toString('base64'),
        contentType: 'image/png',
        bytes: buffer.length,
        title: `${title} screenshot`,
      }
    },
    click: async ({ ref }) => {
      const targetPage = currentPage()
      const beforeURL = targetPage.url()
      const locator = targetPage.locator(browserRefSelector(ref)).first()
      const risk = await locator.evaluate((element: unknown) => {
        const candidate = element as {
          innerText?: string
          textContent?: string
          value?: string
          href?: string
          getAttribute?: (name: string) => string | null
        }
        const label = [
          candidate.getAttribute?.('aria-label'),
          candidate.innerText,
          candidate.textContent,
          candidate.value,
          candidate.href,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
        const hasDownload = Boolean(candidate.getAttribute?.('download'))
        const riskyAction = /(download|checkout|place order|submit order|purchase|buy now|pay now|subscribe|post|send email|下载|结账|下单|提交订单|购买|支付|订阅|发帖|发送邮件)/i.test(label)
        return {
          blocked: hasDownload || riskyAction,
          reason: hasDownload ? 'download' : riskyAction ? 'high_risk_action' : '',
        }
      })
      if (risk.blocked) {
        throw recoverableToolError('browser_high_risk_action_blocked', `High-risk browser action is blocked in this phase: ${risk.reason}`)
      }
      await locator.click({ timeout: timeoutMs })
      await settlePlaywrightPage(targetPage, timeoutMs)
      const checked = await validatePublicHTTPURL(targetPage.url(), options)
      if (!checked.ok) {
        await rollbackUnsafeNavigation(targetPage, beforeURL, timeoutMs)
        throw recoverableToolError('browser_navigation_blocked', checked.message)
      }
      return snapshotPlaywrightPage(targetPage)
    },
    type: async ({ ref, text }) => {
      const targetPage = currentPage()
      const locator = targetPage.locator(browserRefSelector(ref)).first()
      const sensitive = await locator.evaluate((element: unknown) => {
        const input = element as { getAttribute?: (name: string) => string | null }
        const type = input.getAttribute?.('type')?.toLowerCase() ?? ''
        const autocomplete = input.getAttribute?.('autocomplete')?.toLowerCase() ?? ''
        return type === 'password' || autocomplete === 'one-time-code' || autocomplete === 'current-password'
      })
      if (sensitive) {
        throw recoverableToolError('browser_sensitive_input_blocked', 'Typing into password or one-time-code fields is blocked in this phase.')
      }
      await locator.fill(text, { timeout: timeoutMs })
      await settlePlaywrightPage(targetPage, timeoutMs)
      return snapshotPlaywrightPage(targetPage)
    },
    scroll: async ({ direction, amount }) => {
      const targetPage = currentPage()
      const delta = Math.max(100, Math.min(amount ?? 700, 5000)) * (direction === 'up' ? -1 : 1)
      await targetPage.mouse.wheel(0, delta)
      await settlePlaywrightPage(targetPage, timeoutMs)
      return snapshotPlaywrightPage(targetPage)
    },
    close: async () => {
      await page?.close().catch(() => undefined)
      await context?.close().catch(() => undefined)
      await browser?.close().catch(() => undefined)
      page = undefined
      context = undefined
      browser = undefined
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

export const browserSnapshotScript = String.raw`(() => {
  const doc = globalThis.document;
  const locationHref = globalThis.location.href;
  const toArray = (value) => Array.from(value || []);
  const textOf = (element) => (
    element.getAttribute?.('aria-label') ||
    element.innerText ||
    element.value ||
    element.placeholder ||
    element.textContent ||
    ''
  ).replace(/\s+/g, ' ').trim().slice(0, 180);
  const resolveURL = (value) => {
    if (typeof value !== 'string' || !value) return undefined;
    try {
      return new URL(value, locationHref).href;
    } catch {
      return undefined;
    }
  };
  const isVisible = (element) => {
    const rect = element.getBoundingClientRect?.();
    const style = globalThis.getComputedStyle?.(element);
    return Boolean(rect && rect.width > 0 && rect.height > 0 && style?.visibility !== 'hidden' && style?.display !== 'none');
  };
  const elementRole = (element) => {
    const explicit = element.getAttribute?.('role');
    if (explicit) return explicit;
    const tag = element.tagName?.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'input' || tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    return tag || 'element';
  };
  const metaDescription = (
    doc.querySelector?.('meta[name="description"]')?.getAttribute?.('content') ||
    doc.querySelector?.('meta[property="og:description"]')?.getAttribute?.('content') ||
    ''
  ).replace(/\s+/g, ' ').trim();

  const links = toArray(doc.querySelectorAll('a[href]'))
    .filter(isVisible)
    .map((element) => ({
      text: textOf(element),
      url: resolveURL(element.getAttribute?.('href')) || '',
    }))
    .filter((link) => link.url)
    .slice(0, 50);
  const forms = toArray(doc.querySelectorAll('form'))
    .map((form) => {
      const fields = toArray(form.querySelectorAll?.('input[name], textarea[name], select[name]'))
        .map((field) => field.getAttribute?.('name') || '')
        .filter(Boolean)
        .slice(0, 30);
      return {
        action: resolveURL(form.getAttribute?.('action')) || locationHref,
        fields,
      };
    })
    .slice(0, 20);
  const buttons = toArray(doc.querySelectorAll('button, input[type="submit"], input[type="button"]'))
    .filter(isVisible)
    .map(textOf)
    .filter(Boolean)
    .slice(0, 50);
  const elements = toArray(doc.querySelectorAll('a[href], button, input, textarea, select, [role="button"], [contenteditable="true"]'))
    .filter(isVisible)
    .slice(0, 100)
    .map((element, index) => {
      const ref = 'el-' + (index + 1);
      element.setAttribute?.('data-jiandanly-ref', ref);
      const href = resolveURL(element.getAttribute?.('href'));
      const text = textOf(element);
      return {
        ref,
        role: elementRole(element),
        name: text || href || ref,
        text,
        tag: element.tagName?.toLowerCase(),
        href,
      };
    });

  return {
    url: locationHref,
    title: doc.title || new URL(locationHref).hostname,
    description: metaDescription,
    visibleText: (doc.body?.innerText || '').replace(/\s+/g, ' ').trim(),
    links,
    forms,
    buttons,
    elements,
  };
})()`

async function snapshotPlaywrightPage(page: PlaywrightPage, httpStatus?: number): Promise<BrowserSnapshot> {
  const snapshot = (await page.evaluate(browserSnapshotScript)) as BrowserSnapshot
  return normalizeBrowserSnapshot({ ...snapshot, httpStatus })
}

function parseBrowserSnapshot(rawText: string, url: string, contentType: string): BrowserSnapshot {
  const isHTML = contentType.toLowerCase().includes('html') || /<html[\s>]/i.test(rawText) || /<body[\s>]/i.test(rawText)
  if (!isHTML) {
    return {
      url,
      title: new URL(url).hostname,
      description: '',
      visibleText: rawText.replace(/\s+/g, ' ').trim(),
      links: [],
      forms: [],
      buttons: [],
      elements: [],
    }
  }
  const title = decodeHTML(extractHTMLText(firstMatch(rawText, /<title[^>]*>([\s\S]*?)<\/title>/i) ?? '') || new URL(url).hostname)
  const description = decodeHTML(extractMetaDescription(rawText) ?? '')
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
  const elements = links.map((link, index) => ({
    ref: `link-${index + 1}`,
    role: 'link',
    name: link.text || link.url,
    text: link.text,
    href: link.url,
  }))
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
    description,
    visibleText: decodeHTML(extractHTMLText(rawText)),
    links,
    forms,
    buttons,
    elements,
  }
}

function normalizeBrowserSnapshot(snapshot: BrowserSnapshot): BrowserSnapshot {
  return {
    url: snapshot.url,
    title: snapshot.title || safeHostname(snapshot.url),
    description: snapshot.description ?? '',
    visibleText: snapshot.visibleText ?? '',
    httpStatus: snapshot.httpStatus,
    links: (snapshot.links ?? []).slice(0, 50),
    forms: (snapshot.forms ?? []).slice(0, 20),
    buttons: (snapshot.buttons ?? []).slice(0, 50),
    elements: (snapshot.elements ?? []).slice(0, 100),
  }
}

function browserSnapshotResult(
  source: 'browser.open' | 'browser.search' | 'browser.snapshot' | 'browser.click' | 'browser.type' | 'browser.scroll',
  snapshot: BrowserSnapshot,
  maxTextCharacters: unknown,
): ToolExecutionResult {
  const maxText = typeof maxTextCharacters === 'number' ? Math.max(1, Math.min(Math.floor(maxTextCharacters), 60000)) : 6000
  const visibleText = snapshot.visibleText.slice(0, maxText).trim()
  const observationStatus = classifyBrowserObservation(snapshot)
  const payload = {
    title: snapshot.title,
    url: snapshot.url,
    description: snapshot.description ?? '',
    observation_status: observationStatus,
    http_status: snapshot.httpStatus,
    visible_text: visibleText,
    text_characters: snapshot.visibleText.length,
    text_truncated: snapshot.visibleText.length > visibleText.length,
    links: snapshot.links,
    forms: snapshot.forms,
    buttons: snapshot.buttons,
    elements: snapshot.elements ?? [],
  }
  const data = {
    source,
    url: snapshot.url,
    title: snapshot.title,
    description: snapshot.description ?? '',
    observation_status: observationStatus,
    http_status: snapshot.httpStatus,
    text_characters: snapshot.visibleText.length,
    text_truncated: snapshot.visibleText.length > visibleText.length,
    links_count: snapshot.links.length,
    forms_count: snapshot.forms.length,
    buttons_count: snapshot.buttons.length,
    elements_count: snapshot.elements?.length ?? 0,
  }
  if (observationStatus !== 'usable') {
    return {
      ok: false,
      content: JSON.stringify({
        error: browserObservationMessage(observationStatus, snapshot),
        ...payload,
      }),
      errorCode: browserObservationErrorCode(observationStatus),
      recoverable: true,
      data,
    }
  }
  return {
    ok: true,
    content: JSON.stringify(payload),
    data,
  }
}

function browserReadResult(snapshot: BrowserSnapshot, maxTextCharacters: unknown): ToolExecutionResult {
  const maxText = typeof maxTextCharacters === 'number' ? Math.max(1, Math.min(Math.floor(maxTextCharacters), 60000)) : 12000
  const mainText = snapshot.visibleText.slice(0, maxText).trim()
  const observationStatus = classifyBrowserObservation(snapshot)
  const payload = {
    title: snapshot.title,
    url: snapshot.url,
    description: snapshot.description ?? '',
    observation_status: observationStatus,
    http_status: snapshot.httpStatus,
    main_text: mainText,
    text_characters: snapshot.visibleText.length,
    text_truncated: snapshot.visibleText.length > mainText.length,
    links: snapshot.links.slice(0, 20),
    key_links: snapshot.links.slice(0, 20),
  }
  const data = {
    source: 'browser.read',
    url: snapshot.url,
    title: snapshot.title,
    description: snapshot.description ?? '',
    observation_status: observationStatus,
    http_status: snapshot.httpStatus,
    text_characters: snapshot.visibleText.length,
    text_truncated: snapshot.visibleText.length > mainText.length,
    links_count: snapshot.links.length,
  }
  if (observationStatus !== 'usable') {
    return {
      ok: false,
      content: JSON.stringify({
        error: browserObservationMessage(observationStatus, snapshot),
        ...payload,
      }),
      errorCode: browserObservationErrorCode(observationStatus),
      recoverable: true,
      data,
    }
  }
  return {
    ok: true,
    content: JSON.stringify(payload),
    data,
  }
}

function browserVerifyResult(
  snapshot: BrowserSnapshot,
  input: { expectText: string; requireUsable: boolean; screenshot?: BrowserScreenshot },
): ToolExecutionResult {
  const observationStatus = classifyBrowserObservation(snapshot)
  const match = input.expectText ? findBrowserEvidence(snapshot, input.expectText) : { matched: true, evidence: '' }
  const usablePassed = !input.requireUsable || observationStatus === 'usable'
  const passed = usablePassed && match.matched
  const verificationStatus = passed ? 'passed' : 'failed'
  const payload = {
    title: snapshot.title,
    url: snapshot.url,
    description: snapshot.description ?? '',
    observation_status: observationStatus,
    verification_status: verificationStatus,
    http_status: snapshot.httpStatus,
    expect_text: input.expectText,
    matched_text: match.matched,
    evidence: match.evidence,
    text_characters: snapshot.visibleText.length,
    checks: [
      { name: 'page_usable', passed: usablePassed, detail: observationStatus },
      ...(input.expectText ? [{ name: 'expected_text_present', passed: match.matched, detail: input.expectText }] : []),
    ],
    screenshot: input.screenshot
      ? { captured: true, bytes: input.screenshot.bytes, content_type: input.screenshot.contentType }
      : { captured: false },
  }
  const data = {
    source: 'browser.verify',
    url: snapshot.url,
    title: snapshot.title,
    description: snapshot.description ?? '',
    observation_status: observationStatus,
    verification_status: verificationStatus,
    http_status: snapshot.httpStatus,
    text_characters: snapshot.visibleText.length,
    matched_text: match.matched,
    screenshot_captured: Boolean(input.screenshot),
    screenshot_bytes: input.screenshot?.bytes,
  }
  return {
    ok: true,
    content: JSON.stringify(payload),
    data,
    artifact: input.screenshot
      ? {
          title: input.screenshot.title,
          content: input.screenshot.content,
          contentType: input.screenshot.contentType,
          metadata: data,
        }
      : undefined,
  }
}

function findBrowserEvidence(snapshot: BrowserSnapshot, expectedText: string): { matched: boolean; evidence: string } {
  const haystacks = [
    snapshot.title,
    snapshot.description ?? '',
    snapshot.url,
    snapshot.visibleText,
    ...snapshot.links.flatMap((link) => [link.text, link.url]),
  ]
  const needle = normalizeSearchText(expectedText)
  for (const value of haystacks) {
    const normalized = normalizeSearchText(value)
    const index = normalized.indexOf(needle)
    if (index >= 0) {
      return { matched: true, evidence: evidenceSnippet(value, expectedText) }
    }
  }
  return { matched: false, evidence: '' }
}

function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim()
}

function evidenceSnippet(value: string, expectedText: string): string {
  const lower = value.toLowerCase()
  const index = lower.indexOf(expectedText.toLowerCase())
  if (index < 0) {
    return value.replace(/\s+/g, ' ').trim().slice(0, 240)
  }
  const start = Math.max(0, index - 80)
  const end = Math.min(value.length, index + expectedText.length + 80)
  return value.slice(start, end).replace(/\s+/g, ' ').trim()
}

function classifyBrowserObservation(snapshot: BrowserSnapshot): BrowserObservationStatus {
  if (typeof snapshot.httpStatus === 'number' && snapshot.httpStatus >= 400) {
    return 'http_error'
  }
  const text = (snapshot.visibleText ?? '').trim()
  const lower = text.toLowerCase()
  const title = (snapshot.title ?? '').toLowerCase()
  const combined = `${title}\n${lower}`
  if (/(captcha|verify you are human|human verification|security check|访问验证|验证码|人机验证|安全验证)/i.test(combined)) {
    return 'captcha_like'
  }
  if (looksLoginRequired(snapshot, combined)) {
    return 'login_required'
  }
  if (text.length === 0 && snapshot.links.length === 0 && snapshot.forms.length === 0 && snapshot.buttons.length === 0 && (snapshot.elements?.length ?? 0) === 0) {
    return 'empty'
  }
  return 'usable'
}

function looksLoginRequired(snapshot: BrowserSnapshot, combined: string): boolean {
  if (looksLikeReadableArticle(snapshot)) {
    return false
  }
  if (/(请先登录|登录后(?:查看|继续|访问|阅读)|注册后(?:查看|继续|访问|阅读)|账号密码|请输入密码|password|sign in to continue|log in to continue|authentication required|login required)/i.test(combined)) {
    return true
  }
  const actionText = [
    ...snapshot.buttons,
    ...snapshot.forms.flatMap((form) => form.fields),
    ...(snapshot.elements ?? []).flatMap((element) => [element.name, element.text ?? '']),
  ].join(' ')
  return snapshot.forms.length > 0
    && snapshot.visibleText.length < 2000
    && /(登录|注册|sign in|log in|login|password)/i.test(actionText)
}

function looksLikeReadableArticle(snapshot: BrowserSnapshot): boolean {
  const text = snapshot.visibleText ?? ''
  const title = snapshot.title ?? ''
  return text.length > 100
    && (
      /来源[:：]/.test(text)
      || /记者/.test(text)
      || /发表于|发布于|published/i.test(text)
      || /--/.test(title)
    )
}

function browserObservationErrorCode(status: BrowserObservationStatus): string {
  return status === 'http_error' ? 'browser_http_error' : `browser_${status}`
}

function browserObservationMessage(status: BrowserObservationStatus, snapshot: BrowserSnapshot): string {
  if (status === 'http_error') {
    return `Managed browser page returned HTTP ${snapshot.httpStatus}.`
  }
  if (status === 'empty') {
    return 'Managed browser page did not expose usable text or interactive content.'
  }
  if (status === 'login_required') {
    return 'Managed browser page appears to require login.'
  }
  if (status === 'captcha_like') {
    return 'Managed browser page appears to require captcha or human verification.'
  }
  if (status === 'blocked') {
    return 'Managed browser observation was blocked by a safety or repetition guard.'
  }
  return 'Managed browser page is usable.'
}

function blockedBrowserObservation(source: 'browser.open' | 'browser.search', message: string, errorCode: string, extra: Record<string, unknown>): ToolExecutionResult {
  const data = {
    source,
    observation_status: 'blocked',
    ...extra,
  }
  return {
    ok: false,
    content: JSON.stringify({
      error: message,
      observation_status: 'blocked',
      ...extra,
    }),
    errorCode,
    recoverable: true,
    data,
  }
}

function browserDuplicateObservation(options: ToolExecutionOptions, source: 'browser.open' | 'browser.search', key: string): ToolExecutionResult | undefined {
  options.browserObservationCounts ??= new Map<string, number>()
  const count = options.browserObservationCounts.get(key) ?? 0
  if (count >= 2) {
    const message = source === 'browser.search'
      ? 'This search query has already been tried twice in this run. Use a different query or summarize the existing results.'
      : 'This URL has already been opened twice in this run. Use a different source or summarize the existing page.'
    return blockedBrowserObservation(source, message, 'browser_duplicate_observation', {
      duplicate_key: key,
      duplicate_count: count,
    })
  }
  options.browserObservationCounts.set(key, count + 1)
  return undefined
}

function duplicateQueryKey(query: string): string {
  return `search:${query.trim().toLowerCase().replace(/\s+/g, ' ')}`
}

function duplicateURLKey(url: URL): string {
  const copy = new URL(url.href)
  copy.hash = ''
  copy.hostname = copy.hostname.toLowerCase()
  copy.pathname = copy.pathname.replace(/\/+$/, '') || '/'
  copy.searchParams.sort()
  return `open:${copy.href}`
}

function buildBrowserSearchURL(query: string, options: ToolExecutionOptions): string {
  const template = options.browserSearchURL ?? process.env.JIANDANLY_BROWSER_SEARCH_URL ?? 'https://cn.bing.com/search?q={query}'
  const encoded = encodeURIComponent(query)
  if (template.includes('{query}')) {
    return template.split('{query}').join(encoded)
  }
  const url = new URL(template)
  url.searchParams.set('q', query)
  return url.href
}

function browserTimeoutMs(options: ToolExecutionOptions): number {
  const env = Number(process.env.JIANDANLY_BROWSER_TIMEOUT_MS)
  const value = options.browserTimeoutMs ?? (Number.isFinite(env) && env > 0 ? env : 15000)
  return Math.max(1000, Math.min(value, 120000))
}

function browserHeadless(options: ToolExecutionOptions): boolean {
  if (typeof options.browserHeadless === 'boolean') {
    return options.browserHeadless
  }
  return (process.env.JIANDANLY_BROWSER_HEADLESS ?? 'true').toLowerCase() !== 'false'
}

function browserViewport(options: ToolExecutionOptions): { width: number; height: number } {
  return {
    width: options.browserViewport?.width ?? 1280,
    height: options.browserViewport?.height ?? 800,
  }
}

async function settlePlaywrightPage(page: PlaywrightPage, timeoutMs: number): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: Math.min(timeoutMs, 3000) }).catch(() => undefined)
}

async function rollbackUnsafeNavigation(page: PlaywrightPage, beforeURL: string, timeoutMs: number): Promise<void> {
  if (!beforeURL || beforeURL === 'about:blank') {
    await page.close().catch(() => undefined)
    return
  }
  await page.goto(beforeURL, { waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => undefined)
}

function browserRefSelector(ref: string): string {
  return `[data-jiandanly-ref="${cssAttributeEscape(ref)}"]`
}

function cssAttributeEscape(input: string): string {
  return input.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function safeHostname(rawURL: string): string {
  try {
    return new URL(rawURL).hostname
  } catch {
    return 'Browser page'
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

function extractMetaDescription(html: string): string | undefined {
  for (const match of html.matchAll(/<meta\b([^>]*)>/gi)) {
    const attrs = match[1] ?? ''
    const name = (attributeValue(attrs, 'name') ?? attributeValue(attrs, 'property') ?? '').toLowerCase()
    if (name === 'description' || name === 'og:description') {
      return attributeValue(attrs, 'content')?.replace(/\s+/g, ' ').trim()
    }
  }
  return undefined
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
