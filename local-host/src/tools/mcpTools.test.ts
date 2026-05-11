import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { executeTool } from './executor.js'
import type { LocalRun } from '../types.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs.length = 0
})

const run: LocalRun = {
  id: 'run-mcp-test',
  goal: 'Use MCP safely.',
  status: 'running',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}

describe('MCP tool guardrail', () => {
  it('blocks MCP calls outside the configured allowlist', async () => {
    const result = await executeTool(
      { id: 'call-mcp', name: 'mcp.call', arguments: { server: 'local-docs', tool: 'private.read', input: {} } },
      run,
      { mcpAllowlist: ['local-docs.safe.search'] },
    )

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'mcp_tool_not_allowed',
      recoverable: true,
    })
  })

  it('accepts allowlisted MCP names but does not execute without a runtime adapter', async () => {
    const result = await executeTool(
      { id: 'call-mcp', name: 'mcp.call', arguments: { server: 'local-docs', tool: 'safe.search', input: { q: 'harness' } } },
      run,
      { mcpAllowlist: ['local-docs.safe.search'] },
    )

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'mcp_runtime_not_configured',
      recoverable: true,
      data: expect.objectContaining({
        mcp_tool: 'local-docs.safe.search',
        allowed: true,
      }),
    })
  })

  it('executes an allowlisted MCP tool through a configured stdio server', async () => {
    const serverPath = await writeFakeMCPServer()
    const result = await executeTool(
      { id: 'call-mcp', name: 'mcp.call', arguments: { server: 'local-docs', tool: 'safe.search', input: { q: 'harness' } } },
      run,
      {
        mcpAllowlist: ['local-docs.safe.search'],
        mcpServers: {
          'local-docs': {
            command: process.execPath,
            args: [serverPath],
          },
        },
      },
    )

    expect(result).toMatchObject({
      ok: true,
      content: 'MCP result for harness',
      data: expect.objectContaining({
        mcp_tool: 'local-docs.safe.search',
        allowed: true,
        server: 'local-docs',
        tool: 'safe.search',
      }),
    })
  })

  it('does not return MCP server command, env, or stderr in the tool metadata', async () => {
    const serverPath = await writeFakeMCPServer()
    const result = await executeTool(
      { id: 'call-mcp', name: 'mcp.call', arguments: { server: 'local-docs', tool: 'safe.search', input: { q: 'redact' } } },
      run,
      {
        mcpAllowlist: ['local-docs.safe.search'],
        mcpServers: {
          'local-docs': {
            command: process.execPath,
            args: [serverPath],
            env: { MCP_SECRET_TOKEN: 'secret-value' },
          },
        },
      },
    )

    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(serverPath)
    expect(serialized).not.toContain('MCP_SECRET_TOKEN')
    expect(serialized).not.toContain('secret-value')
    expect(result.data).not.toHaveProperty('command')
    expect(result.data).not.toHaveProperty('env')
  })

  it('returns a recoverable observation when the configured MCP process cannot start', async () => {
    const result = await executeTool(
      { id: 'call-mcp', name: 'mcp.call', arguments: { server: 'local-docs', tool: 'safe.search', input: { q: 'harness' } } },
      run,
      {
        mcpAllowlist: ['local-docs.safe.search'],
        mcpServers: {
          'local-docs': {
            command: 'definitely-not-a-real-jiandanly-mcp-command',
          },
        },
        mcpTimeoutMs: 1000,
      },
    )

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'mcp_process_failed',
      recoverable: true,
      data: expect.objectContaining({
        mcp_tool: 'local-docs.safe.search',
        allowed: true,
      }),
    })
  })
})

async function writeFakeMCPServer(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'jiandanly-mcp-'))
  tempDirs.push(dir)
  const serverPath = join(dir, 'fake-mcp-server.mjs')
  await writeFile(
    serverPath,
    `
      import { createInterface } from 'node:readline'

      const rl = createInterface({ input: process.stdin })
      function send(message) {
        process.stdout.write(JSON.stringify(message) + '\\n')
      }

      rl.on('line', (line) => {
        const message = JSON.parse(line)
        if (message.method === 'initialize') {
          send({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: { name: 'fake-local-docs', version: '0.1.0' }
            }
          })
          return
        }
        if (message.method === 'notifications/initialized') {
          return
        }
        if (message.method === 'tools/call') {
          send({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              content: [{ type: 'text', text: 'MCP result for ' + message.params.arguments.q }],
              isError: false
            }
          })
        }
      })
    `,
    'utf8',
  )
  return serverPath
}
