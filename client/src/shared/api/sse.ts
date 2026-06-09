export type StreamEvent =
  | { type: 'delta'; content: string }
  | { type: 'done' }
  | { type: 'ignore' }

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

export function parseOpenAIStreamEvent(line: string): StreamEvent {
  const trimmed = line.trim()
  if (!trimmed.startsWith('data:')) {
    return { type: 'ignore' }
  }

  const data = trimmed.slice('data:'.length).trim()
  if (data === '[DONE]') {
    return { type: 'done' }
  }

  const parsed = JSON.parse(data) as {
    choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>
  }
  const content = parsed.choices?.[0]?.delta?.content
  if (!content) {
    return { type: 'ignore' }
  }
  return { type: 'delta', content }
}

export function parseSSEBuffer(buffer: string): { events: StreamEvent[]; rest: string } {
  const chunks = buffer.split(/\n\n/)
  const rest = chunks.pop() ?? ''
  const events = chunks
    .flatMap((chunk) => chunk.split(/\n/))
    .map(parseOpenAIStreamEvent)
    .filter((event) => event.type !== 'ignore')
  return { events, rest }
}

export function parseAgentSSEBuffer(buffer: string): { events: AgentSSEEvent[]; rest: string } {
  const chunks = buffer.split(/\n\n/)
  const rest = chunks.pop() ?? ''
  const events = chunks.map(parseAgentSSEChunk).filter((event) => event.type !== 'ignore')
  return { events, rest }
}

function parseAgentSSEChunk(chunk: string): AgentSSEEvent {
  const dataLines = chunk
    .split(/\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
  if (dataLines.length === 0) {
    return { type: 'ignore' }
  }
  const data = dataLines.join('\n')
  if (data === '[DONE]') {
    return { type: 'done' }
  }
  return { type: 'agent', event: JSON.parse(data) as AgentRunEvent }
}

// ---------------------------------------------------------------------------
// Named-event SSE — the cloud LLM gateway (`POST /api/v1/agent/llm/stream`).
//
// Unlike the daemon/agent-run envelope above (`data: {event_type,...}` + a
// `data: [DONE]` terminator), this leg emits NAMED events:
//
//   event: llm.delta
//   data: {"content_delta":"...","reasoning_delta":"..."}
//
// with event names llm.delta / llm.tool_call / llm.usage / llm.done / llm.error.
// SheJane's web client orchestrates the tool-calling loop itself (see
// cloudAgentLoop.ts), so it needs to read these raw turn-level events.
// ---------------------------------------------------------------------------

export type LLMStreamEvent =
  | { type: 'delta'; contentDelta: string; reasoningDelta: string }
  | { type: 'tool_call'; id: string; name: string; arguments: Record<string, unknown> }
  | { type: 'usage'; inputTokens: number; outputTokens: number; creditsCost: number }
  | { type: 'done'; requestId: string; finishReason: string }
  | { type: 'error'; requestId: string; message: string }
  | { type: 'ignore' }

export function parseLLMStreamBuffer(buffer: string): { events: LLMStreamEvent[]; rest: string } {
  const chunks = buffer.split(/\n\n/)
  const rest = chunks.pop() ?? ''
  const events = chunks.map(parseLLMStreamChunk).filter((event) => event.type !== 'ignore')
  return { events, rest }
}

function parseLLMStreamChunk(chunk: string): LLMStreamEvent {
  let eventName = ''
  const dataLines: string[] = []
  for (const raw of chunk.split(/\n/)) {
    const line = raw.trim()
    if (line.startsWith('event:')) {
      eventName = line.slice('event:'.length).trim()
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trim())
    }
  }
  if (!eventName || dataLines.length === 0) {
    return { type: 'ignore' }
  }
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(dataLines.join('\n')) as Record<string, unknown>
  } catch {
    return { type: 'ignore' }
  }
  const str = (key: string): string => (typeof payload[key] === 'string' ? (payload[key] as string) : '')
  const num = (key: string): number => (typeof payload[key] === 'number' ? (payload[key] as number) : 0)
  switch (eventName) {
    case 'llm.delta':
      return { type: 'delta', contentDelta: str('content_delta'), reasoningDelta: str('reasoning_delta') }
    case 'llm.tool_call':
      return {
        type: 'tool_call',
        id: str('id'),
        name: str('name'),
        arguments:
          payload.arguments && typeof payload.arguments === 'object'
            ? (payload.arguments as Record<string, unknown>)
            : {},
      }
    case 'llm.usage':
      return {
        type: 'usage',
        inputTokens: num('input_tokens'),
        outputTokens: num('output_tokens'),
        creditsCost: num('credits_cost'),
      }
    case 'llm.done':
      return { type: 'done', requestId: str('request_id'), finishReason: str('finish_reason') }
    case 'llm.error':
      return { type: 'error', requestId: str('request_id'), message: str('message') }
    default:
      return { type: 'ignore' }
  }
}
