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
      label: '请求操作：打开网页',
    })
    expect(timelineItem({ event_type: 'ui.action.completed', payload: { tool: 'browser.open' } })).toMatchObject({
      label: '操作完成：打开网页',
    })
    expect(timelineItem({ event_type: 'tool.requested', payload: { tool: 'browser.search' } })).toMatchObject({
      label: '调用工具：搜索网页',
    })
    expect(timelineItem({ event_type: 'tool.requested', payload: { tool: 'browser.screenshot' } })).toMatchObject({
      label: '调用工具：页面截图',
    })
    expect(timelineItem({ event_type: 'permission.required', payload: { request_id: 'perm-click', tool: 'browser.click' } })).toMatchObject({
      label: '需要权限：点击网页元素',
      permissionTool: '点击网页元素',
    })
    expect(timelineItem({ event_type: 'permission.required', payload: { request_id: 'perm-type', tool: 'browser.type' } })).toMatchObject({
      label: '需要权限：输入网页文本',
      permissionTool: '输入网页文本',
    })
    expect(timelineItem({ event_type: 'tool.completed', payload: { tool: 'browser.scroll' } })).toMatchObject({
      label: '工具完成：滚动网页',
    })
  })

  it('renders local harness budget warnings with a readable label', () => {
    expect(timelineItem({ event_type: 'run.budget_warning', payload: { reason: 'max_steps_reached', max_steps: 12 } })).toMatchObject({
      label: '工具步数达到上限，正在整理已有结果',
    })
    expect(timelineItem({ event_type: 'run.budget_warning', payload: { reason: 'long_running', step: 20 } })).toMatchObject({
      label: '任务较长，仍在继续执行',
    })
  })

  it('renders run-scoped permission approvals and automatic approvals', () => {
    expect(timelineItem({ event_type: 'permission.resolved', payload: { request_id: 'perm-shell', decision: 'approve', tool: 'shell.run', scope: 'run' } })).toMatchObject({
      label: '本会话已允许：运行命令',
      permissionScope: 'run',
    })
    expect(timelineItem({ event_type: 'permission.auto_approved', payload: { tool: 'shell.run', scope: 'run' } })).toMatchObject({
      label: '本会话自动允许：运行命令',
      permissionScope: 'run',
    })
  })
})
