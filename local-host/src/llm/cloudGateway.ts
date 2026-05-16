import type { LLMGateway, LLMGatewayRequest, LLMGatewayResponse } from './gateway.js'

export interface CloudLLMGatewayOptions {
  baseURL: string
  accessToken: string
  fetcher?: typeof fetch
}

export class CloudLLMGateway implements LLMGateway {
  private readonly baseURL: string
  private readonly fetcher: typeof fetch

  constructor(private readonly options: CloudLLMGatewayOptions) {
    this.baseURL = options.baseURL.replace(/\/$/, '')
    this.fetcher = options.fetcher ?? fetch
  }

  async call(request: LLMGatewayRequest): Promise<LLMGatewayResponse> {
    const response = await this.fetcher(`${this.baseURL}/api/v1/agent/llm`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.options.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        run_id: request.runId,
        mode: request.mode ?? 'fast',
        messages: request.messages,
        tools: request.tools,
      }),
    })
    if (!response.ok) {
      throw new Error(await cloudGatewayErrorMessage(response))
    }
    const body = (await response.json()) as { code?: number; message?: string; data?: LLMGatewayResponse } & LLMGatewayResponse
    const data = body.data ?? body
    return { ...data, usage: parseUsage((data as { usage?: unknown }).usage) }
  }
}

function parseUsage(raw: unknown): LLMGatewayResponse['usage'] {
  if (!raw || typeof raw !== 'object') {
    return undefined
  }
  const source = raw as Record<string, unknown>
  const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
  const inputTokens = num(source.input_tokens)
  const outputTokens = num(source.output_tokens)
  const creditsCost = num(source.credits_cost)
  if (inputTokens === 0 && outputTokens === 0 && creditsCost === 0) {
    return undefined
  }
  return { inputTokens, outputTokens, creditsCost }
}

async function cloudGatewayErrorMessage(response: Response): Promise<string> {
  const fallback = `Cloud LLM gateway returned HTTP ${response.status}`
  try {
    const body = (await response.clone().json()) as { code?: number; message?: string }
    const message = typeof body.message === 'string' ? body.message.trim() : ''
    const code = typeof body.code === 'number' || typeof body.code === 'string' ? String(body.code) : ''
    if (message && code) {
      return `${fallback} (${code}): ${message}`
    }
    if (message) {
      return `${fallback}: ${message}`
    }
  } catch {
    try {
      const text = (await response.text()).trim()
      if (text) {
        return `${fallback}: ${text.slice(0, 240)}`
      }
    } catch {
      return fallback
    }
  }
  return fallback
}
