import { describe, expect, it } from 'vitest'
import { deriveAgentHistory } from './conversationHistory'
import type { ChatMessage } from '@/shared/local-data/types'

function msg(partial: Partial<ChatMessage> & { role: ChatMessage['role']; content: string }): ChatMessage {
  return {
    id: Math.random().toString(36).slice(2),
    createdAt: new Date().toISOString(),
    status: 'done',
    ...partial,
  }
}

describe('deriveAgentHistory', () => {
  it('keeps prior user/assistant turns in order', () => {
    const history = deriveAgentHistory([
      msg({ role: 'user', content: '今天天气怎么样' }),
      msg({ role: 'assistant', content: '你想查询哪个城市的天气？' }),
    ])
    expect(history).toEqual([
      { role: 'user', content: '今天天气怎么样' },
      { role: 'assistant', content: '你想查询哪个城市的天气？' },
    ])
  })

  it('drops system, empty, errored and in-flight placeholder messages', () => {
    const history = deriveAgentHistory([
      msg({ role: 'system', content: 'system prompt' }),
      msg({ role: 'user', content: '  ' }),
      msg({ role: 'assistant', content: 'failed', status: 'error' }),
      msg({ role: 'assistant', content: '', status: 'streaming' }),
      msg({ role: 'user', content: '正常一句' }),
    ])
    expect(history).toEqual([{ role: 'user', content: '正常一句' }])
  })

  it('uses only the transport item boundary and prepends an honest omission marker', () => {
    const many = Array.from({ length: 260 }, (_, i) => msg({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }))
    const history = deriveAgentHistory(many)
    expect(history).toHaveLength(257)
    expect(history[0].role).toBe('user')
    expect(history[0].content).toContain('已省略更早的 4 条消息')
    expect(history[0].content).not.toContain('早期摘要')
    expect(history.slice(1).map((t) => t.content)).toEqual(
      Array.from({ length: 256 }, (_, i) => `m${i + 4}`),
    )
  })

  it('drops oldest turns only when the transport character boundary is reached', () => {
    const history = deriveAgentHistory([
      msg({ role: 'user', content: 'A'.repeat(400_000) }),
      msg({ role: 'assistant', content: 'B'.repeat(400_000) }),
      msg({ role: 'user', content: 'C'.repeat(100) }),
    ])
    expect(history[0].content).toContain('已省略更早的 1 条消息')
    expect(history[1].content).toBe('B'.repeat(400_000))
    expect(history[2].content).toBe('C'.repeat(100))
  })

  it('adds no marker when nothing is omitted', () => {
    const history = deriveAgentHistory([
      msg({ role: 'user', content: '只有一轮' }),
      msg({ role: 'assistant', content: '回复' }),
    ])
    expect(history).toEqual([
      { role: 'user', content: '只有一轮' },
      { role: 'assistant', content: '回复' },
    ])
  })
})
