import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { createChatStore } from './chatStore'
import { LocalConversationStore } from '../../shared/local-data/localConversations'
import type { ChatAPI } from '../../shared/api/client'

describe('chat store', () => {
  beforeEach(() => {
    indexedDB.deleteDatabase('jiandanly-chat-test')
  })

  it('creates local messages before streaming and persists assistant deltas', async () => {
    const localData = new LocalConversationStore('jiandanly-chat-test')
    const api: ChatAPI = {
      streamChat: async (_request, handlers) => {
        handlers.onDelta('第一段')
        handlers.onDelta('，第二段')
        return { requestId: 'req-1', inputTokens: 8, outputTokens: 12, creditsCost: 20 }
      },
    }
    const chat = createChatStore({ localData, api, now: () => '2026-05-10T00:00:00.000Z' })

    const conversation = await chat.sendMessage({
      content: '写一封客户跟进邮件',
      mode: 'fast',
      scene: 'write',
    })

    expect(conversation.messages).toHaveLength(2)
    expect(conversation.messages[0]).toMatchObject({ role: 'user', content: '写一封客户跟进邮件' })
    expect(conversation.messages[1]).toMatchObject({
      role: 'assistant',
      content: '第一段，第二段',
      status: 'done',
      requestId: 'req-1',
    })
    expect(await localData.list()).toHaveLength(1)
  })
})
