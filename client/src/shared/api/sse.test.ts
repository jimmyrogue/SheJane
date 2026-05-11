import { describe, expect, it } from 'vitest'
import { parseAgentSSEBuffer, parseOpenAIStreamEvent, parseSSEBuffer } from './sse'

describe('SSE parser', () => {
  it('extracts OpenAI-compatible delta content', () => {
    const event = parseOpenAIStreamEvent(
      'data: {"choices":[{"delta":{"content":"你好"},"finish_reason":null}]}',
    )

    expect(event).toEqual({ type: 'delta', content: '你好' })
  })

  it('detects done events', () => {
    expect(parseOpenAIStreamEvent('data: [DONE]')).toEqual({ type: 'done' })
  })

  it('returns complete events and keeps partial buffer', () => {
    const result = parseSSEBuffer(
      'data: {"choices":[{"delta":{"content":"A"}}]}\n\n' +
        'data: {"choices":[{"delta":{"content":"B"}}]}',
    )

    expect(result.events).toEqual([{ type: 'delta', content: 'A' }])
    expect(result.rest).toContain('"B"')
  })

  it('extracts Agent Run events from event-stream chunks', () => {
    const result = parseAgentSSEBuffer(
      'event: agent.event\n' +
        'data: {"event_type":"tool.completed","payload":{"tool":"document.read"}}\n\n' +
        'data: [DONE]\n\n',
    )

    expect(result.events).toEqual([
      { type: 'agent', event: { event_type: 'tool.completed', payload: { tool: 'document.read' } } },
      { type: 'done' },
    ])
    expect(result.rest).toBe('')
  })
})
