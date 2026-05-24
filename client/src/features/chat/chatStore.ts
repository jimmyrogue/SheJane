import type { ChatAPI } from '../../shared/api/client'
import type { AgentRunEvent } from '../../shared/api/sse'
import { deriveAgentHistory } from './conversationHistory'
import { createTranslator, type Translator } from '../../shared/i18n/i18n'
import { createLocalID, LocalConversationStore } from '../../shared/local-data/localConversations'
import type {
  AgentQuestionItem,
  AgentTimelineItem,
  AgentToolDetail,
  ChatMode,
  ChatMessage,
  Conversation,
} from '../../shared/local-data/types'

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
    case 'llm.usage': {
      const input = Number(payload.input_tokens) || 0
      const output = Number(payload.output_tokens) || 0
      return { type: event.event_type, label: '', eventId, tokens: input + output }
    }
    case 'skill.selected':
      return { type: event.event_type, label: t('chat.timeline.skillSelected', { skill: stringValue(payload.skill) || 'direct-answer' }), eventId }
    case 'tool.requested': {
      const tool = stringValue(payload.tool)
      return {
        type: event.event_type,
        label: t('chat.timeline.toolRequested', { tool: toolActionLabel(tool, t) }),
        eventId,
        tool,
        toolCallId: stringValue(payload.tool_call_id) || undefined,
        target: toolTarget(payload, tool),
        toolDetail: toolDetail(payload, tool),
      }
    }
    case 'tool.completed': {
      const tool = stringValue(payload.tool)
      return {
        type: event.event_type,
        label: t('chat.timeline.toolCompleted', { tool: toolActionLabel(tool, t) }),
        eventId,
        tool,
        toolCallId: stringValue(payload.tool_call_id) || undefined,
        target: toolTarget(payload, tool),
        toolDetail: toolDetail(payload, tool),
      }
    }
    case 'tool.failed': {
      const tool = stringValue(payload.tool)
      return {
        type: event.event_type,
        label: t('chat.timeline.toolFailed', { tool: toolActionLabel(tool, t) }),
        eventId,
        tool,
        toolCallId: stringValue(payload.tool_call_id) || undefined,
        target: toolTarget(payload, tool),
        toolDetail: toolDetail(payload, tool),
      }
    }
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
    case 'question.asked': {
      const questions = parseQuestionPayload(payload.questions)
      return {
        type: event.event_type,
        label: t('chat.timeline.questionAsked'),
        eventId,
        questionRequestId: stringValue(payload.request_id),
        questions,
      }
    }
    case 'question.answered': {
      return {
        type: event.event_type,
        label: t('chat.timeline.questionAnswered'),
        eventId,
        questionRequestId: stringValue(payload.request_id),
        questionAnswers: parseAnswerPayload(payload.answers),
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
      return { type: event.event_type, label: t('chat.timeline.browserObserved', { target: title || url || t('chat.timeline.currentPage') }), eventId, artifactId: stringValue(payload.artifact_id), target: toolTarget(payload) }
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

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

/** A short, human concrete target for the current operation — a file name,
 *  a URL host, the command, or the search query. Back-compat single
 *  string; new code should call `toolDetail()` and read `.text`. */
function toolTarget(payload: Record<string, unknown>, tool?: string): string {
  return toolDetail(payload, tool)?.text ?? ''
}

const TOOL_TARGET_MAX = 40

/** Rich primary-argument badge per tool. Reads `payload.arguments`
 *  (assembled from the daemon's `tool.requested` event), picks the
 *  most informative field for the tool, and returns a renderable
 *  display shape. Returns `undefined` when there's nothing useful
 *  to surface — the renderer should fall back to a plain verb. */
export function toolDetail(
  payload: Record<string, unknown>,
  tool?: string,
): AgentToolDetail | undefined {
  const args =
    payload.arguments && typeof payload.arguments === 'object' && !Array.isArray(payload.arguments)
      ? (payload.arguments as Record<string, unknown>)
      : {}

  // `task` (deepagents subagent dispatcher) needs special handling —
  // its real arg names are `description` + `subagent_type`. Older code
  // in this file guessed `task_description` + `subagent_name`, which
  // matched nothing on real runs, so the task headline showed only the
  // verb. We keep the old names as aliases so any persisted timeline
  // items from before this fix still render something sensible.
  if (tool === 'task') {
    const subagent = stringValue(args.subagent_type) || stringValue(args.subagent_name)
    const description = stringValue(args.description) || stringValue(args.task_description)
    if (description) {
      return {
        kind: 'text',
        text: truncate(description, TOOL_TARGET_MAX),
        tooltip: subagent ? `${subagent}: ${description}` : description,
      }
    }
    if (subagent) {
      return { kind: 'text', text: subagent }
    }
  }

  // Web tools — host + globe icon. Tooltip carries the full URL.
  const url = stringValue(args.url) || stringValue(payload.url)
  if (url) {
    try {
      const host = new URL(url).hostname.replace(/^www\./, '')
      return { kind: 'host', text: host, tooltip: url, showWebIcon: true }
    } catch {
      // Malformed URL — fall back to truncated raw string, no icon.
      return { kind: 'text', text: truncate(url, TOOL_TARGET_MAX), tooltip: url }
    }
  }

  // Filesystem tools — basename + full path tooltip.
  const path = stringValue(args.path)
  if (path) {
    const segments = path.split(/[\\/]/).filter(Boolean)
    const basename = segments[segments.length - 1] || path
    const trailing = tool === 'ls' || tool === 'fs.list' || tool === 'workspace.open' ? '/' : ''
    return { kind: 'text', text: basename + trailing, tooltip: path }
  }

  // Search / question / prompt-style tools — pick the most natural arg.
  const command = stringValue(args.command)
  if (command) {
    return { kind: 'text', text: truncate(command, TOOL_TARGET_MAX), tooltip: command }
  }
  const query = stringValue(args.query)
  if (query) {
    return { kind: 'text', text: truncate(query, TOOL_TARGET_MAX), tooltip: query }
  }
  const task = stringValue(args.task)
  if (task) {
    return { kind: 'text', text: truncate(task, TOOL_TARGET_MAX), tooltip: task }
  }
  const prompt = stringValue(args.prompt)
  if (prompt) {
    return { kind: 'text', text: truncate(prompt, TOOL_TARGET_MAX), tooltip: prompt }
  }
  const question = stringValue(args.question)
  if (question) {
    return { kind: 'text', text: truncate(question, 30), tooltip: question }
  }
  const pattern = stringValue(args.pattern)
  if (pattern) {
    return { kind: 'text', text: truncate(pattern, TOOL_TARGET_MAX), tooltip: pattern }
  }

  // Count-style tools.
  if (Array.isArray(args.todos)) {
    return { kind: 'count', text: String(args.todos.length) }
  }
  if (Array.isArray(args.checks)) {
    return { kind: 'count', text: String(args.checks.length) }
  }

  // Last-ditch: an event-level title (browser.observed, source.collected).
  const title = stringValue(payload.title)
  if (title) {
    return { kind: 'text', text: truncate(title, TOOL_TARGET_MAX), tooltip: title }
  }
  return undefined
}

function parseAnswerPayload(value: unknown): Record<string, string[]> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const result: Record<string, string[]> = {}
  for (const [question, picks] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(picks)) {
      continue
    }
    const labels = picks.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    if (labels.length > 0) {
      result[question] = labels
    }
  }
  return Object.keys(result).length > 0 ? result : undefined
}

function parseQuestionPayload(value: unknown): AgentQuestionItem[] {
  if (!Array.isArray(value)) {
    return []
  }
  const questions: AgentQuestionItem[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') {
      continue
    }
    const item = raw as Record<string, unknown>
    const question = stringValue(item.question)
    const header = stringValue(item.header)
    const rawOptions = Array.isArray(item.options) ? item.options : []
    // Accept BOTH shapes:
    //   - { label, description? }  — the documented AgentQuestionChoice
    //   - string                   — what the daemon used to emit (and
    //                                still might if it comes from a
    //                                third-party SSE producer)
    // The daemon now normalizes to the object form at its boundary
    // (see runs.py:_normalize_question_options), but client tolerance
    // is cheap defense in depth so the UI never silently drops options
    // again.
    const options = rawOptions
      .map((option) => {
        if (typeof option === 'string') {
          const label = option.trim()
          return label ? { label } : undefined
        }
        if (!option || typeof option !== 'object') {
          return undefined
        }
        const label = stringValue((option as Record<string, unknown>).label)
        if (!label) {
          return undefined
        }
        const description = stringValue((option as Record<string, unknown>).description)
        return description ? { label, description } : { label }
      })
      .filter((option): option is { label: string; description?: string } => Boolean(option))
    if (!question || options.length === 0) {
      continue
    }
    questions.push({ question, header, multiSelect: item.multiSelect === true, options })
  }
  return questions
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
    // Daemon-side tools (deepagents built-ins + our ALWAYS_INCLUDE
    // set) that previously leaked their raw names into the timeline.
    'user.ask': t('chat.tool.user.ask'),
    write_todos: t('chat.tool.write_todos'),
    task: t('chat.tool.task'),
    read_file: t('chat.tool.read_file'),
    write_file: t('chat.tool.write_file'),
    edit_file: t('chat.tool.edit_file'),
    ls: t('chat.tool.ls'),
    execute: t('chat.tool.execute'),
    'memory.search': t('chat.tool.memory.search'),
    'memory.write': t('chat.tool.memory.write'),
    'image.generate': t('chat.tool.image.generate'),
    'image.edit': t('chat.tool.image.edit'),
    'browser.task': t('chat.tool.browser.task'),
  }
  return labels[tool] || tool || t('chat.tool.fallback')
}
