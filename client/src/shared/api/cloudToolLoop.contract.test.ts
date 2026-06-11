import { afterEach, describe, expect, it, vi } from 'vitest'
import { SheJaneAPI } from './client'

interface RecordedRequest {
  url: string
  init?: RequestInit
  body: Record<string, unknown>
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ code: status >= 400 ? 1 : 0, data }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function sseResponse(text: string): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text))
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'X-Request-ID': 'req-header',
    },
  })
}

function bodyFrom(init?: RequestInit): Record<string, unknown> {
  if (typeof init?.body !== 'string') {
    return {}
  }
  return JSON.parse(init.body) as Record<string, unknown>
}

describe('SheJaneAPI web cloud tool loop HTTP contract', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('drives model to tool to model over the real fetch/SSE wire shape', async () => {
    const api = new SheJaneAPI('http://api.test')
    api.setAccessToken('access-token')
    const requests: RecordedRequest[] = []

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      const body = bodyFrom(init)
      requests.push({ url, init, body })

      if (url.endsWith('/api/v1/models/resolve')) {
        return jsonResponse({ model_id: 'claude-sonnet', label: 'Claude Sonnet', reason: 'tool task' })
      }
      if (url.endsWith('/api/v1/agent/llm/stream') && requests.filter((r) => r.url.endsWith('/api/v1/agent/llm/stream')).length === 1) {
        return sseResponse([
          'event: llm.delta',
          'data: {"content_delta":"我先搜索。","reasoning_delta":"plan"}',
          '',
          'event: llm.tool_call',
          'data: {"id":"call-search-1","name":"web.search","arguments":{"query":"agent harness","max_results":2}}',
          '',
          'event: llm.usage',
          'data: {"input_tokens":11,"output_tokens":3,"credits_cost":5}',
          '',
          'event: llm.done',
          'data: {"request_id":"req-llm-1","finish_reason":"tool_calls"}',
          '',
          '',
        ].join('\n'))
      }
      if (url.endsWith('/api/v1/agent/tools/execute')) {
        return jsonResponse({
          ok: true,
          content: 'Search result: harnesses need durable traces.',
          data: {
            results: [{ title: 'Harness', url: 'https://example.com/harness' }],
          },
        })
      }
      if (url.endsWith('/api/v1/agent/llm/stream')) {
        return sseResponse([
          'event: llm.delta',
          'data: {"content_delta":"找到资料。","reasoning_delta":""}',
          '',
          'event: llm.usage',
          'data: {"input_tokens":17,"output_tokens":5,"credits_cost":6}',
          '',
          'event: llm.done',
          'data: {"request_id":"req-llm-2","finish_reason":"stop"}',
          '',
          '',
        ].join('\n'))
      }
      return jsonResponse({}, 404)
    })

    const deltas: string[] = []
    const events: string[] = []

    const result = await api.runCloudToolLoop(
      {
        runId: 'run-web-1',
        goal: '查一下 agent harness 架构',
        mode: 'auto',
        history: [
          { role: 'user', content: '之前的问题' },
          { role: 'assistant', content: '之前的回答' },
        ],
        tools: [{
          name: 'web.search',
          description: 'Search the public web.',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string' },
              max_results: { type: 'integer' },
            },
            required: ['query'],
          },
        }],
      },
      {
        onDelta: (delta) => deltas.push(delta),
        onEvent: (event) => events.push(`${event.event_type}:${event.run_id ?? ''}`),
      },
    )

    expect(requests.map((r) => new URL(r.url).pathname)).toEqual([
      '/api/v1/models/resolve',
      '/api/v1/agent/llm/stream',
      '/api/v1/agent/tools/execute',
      '/api/v1/agent/llm/stream',
    ])
    for (const request of requests) {
      expect((request.init?.headers as Record<string, string>).Authorization).toBe('Bearer access-token')
    }

    expect(requests[0].body).toMatchObject({ goal: '查一下 agent harness 架构' })

    const firstLLMBody = requests[1].body
    expect(firstLLMBody).toMatchObject({
      run_id: 'run-web-1',
      model: 'claude-sonnet',
      messages: [
        { role: 'user', content: '之前的问题' },
        { role: 'assistant', content: '之前的回答' },
        { role: 'user', content: '查一下 agent harness 架构' },
      ],
      tools: [{
        name: 'web.search',
        description: 'Search the public web.',
        inputSchema: {
          properties: {
            max_results: { type: 'integer' },
          },
        },
      }],
    })

    expect(requests[2].body).toEqual({
      run_id: 'run-web-1',
      tool_call_id: 'call-search-1',
      tool: 'web.search',
      arguments: { query: 'agent harness', max_results: 2 },
      idempotency_key: 'run-web-1:call-search-1:web.search',
    })

    const secondMessages = requests[3].body.messages as Array<Record<string, unknown>>
    expect(secondMessages.at(-2)).toMatchObject({
      role: 'assistant',
      content: '我先搜索。',
      toolCalls: [{ id: 'call-search-1', name: 'web.search', arguments: { query: 'agent harness', max_results: 2 } }],
    })
    expect(secondMessages.at(-1)).toMatchObject({
      role: 'tool',
      toolCallId: 'call-search-1',
      name: 'web.search',
      content: 'Search result: harnesses need durable traces.',
    })

    expect(deltas.join('')).toBe('我先搜索。找到资料。')
    expect(events).toContain('model.selected:run-web-1')
    expect(events).toContain('tool.requested:run-web-1')
    expect(events).toContain('tool.completed:run-web-1')
    expect(result).toEqual({
      requestId: 'req-llm-2',
      inputTokens: 28,
      outputTokens: 8,
      creditsCost: 11,
    })
  })
})
