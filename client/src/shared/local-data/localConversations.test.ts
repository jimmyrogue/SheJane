import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { LocalConversationStore } from './localConversations'
import type { Conversation } from './types'

describe('LocalConversationStore', () => {
  beforeEach(async () => {
    await Promise.all([
      deleteDatabase('jiandanly-test'),
      deleteDatabase('jiandanly-test-pinned'),
    ])
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

  it('keeps pinned conversations before regular recent conversations', async () => {
    const store = new LocalConversationStore('jiandanly-test-pinned')
    await store.save(conversation('older-pinned', '固定会话', '2026-05-10T00:00:00.000Z', true))
    await store.save(conversation('newer-regular', '普通会话', '2026-05-11T00:00:00.000Z'))
    await store.save(conversation('newest-pinned', '更新固定会话', '2026-05-12T00:00:00.000Z', true))

    expect((await store.list()).map((item) => item.id)).toEqual(['newest-pinned', 'older-pinned', 'newer-regular'])
  })
})

function conversation(id: string, title: string, updatedAt: string, pinned = false): Conversation {
  return {
    id,
    title,
    archived: false,
    pinned,
    createdAt: '2026-05-10T00:00:00.000Z',
    updatedAt,
    messages: [],
  }
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
    request.onblocked = () => resolve()
  })
}
