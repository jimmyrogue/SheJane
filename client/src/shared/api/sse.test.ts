import { describe, expect, it } from 'vitest'
import { parseAgentSSEBuffer, parseLLMStreamBuffer, parseOpenAIStreamEvent, parseSSEBuffer } from './sse'

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

  // The cloud LLM gateway (/agent/llm/stream) uses NAMED events, distinct from
  // the daemon envelope above. The web tool loop reads these directly.
  describe('parseLLMStreamBuffer (named llm.* events)', () => {
    it('parses delta / tool_call / usage / done in order', () => {
      const result = parseLLMStreamBuffer(
        'event: llm.delta\ndata: {"content_delta":"你好","reasoning_delta":""}\n\n' +
          'event: llm.tool_call\ndata: {"id":"c1","name":"image.generate","arguments":{"prompt":"cat"}}\n\n' +
          'event: llm.usage\ndata: {"input_tokens":10,"output_tokens":4,"credits_cost":7}\n\n' +
          'event: llm.done\ndata: {"request_id":"req-1","finish_reason":"tool_calls"}\n\n',
      )
      expect(result.events).toEqual([
        { type: 'delta', contentDelta: '你好', reasoningDelta: '' },
        { type: 'tool_call', id: 'c1', name: 'image.generate', arguments: { prompt: 'cat' } },
        { type: 'usage', inputTokens: 10, outputTokens: 4, creditsCost: 7 },
        { type: 'done', requestId: 'req-1', finishReason: 'tool_calls' },
      ])
      expect(result.rest).toBe('')
    })

    it('keeps a partial trailing frame in rest', () => {
      const result = parseLLMStreamBuffer(
        'event: llm.delta\ndata: {"content_delta":"A","reasoning_delta":""}\n\n' + 'event: llm.delta\ndata: {"conte',
      )
      expect(result.events).toEqual([{ type: 'delta', contentDelta: 'A', reasoningDelta: '' }])
      expect(result.rest).toContain('llm.delta')
    })

    it('surfaces llm.error', () => {
      const result = parseLLMStreamBuffer('event: llm.error\ndata: {"request_id":"r","message":"boom"}\n\n')
      expect(result.events).toEqual([{ type: 'error', requestId: 'r', message: 'boom' }])
    })
  })
})
