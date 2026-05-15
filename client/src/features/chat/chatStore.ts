import type { ChatAPI } from '../../shared/api/client'
import type { AgentRunEvent } from '../../shared/api/sse'
import { deriveAgentHistory } from './conversationHistory'
import { createTranslator, type Translator } from '../../shared/i18n/i18n'
import { createLocalID, LocalConversationStore } from '../../shared/local-data/localConversations'
import type { AgentTimelineItem, ChatMode, ChatMessage, Conversation } from '../../shared/local-data/types'

interface ChatStoreDeps {
  localData: LocalConversationStore
  api: ChatAPI
  t?: Translator
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
  onConversationUpdate?: (conversation: Conversation) => void
}

export function createChatStore(deps: ChatStoreDeps) {
  const now = deps.now ?? (() => new Date().toISOString())
  const t = deps.t ?? createTranslator('zh')

  return {
    async sendMessage(input: SendMessageInput): Promise<Conversation> {
      const text = input.content.trim()
      if (!text) {
        throw new Error(t('chat.error.empty'))
      }

      const timestamp = now()
      const conversation =
        (input.conversationId ? await deps.localData.get(input.conversationId) : undefined) ??
        createConversation(text, timestamp, t)

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

      const priorMessages = conversation.messages
      conversation.messages = [...priorMessages, userMessage, assistantMessage]
      conversation.updatedAt = timestamp
      await deps.localData.save(conversation)
      input.onConversationUpdate?.(cloneConversation(conversation))

      try {
        const run = await deps.api.createAgentRun({
          goal: text,
          mode: input.mode,
          clientConversationId: conversation.id,
          clientMessageId: userMessage.id,
          attachments: input.document
            ? [{ type: 'document', document_id: input.document.id, name: input.document.name }]
            : [],
          history: deriveAgentHistory(priorMessages),
        })
        assistantMessage.runId = run.id
        assistantMessage.runOrigin = 'cloud'
        input.onConversationUpdate?.(cloneConversation(conversation))
        const streamHandlers = {
          onDelta: (delta: string) => {
            assistantMessage.content += delta
            input.onConversationUpdate?.(cloneConversation(conversation))
          },
          onEvent: (event: AgentRunEvent) => {
            const item = timelineItem(event, t)
            if (item) {
              assistantMessage.agentEvents = [...(assistantMessage.agentEvents ?? []), item]
              input.onConversationUpdate?.(cloneConversation(conversation))
            }
          },
        }
        const result = await deps.api.streamAgentRun(run.id, streamHandlers)
        assistantMessage.status = 'done'
        assistantMessage.requestId = result.requestId
        assistantMessage.creditsCost = result.creditsCost
        input.onConversationUpdate?.(cloneConversation(conversation))
      } catch (error) {
        assistantMessage.status = 'error'
        assistantMessage.content = error instanceof Error ? error.message : t('chat.error.sendFailed')
        input.onConversationUpdate?.(cloneConversation(conversation))
        throw error
      } finally {
        conversation.updatedAt = now()
        await deps.localData.save(conversation)
      }

      return conversation
    },
  }
}

function cloneConversation(conversation: Conversation): Conversation {
  return {
    ...conversation,
    messages: conversation.messages.map((message) => ({
      ...message,
      agentEvents: message.agentEvents ? [...message.agentEvents] : undefined,
    })),
  }
}

function createConversation(firstMessage: string, timestamp: string, t: Translator): Conversation {
  return {
    id: createLocalID('conv'),
    title: firstMessage.slice(0, 24) || t('chat.newConversation'),
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

export function timelineItem(event: AgentRunEvent, t: Translator = createTranslator('zh')): AgentTimelineItem | null {
  if (event.event_type === 'llm.delta') {
    return null
  }
  const payload = event.payload ?? {}
  const eventId = event.id
  switch (event.event_type) {
    case 'skill.selected':
      return { type: event.event_type, label: t('chat.timeline.skillSelected', { skill: stringValue(payload.skill) || 'direct-answer' }), eventId }
    case 'tool.requested':
      return { type: event.event_type, label: t('chat.timeline.toolRequested', { tool: toolActionLabel(stringValue(payload.tool), t) }), eventId }
    case 'tool.completed':
      return { type: event.event_type, label: t('chat.timeline.toolCompleted', { tool: toolActionLabel(stringValue(payload.tool), t) }), eventId }
    case 'tool.failed':
      return { type: event.event_type, label: t('chat.timeline.toolFailed', { tool: toolActionLabel(stringValue(payload.tool), t) }), eventId }
    case 'permission.required': {
      const tool = stringValue(payload.tool)
      return {
        type: event.event_type,
        label: t('chat.timeline.permissionRequired', { tool: toolActionLabel(tool, t) }),
        eventId,
        permissionRequestId: stringValue(payload.request_id),
        permissionTool: toolActionLabel(tool, t),
      }
    }
    case 'permission.resolved': {
      const tool = stringValue(payload.tool)
      const decision = payload.decision === 'approve' ? 'approve' : 'deny'
      const scope = payload.scope === 'run' ? 'run' : 'once'
      const approvedLabel = scope === 'run' ? t('chat.timeline.permissionApprovedRun') : t('chat.timeline.permissionApprovedOnce')
      return {
        type: event.event_type,
        label: `${decision === 'approve' ? approvedLabel : t('chat.timeline.permissionDenied')}${t('chat.timeline.labelJoiner')}${toolActionLabel(tool, t)}`,
        eventId,
        permissionRequestId: stringValue(payload.request_id),
        permissionTool: toolActionLabel(tool, t),
        permissionDecision: decision,
        permissionScope: scope,
      }
    }
    case 'permission.auto_approved': {
      const tool = stringValue(payload.tool)
      return {
        type: event.event_type,
        label: t('chat.timeline.permissionAutoApproved', { tool: toolActionLabel(tool, t) }),
        eventId,
        permissionTool: toolActionLabel(tool, t),
        permissionDecision: 'approve',
        permissionScope: 'run',
      }
    }
    case 'artifact.created': {
      const title = stringValue(payload.title) || stringValue(payload.artifact_id)
      const tool = stringValue(payload.tool)
      return {
        type: event.event_type,
        label: t('chat.timeline.artifact', { title: title || tool }),
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
        label: `${status === 'passed' ? t('chat.timeline.verificationPassed') : t('chat.timeline.verificationFailed')}${t('chat.timeline.labelJoiner')}${toolActionLabel(tool, t)}`,
        eventId,
        verificationStatus: status,
      }
    }
    case 'browser.observed': {
      const title = stringValue(payload.title)
      const url = stringValue(payload.url)
      return { type: event.event_type, label: t('chat.timeline.browserObserved', { target: title || url || t('chat.timeline.currentPage') }), eventId, artifactId: stringValue(payload.artifact_id) }
    }
    case 'source.collected': {
      const title = stringValue(payload.title)
      const url = stringValue(payload.url)
      return {
        type: event.event_type,
        label: t('chat.timeline.sourceCollected', { target: title || url || t('chat.timeline.webSource') }),
        eventId,
        artifactId: stringValue(payload.artifact_id),
        sourceTitle: title,
        sourceUrl: url,
      }
    }
    case 'environment.observed': {
      const app = stringValue(payload.foreground_app)
      const title = stringValue(payload.window_title)
      const platform = stringValue(payload.platform)
      const target = app && title ? `${app} - ${title}` : app || title || platform || t('chat.timeline.localEnvironment')
      return { type: event.event_type, label: t('chat.timeline.environmentObserved', { target }), eventId }
    }
    case 'ui.action.requested': {
      const tool = stringValue(payload.tool)
      return { type: event.event_type, label: t('chat.timeline.uiRequested', { tool: toolActionLabel(tool, t) }), eventId }
    }
    case 'ui.action.completed': {
      const tool = stringValue(payload.tool)
      return { type: event.event_type, label: t('chat.timeline.uiCompleted', { tool: toolActionLabel(tool, t) }), eventId, artifactId: stringValue(payload.artifact_id) }
    }
    case 'run.budget_warning': {
      const label = payload.reason === 'long_running' ? t('chat.timeline.budgetLong') : t('chat.timeline.budgetMax')
      return { type: event.event_type, label, eventId }
    }
    case 'run.completed':
      return { type: event.event_type, label: t('chat.timeline.runCompleted'), eventId }
    case 'run.failed':
      return { type: event.event_type, label: stringValue(payload.message) || t('chat.timeline.runFailed'), eventId }
    case 'run.canceled':
      return { type: event.event_type, label: t('chat.timeline.runCanceled'), eventId }
    default:
      return { type: event.event_type, label: event.event_type, eventId }
  }
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function toolActionLabel(tool: string, t: Translator): string {
  const labels: Record<string, string> = {
    'fs.list': t('chat.tool.fs.list'),
    'fs.read': t('chat.tool.fs.read'),
    'fs.search': t('chat.tool.fs.search'),
    'fs.write': t('chat.tool.fs.write'),
    'file.read': t('chat.tool.fs.read'),
    'file.search': t('chat.tool.fs.search'),
    'file.write': t('chat.tool.fs.write'),
    'workspace.open': t('chat.tool.workspace.open'),
    'open.url': t('chat.tool.open.url'),
    'open.file': t('chat.tool.open.file'),
    'clipboard.read': t('chat.tool.clipboard.read'),
    'clipboard.write': t('chat.tool.clipboard.write'),
    'task.verify': t('chat.tool.task.verify'),
    'browser.open': t('chat.tool.browser.open'),
    'browser.search': t('chat.tool.browser.search'),
    'browser.snapshot': t('chat.tool.browser.snapshot'),
    'browser.read': t('chat.tool.browser.read'),
    'browser.verify': t('chat.tool.browser.verify'),
    'browser.screenshot': t('chat.tool.browser.screenshot'),
    'browser.click': t('chat.tool.browser.click'),
    'browser.type': t('chat.tool.browser.type'),
    'browser.scroll': t('chat.tool.browser.scroll'),
    'browser.close': t('chat.tool.browser.close'),
    'environment.observe': t('chat.tool.environment.observe'),
    'shell.run': t('chat.tool.shell.run'),
    'web.fetch': t('chat.tool.web.fetch'),
    'web.search': t('chat.tool.web.search'),
    'mcp.call': t('chat.tool.mcp.call'),
    'document.read': t('chat.tool.document.read'),
    'time.now': t('chat.tool.time.now'),
  }
  return labels[tool] || tool || t('chat.tool.fallback')
}
