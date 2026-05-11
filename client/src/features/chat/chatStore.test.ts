import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { createChatStore, timelineItem } from './chatStore'
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

  it('renders universal primitive tool events with user-facing action names', () => {
    expect(timelineItem({ event_type: 'permission.required', payload: { request_id: 'perm-url', tool: 'open.url' } })).toMatchObject({
      label: '需要权限：打开网页',
      permissionTool: '打开网页',
    })
    expect(timelineItem({ event_type: 'permission.required', payload: { request_id: 'perm-write', tool: 'fs.write' } })).toMatchObject({
      label: '需要权限：写入文件',
      permissionTool: '写入文件',
    })
    expect(timelineItem({ event_type: 'tool.requested', payload: { tool: 'fs.list' } })).toMatchObject({
      label: '调用工具：列出文件',
    })
    expect(timelineItem({ event_type: 'verification.completed', payload: { tool: 'task.verify', status: 'passed' } })).toMatchObject({
      label: '验证通过：验证任务结果',
    })
  })

  it('renders browser and environment observation events with user-facing labels', () => {
    expect(timelineItem({ event_type: 'browser.observed', payload: { title: 'Example Report', url: 'https://example.com/report' } })).toMatchObject({
      label: '观察网页：Example Report',
    })
    expect(timelineItem({ event_type: 'environment.observed', payload: { foreground_app: 'Preview', window_title: 'Invoice.pdf' } })).toMatchObject({
      label: '观察环境：Preview - Invoice.pdf',
    })
    expect(timelineItem({ event_type: 'ui.action.requested', payload: { tool: 'browser.open' } })).toMatchObject({
      label: '请求操作：打开受控网页',
    })
    expect(timelineItem({ event_type: 'ui.action.completed', payload: { tool: 'browser.open' } })).toMatchObject({
      label: '操作完成：打开受控网页',
    })
  })
})
