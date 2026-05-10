import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { LocalConversationStore } from './localConversations'
import type { Conversation } from './types'

describe('LocalConversationStore', () => {
  beforeEach(() => {
    indexedDB.deleteDatabase('jiandanly-test')
  })

  it('saves, lists, exports, imports, and deletes local conversations', async () => {
    const store = new LocalConversationStore('jiandanly-test')
    const conversation: Conversation = {
      id: 'conv-1',
      title: '客户跟进',
      archived: false,
      createdAt: '2026-05-10T00:00:00.000Z',
      updatedAt: '2026-05-10T00:01:00.000Z',
      messages: [
        {
          id: 'msg-1',
          role: 'user',
          content: '帮我写一封客户跟进邮件',
          createdAt: '2026-05-10T00:00:00.000Z',
          status: 'done',
        },
      ],
    }

    await store.save(conversation)
    expect(await store.list()).toHaveLength(1)
    expect(await store.get('conv-1')).toMatchObject({ title: '客户跟进' })

    const exported = await store.exportAll()
    await store.delete('conv-1')
    expect(await store.list()).toHaveLength(0)

    await store.importAll(exported)
    expect(await store.list()).toHaveLength(1)
  })
})
