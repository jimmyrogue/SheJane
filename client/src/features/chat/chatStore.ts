import type { ChatAPI } from '../../shared/api/client'
import type { AgentRunEvent } from '../../shared/api/sse'
import { createLocalID, LocalConversationStore } from '../../shared/local-data/localConversations'
import type { AgentTimelineItem, ChatMode, ChatMessage, Conversation } from '../../shared/local-data/types'

interface ChatStoreDeps {
  localData: LocalConversationStore
  api: ChatAPI
  now?: () => string
}

interface SendMessageInput {
  conversationId?: string
  content: string
  mode: ChatMode
  scene: string
  document?: {
    id: string
    name: string
  }
}

export function createChatStore(deps: ChatStoreDeps) {
  const now = deps.now ?? (() => new Date().toISOString())

  return {
    async sendMessage(input: SendMessageInput): Promise<Conversation> {
      const text = input.content.trim()
      if (!text) {
        throw new Error('消息不能为空')
      }

      const timestamp = now()
      const conversation =
        (input.conversationId ? await deps.localData.get(input.conversationId) : undefined) ??
        createConversation(text, timestamp)

      const userMessage: ChatMessage = {
        id: createLocalID('msg'),
        role: 'user',
        content: formatUserMessage(text, input.document),
        createdAt: timestamp,
        status: 'done',
      }
      const assistantMessage: ChatMessage = {
        id: createLocalID('msg'),
        role: 'assistant',
        content: '',
        createdAt: timestamp,
        status: 'streaming',
      }

      conversation.messages = [...conversation.messages, userMessage, assistantMessage]
      conversation.updatedAt = timestamp
      await deps.localData.save(conversation)

      try {
        const run = await deps.api.createAgentRun({
          goal: text,
          mode: input.mode,
          clientConversationId: conversation.id,
          clientMessageId: userMessage.id,
          attachments: input.document
            ? [{ type: 'document', document_id: input.document.id, name: input.document.name }]
            : [],
        })
        assistantMessage.runId = run.id
        const streamHandlers = {
          onDelta: (delta: string) => {
            assistantMessage.content += delta
          },
          onEvent: (event: AgentRunEvent) => {
            const item = timelineItem(event)
            if (item) {
              assistantMessage.agentEvents = [...(assistantMessage.agentEvents ?? []), item]
            }
          },
        }
        const result = await deps.api.streamAgentRun(run.id, streamHandlers)
        assistantMessage.status = 'done'
        assistantMessage.requestId = result.requestId
        assistantMessage.creditsCost = result.creditsCost
      } catch (error) {
        assistantMessage.status = 'error'
        assistantMessage.content = error instanceof Error ? error.message : '发送失败'
        throw error
      } finally {
        conversation.updatedAt = now()
        await deps.localData.save(conversation)
      }

      return conversation
    },
  }
}

function createConversation(firstMessage: string, timestamp: string): Conversation {
  return {
    id: createLocalID('conv'),
    title: firstMessage.slice(0, 24) || '新对话',
    archived: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    messages: [],
  }
}

function formatUserMessage(text: string, document?: { name: string }): string {
  if (!document) {
    return text
  }
  return `📎 ${document.name}\n${text}`
}

export function timelineItem(event: AgentRunEvent): AgentTimelineItem | null {
  if (event.event_type === 'llm.delta') {
    return null
  }
  const payload = event.payload ?? {}
  const eventId = event.id
  switch (event.event_type) {
    case 'skill.selected':
      return { type: event.event_type, label: `选择能力：${stringValue(payload.skill) || 'direct-answer'}`, eventId }
    case 'tool.requested':
      return { type: event.event_type, label: `调用工具：${toolActionLabel(stringValue(payload.tool))}`, eventId }
    case 'tool.completed':
      return { type: event.event_type, label: `工具完成：${toolActionLabel(stringValue(payload.tool))}`, eventId }
    case 'tool.failed':
      return { type: event.event_type, label: `工具失败：${toolActionLabel(stringValue(payload.tool))}`, eventId }
    case 'permission.required': {
      const tool = stringValue(payload.tool)
      return {
        type: event.event_type,
        label: `需要权限：${toolActionLabel(tool)}`,
        eventId,
        permissionRequestId: stringValue(payload.request_id),
        permissionTool: toolActionLabel(tool),
      }
    }
    case 'permission.resolved': {
      const tool = stringValue(payload.tool)
      const decision = payload.decision === 'approve' ? 'approve' : 'deny'
      return {
        type: event.event_type,
        label: `${decision === 'approve' ? '权限已批准' : '权限已拒绝'}：${toolActionLabel(tool)}`,
        eventId,
        permissionRequestId: stringValue(payload.request_id),
        permissionTool: toolActionLabel(tool),
        permissionDecision: decision,
      }
    }
    case 'artifact.created': {
      const title = stringValue(payload.title) || stringValue(payload.artifact_id)
      const tool = stringValue(payload.tool)
      return {
        type: event.event_type,
        label: `Artifact：${title || tool}`,
        eventId,
        artifactId: stringValue(payload.artifact_id),
        artifactTitle: title,
        artifactTool: tool,
      }
    }
    case 'verification.completed': {
      const status = payload.status === 'passed' ? 'passed' : 'failed'
      const tool = stringValue(payload.tool)
      return {
        type: event.event_type,
        label: `${status === 'passed' ? '验证通过' : '验证失败'}：${toolActionLabel(tool)}`,
        eventId,
        verificationStatus: status,
      }
    }
    case 'run.completed':
      return { type: event.event_type, label: '任务完成', eventId }
    case 'run.failed':
      return { type: event.event_type, label: stringValue(payload.message) || '任务失败', eventId }
    case 'run.canceled':
      return { type: event.event_type, label: '任务已取消', eventId }
    default:
      return { type: event.event_type, label: event.event_type, eventId }
  }
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function toolActionLabel(tool: string): string {
  const labels: Record<string, string> = {
    'fs.list': '列出文件',
    'fs.read': '读取文件',
    'fs.search': '搜索文件',
    'fs.write': '写入文件',
    'file.read': '读取文件',
    'file.search': '搜索文件',
    'file.write': '写入文件',
    'workspace.open': '打开工作区',
    'open.url': '打开网页',
    'open.file': '打开文件',
    'clipboard.read': '读取剪贴板',
    'clipboard.write': '写入剪贴板',
    'task.verify': '验证任务结果',
    'shell.run': '运行命令',
    'web.fetch': '读取网页',
    'web.search': '搜索网页',
    'mcp.call': '调用扩展工具',
    'document.read': '阅读文档',
    'time.now': '读取时间',
  }
  return labels[tool] || tool || '工具'
}
