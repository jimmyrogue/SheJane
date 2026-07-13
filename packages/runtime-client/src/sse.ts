export interface AgentRunEvent {
  event_type: string
  payload?: Record<string, unknown>
  id?: string
  run_id?: string
  seq?: number
  created_at?: string
}

export type AgentSSEEvent =
  | { type: 'agent'; event: AgentRunEvent }
  | { type: 'done' }
  | { type: 'ignore' }

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

export function parseAgentSSEBuffer(buffer: string): { events: AgentSSEEvent[]; rest: string } {
  const chunks = buffer.split(/\n\n/)
  const rest = chunks.pop() ?? ''
  const events = chunks.map(parseAgentSSEChunk).filter((event) => event.type !== 'ignore')
  return { events, rest }
}

export async function streamAgentSSE(
  response: Response,
  handlers: StreamTransportHandlers,
  signal?: AbortSignal,
): Promise<AgentStreamResult> {
  if (signal?.aborted) throw new Error('Stream transport aborted')
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
    if (signal?.aborted) throw new Error('Stream transport aborted')
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
      if (parsedEvent.type !== 'agent') continue
      handlers.onEvent?.(parsedEvent.event)
      if (parsedEvent.event.event_type === 'llm.delta') {
        const content = parsedEvent.event.payload?.content
        if (typeof content === 'string') handlers.onDelta(content, parsedEvent.event)
      }
      if (parsedEvent.event.event_type === 'run.completed') {
        requestId = stringPayload(parsedEvent.event, 'request_id') || requestId
        inputTokens = numberPayload(parsedEvent.event, 'input_tokens')
        outputTokens = numberPayload(parsedEvent.event, 'output_tokens')
        creditsCost = numberPayload(parsedEvent.event, 'credits_cost')
      }
    }
  }

  return { requestId, inputTokens, outputTokens, creditsCost, completed }
}

function parseAgentSSEChunk(chunk: string): AgentSSEEvent {
  const dataLines = chunk
    .split(/\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
  if (dataLines.length === 0) return { type: 'ignore' }
  const data = dataLines.join('\n')
  if (data === '[DONE]') return { type: 'done' }
  return { type: 'agent', event: JSON.parse(data) as AgentRunEvent }
}

function stringPayload(event: AgentRunEvent, key: string): string {
  const value = event.payload?.[key]
  return typeof value === 'string' ? value : ''
}

function numberPayload(event: AgentRunEvent, key: string): number {
  const value = event.payload?.[key]
  return typeof value === 'number' ? value : 0
}
