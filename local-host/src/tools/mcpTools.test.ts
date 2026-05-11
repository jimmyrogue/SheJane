import { describe, expect, it } from 'vitest'
import { executeTool } from './executor.js'
import type { LocalRun } from '../types.js'

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
})
