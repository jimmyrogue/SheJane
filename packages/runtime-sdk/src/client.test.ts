import { describe, expect, it, vi } from 'vitest'

import {
  discoverLocalModels,
  parseAgentSSEBuffer,
  parseRuntimeModelSpec,
  SheJaneRuntimeClient,
} from './index'

describe('parseRuntimeModelSpec', () => {
  it('accepts only concrete Runtime model identifiers', () => {
    expect(parseRuntimeModelSpec(' local:openai:gpt-4.1 ')).toBe('local:openai:gpt-4.1')
    expect(parseRuntimeModelSpec('auto')).toBeUndefined()
    expect(parseRuntimeModelSpec('local::gpt-4.1')).toBeUndefined()
  })
})

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

  it('discovers provider models without exposing Runtime credentials', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        models: [{ model_id: 'openai/gpt-4.1', display_name: 'GPT-4.1' }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    const models = await discoverLocalModels(
      { provider_id: 'openrouter', base_url: 'https://openrouter.ai/api/v1' },
      { baseURL: 'http://127.0.0.1:17371', token: 'runtime-token' },
      fetcher,
    )

    expect(models).toEqual([{ model_id: 'openai/gpt-4.1', display_name: 'GPT-4.1' }])
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:17371/local/v1/model-providers/discover-models',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          provider_id: 'openrouter',
          base_url: 'https://openrouter.ai/api/v1',
        }),
      }),
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
