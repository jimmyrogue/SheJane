import { parseSSEBuffer, type AgentRunEvent } from './sse'
import { streamAgentSSE } from '../streaming/streamTransport'
import type { ChatMode } from '../local-data/types'

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
}

export interface ChatAPI {
  createAgentRun(request: CreateAgentRunRequest): Promise<AgentRun>
  streamAgentRun(runID: string, handlers: StreamHandlers): Promise<StreamChatResult>
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
}

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

export class JiandanAPI implements ChatAPI {
  private accessToken = ''

  constructor(readonly baseURL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8080') {}

  setAccessToken(token: string): void {
    this.accessToken = token
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

  async balance(): Promise<WalletBalance> {
    return this.get<WalletBalance>('/api/v1/billing/balance')
  }

  async createSubscriptionCheckout(): Promise<{ checkout_url: string }> {
    const order = await this.post<{ checkout_url: string }>('/api/v1/billing/subscription/checkout', {}, true)
    return { checkout_url: order.checkout_url }
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
    const response = await fetch(`${this.baseURL}/api/v1/documents/${documentID}`, {
      method: 'DELETE',
      credentials: 'include',
      headers: this.headers(true),
    })
    return decodeResponse<UserDocument>(response)
  }

  async streamChat(request: StreamChatRequest, handlers: StreamHandlers): Promise<StreamChatResult> {
    const response = await fetch(`${this.baseURL}/api/v1/chat/completions`, {
      method: 'POST',
      credentials: 'include',
      headers: this.headers(true),
      body: JSON.stringify({
        model: request.mode,
        stream: true,
        scene: request.scene,
        client_conversation_id: request.clientConversationId,
        client_message_id: request.clientMessageId,
        messages: request.messages,
      }),
    })
    if (!response.ok || !response.body) {
      throw new Error(await errorMessage(response))
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
      mode: request.mode,
      client_conversation_id: request.clientConversationId,
      client_message_id: request.clientMessageId,
      attachments: request.attachments,
      history: request.history ?? [],
    }, true)
  }

  async streamAgentRun(runID: string, handlers: StreamHandlers): Promise<StreamChatResult> {
    const response = await fetch(`${this.baseURL}/api/v1/agent/runs/${encodeURIComponent(runID)}/stream`, {
      method: 'GET',
      credentials: 'include',
      headers: this.headers(true),
    })
    if (!response.ok || !response.body) {
      throw new Error(await errorMessage(response))
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
    const response = await fetch(`${this.baseURL}/api/v1/documents/${documentID}/ask`, {
      method: 'POST',
      credentials: 'include',
      headers: this.headers(true),
      body: JSON.stringify({
        model: request.mode,
        question: request.question,
      }),
    })
    if (!response.ok || !response.body) {
      throw new Error(await errorMessage(response))
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

  private async get<T>(path: string): Promise<T> {
    const response = await fetch(`${this.baseURL}${path}`, {
      credentials: 'include',
      headers: this.headers(true),
    })
    return decodeResponse<T>(response)
  }

  private async post<T>(path: string, body: unknown, requireAuth: boolean): Promise<T> {
    const response = await fetch(`${this.baseURL}${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: this.headers(requireAuth),
      body: JSON.stringify(body),
    })
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

async function decodeResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(await errorMessage(response))
  }
  const body = (await response.json()) as APIResponse<T>
  if (body.code !== 0) {
    throw new Error(body.message)
  }
  return body.data
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as APIResponse<unknown>
    return body.message || `HTTP ${response.status}`
  } catch {
    return `HTTP ${response.status}`
  }
}
