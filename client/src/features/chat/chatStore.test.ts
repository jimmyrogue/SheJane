import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { createChatStore, timelineItem, toolDetail } from './chatStore'
import { LocalConversationStore } from '../../shared/local-data/localConversations'
import type { ChatAPI } from '../../shared/api/client'

describe('chat store', () => {
  beforeEach(() => {
    indexedDB.deleteDatabase('shejane-chat-test')
  })

  it('creates local messages before streaming and persists assistant deltas', async () => {
    const localData = new LocalConversationStore('shejane-chat-test-stream')
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
      runCloudToolLoop: async () => {
        throw new Error('runCloudToolLoop not used in this test')
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
    const localData = new LocalConversationStore('shejane-chat-test-document')
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
      runCloudToolLoop: async () => {
        throw new Error('runCloudToolLoop not used in this test')
      },
    }
    const chat = createChatStore({ localData, api, now: () => '2026-05-10T00:00:00.000Z' })

    const conversation = await chat.sendMessage({
      content: '总结这份材料',
      mode: 'fast',
      scene: 'chat',
      document: { id: 'doc-1', name: 'roadmap.pdf', contentType: 'application/pdf' },
    })

    // The user message's CONTENT is the plain text (no more `📎 name`
    // embedding); the attachment rides as a STRUCTURED attachment so
    // MessageBubble renders the clickable AttachmentChip.
    expect(conversation.messages[0]).toMatchObject({
      role: 'user',
      content: '总结这份材料',
      attachments: [{ documentId: 'doc-1', name: 'roadmap.pdf', contentType: 'application/pdf' }],
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

  it('routes to the cloud tool loop (not the single-completion run) when cloudTools are provided', async () => {
    const localData = new LocalConversationStore('shejane-chat-test-toolloop')
    let createCalled = false
    const api: ChatAPI = {
      createAgentRun: async () => {
        createCalled = true
        return { id: 'should-not-run', status: 'queued', mode: 'fast' }
      },
      streamAgentRun: async () => ({ requestId: '', inputTokens: 0, outputTokens: 0, creditsCost: 0 }),
      runCloudToolLoop: async (input, handlers) => {
        expect(input.goal).toBe('画一只猫')
        expect(input.tools.map((t) => t.name)).toEqual(['image.generate'])
        expect(input.runId).toMatch(/^run_/)
        handlers.onEvent?.({ event_type: 'tool.completed', payload: { tool: 'image.generate' } })
        handlers.onDelta('好的，这是图片')
        handlers.onDelta('\n\n![image.generate](https://cdn.example.com/cat.png)\n')
        return { requestId: 'req-loop', inputTokens: 5, outputTokens: 9, creditsCost: 12 }
      },
    }
    const chat = createChatStore({ localData, api, now: () => '2026-05-10T00:00:00.000Z' })

    const conversation = await chat.sendMessage({
      content: '画一只猫',
      mode: 'fast',
      scene: 'chat',
      cloudTools: [
        { name: 'image.generate', description: 'gen', inputSchema: { type: 'object' } },
      ],
    })

    expect(createCalled).toBe(false)
    expect(conversation.messages[1]).toMatchObject({
      role: 'assistant',
      status: 'done',
      requestId: 'req-loop',
      runOrigin: 'cloud',
    })
    expect(conversation.messages[1].content).toContain('![image.generate](https://cdn.example.com/cat.png)')
    expect(conversation.messages[1].agentEvents?.[0]).toMatchObject({ type: 'tool.completed' })
  })

  it('renders universal primitive tool events with user-facing action names', () => {
    expect(timelineItem({ event_type: 'permission.required', payload: { request_id: 'perm-url', tool: 'open.url' } })).toMatchObject({
      label: '需要权限：用系统浏览器打开网页',
      permissionTool: '用系统浏览器打开网页',
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
    expect(timelineItem({ event_type: 'tool.requested', payload: { tool: 'browser.search' } })).toMatchObject({
      label: '调用工具：搜索网页',
    })
    expect(timelineItem({ event_type: 'tool.requested', payload: { tool: 'browser.read' } })).toMatchObject({
      label: '调用工具：阅读网页正文',
    })
    expect(timelineItem({ event_type: 'tool.requested', payload: { tool: 'browser.verify' } })).toMatchObject({
      label: '调用工具：验证网页',
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

  it('renders collected browser sources with title and url', () => {
    expect(timelineItem({ event_type: 'source.collected', payload: { title: 'Example Source', url: 'https://example.com/source', artifact_id: 'artifact-source' } })).toMatchObject({
      label: '收集来源：Example Source',
      sourceTitle: 'Example Source',
      sourceUrl: 'https://example.com/source',
      artifactId: 'artifact-source',
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

  // Regression: bare-string options used to be silently filtered out
  // because parseQuestionPayload required `option.label`. The daemon
  // now normalizes to {label} at its boundary, but the parser stays
  // tolerant so any future emitter / older daemon still works.
  describe('question.asked option-shape tolerance', () => {
    it('accepts options as plain strings (legacy daemon shape)', () => {
      const item = timelineItem({
        event_type: 'question.asked',
        payload: {
          request_id: 'q1',
          questions: [
            {
              question: '你想在普吉岛待几天？',
              options: ['3天', '5天', '7天'],
            },
          ],
        },
      })
      expect(item).not.toBeNull()
      expect(item?.questions?.[0].options).toEqual([
        { label: '3天' },
        { label: '5天' },
        { label: '7天' },
      ])
    })

    it('accepts options as {label, description?} objects (canonical shape)', () => {
      const item = timelineItem({
        event_type: 'question.asked',
        payload: {
          request_id: 'q2',
          questions: [
            {
              question: '选择模式',
              options: [
                { label: 'Fast', description: '快速回答' },
                { label: 'Pro' },
              ],
            },
          ],
        },
      })
      expect(item?.questions?.[0].options).toEqual([
        { label: 'Fast', description: '快速回答' },
        { label: 'Pro' },
      ])
    })

    it('drops empty strings and option-objects with no label', () => {
      const item = timelineItem({
        event_type: 'question.asked',
        payload: {
          request_id: 'q3',
          questions: [
            {
              question: '混杂输入',
              options: ['  valid  ', '', { label: '', description: 'no label' }, { label: '保留' }],
            },
          ],
        },
      })
      expect(item?.questions?.[0].options).toEqual([{ label: 'valid' }, { label: '保留' }])
    })
  })

  // Rich per-tool primary-argument badge. The renderer reads
  // `event.toolDetail` and draws "{label} · {detail.text}" — with an
  // optional globe icon for web tools. These tests pin the mapping
  // from raw daemon args to the displayed shape.
  describe('toolDetail per tool', () => {
    it('web.search → text + truncated query, no icon', () => {
      const detail = toolDetail({ arguments: { query: '普吉岛雨季天气' } }, 'web.search')
      expect(detail).toEqual({
        kind: 'text',
        text: '普吉岛雨季天气',
        tooltip: '普吉岛雨季天气',
      })
    })

    it('web.fetch → host with globe icon + url tooltip', () => {
      const detail = toolDetail(
        { arguments: { url: 'https://weather.com/today?city=phuket' } },
        'web.fetch',
      )
      expect(detail).toEqual({
        kind: 'host',
        text: 'weather.com',
        tooltip: 'https://weather.com/today?city=phuket',
        showWebIcon: true,
      })
    })

    it('web.fetch with www.X.com strips the www prefix', () => {
      const detail = toolDetail({ arguments: { url: 'https://www.example.com/' } }, 'web.fetch')
      expect(detail?.text).toBe('example.com')
    })

    it('web.fetch falls back to truncated raw URL when URL parsing fails', () => {
      const detail = toolDetail({ arguments: { url: 'not a real url ::: !!!' } }, 'web.fetch')
      expect(detail?.kind).toBe('text') // no host extraction, no globe icon
      expect(detail?.showWebIcon).toBeUndefined()
    })

    it('read_file → basename + full path tooltip', () => {
      const detail = toolDetail(
        { arguments: { path: '/Users/me/project/src/App.tsx' } },
        'read_file',
      )
      expect(detail).toEqual({
        kind: 'text',
        text: 'App.tsx',
        tooltip: '/Users/me/project/src/App.tsx',
      })
    })

    it('ls / fs.list / workspace.open get a trailing slash on the basename', () => {
      const args = { arguments: { path: '/Users/me/project/src' } }
      expect(toolDetail(args, 'ls')?.text).toBe('src/')
      expect(toolDetail(args, 'fs.list')?.text).toBe('src/')
      expect(toolDetail(args, 'workspace.open')?.text).toBe('src/')
      // read_file etc do NOT get a slash
      expect(toolDetail(args, 'read_file')?.text).toBe('src')
    })

    it('execute / shell.run → command, truncated to 40 chars', () => {
      const command = 'ls -la /tmp/some/very/long/path/and/then/some/more'
      const detail = toolDetail({ arguments: { command } }, 'execute')
      expect(detail?.text.length).toBeLessThanOrEqual(40)
      expect(detail?.text).toContain('ls -la')
      expect(detail?.tooltip).toBe(command)
    })

    it('user.ask → question, tighter 30-char truncation', () => {
      const longQ = 'A'.repeat(120)
      const detail = toolDetail({ arguments: { question: longQ } }, 'user.ask')
      expect(detail?.text.length).toBeLessThanOrEqual(30)
      expect(detail?.text.endsWith('…')).toBe(true)
    })

    it('write_todos → count-kind with todos.length', () => {
      const detail = toolDetail(
        { arguments: { todos: [1, 2, 3, 4, 5] } },
        'write_todos',
      )
      expect(detail).toEqual({ kind: 'count', text: '5' })
    })

    it('task.verify → count-kind with checks.length', () => {
      const detail = toolDetail(
        { arguments: { checks: [{ kind: 'file_exists' }, { kind: 'shell_exit_code' }] } },
        'task.verify',
      )
      expect(detail).toEqual({ kind: 'count', text: '2' })
    })

    it('no args + no payload fallback → undefined (renderer shows just the verb)', () => {
      expect(toolDetail({}, 'time.now')).toBeUndefined()
      expect(toolDetail({})).toBeUndefined()
    })

    it('falls through to payload.title for source.collected / browser.observed', () => {
      const detail = toolDetail({ title: '普吉岛旅行攻略 2025 - Klook' })
      expect(detail?.kind).toBe('text')
      expect(detail?.text).toContain('普吉岛')
    })

    it('image.generate → prompt text', () => {
      const detail = toolDetail(
        { arguments: { prompt: 'A sunset over Phuket beach', size: '1024x1024' } },
        'image.generate',
      )
      expect(detail?.kind).toBe('text')
      expect(detail?.text).toBe('A sunset over Phuket beach')
    })

    it('subagent task call uses real deepagents arg names (description + subagent_type)', () => {
      const detail = toolDetail(
        { arguments: { subagent_type: 'researcher', description: 'Find current Phuket weather' } },
        'task',
      )
      // description (truncated) wins over subagent_type for the visible
      // text — the user-facing badge reads better as the actual prompt
      // than as the subagent label.
      expect(detail?.text).toContain('Phuket weather')
      // tooltip carries the full prompt prefixed by the subagent type
      // so hover reveals which subagent was dispatched.
      expect(detail?.tooltip).toContain('researcher')
      expect(detail?.tooltip).toContain('Phuket weather')
    })

    it('task call back-compat: old field names (subagent_name + task_description) still render', () => {
      // Earlier versions of this file guessed the wrong field names.
      // Any persisted timeline items from that era should still render
      // sensibly — the aliases keep working.
      const detail = toolDetail(
        { arguments: { subagent_name: 'researcher', task_description: 'Find current Phuket weather' } },
        'task',
      )
      expect(detail?.text).toContain('Phuket weather')
    })

    it('task call with only subagent_type falls back to subagent name', () => {
      const detail = toolDetail({ arguments: { subagent_type: 'writer' } }, 'task')
      expect(detail?.text).toBe('writer')
    })
  })
})
