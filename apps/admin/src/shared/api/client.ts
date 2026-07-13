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
  tool_calls: AdminToolCall[]
  orders: AdminOrder[]
  transactions: AdminWalletTransaction[]
}

export interface AdminLLMCall {
  request_id: string
  user_id: string
  user_email?: string
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
  vendor: string
  vendor_info: string
  capability_tier: string
  description: string
  priority: number
  base_url: string
  model_name: string
  credit_multiplier: number
  input_credit_multiplier: number
  output_credit_multiplier: number
  cached_input_credit_multiplier: number
  cache_write_credit_multiplier: number
  input_price_per_million_cny: number
  output_price_per_million_cny: number
  cached_input_price_per_million_cny: number
  cache_write_price_per_million_cny: number
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
  vendor?: string
  vendor_info?: string
  capability_tier?: string
  description?: string
  priority?: number
  base_url: string
  model_name: string
  credit_multiplier: number
  input_credit_multiplier?: number
  output_credit_multiplier?: number
  cached_input_credit_multiplier?: number
  cache_write_credit_multiplier?: number
  input_price_per_million_cny?: number
  output_price_per_million_cny?: number
  cached_input_price_per_million_cny?: number
  cache_write_price_per_million_cny?: number
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

export interface AdminBillingLevers {
  tavily_search_credits: number
  e2b_code_exec_base_credits: number
  e2b_code_exec_per_second_credits: number
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

export interface AdminAgentEvent {
  id: string
  run_id: string
  seq: number
  event_type: string
  payload: Record<string, unknown>
  created_at: string
}

export interface AdminAgentRunTrace {
  run: AdminAgentRun
  events: AdminAgentEvent[]
  llm_calls: AdminLLMCall[]
  tool_calls: AdminToolCall[]
  wallet_transactions: AdminWalletTransaction[]
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
  private tokenRefresher?: () => Promise<string | null>
  private refreshInFlight: Promise<string | null> | null = null

  constructor(private readonly baseURL = '') {}

  setAccessToken(token: string): void {
    this.accessToken = token
  }

  /** Wired by the app shell so authedFetch can silently mint a new access
   *  token on a mid-session 401 instead of bouncing to the login screen.
   *  Returns the new access token, or null when refresh failed. */
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
   *  so an open admin session routinely outlives it. On the first 401 of
   *  an authed request we refresh via the refresh cookie and replay once.
   *  Auth endpoints are excluded to avoid recursion. */
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

  async adminAgentRunTrace(id: string): Promise<AdminAgentRunTrace> {
    return this.get<AdminAgentRunTrace>(`/api/v1/admin/agent-runs/${encodeURIComponent(id)}/trace`)
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

  async adminBillingLevers(): Promise<AdminBillingLevers> {
    return this.get<AdminBillingLevers>('/api/v1/admin/settings/billing-levers')
  }

  async adminSetBillingLevers(input: {
    tavily_search_credits: number
    e2b_code_exec_base_credits: number
    e2b_code_exec_per_second_credits: number
  }): Promise<AdminBillingLevers> {
    return this.put<AdminBillingLevers>('/api/v1/admin/settings/billing-levers', input)
  }

  async adminAuditLogs(limit?: number, offset?: number): Promise<AdminAuditLog[]> {
    return this.get<AdminAuditLog[]>(`/api/v1/admin/audit-logs${pageQuery(limit, offset)}`)
  }

  private async get<T>(path: string): Promise<T> {
    const response = await this.authedFetch(path, { method: 'GET' }, true)
    return decodeResponse<T>(response)
  }

  private async post<T>(path: string, body: unknown, requireAuth: boolean): Promise<T> {
    const response = await this.authedFetch(path, { method: 'POST', body: JSON.stringify(body) }, requireAuth)
    return decodeResponse<T>(response)
  }

  private async patch<T>(path: string, body: unknown): Promise<T> {
    const response = await this.authedFetch(path, { method: 'PATCH', body: JSON.stringify(body) }, true)
    return decodeResponse<T>(response)
  }

  private async put<T>(path: string, body: unknown): Promise<T> {
    const response = await this.authedFetch(path, { method: 'PUT', body: JSON.stringify(body) }, true)
    return decodeResponse<T>(response)
  }

  private async del<T>(path: string): Promise<T> {
    const response = await this.authedFetch(path, { method: 'DELETE' }, true)
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
