import { spawn } from 'node:child_process'
import { lookup } from 'node:dns/promises'
import { readdir, readFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { relative, resolve, sep } from 'node:path'
import type { LLMToolCall } from '../llm/gateway.js'
import type { LocalRun } from '../types.js'

export interface ToolExecutionResult {
  ok: boolean
  content: string
  data?: Record<string, unknown>
  errorCode?: string
  recoverable?: boolean
}

export interface ToolExecutionOptions {
  fetcher?: typeof fetch
  resolveHostname?: (hostname: string) => Promise<string[]>
  tavilyApiKey?: string
  tavilyBaseURL?: string
  mcpAllowlist?: string[]
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
        },
      }
    case 'file.read':
      return readWorkspaceFile(call, run)
    case 'file.search':
      return searchWorkspaceFiles(call, run)
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

async function readWorkspaceFile(call: LLMToolCall, run: LocalRun): Promise<ToolExecutionResult> {
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
        path: relative(checked.root, checked.path),
        bytes: buffer.length,
        truncated,
      },
    }
  } catch (error) {
    return {
      ok: false,
      content: error instanceof Error ? error.message : 'Failed to read file.',
      errorCode: 'file_read_failed',
      recoverable: true,
    }
  }
}

async function searchWorkspaceFiles(call: LLMToolCall, run: LocalRun): Promise<ToolExecutionResult> {
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
    data: { results },
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
  return {
    ok: false,
    content: `MCP tool ${mcpTool} is allowlisted, but the local MCP runtime adapter is not configured in this MVP.`,
    errorCode: 'mcp_runtime_not_configured',
    recoverable: true,
    data: { mcp_tool: mcpTool, allowed: true },
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
