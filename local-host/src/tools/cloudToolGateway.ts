import type { CloudToolCapabilities, CloudToolExecuteRequest, CloudToolGateway, ToolExecutionResult } from './executor.js'

export interface CloudToolGatewayClientOptions {
  baseURL: string
  accessToken: string
  fetcher?: typeof fetch
}

export class CloudToolGatewayClient implements CloudToolGateway {
  private readonly baseURL: string
  private readonly fetcher: typeof fetch

  constructor(private readonly options: CloudToolGatewayClientOptions) {
    this.baseURL = options.baseURL.replace(/\/$/, '')
    this.fetcher = options.fetcher ?? fetch
  }

  async capabilities(): Promise<CloudToolCapabilities> {
    const response = await this.fetcher(`${this.baseURL}/api/v1/agent/tool-capabilities`, {
      headers: {
        Authorization: `Bearer ${this.options.accessToken}`,
      },
    })
    if (!response.ok) {
      throw new Error(await cloudToolGatewayErrorMessage(response, 'Cloud tool capabilities'))
    }
    const body = (await response.json()) as { data?: CloudToolCapabilities } & CloudToolCapabilities
    return body.data ?? body
  }

  async execute(request: CloudToolExecuteRequest): Promise<ToolExecutionResult> {
    const response = await this.fetcher(`${this.baseURL}/api/v1/agent/tools/execute`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.options.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        run_id: request.runId,
        tool_call_id: request.toolCallId,
        tool: request.tool,
        arguments: request.arguments,
        idempotency_key: request.idempotencyKey,
      }),
    })

    const body = await parseGatewayBody(response)
    const result = body.data
    if (response.ok && result) {
      return result
    }
    if (result && typeof result === 'object' && 'ok' in result) {
      return result
    }
    return {
      ok: false,
      content: body.message || `Cloud tool gateway returned HTTP ${response.status}.`,
      errorCode: `cloud_tool_gateway_http_${response.status}`,
      recoverable: response.status < 500,
    }
  }
}

async function parseGatewayBody(response: Response): Promise<{ message?: string; data?: ToolExecutionResult }> {
  try {
    return (await response.clone().json()) as { message?: string; data?: ToolExecutionResult }
  } catch {
    try {
      const text = (await response.text()).trim()
      return { message: text.slice(0, 240) }
    } catch {
      return {}
    }
  }
}

async function cloudToolGatewayErrorMessage(response: Response, prefix: string): Promise<string> {
  const fallback = `${prefix} returned HTTP ${response.status}`
  const body = await parseGatewayBody(response)
  if (body.message) {
    return `${fallback}: ${body.message}`
  }
  return fallback
}
