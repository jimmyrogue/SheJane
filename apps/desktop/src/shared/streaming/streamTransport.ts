import {
  streamAgentSSE,
  type AgentRunEvent,
  type AgentStreamResult,
} from '@shejane/runtime-client'

export { streamAgentSSE } from '@shejane/runtime-client'

export interface StreamTransportHandlers {
  onDelta: (content: string, event: AgentRunEvent) => void
  onEvent?: (event: AgentRunEvent) => void
}

export interface StreamTransport<TInput> {
  start: (input: TInput, handlers: StreamTransportHandlers, signal?: AbortSignal) => Promise<AgentStreamResult>
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
