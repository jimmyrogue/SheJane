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

  it('caps to the most recent N messages', () => {
    const many = Array.from({ length: 30 }, (_, i) => msg({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }))
    const history = deriveAgentHistory(many, { maxMessages: 5 })
    expect(history).toHaveLength(5)
    expect(history[history.length - 1].content).toBe('m29')
    expect(history[0].content).toBe('m25')
  })

  it('drops oldest turns until within the char budget', () => {
    const history = deriveAgentHistory(
      [
        msg({ role: 'user', content: 'A'.repeat(100) }),
        msg({ role: 'assistant', content: 'B'.repeat(100) }),
        msg({ role: 'user', content: 'C'.repeat(100) }),
      ],
      { maxChars: 150 },
    )
    expect(history.map((turn) => turn.content[0])).toEqual(['C'])
  })
})
