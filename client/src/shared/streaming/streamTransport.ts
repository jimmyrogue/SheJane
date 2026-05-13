import { parseAgentSSEBuffer, type AgentRunEvent } from '../api/sse'

export interface StreamTransportHandlers {
  onDelta: (content: string, event: AgentRunEvent) => void
  onEvent?: (event: AgentRunEvent) => void
}

export interface AgentStreamResult {
  requestId: string
  inputTokens: number
  outputTokens: number
  creditsCost: number
  completed: boolean
}

export interface StreamTransport<TInput> {
  start: (input: TInput, handlers: StreamTransportHandlers, signal?: AbortSignal) => Promise<AgentStreamResult>
}

export async function streamAgentSSE(
  response: Response,
  handlers: StreamTransportHandlers,
  signal?: AbortSignal,
): Promise<AgentStreamResult> {
  throwIfAborted(signal)
  if (!response.ok || !response.body) {
    throw new Error(`Stream transport HTTP ${response.status}`)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let done = false
  let completed = false
  let requestId = response.headers.get('X-Request-ID') ?? ''
  let inputTokens = 0
  let outputTokens = 0
  let creditsCost = 0

  while (!done) {
    throwIfAborted(signal)
    const result = await reader.read()
    done = result.done
    buffer += decoder.decode(result.value ?? new Uint8Array(), { stream: !done })
    let parsed: ReturnType<typeof parseAgentSSEBuffer>
    try {
      parsed = parseAgentSSEBuffer(buffer)
    } catch (error) {
      throw new Error(`Malformed Agent SSE: ${error instanceof Error ? error.message : String(error)}`)
    }
    buffer = parsed.rest
    for (const parsedEvent of parsed.events) {
      if (parsedEvent.type === 'done') {
        completed = true
        continue
      }
      if (parsedEvent.type !== 'agent') {
        continue
      }
      handlers.onEvent?.(parsedEvent.event)
      if (parsedEvent.event.event_type === 'llm.delta') {
        const content = parsedEvent.event.payload?.content
        if (typeof content === 'string') {
          handlers.onDelta(content, parsedEvent.event)
        }
      }
      if (parsedEvent.event.event_type === 'run.completed') {
        requestId = stringPayload(parsedEvent.event, 'request_id') || requestId
        inputTokens = numberPayload(parsedEvent.event, 'input_tokens')
        outputTokens = numberPayload(parsedEvent.event, 'output_tokens')
        creditsCost = numberPayload(parsedEvent.event, 'credits_cost')
      }
    }
  }

  return {
    requestId,
    inputTokens,
    outputTokens,
    creditsCost,
    completed,
  }
}

export function createFetchAgentRunTransport(input: {
  baseURL: string
  accessToken?: string
  fetcher?: typeof fetch
}): StreamTransport<{ runID: string }> {
  const fetcher = input.fetcher ?? fetch
  return {
    async start({ runID }, handlers, signal) {
      const response = await fetcher(`${input.baseURL.replace(/\/$/, '')}/api/v1/agent/runs/${encodeURIComponent(runID)}/stream`, {
        method: 'GET',
        credentials: 'include',
        headers: input.accessToken ? { Authorization: `Bearer ${input.accessToken}` } : undefined,
        signal,
      })
      return streamAgentSSE(response, handlers, signal)
    },
  }
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new Error('Stream transport aborted')
  }
}

function stringPayload(event: AgentRunEvent, key: string): string {
  const value = event.payload?.[key]
  return typeof value === 'string' ? value : ''
}

function numberPayload(event: AgentRunEvent, key: string): number {
  const value = event.payload?.[key]
  return typeof value === 'number' ? value : 0
}
