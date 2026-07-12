import { APIError, type ChatAPI, type StreamChatResult } from '../../shared/api/client'
import type { CloudLLMMessage, CloudToolDefinition } from '../../shared/cloudAgentLoop'
import type { AgentRunEvent } from '../../shared/api/sse'
import { deriveAgentHistory } from './conversationHistory'
import { createTranslator, type TranslationKey, type Translator } from '../../shared/i18n/i18n'
import { createLocalID, LocalConversationStore } from '../../shared/local-data/localConversations'
import { isAutoMode } from '../../shared/modelMode'
import type {
  AgentQuestionItem,
  AgentPlanTodo,
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
  documents?: Array<{
    id: string
    name: string
    contentType?: string
  }>
  document?: {
    id: string
    name: string
    /** MIME type — lets the rendered attachment chip pick the right
     *  typed icon + decide previewability. Optional for back-compat;
     *  the chip falls back to filename-extension sniffing. */
    contentType?: string
  }
  /** Web build only: when non-empty, run the client-orchestrated cloud tool
   *  loop (image gen / web search) instead of the single-completion cloud run.
   *  These are the tool definitions advertised to the model. */
  cloudTools?: CloudToolDefinition[]
  cloudToolMaxSteps?: number
  onConversationUpdate?: (conversation: Conversation) => void
}

interface ContinueCloudToolLoopInput {
  conversationId: string
  messageId: string
  requestId: string
  answers: Record<string, string[]>
  maxSteps?: number
  onConversationUpdate?: (conversation: Conversation) => void
}

const DEFAULT_WEB_TOOL_LOOP_MAX_STEPS = 5

export function createChatStore(deps: ChatStoreDeps) {
  const now = deps.now ?? (() => new Date().toISOString())
  const t = deps.t ?? createTranslator('zh')
  const cloudToolLoopControllers = new Map<string, AbortController>()

  const streamHandlersFor = (
    conversation: Conversation,
    assistantMessage: ChatMessage,
    onConversationUpdate?: (conversation: Conversation) => void,
  ) => ({
    onDelta: (delta: string) => {
      assistantMessage.content += delta
      onConversationUpdate?.(cloneConversation(conversation))
    },
    onEvent: (event: AgentRunEvent) => {
      // "Auto → <label>" badge: emitted once per run by the cloud run
      // executor, or synthesized by the web tool loop after resolving.
      if (event.event_type === 'model.selected') {
        const payload = event.payload ?? {}
        const requested = String(payload.requested_label ?? '').trim()
        assistantMessage.runMode = {
          resolved: String(payload.label ?? payload.resolved_model_id ?? ''),
          reason: String(payload.reason ?? ''),
        }
        if (requested) assistantMessage.runMode.requested = requested
        onConversationUpdate?.(cloneConversation(conversation))
      }
      appendAgentEvent(assistantMessage, event, t)
      onConversationUpdate?.(cloneConversation(conversation))
    },
  })

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
      const documents = input.documents ?? (input.document ? [input.document] : [])

      const userMessage: ChatMessage = {
        id: createLocalID('msg'),
        role: 'user',
        // Content is the user's text ONLY. The attachment is carried
        // as a STRUCTURED attachment below (not embedded in the text
        // via the old `📎 name\n…` formatter) so MessageBubble renders
        // the clickable AttachmentChip — typed icon, side-panel
        // preview, download button. The agent still receives the doc
        // independently via createAgentRun({ attachments }) below, so
        // dropping the text embedding doesn't starve the backend.
        content: text,
        createdAt: timestamp,
        status: 'done',
        attachments: documents.length > 0
          ? documents.map((document) => ({
              documentId: document.id,
              name: document.name,
              contentType: document.contentType ?? '',
            }))
          : undefined,
      }
      const assistantMessage: ChatMessage = {
        id: createLocalID('msg'),
        role: 'assistant',
        content: '',
        createdAt: timestamp,
        status: 'streaming',
      }
      if (!isAutoMode(input.mode)) {
        assistantMessage.runMode = {
          resolved: input.mode,
          reason: '',
        }
      }

      const priorMessages = conversation.messages
      conversation.messages = [...priorMessages, userMessage, assistantMessage]
      conversation.updatedAt = timestamp
      await deps.localData.save(conversation)
      input.onConversationUpdate?.(cloneConversation(conversation))

      let cloudToolLoopRunId: string | undefined
      try {
        const streamHandlers = streamHandlersFor(conversation, assistantMessage, input.onConversationUpdate)
        let result: StreamChatResult
        if (input.cloudTools && input.cloudTools.length > 0) {
          // Web tool loop: the browser drives /agent/llm/stream + /tools/execute.
          // No server-side AgentRun record (billing still flows through both
          // endpoints' ledger writes); use a client-generated run id so the
          // tool gateway's idempotency key is stable across retries.
          const runId = createLocalID('run')
          const controller = new AbortController()
          cloudToolLoopRunId = runId
          cloudToolLoopControllers.set(runId, controller)
          assistantMessage.runId = runId
          assistantMessage.runOrigin = 'cloud'
          input.onConversationUpdate?.(cloneConversation(conversation))
          const maxSteps = input.cloudToolMaxSteps ?? DEFAULT_WEB_TOOL_LOOP_MAX_STEPS
          result = await deps.api.runCloudToolLoop(
            {
              runId,
              goal: text,
              mode: input.mode,
              history: deriveAgentHistory(priorMessages),
              tools: input.cloudTools,
              maxSteps,
            },
            streamHandlers,
            controller.signal,
          )
          settleCloudToolLoopResult(assistantMessage, result, {
            goal: text,
            mode: input.mode,
            tools: input.cloudTools,
            maxSteps,
            t,
          })
        } else {
          const run = await deps.api.createAgentRun({
            goal: text,
            mode: input.mode,
            clientConversationId: conversation.id,
            clientMessageId: userMessage.id,
            attachments: documents.map((document) => ({
              type: 'document',
              document_id: document.id,
              name: document.name,
            })),
            history: deriveAgentHistory(priorMessages),
          })
          assistantMessage.runId = run.id
          assistantMessage.runOrigin = 'cloud'
          input.onConversationUpdate?.(cloneConversation(conversation))
          result = await deps.api.streamAgentRun(run.id, streamHandlers)
          assistantMessage.status = 'done'
          assistantMessage.requestId = result.requestId
          assistantMessage.creditsCost = result.creditsCost
        }
        input.onConversationUpdate?.(cloneConversation(conversation))
      } catch (error) {
        if (cloudToolLoopRunId && isAbortError(error)) {
          assistantMessage.status = 'done'
          const canceledItem = timelineItem(
            { event_type: 'run.canceled', run_id: cloudToolLoopRunId, payload: {} },
            t,
          )
          if (canceledItem) {
            assistantMessage.agentEvents = [...(assistantMessage.agentEvents ?? []), canceledItem]
          }
          input.onConversationUpdate?.(cloneConversation(conversation))
          return conversation
        }
        assistantMessage.status = 'error'
        assistantMessage.content = chatErrorMessage(error, t)
        input.onConversationUpdate?.(cloneConversation(conversation))
        throw error
      } finally {
        if (cloudToolLoopRunId) {
          cloudToolLoopControllers.delete(cloudToolLoopRunId)
        }
        conversation.updatedAt = now()
        await deps.localData.save(conversation)
      }

      return conversation
    },
    async continueCloudToolLoop(input: ContinueCloudToolLoopInput): Promise<Conversation> {
      const conversation = await deps.localData.get(input.conversationId)
      const assistantMessage = conversation?.messages.find((message) => message.id === input.messageId)
      const continuation = assistantMessage?.cloudToolContinuation
      if (!conversation || !assistantMessage?.runId || !continuation) {
        throw new Error(t('app.notice.missingCloudToolContinuation'))
      }

      appendAgentEvent(
        assistantMessage,
        {
          event_type: 'question.answered',
          run_id: assistantMessage.runId,
          payload: {
            request_id: input.requestId,
            answers: input.answers,
          },
        },
        t,
      )

      if (!hasConcreteAnswer(input.answers)) {
        assistantMessage.status = 'done'
        assistantMessage.cloudToolContinuation = undefined
        conversation.updatedAt = now()
        await deps.localData.save(conversation)
        input.onConversationUpdate?.(cloneConversation(conversation))
        return conversation
      }

      const controller = new AbortController()
      const runId = assistantMessage.runId
      cloudToolLoopControllers.set(runId, controller)
      assistantMessage.status = 'streaming'
      input.onConversationUpdate?.(cloneConversation(conversation))
      try {
        const maxSteps = input.maxSteps ?? continuation.maxSteps
        const result = await deps.api.runCloudToolLoop(
          {
            runId,
            goal: continuation.goal,
            mode: continuation.mode,
            history: [],
            tools: continuation.tools,
            maxSteps,
            continuationMessages: continuation.messages as CloudLLMMessage[],
          },
          streamHandlersFor(conversation, assistantMessage, input.onConversationUpdate),
          controller.signal,
        )
        settleCloudToolLoopResult(assistantMessage, result, {
          goal: continuation.goal,
          mode: continuation.mode,
          tools: continuation.tools,
          maxSteps,
          t,
        })
        input.onConversationUpdate?.(cloneConversation(conversation))
      } catch (error) {
        if (isAbortError(error)) {
          assistantMessage.status = 'done'
          appendAgentEvent(
            assistantMessage,
            { event_type: 'run.canceled', run_id: runId, payload: {} },
            t,
          )
          input.onConversationUpdate?.(cloneConversation(conversation))
          return conversation
        }
        assistantMessage.status = 'error'
        assistantMessage.content = chatErrorMessage(error, t)
        input.onConversationUpdate?.(cloneConversation(conversation))
        throw error
      } finally {
        cloudToolLoopControllers.delete(runId)
        conversation.updatedAt = now()
        await deps.localData.save(conversation)
      }

      return conversation
    },
    async cancelCloudToolLoop(runId: string): Promise<boolean> {
      const controller = cloudToolLoopControllers.get(runId)
      if (!controller || controller.signal.aborted) {
        return false
      }
      controller.abort()
      return true
    },
  }
}

export async function recoverOrphanCloudStreamingConversations(
  localData: LocalConversationStore,
  options: { t?: Translator } = {},
): Promise<Conversation[]> {
  const t = options.t ?? createTranslator('zh')
  const conversations = await localData.list()
  const recovered: Conversation[] = []

  for (const conversation of conversations) {
    const next = cloneConversation(conversation)
    if (recoverOrphanCloudStreamingMessages(next, t)) {
      await localData.save(next)
    }
    recovered.push(next)
  }

  return recovered
}

function appendAgentEvent(message: ChatMessage, event: AgentRunEvent, t: Translator): void {
  const item = timelineItem(event, t)
  if (item) {
    message.agentEvents = [...(message.agentEvents ?? []), item]
  }
}

function settleCloudToolLoopResult(
  message: ChatMessage,
  result: StreamChatResult,
  options: {
    goal: string
    mode: ChatMode
    tools: CloudToolDefinition[]
    maxSteps: number
    t: Translator
  },
): void {
  message.requestId = result.requestId
  message.creditsCost = (message.creditsCost ?? 0) + result.creditsCost
  if (result.hitStepCap && result.continuationMessages?.length) {
    const maxSteps = result.maxSteps ?? options.maxSteps
    message.status = 'waiting_input'
    message.cloudToolContinuation = {
      requestId: result.requestId,
      goal: options.goal,
      mode: options.mode,
      messages: result.continuationMessages,
      tools: options.tools,
      maxSteps,
    }
    appendAgentEvent(
      message,
      {
        event_type: 'question.asked',
        run_id: message.runId,
        payload: {
          request_id: createLocalID('web-step-cap'),
          questions: [
            {
              header: options.t('chat.webToolStepCap.header'),
              question: options.t('chat.webToolStepCap.question', { count: maxSteps }),
              options: [
                {
                  label: options.t('chat.webToolStepCap.continueLabel', { count: maxSteps }),
                  description: options.t('chat.webToolStepCap.continueDescription'),
                },
              ],
            },
          ],
        },
      },
      options.t,
    )
    return
  }

  message.status = 'done'
  message.cloudToolContinuation = undefined
}

function hasConcreteAnswer(answers: Record<string, string[]>): boolean {
  return Object.values(answers).some((values) => values.some((value) => value.trim().length > 0))
}

function recoverOrphanCloudStreamingMessages(conversation: Conversation, t: Translator): boolean {
  let changed = false
  const message = t('chat.error.cloudRunInterrupted')

  for (const item of conversation.messages) {
    if (!isOrphanWebCloudToolLoopMessage(item)) {
      continue
    }
    item.status = 'error'
    if (!item.content.trim()) {
      item.content = message
    }
    const failedItem = timelineItem(
      {
        event_type: 'run.failed',
        run_id: item.runId,
        payload: { message },
      },
      t,
    )
    if (failedItem) {
      item.agentEvents = [...(item.agentEvents ?? []), failedItem]
    }
    changed = true
  }

  return changed
}

function isOrphanWebCloudToolLoopMessage(message: ChatMessage): boolean {
  return (
    message.role === 'assistant' &&
    message.status === 'streaming' &&
    message.runOrigin === 'cloud' &&
    typeof message.runId === 'string' &&
    message.runId.startsWith('run_')
  )
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && /abort/i.test(error.name || error.message))
  )
}

function chatErrorMessage(error: unknown, t: Translator): string {
  if (error instanceof APIError && error.status === 429) {
    const wait = formatRetryAfter(error.retryAfterSeconds, t)
    return wait
      ? t('chat.error.rateLimitedWithWait', { wait })
      : t('chat.error.rateLimited')
  }
  return error instanceof Error ? error.message : t('chat.error.sendFailed')
}

function formatRetryAfter(seconds: number | undefined, t: Translator): string {
  if (seconds === undefined || !Number.isFinite(seconds)) {
    return ''
  }
  if (seconds < 60) {
    return t('chat.retryAfter.seconds', { count: Math.max(0, Math.ceil(seconds)) })
  }
  return t('chat.retryAfter.minutes', { count: Math.ceil(seconds / 60) })
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
      const item: AgentTimelineItem = {
        type: event.event_type,
        label: t('chat.timeline.toolCompleted', { tool: toolActionLabel(tool, t) }),
        eventId,
        tool,
        toolCallId: stringValue(payload.tool_call_id) || undefined,
        target: toolTarget(payload, tool),
        toolDetail: toolDetail(payload, tool),
      }
      // For code.execute, extract any image/png payloads from the
      // tool result so MessageBubble can render them inline. Without
      // this the user only sees the LLM's text, which often makes up
      // bogus `![](https://imgbb.com/...)` URLs as placeholders for
      // charts it knows it produced but can't reference.
      if (tool === 'code.execute') {
        item.codeExecImages = extractCodeExecImages(payload)
      }
      return item
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
        permissionToolName: tool,
        permissionArguments:
          payload.arguments && typeof payload.arguments === 'object' && !Array.isArray(payload.arguments)
            ? payload.arguments as Record<string, unknown>
            : {},
      }
    }
    case 'permission.resolved': {
      const tool = stringValue(payload.tool)
      const decision = payload.decision === 'approve' || payload.decision === 'edit' ? payload.decision : 'deny'
      const scope = payload.scope === 'run' ? 'run' : 'once'
      const approvedLabel = scope === 'run' ? t('chat.timeline.permissionApprovedRun') : t('chat.timeline.permissionApprovedOnce')
      return {
        type: event.event_type,
        label: `${decision === 'approve' || decision === 'edit' ? approvedLabel : t('chat.timeline.permissionDenied')}${t('chat.timeline.labelJoiner')}${toolActionLabel(tool, t)}`,
        eventId,
        permissionRequestId: stringValue(payload.request_id),
        permissionTool: toolActionLabel(tool, t),
        permissionDecision: decision,
        permissionScope: scope,
      }
    }
    case 'tool.reconciliation_required': {
      const tool = stringValue(payload.tool_name)
      return {
        type: event.event_type,
        label: t('chat.timeline.toolReconciliationRequired', { tool: toolActionLabel(tool, t) }),
        eventId,
        permissionRequestId: stringValue(payload.request_id),
        permissionTool: toolActionLabel(tool, t),
        permissionToolName: tool,
      }
    }
    case 'tool.reconciliation_resolved': {
      const decision = payload.decision === 'confirmed_completed' || payload.decision === 'retry_not_executed'
        ? payload.decision
        : 'abort'
      return {
        type: event.event_type,
        label: t(`chat.timeline.toolReconciliation.${decision}`),
        eventId,
        permissionRequestId: stringValue(payload.request_id),
        reconciliationDecision: decision,
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
    case 'plan.approval_required': {
      return {
        type: event.event_type,
        label: t('chat.timeline.planApprovalRequired'),
        eventId,
        planApprovalRequestId: stringValue(payload.request_id),
        planTodos: parsePlanTodos(payload.todos),
      }
    }
    case 'plan.approval_resolved': {
      const decision = planApprovalDecision(payload.decision)
      const labelKey =
        decision === 'approve'
          ? 'chat.timeline.planApproved'
          : decision === 'modify'
            ? 'chat.timeline.planModified'
            : 'chat.timeline.planRejected'
      return {
        type: event.event_type,
        label: t(labelKey),
        eventId,
        planApprovalRequestId: stringValue(payload.request_id),
        planApprovalDecision: decision,
      }
    }
    case 'steering.injected':
      return { type: event.event_type, label: t('chat.timeline.steeringInjected'), eventId }
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
    case 'repair.workflow': {
      const attempt = numberValue(payload.attempt)
      const maxAttempts = numberValue(payload.max_attempts)
      const status = repairWorkflowStatus(payload.status)
      return {
        type: event.event_type,
        label: t(repairWorkflowLabelKey(status), {
          attempt: attempt ? String(attempt) : '?',
          max: maxAttempts ? String(maxAttempts) : '?',
        }),
        eventId,
        repairWorkflowStatus: status,
        repairAttempt: attempt || undefined,
        repairSourceRunId: stringValue(payload.source_run_id) || undefined,
        repairSourceMessageId: stringValue(payload.source_message_id) || undefined,
      }
    }
    case 'run.waiting': {
      const handoff = objectValue(payload.handoff)
      const handoffLedgerState = handoffLedgerStateValue(handoff?.ledger_state)
      const handoffLedgerMessage = stringValue(handoff?.ledger_message)
      return {
        type: event.event_type,
        label: t('chat.timeline.runWaiting'),
        eventId,
        ...(handoffLedgerState ? { handoffLedgerState } : {}),
        ...(handoffLedgerMessage ? { handoffLedgerMessage } : {}),
      }
    }
    case 'run.budget_warning': {
      const label = payload.reason === 'long_running' ? t('chat.timeline.budgetLong') : t('chat.timeline.budgetMax')
      return { type: event.event_type, label, eventId }
    }
    case 'run.completed':
      return { type: event.event_type, label: t('chat.timeline.runCompleted'), eventId }
    case 'run.failed':
      return runFailedTimelineItem(event.event_type, payload, eventId, t)
    case 'run.cleanup_required':
      return {
        type: event.event_type,
        label: stringValue(payload.error) || t('chat.timeline.runCleanupRequired'),
        eventId,
        failureCategory: stringValue(payload.category) || 'execution_cleanup_unconfirmed',
        failureRetryable: false,
      }
    case 'run.canceled':
      return { type: event.event_type, label: t('chat.timeline.runCanceled'), eventId }
    default:
      return { type: event.event_type, label: event.event_type, eventId }
  }
}

function runFailedTimelineItem(
  type: string,
  payload: Record<string, unknown>,
  eventId: string | undefined,
  t: Translator,
): AgentTimelineItem {
  const failureActionKind = knownFailureActionKind(payload.action_kind)
  const failureRecoveryAction = knownFailureRecoveryAction(payload.recovery_action)
  const failureCategory = stringValue(payload.category)
  const failureSuggestedAction = stringValue(payload.suggested_action)
  const rawRetryable = payload.retryable
  const failureRetryable = typeof rawRetryable === 'boolean' ? rawRetryable : undefined
  const baseLabel = stringValue(payload.message) || stringValue(payload.error) || t('chat.timeline.runFailed')
  const policyLabel = failureActionKind ? t(failureActionKindKey(failureActionKind)) : ''
  return {
    type,
    label: policyLabel ? `${baseLabel} · ${policyLabel}` : baseLabel,
    eventId,
    ...(failureCategory ? { failureCategory } : {}),
    ...(failureRetryable !== undefined ? { failureRetryable } : {}),
    ...(failureActionKind ? { failureActionKind } : {}),
    ...(failureRecoveryAction ? { failureRecoveryAction } : {}),
    ...(failureSuggestedAction ? { failureSuggestedAction } : {}),
  }
}

function knownFailureRecoveryAction(value: unknown): AgentTimelineItem['failureRecoveryAction'] | undefined {
  switch (value) {
    case 'retry':
    case 'repair':
    case 'recharge':
    case 'refresh_session':
    case 'workspace':
    case 'diagnostics':
      return value
    default:
      return undefined
  }
}

function knownFailureActionKind(value: unknown): AgentTimelineItem['failureActionKind'] | undefined {
  switch (value) {
    case 'retry':
    case 'user_action':
    case 'repair':
    case 'operator_action':
    case 'inspect':
      return value
    default:
      return undefined
  }
}

function failureActionKindKey(actionKind: NonNullable<AgentTimelineItem['failureActionKind']>): TranslationKey {
  switch (actionKind) {
    case 'retry':
      return 'diagnostics.failureActionKind.retry'
    case 'user_action':
      return 'diagnostics.failureActionKind.user_action'
    case 'repair':
      return 'diagnostics.failureActionKind.repair'
    case 'operator_action':
      return 'diagnostics.failureActionKind.operator_action'
    case 'inspect':
      return 'diagnostics.failureActionKind.inspect'
  }
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function handoffLedgerStateValue(value: unknown): AgentTimelineItem['handoffLedgerState'] | undefined {
  switch (value) {
    case 'not_required':
    case 'missing':
    case 'fresh':
    case 'stale':
      return value
    default:
      return undefined
  }
}

function repairWorkflowStatus(value: unknown): NonNullable<AgentTimelineItem['repairWorkflowStatus']> {
  switch (value) {
    case 'completed':
    case 'failed':
    case 'rejected':
    case 'canceled':
      return value
    default:
      return 'started'
  }
}

function repairWorkflowLabelKey(
  status: NonNullable<AgentTimelineItem['repairWorkflowStatus']>,
): Parameters<Translator>[0] {
  switch (status) {
    case 'completed':
      return 'chat.timeline.repairCompleted'
    case 'failed':
      return 'chat.timeline.repairFailed'
    case 'rejected':
      return 'chat.timeline.repairRejected'
    case 'canceled':
      return 'chat.timeline.repairCanceled'
    default:
      return 'chat.timeline.repairStarted'
  }
}

/** Extract base64-encoded image payloads from a code.execute tool
 *  result payload. The wire envelope is set by
 *  api/internal/httpapi/code_gateway.go:codeExecData → JSON-encoded
 *  into `payload.content` AND mirrored on `payload.data`. We try both
 *  so older daemon builds still produce images; current daemons
 *  populate `data.results[].data["image/png" | "image/jpeg" | "image/svg+xml"]`.
 *  Returns the unique image strings in document order. */
function extractCodeExecImages(payload: Record<string, unknown>): string[] {
  const out: string[] = []
  const visit = (results: unknown) => {
    if (!Array.isArray(results)) return
    for (const entry of results) {
      if (!entry || typeof entry !== 'object') continue
      const data = (entry as { data?: unknown }).data
      if (!data || typeof data !== 'object') continue
      const dataMap = data as Record<string, unknown>
      for (const key of ['image/png', 'image/jpeg', 'image/svg+xml']) {
        const value = dataMap[key]
        if (typeof value === 'string' && value.length > 0 && !out.includes(value)) {
          out.push(value)
        }
      }
    }
  }
  // Daemon path: payload.data.results.
  const data = payload.data
  if (data && typeof data === 'object') {
    visit((data as { results?: unknown }).results)
  }
  // Wire-envelope fallback: payload.content is a JSON string of the
  // full result envelope (see daemon code.py wrapper).
  if (out.length === 0 && typeof payload.content === 'string') {
    try {
      const parsed = JSON.parse(payload.content) as { data?: { results?: unknown } }
      visit(parsed?.data?.results)
    } catch {
      // Not JSON — ignore.
    }
  }
  return out
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
  const path = stringValue(args.path) || stringValue(args.file_path)
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

function parsePlanTodos(value: unknown): AgentPlanTodo[] {
  if (!Array.isArray(value)) {
    return []
  }
  const todos: AgentPlanTodo[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') {
      continue
    }
    const item = raw as Record<string, unknown>
    const content = stringValue(item.content).trim()
    if (!content) {
      continue
    }
    todos.push({
      content,
      status: planTodoStatus(item.status),
    })
  }
  return todos
}

function planTodoStatus(value: unknown): AgentPlanTodo['status'] {
  switch (value) {
    case 'in_progress':
    case 'completed':
      return value
    default:
      return 'pending'
  }
}

function planApprovalDecision(value: unknown): NonNullable<AgentTimelineItem['planApprovalDecision']> {
  switch (value) {
    case 'modify':
    case 'reject':
      return value
    default:
      return 'approve'
  }
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
    'code.execute': t('chat.tool.code.execute'),
    'pdf.inspect': t('chat.tool.pdf.inspect'),
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
    glob: t('chat.tool.glob'),
    grep: t('chat.tool.grep'),
    execute: t('chat.tool.execute'),
    'memory.search': t('chat.tool.memory.search'),
    'memory.write': t('chat.tool.memory.write'),
    'image.generate': t('chat.tool.image.generate'),
    'image.edit': t('chat.tool.image.edit'),
    'browser.task': t('chat.tool.browser.task'),
    // Office tools — read + outline + read_range + 10 write tools.
    'office.read': t('chat.tool.office.read'),
    'office.outline': t('chat.tool.office.outline'),
    'office.read_range': t('chat.tool.office.read_range'),
    'office.find_replace': t('chat.tool.office.find_replace'),
    'office.insert_paragraph': t('chat.tool.office.insert_paragraph'),
    'office.update_paragraph': t('chat.tool.office.update_paragraph'),
    'office.delete_paragraph': t('chat.tool.office.delete_paragraph'),
    'office.apply_style': t('chat.tool.office.apply_style'),
    'office.set_cells': t('chat.tool.office.set_cells'),
    'office.set_formula': t('chat.tool.office.set_formula'),
    'office.set_cell_format': t('chat.tool.office.set_cell_format'),
    'office.merge_cells': t('chat.tool.office.merge_cells'),
    'office.add_row': t('chat.tool.office.add_row'),
    // Phase 3 — pptx
    'office.create_pptx': t('chat.tool.office.create_pptx'),
    'office.add_slide': t('chat.tool.office.add_slide'),
    'office.update_slide': t('chat.tool.office.update_slide'),
    'office.delete_slide': t('chat.tool.office.delete_slide'),
    'office.reorder_slides': t('chat.tool.office.reorder_slides'),
    'office.set_slide_title': t('chat.tool.office.set_slide_title'),
    'office.set_slide_bullets': t('chat.tool.office.set_slide_bullets'),
    'office.set_slide_notes': t('chat.tool.office.set_slide_notes'),
    'office.add_image_to_slide': t('chat.tool.office.add_image_to_slide'),
    'office.read_slides': t('chat.tool.office.read_slides'),
  }
  return labels[tool] || tool || t('chat.tool.fallback')
}
