import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'

export interface MCPServerConfig {
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
}

export interface MCPRuntimeCallInput {
  server: string
  tool: string
  input: Record<string, unknown>
  config: MCPServerConfig
  timeoutMs?: number
}

export interface MCPRuntimeCallResult {
  ok: boolean
  content: string
  contentTypes: string[]
  isToolError: boolean
  errorCode?: string
}

interface JSONRPCResponse {
  jsonrpc: '2.0'
  id: number
  result?: unknown
  error?: {
    code?: number
    message?: string
    data?: unknown
  }
}

interface MCPToolResult {
  content?: Array<{ type?: string; text?: string; [key: string]: unknown }>
  structuredContent?: unknown
  isError?: boolean
}

const defaultTimeoutMs = 15000
const maxMCPResultChars = 65536

export function parseMCPServersConfig(raw: string | undefined): Record<string, MCPServerConfig> {
  if (!raw?.trim()) {
    return {}
  }
  const parsed = JSON.parse(raw) as Record<string, unknown>
  const output: Record<string, MCPServerConfig> = {}
  for (const [name, value] of Object.entries(parsed)) {
    if (!value || typeof value !== 'object') {
      continue
    }
    const record = value as Record<string, unknown>
    if (typeof record.command !== 'string' || !record.command.trim()) {
      continue
    }
    output[name] = {
      command: record.command,
      args: Array.isArray(record.args) ? record.args.filter((arg): arg is string => typeof arg === 'string') : undefined,
      cwd: typeof record.cwd === 'string' && record.cwd.trim() ? record.cwd : undefined,
      env: parseEnv(record.env),
    }
  }
  return output
}

export async function callStdioMCPTool(input: MCPRuntimeCallInput): Promise<MCPRuntimeCallResult> {
  const timeoutMs = normalizeTimeout(input.timeoutMs)
  const child = spawn(input.config.command, input.config.args ?? [], {
    cwd: input.config.cwd,
    env: input.config.env ? { ...process.env, ...input.config.env } : process.env,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  const session = new StdioJSONRPCSession(child, timeoutMs)
  try {
    const initialized = await session.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'jiandanly-local-host',
        version: '0.1.0',
      },
    })
    if (!initialized.ok) {
      return initialized
    }

    session.notify('notifications/initialized', {})
    const response = await session.request('tools/call', {
      name: input.tool,
      arguments: input.input,
    })
    if (!response.ok) {
      return response
    }

    const toolResult = normalizeToolResult(response.result)
    return {
      ok: !toolResult.isToolError,
      content: toolResult.content,
      contentTypes: toolResult.contentTypes,
      isToolError: toolResult.isToolError,
      errorCode: toolResult.isToolError ? 'mcp_tool_error' : undefined,
    }
  } finally {
    session.close()
  }
}

class StdioJSONRPCSession {
  private readonly pending = new Map<number, (response: JSONRPCResponse) => void>()
  private nextID = 1
  private closed = false
  private processError: string | undefined

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly timeoutMs: number,
  ) {
    child.stderr.on('data', () => {
      // Drain stderr so a noisy MCP server cannot block on a full pipe.
    })
    child.stdin.on('error', () => {
      this.processError = 'mcp_process_failed'
      this.failPending('mcp_process_failed', 'MCP process failed to start.')
    })
    child.once('error', () => {
      this.processError = 'mcp_process_failed'
      this.failPending('mcp_process_failed', 'MCP process failed to start.')
    })
    child.once('exit', () => {
      if (!this.closed) {
        this.failPending('mcp_process_exited', 'MCP process exited before responding.')
      }
    })
    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => {
      let message: JSONRPCResponse
      try {
        message = JSON.parse(line) as JSONRPCResponse
      } catch {
        return
      }
      if (typeof message.id !== 'number') {
        return
      }
      const resolve = this.pending.get(message.id)
      if (!resolve) {
        return
      }
      this.pending.delete(message.id)
      resolve(message)
    })
  }

  request(method: string, params: Record<string, unknown>): Promise<MCPRuntimeCallResult & { result?: unknown }> {
    if (this.processError) {
      return Promise.resolve({
        ok: false,
        content: 'MCP process failed to start.',
        contentTypes: [],
        isToolError: false,
        errorCode: this.processError,
      })
    }
    if (this.closed) {
      return Promise.resolve({
        ok: false,
        content: 'MCP process is closed.',
        contentTypes: [],
        isToolError: false,
        errorCode: 'mcp_process_closed',
      })
    }
    const id = this.nextID++
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve({
          ok: false,
          content: 'MCP request timed out.',
          contentTypes: [],
          isToolError: false,
          errorCode: 'mcp_timeout',
        })
      }, this.timeoutMs)
      this.pending.set(id, (response) => {
        clearTimeout(timer)
        if (response.error) {
          const errorData = response.error.data && typeof response.error.data === 'object' ? response.error.data as Record<string, unknown> : {}
          const errorCode = typeof errorData.errorCode === 'string' ? errorData.errorCode : 'mcp_rpc_error'
          resolve({
            ok: false,
            content: response.error.message ?? 'MCP JSON-RPC error.',
            contentTypes: [],
            isToolError: false,
            errorCode,
          })
          return
        }
        resolve({
          ok: true,
          content: '',
          contentTypes: [],
          isToolError: false,
          result: response.result,
        })
      })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params: Record<string, unknown>): void {
    if (!this.closed) {
      this.write({ jsonrpc: '2.0', method, params })
    }
  }

  close(): void {
    this.closed = true
    this.pending.clear()
    this.child.stdin.end()
    if (!this.child.killed) {
      this.child.kill('SIGTERM')
    }
  }

  private write(message: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private failPending(errorCode: string, content: string): void {
    for (const resolve of this.pending.values()) {
      resolve({
        jsonrpc: '2.0',
        id: -1,
        error: {
          message: content,
          data: { errorCode },
        },
      })
    }
    this.pending.clear()
  }
}

function normalizeToolResult(result: unknown): { content: string; contentTypes: string[]; isToolError: boolean } {
  const body = (result ?? {}) as MCPToolResult
  const contentItems = Array.isArray(body.content) ? body.content : []
  const contentTypes = contentItems.map((item) => (typeof item.type === 'string' ? item.type : 'unknown'))
  const text = contentItems
    .map((item) => {
      if (item.type === 'text' && typeof item.text === 'string') {
        return item.text
      }
      return JSON.stringify(item)
    })
    .join('\n')
  const structured = body.structuredContent === undefined ? '' : JSON.stringify(body.structuredContent)
  const content = [text, structured].filter(Boolean).join('\n').slice(0, maxMCPResultChars)
  return {
    content,
    contentTypes,
    isToolError: body.isError === true,
  }
}

function parseEnv(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const output: Record<string, string> = {}
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === 'string') {
      output[key] = child
    }
  }
  return Object.keys(output).length > 0 ? output : undefined
}

function normalizeTimeout(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(1000, Math.min(value, 120000)) : defaultTimeoutMs
}
