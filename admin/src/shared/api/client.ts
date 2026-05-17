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

export interface AdminOverview {
  users_total: number
  active_users: number
  disabled_users: number
  llm_calls_total: number
  llm_calls_failed: number
  credits_cost_total: number
  orders_total: number
}

export interface AdminAuditLog {
  id: string
  actor_user_id: string
  action: string
  target_type: string
  target_id: string
  metadata: string
  created_at: string
}

export interface AdminUserSummary {
  user: AuthPayload['user'] & { created_at?: string }
  wallet?: WalletBalance
  calls_count: number
  credits_cost: number
}

export interface AdminUserDetail {
  user: AuthPayload['user'] & { created_at?: string }
  wallet?: WalletBalance
  calls: AdminLLMCall[]
  orders: AdminOrder[]
  transactions: AdminWalletTransaction[]
}

export interface AdminLLMCall {
  request_id: string
  user_id: string
  user_email?: string
  mode: string
  scene: string
  model: string
  provider: string
  input_tokens: number
  output_tokens: number
  credits_cost: number
  status: string
  error_message?: string
  started_at: string
  finished_at?: string
}

export interface AdminToolCall {
  request_id: string
  user_id: string
  user_email?: string
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

export interface AdminOrder {
  id: string
  wallet_id: string
  user_id?: string
  user_email?: string
  type: string
  amount_cny: number
  status: string
  checkout_url: string
  stripe_checkout_session_id: string
  stripe_subscription_id: string
  plan_code?: string
  wallet_status?: string
  idempotency_key: string
  created_at: string
}

export interface AdminWalletTransaction {
  id: string
  type: string
  amount: number
  monthly_used_after: number
  extra_balance_after: number
  description: string
  created_at: string
}

export interface AdminProviderStatus {
  mode: string
  provider: string
  kind: string
  base_url: string
  model: string
  mock: boolean
  api_key_configured: boolean
}

export interface AdminModelConfig {
  id: string
  slot: string
  capability: string
  provider_kind: string
  display_name: string
  base_url: string
  model_name: string
  credit_multiplier: number
  price_per_call_cny: number
  enabled: boolean
  params: Record<string, unknown>
  api_key_configured: boolean
  updated_at: string
}

export interface ModelConfigInput {
  slot: string
  capability: string
  provider_kind: string
  display_name: string
  base_url: string
  model_name: string
  credit_multiplier: number
  price_per_call_cny: number
  enabled: boolean
  params?: Record<string, unknown>
  api_key?: string
}

export interface AdminCreditRate {
  markup_factor: number
  currency_per_credit: number
  currency: string
  configured: boolean
}

export interface AdminAgentRun {
  id: string
  user_id: string
  user_email: string
  origin: string
  status: string
  mode: string
  goal_summary: string
  client_conversation_id?: string
  client_message_id?: string
  attachments?: Array<{ type: string; document_id?: string; name?: string }>
  error_code?: string
  error_message?: string
  expires_at: string
  created_at: string
  updated_at: string
}

interface APIResponse<T> {
  code: number
  message: string
  data: T
}

function pageQuery(limit?: number, offset?: number): string {
  const params = new URLSearchParams()
  if (typeof limit === 'number') {
    params.set('limit', String(limit))
  }
  if (typeof offset === 'number' && offset > 0) {
    params.set('offset', String(offset))
  }
  const qs = params.toString()
  return qs ? `?${qs}` : ''
}

export class AdminAPI {
  private accessToken = ''

  constructor(private readonly baseURL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8080') {}

  setAccessToken(token: string): void {
    this.accessToken = token
  }

  async login(input: { email: string; password: string }): Promise<AuthPayload> {
    return this.post<AuthPayload>('/api/v1/auth/login', input, false)
  }

  async register(input: { email: string; password: string; name: string }): Promise<AuthPayload> {
    return this.post<AuthPayload>('/api/v1/auth/register', input, false)
  }

  async refresh(): Promise<AuthPayload> {
    return this.post<AuthPayload>('/api/v1/auth/refresh', {}, false)
  }

  async logout(): Promise<void> {
    await this.post('/api/v1/auth/logout', {}, true)
    this.accessToken = ''
  }

  async adminOverview(): Promise<AdminOverview> {
    return this.get<AdminOverview>('/api/v1/admin/overview')
  }

  async adminUsers(query = '', limit?: number, offset?: number): Promise<AdminUserSummary[]> {
    const params = new URLSearchParams()
    if (query) {
      params.set('q', query)
    }
    if (typeof limit === 'number') {
      params.set('limit', String(limit))
    }
    if (typeof offset === 'number' && offset > 0) {
      params.set('offset', String(offset))
    }
    const qs = params.toString()
    return this.get<AdminUserSummary[]>(`/api/v1/admin/users${qs ? `?${qs}` : ''}`)
  }

  async adminUserDetail(userId: string): Promise<AdminUserDetail> {
    return this.get<AdminUserDetail>(`/api/v1/admin/users/${encodeURIComponent(userId)}`)
  }

  async adminUpdateUserStatus(userId: string, status: 'active' | 'disabled', reason: string): Promise<AuthPayload['user']> {
    return this.patch<AuthPayload['user']>(`/api/v1/admin/users/${encodeURIComponent(userId)}/status`, { status, reason })
  }

  async adminAdjustCredits(userId: string, delta: number, reason: string): Promise<WalletBalance> {
    return this.post<WalletBalance>(`/api/v1/admin/users/${encodeURIComponent(userId)}/credits/adjust`, { delta, reason }, true)
  }

  async adminLLMCalls(): Promise<AdminLLMCall[]> {
    return this.get<AdminLLMCall[]>('/api/v1/admin/llm-calls')
  }

  async adminToolCalls(limit?: number, offset?: number): Promise<AdminToolCall[]> {
    return this.get<AdminToolCall[]>(`/api/v1/admin/tool-calls${pageQuery(limit, offset)}`)
  }

  async adminOrders(limit?: number, offset?: number): Promise<AdminOrder[]> {
    return this.get<AdminOrder[]>(`/api/v1/admin/orders${pageQuery(limit, offset)}`)
  }

  async adminProviders(): Promise<AdminProviderStatus[]> {
    return this.get<AdminProviderStatus[]>('/api/v1/admin/providers')
  }

  async adminAgentRuns(): Promise<AdminAgentRun[]> {
    return this.get<AdminAgentRun[]>('/api/v1/admin/agent-runs')
  }

  async adminModelConfigs(capability = ''): Promise<AdminModelConfig[]> {
    const qs = capability ? `?capability=${encodeURIComponent(capability)}` : ''
    return this.get<AdminModelConfig[]>(`/api/v1/admin/model-configs${qs}`)
  }

  async adminCreateModelConfig(input: ModelConfigInput): Promise<AdminModelConfig> {
    return this.post<AdminModelConfig>('/api/v1/admin/model-configs', input, true)
  }

  async adminUpdateModelConfig(id: string, input: ModelConfigInput): Promise<AdminModelConfig> {
    return this.patch<AdminModelConfig>(`/api/v1/admin/model-configs/${encodeURIComponent(id)}`, input)
  }

  async adminToggleModelConfig(id: string, enabled: boolean): Promise<AdminModelConfig> {
    return this.post<AdminModelConfig>(`/api/v1/admin/model-configs/${encodeURIComponent(id)}/enabled`, { enabled }, true)
  }

  async adminDeleteModelConfig(id: string): Promise<void> {
    await this.del(`/api/v1/admin/model-configs/${encodeURIComponent(id)}`)
  }

  async adminCreditRate(): Promise<AdminCreditRate> {
    return this.get<AdminCreditRate>('/api/v1/admin/settings/credit-rate')
  }

  async adminSetCreditRate(input: { markup_factor: number; currency_per_credit: number; currency: string }): Promise<AdminCreditRate> {
    return this.put<AdminCreditRate>('/api/v1/admin/settings/credit-rate', input)
  }

  async adminAuditLogs(limit?: number, offset?: number): Promise<AdminAuditLog[]> {
    return this.get<AdminAuditLog[]>(`/api/v1/admin/audit-logs${pageQuery(limit, offset)}`)
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

  private async patch<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${this.baseURL}${path}`, {
      method: 'PATCH',
      credentials: 'include',
      headers: this.headers(true),
      body: JSON.stringify(body),
    })
    return decodeResponse<T>(response)
  }

  private async put<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${this.baseURL}${path}`, {
      method: 'PUT',
      credentials: 'include',
      headers: this.headers(true),
      body: JSON.stringify(body),
    })
    return decodeResponse<T>(response)
  }

  private async del<T>(path: string): Promise<T> {
    const response = await fetch(`${this.baseURL}${path}`, {
      method: 'DELETE',
      credentials: 'include',
      headers: this.headers(true),
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
