import { describe, expect, it, vi } from 'vitest'
import { streamAgentSSE } from './streamTransport'

function streamResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk))
        }
        controller.close()
      },
    }),
    { status, headers: { 'Content-Type': 'text/event-stream', 'X-Request-ID': 'req-stream' } },
  )
}

describe('StreamTransport', () => {
  it('streams partial Agent SSE chunks into events and deltas', async () => {
    const events: string[] = []
    const deltas: string[] = []

    const result = await streamAgentSSE(
      streamResponse([
        'event: agent.event\n',
        'data: {"event_type":"llm.delta","payload":{"content":"你"}}\n\n',
        'event: agent.event\ndata: {"event_type":"run.completed","payload":{"request_id":"req-1","credits_cost":12}}\n\n',
        'data: [DONE]\n\n',
      ]),
      {
        onEvent: (event) => events.push(event.event_type),
        onDelta: (delta) => deltas.push(delta),
      },
    )

    expect(events).toEqual(['llm.delta', 'run.completed'])
    expect(deltas).toEqual(['你'])
    expect(result).toEqual({ requestId: 'req-1', inputTokens: 0, outputTokens: 0, creditsCost: 12, completed: true })
  })

  it('rejects malformed SSE without swallowing the transport error', async () => {
    await expect(streamAgentSSE(streamResponse(['data: {"event_type":\n\n']), {
      onEvent: vi.fn(),
      onDelta: vi.fn(),
    })).rejects.toThrow(/Malformed Agent SSE/)
  })

  it('honors abort signals before reading the stream', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(streamAgentSSE(streamResponse(['data: [DONE]\n\n']), {
      onEvent: vi.fn(),
      onDelta: vi.fn(),
    }, controller.signal)).rejects.toThrow(/aborted/i)
  })
})
