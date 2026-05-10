export type StreamEvent =
  | { type: 'delta'; content: string }
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
