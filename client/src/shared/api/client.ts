import { parseSSEBuffer, parseLLMStreamBuffer, type AgentRunEvent } from './sse'
import { streamAgentSSE } from '../streaming/streamTransport'
import {
  runCloudAgentLoop,
  type CloudAgentLoopDeps,
  type CloudLLMMessage,
  type CloudLLMTurn,
  type CloudToolDefinition,
  type CloudToolResult,
} from '../cloudAgentLoop'
import type { ChatMode, PdfDocumentMetadata } from '../local-data/types'
import { autoIntentFromMode, isAutoMode } from '../modelMode'

export interface StreamChatRequest {
  mode: ChatMode
  scene: string
  clientConversationId: string
  clientMessageId: string
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>
}

export interface StreamHandlers {
  onDelta: (content: string) => void
  onEvent?: (event: AgentRunEvent) => void
}

export interface StreamChatResult {
  requestId: string
  inputTokens: number
  outputTokens: number
  creditsCost: number
  hitStepCap?: boolean
  steps?: number
  maxSteps?: number
  continuationMessages?: CloudLLMMessage[]
}

export interface ChatAPI {
  createAgentRun(request: CreateAgentRunRequest): Promise<AgentRun>
  streamAgentRun(runID: string, handlers: StreamHandlers): Promise<StreamChatResult>
  /** Web-only: drive the client-orchestrated cloud tool loop (image gen /
   *  web search) over the existing Go LLM + tool-gateway endpoints. */
  runCloudToolLoop(input: CloudToolLoopRequest, handlers: StreamHandlers, signal?: AbortSignal): Promise<StreamChatResult>
}

export interface CloudToolLoopRequest {
  runId: string
  goal: string
  mode: ChatMode
  history: AgentHistoryMessage[]
  tools: CloudToolDefinition[]
  maxSteps?: number
  continuationMessages?: CloudLLMMessage[]
}

/** Per-tool configuration as reported by GET /agent/tool-capabilities. */
export interface ToolCapability {
  configured: boolean
  provider: string
  credits_cost: number
  requires_auth?: boolean
  description?: string
  inputSchema?: Record<string, unknown>
}

export interface ToolCapabilitiesResult {
  tools: Record<string, ToolCapability>
  webToolLoopMaxSteps: number
}

export interface AgentAttachment {
  type: 'document'
  document_id: string
  name?: string
}

export interface AgentHistoryMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface CreateAgentRunRequest {
  goal: string
  mode: ChatMode
  clientConversationId: string
  clientMessageId: string
  attachments: AgentAttachment[]
  history?: AgentHistoryMessage[]
}

export interface AgentRun {
  id: string
  status: string
  mode: ChatMode
  goal_summary?: string
}

export interface AuthPayload {
  access_token: string
  user: {
    id: string
    email: string
    name: string
    role: string
    status: string
    email_verified?: boolean
  }
}

export interface WalletBalance {
  id: string
  plan_code: string
  monthly_credit_limit: number
  monthly_credits_used: number
  monthly_remaining: number
  extra_credits_balance: number
  period_end: string
  status: string
}

/** One credit-ledger row, mirroring api/internal/billing.Transaction JSON.
 *  Hand-written (Go-API type, not generated from the daemon openapi). */
export interface WalletTransaction {
  id: string
  wallet_id: string
  reservation_id?: string
  type: string
  amount: number
  monthly_used_after: number
  extra_balance_after: number
  description: string
  idempotency_key?: string
  created_at: string
}

export interface BillingLLMCall {
  request_id: string
  user_id: string
  wallet_id: string
  reservation_id?: string
  run_id?: string
  mode: string
  scene: string
  model: string
  provider: string
  input_tokens: number
  output_tokens: number
  credits_cost: number
  status: string
  error_code?: string
  error_message?: string
  started_at: string
  finished_at?: string
}

export interface BillingToolCall {
  request_id: string
  user_id: string
  wallet_id: string
  reservation_id?: string
  run_id?: string
  tool_call_id?: string
  tool: string
  provider: string
  units: number
  credits_cost: number
  status: string
  error_code?: string
  error_message?: string
  idempotency_key?: string
  started_at: string
  finished_at?: string
}

export interface BillingActivity {
  id: string
  kind: 'usage' | 'ledger' | string
  run_id?: string
  reservation_ids?: string[]
  reserved_credits: number
  settled_credits: number
  released_credits: number
  net_credits: number
  llm_calls: BillingLLMCall[]
  tool_calls: BillingToolCall[]
  transactions: WalletTransaction[]
  created_at: string
  updated_at: string
}

export interface BillingCheckoutResponse {
  checkout_url: string
  stripe_checkout_session_id: string
  amount: number
  currency: 'usd' | string
  credits: number
}

export type DocumentStatus = 'uploading' | 'processing' | 'ready' | 'failed' | 'deleted'

export interface UserDocument {
  id: string
  user_id: string
  original_name: string
  content_type: string
  size_bytes: number
  status: DocumentStatus
  source_object_key: string
  text_object_key?: string
  error_message?: string
  expires_at: string
  created_at: string
  updated_at: string
  /** Structured metadata captured at upload time (PDFs only for
   *  now — pdfinfo output: page count, author, title, encrypted,
   *  …). Other types reserve the field but populate {} until they
   *  grow their own extractor. Canonical type lives in
   *  local-data/types (re-exported below) so OpenDocument can
   *  reference it without a circular import. */
  metadata?: PdfDocumentMetadata
}

// PdfDocumentMetadata is defined in local-data/types (the
// dependency-free leaf) and re-exported here so existing importers
// of `@/shared/api/client` keep working unchanged. (Imported above
// for use in UserDocument; re-exported here for downstream callers.)
export type { PdfDocumentMetadata }

export interface UploadTarget {
  method: 'PUT'
  url: string
  headers: Record<string, string>
  expires_at: string
}

export interface DocumentUploadResponse {
  document: UserDocument
  upload: UploadTarget
}

interface APIResponse<T> {
  code: number
  message: string
  data: T
}

export class APIError extends Error {
  readonly status: number
  readonly retryAfterSeconds?: number

  constructor(message: string, options: { status: number; retryAfterSeconds?: number }) {
    super(message)
    this.name = 'APIError'
    this.status = options.status
    this.retryAfterSeconds = options.retryAfterSeconds
    Object.setPrototypeOf(this, APIError.prototype)
  }
}

/** One selectable chat model from GET /api/v1/models (the user-facing
 *  catalog; no provider/key details). */
export interface ChatModelInfo {
  id: string
  label: string
  description?: string
  vendor?: string
  vendor_info?: string
  capability_tier?: string
  input_price_per_million_cny?: number
  output_price_per_million_cny?: number
  cached_input_price_per_million_cny?: number
  cache_write_price_per_million_cny?: number
  priority: number
}

export class SheJaneAPI implements ChatAPI {
  private accessToken = ''
  private tokenRefresher?: () => Promise<string | null>
  private refreshInFlight: Promise<string | null> | null = null

  constructor(readonly baseURL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8080') {}

  setAccessToken(token: string): void {
    this.accessToken = token
  }

  /** Wired by the app shell to the (Electron-bridge-aware) refresh flow.
   *  Lets authedFetch silently mint a new access token on a mid-session
   *  401 instead of bouncing the user to the login screen. Returns the
   *  new access token, or null when refresh is unavailable / failed. */
  setTokenRefresher(refresher: () => Promise<string | null>): void {
    this.tokenRefresher = refresher
  }

  /** Dedupes concurrent refreshes: a burst of 401s triggers exactly one
   *  /auth/refresh, and every waiter resolves to the same result. */
  private refreshAccessToken(): Promise<string | null> {
    if (!this.tokenRefresher) {
      return Promise.resolve(null)
    }
    if (!this.refreshInFlight) {
      const inflight = this.tokenRefresher().catch(() => null)
      this.refreshInFlight = inflight
      void inflight.finally(() => {
        if (this.refreshInFlight === inflight) {
          this.refreshInFlight = null
        }
      })
    }
    return this.refreshInFlight
  }

  /** fetch + one automatic retry on 401: the access token lives ~15 min,
   *  so an active session routinely outlives it. On the first 401 of an
   *  authed request we refresh via the long-lived refresh cookie and
   *  replay once. Auth endpoints are excluded to avoid recursion. */
  private async authedFetch(path: string, init: RequestInit, requireAuth: boolean): Promise<Response> {
    const run = () =>
      fetch(`${this.baseURL}${path}`, {
        ...init,
        credentials: 'include',
        headers: this.headers(requireAuth),
      })
    const response = await run()
    if (
      response.status === 401 &&
      requireAuth &&
      this.tokenRefresher &&
      !path.startsWith('/api/v1/auth/')
    ) {
      const token = await this.refreshAccessToken()
      if (token) {
        return run()
      }
    }
    return response
  }

  async register(input: { email: string; password: string; name: string }): Promise<AuthPayload> {
    return this.post<AuthPayload>('/api/v1/auth/register', input, false)
  }

  async login(input: { email: string; password: string }): Promise<AuthPayload> {
    return this.post<AuthPayload>('/api/v1/auth/login', input, false)
  }

  async refresh(): Promise<AuthPayload> {
    return this.post<AuthPayload>('/api/v1/auth/refresh', {}, false)
  }

  async logout(): Promise<void> {
    await this.post('/api/v1/auth/logout', {}, true)
    this.accessToken = ''
  }

  // Password reset is unauthenticated (no access token / refresh cookie), so
  // it doesn't go through the Electron auth bridge — a direct POST is fine on
  // both web and desktop.
  async requestPasswordReset(input: { email: string }): Promise<void> {
    await this.post('/api/v1/auth/password/reset-request', input, false)
  }

  async confirmPasswordReset(input: { token: string; password: string }): Promise<void> {
    await this.post('/api/v1/auth/password/reset-confirm', input, false)
  }

  // Resend the verification email to the signed-in user (auth required).
  async requestEmailVerification(): Promise<void> {
    await this.post('/api/v1/auth/email/verify-request', {}, true)
  }

  // Confirm a verification token (unauthenticated — link opens on the web).
  async confirmEmailVerification(input: { token: string }): Promise<void> {
    await this.post('/api/v1/auth/email/verify-confirm', input, false)
  }

  async balance(): Promise<WalletBalance> {
    return this.get<WalletBalance>('/api/v1/billing/balance')
  }

  async transactions(): Promise<WalletTransaction[]> {
    return this.get<WalletTransaction[]>('/api/v1/billing/transactions')
  }

  async billingActivities(): Promise<BillingActivity[]> {
    return this.get<BillingActivity[]>('/api/v1/billing/activities')
  }

  async createBillingCheckout(input: { amount: number; returnTarget: 'web' | 'electron' }): Promise<BillingCheckoutResponse> {
    return this.post<BillingCheckoutResponse>(
      '/api/v1/billing/checkout',
      { amount: input.amount, return_target: input.returnTarget },
      true,
    )
  }

  async listDocuments(): Promise<UserDocument[]> {
    return this.get<UserDocument[]>('/api/v1/documents')
  }

  async createDocumentUpload(input: {
    filename: string
    content_type: string
    size_bytes: number
  }): Promise<DocumentUploadResponse> {
    return this.post<DocumentUploadResponse>('/api/v1/documents/uploads', input, true)
  }

  async completeDocument(documentID: string): Promise<UserDocument> {
    return this.post<UserDocument>(`/api/v1/documents/${documentID}/complete`, {}, true)
  }

  async deleteDocument(documentID: string): Promise<UserDocument> {
    const response = await this.authedFetch(`/api/v1/documents/${documentID}`, { method: 'DELETE' }, true)
    return decodeResponse<UserDocument>(response)
  }

  /**
   * Fetch the raw uploaded bytes of a document so the renderer can feed
   * them to docx-preview / exceljs for in-app preview. Wraps
   * `GET /api/v1/documents/{id}/source` which streams the file with the
   * original Content-Type. Returns ArrayBuffer (NOT JSON — this endpoint
   * deliberately bypasses the apiResponse<T> envelope).
   *
   * Throws on non-2xx so the caller can surface a renderer-level error
   * panel; the typical failure modes are 404 (expired/missing), 403
   * (ownership) and 401 (session expired).
   */
  async fetchDocumentBytes(documentID: string): Promise<ArrayBuffer> {
    // requireAuth=true: this endpoint is behind requireAuth on the Go
    // side, and the app authenticates with a Bearer access token (not
    // a cookie), so we MUST attach the Authorization header. Passing
    // `false` here sent the request unauthenticated → 401 "未登录"
    // even for a logged-in user. Every other authed call uses
    // headers(true); this one was the outlier.
    const response = await this.authedFetch(`/api/v1/documents/${documentID}/source`, { method: 'GET' }, true)
    if (!response.ok) {
      const text = await response.text().catch(() => response.statusText)
      throw new Error(`fetchDocumentBytes failed (${response.status}): ${text || response.statusText}`)
    }
    return response.arrayBuffer()
  }

  async streamChat(request: StreamChatRequest, handlers: StreamHandlers): Promise<StreamChatResult> {
    const response = await this.authedFetch('/api/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: request.mode || 'auto',
        stream: true,
        scene: request.scene,
        client_conversation_id: request.clientConversationId,
        client_message_id: request.clientMessageId,
        messages: request.messages,
      }),
    }, true)
    if (!response.ok || !response.body) {
      throw await apiError(response)
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let done = false
    while (!done) {
      const result = await reader.read()
      done = result.done
      buffer += decoder.decode(result.value ?? new Uint8Array(), { stream: !done })
      const parsed = parseSSEBuffer(buffer)
      buffer = parsed.rest
      for (const event of parsed.events) {
        if (event.type === 'delta') {
          handlers.onDelta(event.content)
        }
      }
    }

    return {
      requestId: response.headers.get('X-Request-ID') ?? '',
      inputTokens: 0,
      outputTokens: 0,
      creditsCost: 0,
    }
  }

  async createAgentRun(request: CreateAgentRunRequest): Promise<AgentRun> {
    return this.post<AgentRun>('/api/v1/agent/runs', {
      goal: request.goal,
      model: request.mode || 'auto',
      client_conversation_id: request.clientConversationId,
      client_message_id: request.clientMessageId,
      attachments: request.attachments,
      history: request.history ?? [],
    }, true)
  }

  async streamAgentRun(runID: string, handlers: StreamHandlers): Promise<StreamChatResult> {
    const response = await this.authedFetch(`/api/v1/agent/runs/${encodeURIComponent(runID)}/stream`, { method: 'GET' }, true)
    if (!response.ok || !response.body) {
      throw await apiError(response)
    }

    const result = await streamAgentSSE(response, {
      onEvent: (event) => handlers.onEvent?.(event),
      onDelta: (delta) => handlers.onDelta(delta),
    })

    return {
      requestId: result.requestId,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      creditsCost: result.creditsCost,
    }
  }

  async askDocument(
    documentID: string,
    request: { mode: ChatMode; question: string },
    handlers: StreamHandlers,
  ): Promise<StreamChatResult> {
    const response = await this.authedFetch(`/api/v1/documents/${documentID}/ask`, {
      method: 'POST',
      body: JSON.stringify({
        model: request.mode || 'auto',
        question: request.question,
      }),
    }, true)
    if (!response.ok || !response.body) {
      throw await apiError(response)
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let done = false
    while (!done) {
      const result = await reader.read()
      done = result.done
      buffer += decoder.decode(result.value ?? new Uint8Array(), { stream: !done })
      const parsed = parseSSEBuffer(buffer)
      buffer = parsed.rest
      for (const event of parsed.events) {
        if (event.type === 'delta') {
          handlers.onDelta(event.content)
        }
      }
    }

    return {
      requestId: response.headers.get('X-Request-ID') ?? '',
      inputTokens: 0,
      outputTokens: 0,
      creditsCost: 0,
    }
  }

  // ---------------------------------------------------------------------
  // Cloud tool loop (web build) — low-level transports + the orchestrator.
  // These drive the SAME Go endpoints the daemon uses; see cloudAgentLoop.ts.
  // ---------------------------------------------------------------------

  /** GET /api/v1/models → the user-facing chat model catalog (enabled,
   *  priority desc). Feeds the composer model picker. */
  async listModels(): Promise<ChatModelInfo[]> {
    const data = await this.get<{ models: ChatModelInfo[] }>('/api/v1/models')
    return data.models ?? []
  }

  /** GET /agent/tool-capabilities → which cloud tools are configured. */
  async agentToolCapabilities(): Promise<ToolCapabilitiesResult> {
    const data = await this.get<{ tools: Record<string, ToolCapability>; web_tool_loop_max_steps?: number }>('/api/v1/agent/tool-capabilities')
    return {
      tools: data.tools ?? {},
      webToolLoopMaxSteps: positiveInteger(data.web_tool_loop_max_steps, 5),
    }
  }

  /** POST /agent/llm/stream — one model turn. Streams content via onDelta and
   *  returns the turn (content + tool_calls + usage). Parses NAMED llm.* SSE. */
  async streamAgentLLM(
    body: { runId: string; mode: ChatMode; messages: CloudLLMMessage[]; tools: CloudToolDefinition[] },
    handlers: { onDelta: (delta: string) => void; onEvent?: (event: AgentRunEvent) => void },
    signal?: AbortSignal,
  ): Promise<CloudLLMTurn> {
    const response = await this.authedFetch(
      '/api/v1/agent/llm/stream',
      {
        method: 'POST',
        body: JSON.stringify({
          run_id: body.runId,
          model: body.mode || 'auto',
          messages: body.messages.map((m) => ({
            role: m.role,
            content: m.content,
            toolCallId: m.toolCallId,
            name: m.name,
            toolCalls: m.toolCalls,
          })),
          tools: body.tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        }),
        signal,
      },
      true,
    )
    if (!response.ok || !response.body) {
      throw await apiError(response)
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let content = ''
    let reasoning = ''
    const toolCalls: CloudLLMTurn['toolCalls'] = []
    let finishReason = ''
    let requestId = response.headers.get('X-Request-ID') ?? ''
    let inputTokens = 0
    let outputTokens = 0
    let creditsCost = 0
    let done = false

    while (!done) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      const result = await reader.read()
      done = result.done
      buffer += decoder.decode(result.value ?? new Uint8Array(), { stream: !done })
      const parsed = parseLLMStreamBuffer(buffer)
      buffer = parsed.rest
      for (const event of parsed.events) {
        if (event.type === 'delta') {
          if (event.contentDelta) {
            content += event.contentDelta
            handlers.onDelta(event.contentDelta)
          }
          reasoning += event.reasoningDelta
        } else if (event.type === 'tool_call') {
          toolCalls.push({ id: event.id, name: event.name, arguments: event.arguments })
        } else if (event.type === 'usage') {
          inputTokens = event.inputTokens
          outputTokens = event.outputTokens
          creditsCost = event.creditsCost
        } else if (event.type === 'model_selected') {
          handlers.onEvent?.({
            event_type: 'model.selected',
            run_id: body.runId,
            payload: {
              requested_model: event.requestedModel,
              resolved_model_id: event.resolvedModelId,
              label: event.label,
              reason: event.reason,
            },
          })
        } else if (event.type === 'done') {
          requestId = event.requestId || requestId
          finishReason = event.finishReason
        } else if (event.type === 'error') {
          throw new Error(event.message || '模型调用失败')
        }
      }
    }

    return { content, reasoning, toolCalls, finishReason, requestId, inputTokens, outputTokens, creditsCost }
  }

  /** POST /agent/tools/execute — run one billed, idempotent tool. Returns the
   *  structured result even on a tool-level failure (ok:false) so the loop can
   *  feed it back to the model; only hard credit failures (402) throw. */
  async executeAgentTool(req: {
    runId: string
    toolCallId: string
    tool: string
    arguments: Record<string, unknown>
    idempotencyKey: string
  }, signal?: AbortSignal): Promise<CloudToolResult> {
    const response = await this.authedFetch(
      '/api/v1/agent/tools/execute',
      {
        method: 'POST',
        signal,
        body: JSON.stringify({
          run_id: req.runId,
          tool_call_id: req.toolCallId,
          tool: req.tool,
          arguments: req.arguments,
          idempotency_key: req.idempotencyKey,
        }),
      },
      true,
    )
    let body: APIResponse<CloudToolResult> | undefined
    try {
      body = (await response.json()) as APIResponse<CloudToolResult>
    } catch {
      body = undefined
    }
    if (response.status === 402) {
      throw new Error(body?.message || '额度不足，请升级或充值')
    }
    if (body?.data) {
      return body.data
    }
    return { ok: false, content: body?.message || `工具调用失败 (HTTP ${response.status})`, errorCode: 'tool_execute_failed' }
  }

  async runCloudToolLoop(
    input: CloudToolLoopRequest,
    handlers: StreamHandlers,
    signal?: AbortSignal,
  ): Promise<StreamChatResult> {
    const messages: CloudLLMMessage[] = input.continuationMessages
      ? [...input.continuationMessages]
      : [
          ...input.history.map((m) => ({ role: m.role, content: m.content }) as CloudLLMMessage),
          { role: 'user', content: input.goal },
        ]
    // Auto modes resolve ONCE before the loop (the cloud's task-aware
    // classifier), so every turn of this run uses the same concrete model.
    // Intent sentinels bias that resolver without pinning a static model.
    let model = input.mode
    if (!model || isAutoMode(model)) {
      const requestedModel = model || 'auto'
      const intent = autoIntentFromMode(requestedModel)
      try {
        const resolved = await this.post<{ model_id: string; label: string; reason: string }>(
          '/api/v1/models/resolve',
          intent ? { goal: input.goal, intent } : { goal: input.goal },
          true,
        )
        if (resolved.model_id) {
          model = resolved.model_id
          handlers.onEvent?.({
            event_type: 'model.selected',
            run_id: input.runId,
            payload: {
              requested_model: requestedModel,
              requested_label: autoRequestedLabel(requestedModel),
              resolved_model_id: resolved.model_id,
              label: resolved.label,
              reason: resolved.reason,
            },
          })
        }
      } catch {
        // Keep the Auto sentinel; the cloud resolves it to a default model per turn.
      }
    }
    const deps: CloudAgentLoopDeps = {
      streamLLM: (body, loopHandlers, loopSignal) =>
        this.streamAgentLLM(body, { ...loopHandlers, onEvent: handlers.onEvent }, loopSignal),
      executeTool: (req, loopSignal) => this.executeAgentTool(req, loopSignal),
    }
    const result = await runCloudAgentLoop(deps, {
      runId: input.runId,
      mode: model,
      messages,
      tools: input.tools,
      maxSteps: input.maxSteps,
      onDelta: handlers.onDelta,
      onEvent: handlers.onEvent,
      signal,
    })
    if (result.hitStepCap) {
      handlers.onEvent?.({
        event_type: 'run.budget_warning',
        run_id: input.runId,
        payload: {
          reason: 'max_steps_reached',
          max_steps: result.steps,
          continue_steps: input.maxSteps ?? result.steps,
        },
      })
    }
    const streamResult: StreamChatResult = {
      requestId: result.requestId,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      creditsCost: result.creditsCost,
    }
    if (result.hitStepCap) {
      streamResult.hitStepCap = true
      streamResult.steps = result.steps
      streamResult.maxSteps = input.maxSteps ?? result.steps
    }
    if (result.continuationMessages) {
      streamResult.continuationMessages = result.continuationMessages
    }
    return streamResult
  }

  private async get<T>(path: string): Promise<T> {
    const response = await this.authedFetch(path, { method: 'GET' }, true)
    return decodeResponse<T>(response)
  }

  private async post<T>(path: string, body: unknown, requireAuth: boolean): Promise<T> {
    const response = await this.authedFetch(path, { method: 'POST', body: JSON.stringify(body) }, requireAuth)
    return decodeResponse<T>(response)
  }

  private headers(requireAuth: boolean): HeadersInit {
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
    }
    if (requireAuth && this.accessToken) {
      headers.Authorization = `Bearer ${this.accessToken}`
    }
    return headers
  }
}

function autoRequestedLabel(mode: string): string {
  switch (mode) {
    case 'auto.fast':
      return '更快'
    case 'auto.smart':
      return '更强'
    default:
      return '自动'
  }
}

async function decodeResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw await apiError(response)
  }
  const body = (await response.json()) as APIResponse<T>
  if (body.code !== 0) {
    throw new APIError(body.message, {
      status: response.status,
      retryAfterSeconds: retryAfterSeconds(response.headers.get('Retry-After')),
    })
  }
  return body.data
}

async function apiError(response: Response): Promise<APIError> {
  return new APIError(await errorMessage(response), {
    status: response.status,
    retryAfterSeconds: retryAfterSeconds(response.headers.get('Retry-After')),
  })
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as APIResponse<unknown>
    return body.message || `HTTP ${response.status}`
  } catch {
    return `HTTP ${response.status}`
  }
}

function retryAfterSeconds(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds)
  }
  const dateMs = Date.parse(value)
  if (!Number.isFinite(dateMs)) {
    return undefined
  }
  return Math.max(0, Math.ceil((dateMs - Date.now()) / 1000))
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback
}
