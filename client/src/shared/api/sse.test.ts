import { describe, expect, it } from 'vitest'
import { parseOpenAIStreamEvent, parseSSEBuffer } from './sse'

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
})
