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
