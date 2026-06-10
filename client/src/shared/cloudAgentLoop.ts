/**
 * Client-orchestrated cloud tool-calling loop (web build).
 *
 * The desktop app runs a full Python/LangGraph agent loop in its local daemon.
 * The web build has no daemon, so it drives the SAME two Go endpoints the
 * daemon uses — `POST /agent/llm/stream` (the model half, returns tool_calls)
 * and `POST /agent/tools/execute` (the billed, idempotent executor) — from a
 * thin loop right here in the browser. This is exactly OpenAI Chat Completions
 * function-calling as documented (caller runs the roundtrip) and the pattern
 * Vercel AI SDK / assistant-ui ship in production.
 *
 * Scope is deliberately shallow: only API-backed, server-paid tools that need
 * no local resources — web.search + image.generate. Filesystem / browser /
 * code.execute / MCP / skills stay daemon-only (no permission middleware here).
 *
 * Why this is NOT a duplicate of the daemon loop: the daemon ALSO just drives
 * these two endpoints over the cloud base URL. The Go API is the shared core;
 * this is a second thin driver of it, not a re-authored agent.
 */
import type { AgentRunEvent } from './api/sse'
import type { ChatMode } from './local-data/types'

export interface CloudToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/** One message in the running history sent to `/agent/llm/stream`. Matches the
 *  Go `agentLLMBody.messages` shape (camelCase keys the handler accepts). */
export interface CloudLLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolCallId?: string
  name?: string
  toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[]
}

export interface CloudLLMTurn {
  content: string
  reasoning: string
  toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[]
  finishReason: string
  requestId: string
  inputTokens: number
  outputTokens: number
  creditsCost: number
}

export interface CloudToolResult {
  ok: boolean
  content: string
  data?: Record<string, unknown>
  errorCode?: string
}

/** The two low-level transports the loop drives. Injected so the loop is
 *  testable with plain fakes (no fetch/MockTransport needed). */
export interface CloudAgentLoopDeps {
  streamLLM(
    body: { runId: string; mode: ChatMode; messages: CloudLLMMessage[]; tools: CloudToolDefinition[] },
    handlers: { onDelta: (delta: string) => void },
    signal?: AbortSignal,
  ): Promise<CloudLLMTurn>
  executeTool(req: {
    runId: string
    toolCallId: string
    tool: string
    arguments: Record<string, unknown>
    idempotencyKey: string
  }): Promise<CloudToolResult>
}

export interface CloudAgentLoopParams {
  runId: string
  mode: ChatMode
  /** Full message history INCLUDING the new user turn as the last element. */
  messages: CloudLLMMessage[]
  tools: CloudToolDefinition[]
  /** Hard cap on model↔tool roundtrips. Image+search is 1–2 hops; default 5. */
  maxSteps?: number
  onDelta: (delta: string) => void
  /** Surface tool.requested / tool.completed so the timeline renders steps. */
  onEvent?: (event: AgentRunEvent) => void
  signal?: AbortSignal
}

export interface CloudAgentLoopResult {
  requestId: string
  creditsCost: number
  inputTokens: number
  outputTokens: number
  steps: number
  hitStepCap: boolean
}

const DEFAULT_MAX_STEPS = 5

/**
 * Drive the model↔tool loop to a final text answer.
 *
 * Each turn: call the model with the accumulated history + tool defs. If it
 * returns tool_calls, execute each (billed server-side), append the assistant
 * message (with tool_calls) + one `tool` message per result, and loop. Stop
 * when a turn returns no tool_calls, or the step cap is hit.
 */
export async function runCloudAgentLoop(
  deps: CloudAgentLoopDeps,
  params: CloudAgentLoopParams,
): Promise<CloudAgentLoopResult> {
  const maxSteps = params.maxSteps ?? DEFAULT_MAX_STEPS
  const messages = [...params.messages]
  let creditsCost = 0
  let inputTokens = 0
  let outputTokens = 0
  let requestId = ''
  const pendingGeneratedImageURLs: string[] = []

  for (let step = 0; step < maxSteps; step += 1) {
    throwIfAborted(params.signal)
    const turn = await deps.streamLLM(
      { runId: params.runId, mode: params.mode, messages, tools: params.tools },
      { onDelta: params.onDelta },
      params.signal,
    )
    creditsCost += turn.creditsCost
    inputTokens += turn.inputTokens
    outputTokens += turn.outputTokens
    requestId = turn.requestId || requestId

    if (turn.toolCalls.length === 0) {
      appendMissingGeneratedImages(params.onDelta, pendingGeneratedImageURLs, turn.content)
      return { requestId, creditsCost, inputTokens, outputTokens, steps: step + 1, hitStepCap: false }
    }

    // Record the assistant's tool-calling turn before executing.
    messages.push({ role: 'assistant', content: turn.content, toolCalls: turn.toolCalls })

    // Tools within one turn are independent — run concurrently. The gateway
    // is idempotent on (runId:toolCallId:tool), so a stable key per call makes
    // a reconnect/retry safe from double-charging.
    const results = await Promise.all(
      turn.toolCalls.map(async (call) => {
        params.onEvent?.(toolRequestedEvent(params.runId, call))
        const result = await deps.executeTool({
          runId: params.runId,
          toolCallId: call.id,
          tool: call.name,
          arguments: call.arguments,
          idempotencyKey: `${params.runId}:${call.id}:${call.name}`,
        })
        params.onEvent?.(toolCompletedEvent(params.runId, call, result))
        return { call, result }
      }),
    )

    for (const { call, result } of results) {
      appendUnique(pendingGeneratedImageURLs, imageUrlsFromResult(result))
      messages.push({
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: result.content || (result.ok ? 'OK' : `Error: ${result.errorCode ?? 'tool_failed'}`),
      })
    }
  }

  // Ran out of steps with tools still pending. Caller decides how to surface;
  // we return hitStepCap so it can append a note.
  appendMissingGeneratedImages(params.onDelta, pendingGeneratedImageURLs, '')
  return { requestId, creditsCost, inputTokens, outputTokens, steps: maxSteps, hitStepCap: true }
}

/** Extract image URLs from an image.* tool result (`data.images[].url`). */
export function imageUrlsFromResult(result: CloudToolResult): string[] {
  const images = result.data?.images
  if (!Array.isArray(images)) return []
  const urls: string[] = []
  for (const image of images) {
    if (image && typeof image === 'object') {
      const url = (image as Record<string, unknown>).url
      if (typeof url === 'string' && url) urls.push(url)
    }
  }
  return urls
}

function appendMissingGeneratedImages(
  onDelta: (delta: string) => void,
  imageURLs: string[],
  finalContent: string,
): void {
  for (const url of imageURLs) {
    if (!finalContent.includes(url)) {
      onDelta(`\n\n![image.generate](${url})\n`)
    }
  }
}

function appendUnique(target: string[], values: string[]): void {
  for (const value of values) {
    if (!target.includes(value)) {
      target.push(value)
    }
  }
}

function toolRequestedEvent(
  runId: string,
  call: { id: string; name: string; arguments: Record<string, unknown> },
): AgentRunEvent {
  return {
    event_type: 'tool.requested',
    run_id: runId,
    payload: { tool: call.name, tool_call_id: call.id, arguments: call.arguments },
  }
}

function toolCompletedEvent(
  runId: string,
  call: { id: string; name: string },
  result: CloudToolResult,
): AgentRunEvent {
  return {
    event_type: result.ok ? 'tool.completed' : 'tool.failed',
    run_id: runId,
    payload: {
      tool: call.name,
      tool_call_id: call.id,
      ...(result.data ?? {}),
      ...(result.ok ? {} : { error: result.errorCode ?? 'tool_failed' }),
    },
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError')
  }
}

// ---------------------------------------------------------------------------
// Web tool catalog — the ONLY tools advertised to the model on web. Schemas
// mirror the daemon's image.generate / web.search tools (kept minimal). The
// caller filters this by GET /agent/tool-capabilities so an unconfigured tool
// (e.g. Tavily key absent) is never offered.
// ---------------------------------------------------------------------------

export const WEB_TOOL_DEFINITIONS: Record<string, CloudToolDefinition> = {
  'web.search': {
    name: 'web.search',
    description:
      'Search the public web for current information and return ranked results with titles, URLs and snippets. Use for recent events, facts, or anything that may have changed.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query.' },
        max_results: { type: 'integer', description: 'How many results to return (1-10).', minimum: 1, maximum: 10 },
      },
      required: ['query'],
    },
  },
  'image.generate': {
    name: 'image.generate',
    description:
      'Generate one or more images from a text prompt. Use when the user asks to create, draw, or generate a picture.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'A detailed description of the image to generate.' },
        size: { type: 'string', description: 'Image size, e.g. "1024x1024".' },
        n: { type: 'integer', description: 'Number of images (1-4).', minimum: 1, maximum: 4 },
      },
      required: ['prompt'],
    },
  },
}

/** Build the advertised tool list from the capabilities map, in a stable
 *  order (search before image). A tool is offered only when configured. */
export function webToolsFromCapabilities(
  capabilities: Record<string, { configured?: boolean }>,
): CloudToolDefinition[] {
  const order = ['web.search', 'image.generate']
  return order
    .filter((name) => capabilities[name]?.configured && WEB_TOOL_DEFINITIONS[name])
    .map((name) => WEB_TOOL_DEFINITIONS[name])
}
