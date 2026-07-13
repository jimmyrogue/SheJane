import { describe, expect, it, vi } from 'vitest'

import { SheJaneRuntimeClient, parseAgentSSEBuffer } from './index'

describe('SheJaneRuntimeClient', () => {
  it('normalizes the Runtime URL and applies caller-provided authentication', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ protocol_version: 1, capabilities: ['agent.run'] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const client = new SheJaneRuntimeClient({
      baseURL: 'http://127.0.0.1:17371/',
      token: 'runtime-token',
      fetcher,
    })

    await client.getRuntimeInfo()

    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:17371/local/v1/runtime',
      expect.objectContaining({ headers: { Authorization: 'Bearer runtime-token' } }),
    )
  })

  it('parses durable events and the terminal sentinel across one buffer', () => {
    const parsed = parseAgentSSEBuffer(
      'data: {"event_type":"run.completed","run_id":"run-1","seq":4}\n\ndata: [DONE]\n\n',
    )

    expect(parsed.rest).toBe('')
    expect(parsed.events).toEqual([
      {
        type: 'agent',
        event: { event_type: 'run.completed', run_id: 'run-1', seq: 4 },
      },
      { type: 'done' },
    ])
  })
})
