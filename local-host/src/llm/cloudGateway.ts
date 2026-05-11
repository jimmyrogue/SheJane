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
      throw new Error(`Cloud LLM gateway returned HTTP ${response.status}`)
    }
    const body = (await response.json()) as { code?: number; message?: string; data?: LLMGatewayResponse } & LLMGatewayResponse
    if (body.data) {
      return body.data
    }
    return body
  }
}
