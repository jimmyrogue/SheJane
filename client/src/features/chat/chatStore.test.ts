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
    const localData = new LocalConversationStore('jiandanly-chat-test-stream')
    const api: ChatAPI = {
      createAgentRun: async (request) => {
        expect(request.goal).toBe('写一封客户跟进邮件')
        expect(request.attachments).toEqual([])
        return { id: 'run-1', status: 'queued', mode: 'fast' }
      },
      streamAgentRun: async (runID, handlers) => {
        expect(runID).toBe('run-1')
        handlers.onEvent?.({ event_type: 'skill.selected', payload: { skill: 'direct-answer' } })
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
      runId: 'run-1',
    })
    expect(conversation.messages[1].agentEvents?.[0]).toMatchObject({ type: 'skill.selected' })
    expect(await localData.list()).toHaveLength(1)
  })

  it('streams attached document questions through the same agent run protocol', async () => {
    const localData = new LocalConversationStore('jiandanly-chat-test-document')
    const api: ChatAPI = {
      createAgentRun: async (request) => {
        expect(request.goal).toBe('总结这份材料')
        expect(request.attachments).toEqual([{ type: 'document', document_id: 'doc-1', name: 'roadmap.pdf' }])
        return { id: 'run-doc-1', status: 'queued', mode: 'fast' }
      },
      streamAgentRun: async (runID, handlers) => {
        expect(runID).toBe('run-doc-1')
        handlers.onEvent?.({ event_type: 'tool.completed', payload: { tool: 'document.read' } })
        handlers.onDelta('文档')
        handlers.onDelta('总结')
        return { requestId: 'req-doc-1', inputTokens: 10, outputTokens: 8, creditsCost: 18 }
      },
    }
    const chat = createChatStore({ localData, api, now: () => '2026-05-10T00:00:00.000Z' })

    const conversation = await chat.sendMessage({
      content: '总结这份材料',
      mode: 'fast',
      scene: 'chat',
      document: { id: 'doc-1', name: 'roadmap.pdf' },
    })

    expect(conversation.messages[0]).toMatchObject({
      role: 'user',
      content: '📎 roadmap.pdf\n总结这份材料',
    })
    expect(conversation.messages[1]).toMatchObject({
      role: 'assistant',
      content: '文档总结',
      status: 'done',
      requestId: 'req-doc-1',
      runId: 'run-doc-1',
    })
    expect(conversation.messages[1].agentEvents?.[0]).toMatchObject({ type: 'tool.completed' })
  })
})
