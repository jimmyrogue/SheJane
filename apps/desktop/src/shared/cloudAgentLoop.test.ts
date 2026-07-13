import { describe, expect, it, vi } from 'vitest'
import {
  runCloudAgentLoop,
  webToolsFromCapabilities,
  imageUrlsFromResult,
  type CloudAgentLoopDeps,
  type CloudLLMTurn,
  type CloudToolDefinition,
  type CloudToolResult,
} from './cloudAgentLoop'

const WEB_TOOL_FIXTURES: Record<string, CloudToolDefinition> = {
  'web.search': {
    name: 'web.search',
    description: 'Search the public web.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  'image.generate': {
    name: 'image.generate',
    description: 'Generate an image.',
    inputSchema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] },
  },
}

function turn(partial: Partial<CloudLLMTurn>): CloudLLMTurn {
  return {
    content: '',
    reasoning: '',
    toolCalls: [],
    finishReason: 'stop',
    requestId: 'req',
    inputTokens: 0,
    outputTokens: 0,
    creditsCost: 0,
    ...partial,
  }
}

describe('runCloudAgentLoop', () => {
  it('drives a model→tool→model roundtrip and stops when no tool_calls remain', async () => {
    const streamLLM = vi
      .fn()
      .mockResolvedValueOnce(
        turn({
          content: '我来画一只猫',
          toolCalls: [{ id: 'c1', name: 'image.generate', arguments: { prompt: 'a cat' } }],
          finishReason: 'tool_calls',
          creditsCost: 5,
        }),
      )
      .mockResolvedValueOnce(turn({ content: '画好了', finishReason: 'stop', requestId: 'req-2', creditsCost: 3 }))

    const executeTool = vi.fn().mockResolvedValue({
      ok: true,
      content: '已生成 1 张图片',
      data: { images: [{ url: 'https://cdn.example.com/cat.png' }] },
    } satisfies CloudToolResult)

    const deps: CloudAgentLoopDeps = { streamLLM, executeTool }
    const deltas: string[] = []
    const events: string[] = []

    const result = await runCloudAgentLoop(deps, {
      runId: 'run-x',
      mode: 'fast',
      messages: [{ role: 'user', content: '画一只猫' }],
      tools: [WEB_TOOL_FIXTURES['image.generate']],
      onDelta: (d) => deltas.push(d),
      onEvent: (e) => events.push(e.event_type),
    })

    // Two model turns, one tool execution.
    expect(streamLLM).toHaveBeenCalledTimes(2)
    expect(executeTool).toHaveBeenCalledTimes(1)

    // Idempotency key is stable: runId:toolCallId:tool.
    expect(executeTool.mock.calls[0][0]).toMatchObject({
      runId: 'run-x',
      tool: 'image.generate',
      toolCallId: 'c1',
      idempotencyKey: 'run-x:c1:image.generate',
    })

    // The generated image is inlined as markdown so it renders in the bubble.
    expect(deltas.join('')).toContain('![image.generate](https://cdn.example.com/cat.png)')

    // Tool steps surfaced for the timeline.
    expect(events).toContain('tool.requested')
    expect(events).toContain('tool.completed')

    // Second turn received the assistant(tool_calls) + tool(result) messages.
    const secondCallMessages = streamLLM.mock.calls[1][0].messages
    expect(secondCallMessages.at(-2)).toMatchObject({ role: 'assistant' })
    expect(secondCallMessages.at(-1)).toMatchObject({ role: 'tool', toolCallId: 'c1', content: '已生成 1 张图片' })

    // Credits summed across turns; not flagged as capped.
    expect(result.creditsCost).toBe(8)
    expect(result.steps).toBe(2)
    expect(result.hitStepCap).toBe(false)
  })

  it('does not duplicate generated images when the final model reply already includes them', async () => {
    const imageURL = 'https://cdn.example.com/cat.png'
    const streamLLM = vi
      .fn()
      .mockResolvedValueOnce(
        turn({
          content: '我来画一只猫',
          toolCalls: [{ id: 'c1', name: 'image.generate', arguments: { prompt: 'a cat' } }],
          finishReason: 'tool_calls',
        }),
      )
      .mockImplementationOnce(async (_body, handlers: { onDelta: (delta: string) => void }) => {
        handlers.onDelta(`画好了\n\n![cat](${imageURL})`)
        return turn({ content: `画好了\n\n![cat](${imageURL})`, finishReason: 'stop' })
      })

    const executeTool = vi.fn().mockResolvedValue({
      ok: true,
      content: '已生成 1 张图片',
      data: { images: [{ url: imageURL }] },
    } satisfies CloudToolResult)
    const deltas: string[] = []

    await runCloudAgentLoop(
      { streamLLM, executeTool },
      {
        runId: 'run-x',
        mode: 'fast',
        messages: [{ role: 'user', content: '画一只猫' }],
        tools: [WEB_TOOL_FIXTURES['image.generate']],
        onDelta: (d) => deltas.push(d),
      },
    )

    expect(countOccurrences(deltas.join(''), imageURL)).toBe(1)
  })

  it('appends generated images after the final text when the model omits them', async () => {
    const imageURL = 'https://cdn.example.com/cat.png'
    const streamLLM = vi
      .fn()
      .mockResolvedValueOnce(
        turn({
          toolCalls: [{ id: 'c1', name: 'image.generate', arguments: { prompt: 'a cat' } }],
          finishReason: 'tool_calls',
        }),
      )
      .mockImplementationOnce(async (_body, handlers: { onDelta: (delta: string) => void }) => {
        handlers.onDelta('画好了')
        return turn({ content: '画好了', finishReason: 'stop' })
      })

    const executeTool = vi.fn().mockResolvedValue({
      ok: true,
      content: '已生成 1 张图片',
      data: { images: [{ url: imageURL }] },
    } satisfies CloudToolResult)
    const deltas: string[] = []

    await runCloudAgentLoop(
      { streamLLM, executeTool },
      {
        runId: 'run-x',
        mode: 'fast',
        messages: [{ role: 'user', content: '画一只猫' }],
        tools: [WEB_TOOL_FIXTURES['image.generate']],
        onDelta: (d) => deltas.push(d),
      },
    )

    const output = deltas.join('')
    expect(countOccurrences(output, imageURL)).toBe(1)
    expect(output.indexOf('画好了')).toBeLessThan(output.indexOf(`![image.generate](${imageURL})`))
  })

  it('runs multiple tool calls in one turn concurrently', async () => {
    const streamLLM = vi
      .fn()
      .mockResolvedValueOnce(
        turn({
          toolCalls: [
            { id: 'a', name: 'web.search', arguments: { query: 'x' } },
            { id: 'b', name: 'web.search', arguments: { query: 'y' } },
          ],
          finishReason: 'tool_calls',
        }),
      )
      .mockResolvedValueOnce(turn({ content: 'done' }))
    const executeTool = vi.fn().mockResolvedValue({ ok: true, content: 'results' } satisfies CloudToolResult)

    await runCloudAgentLoop(
      { streamLLM, executeTool },
      {
        runId: 'r',
        mode: 'fast',
        messages: [{ role: 'user', content: 'search two things' }],
        tools: [WEB_TOOL_FIXTURES['web.search']],
        onDelta: () => {},
      },
    )

    expect(executeTool).toHaveBeenCalledTimes(2)
  })

  it('stops at the step cap when the model keeps requesting tools', async () => {
    const streamLLM = vi.fn().mockResolvedValue(
      turn({ toolCalls: [{ id: 'c', name: 'web.search', arguments: {} }], finishReason: 'tool_calls' }),
    )
    const executeTool = vi.fn().mockResolvedValue({ ok: true, content: 'r' } satisfies CloudToolResult)

    const result = await runCloudAgentLoop(
      { streamLLM, executeTool },
      {
        runId: 'r',
        mode: 'fast',
        messages: [{ role: 'user', content: 'loop forever' }],
        tools: [WEB_TOOL_FIXTURES['web.search']],
        maxSteps: 3,
        onDelta: () => {},
      },
    )

    expect(streamLLM).toHaveBeenCalledTimes(3)
    expect(result.hitStepCap).toBe(true)
    expect(result.steps).toBe(3)
  })

  it('returns the accumulated model/tool history when a continuation is needed', async () => {
    const streamLLM = vi.fn().mockResolvedValue(
      turn({
        content: '继续查',
        toolCalls: [{ id: 'c1', name: 'web.search', arguments: { query: 'step cap' } }],
        finishReason: 'tool_calls',
      }),
    )
    const executeTool = vi.fn().mockResolvedValue({ ok: true, content: 'search result' } satisfies CloudToolResult)

    const result = await runCloudAgentLoop(
      { streamLLM, executeTool },
      {
        runId: 'r',
        mode: 'fast',
        messages: [{ role: 'user', content: 'loop forever' }],
        tools: [WEB_TOOL_FIXTURES['web.search']],
        maxSteps: 1,
        onDelta: () => {},
      },
    )

    expect(result.hitStepCap).toBe(true)
    expect(result.continuationMessages).toEqual([
      { role: 'user', content: 'loop forever' },
      {
        role: 'assistant',
        content: '继续查',
        toolCalls: [{ id: 'c1', name: 'web.search', arguments: { query: 'step cap' } }],
      },
      {
        role: 'tool',
        toolCallId: 'c1',
        name: 'web.search',
        content: 'search result',
      },
    ])
  })

  it('aborts when the signal is already aborted', async () => {
    const streamLLM = vi.fn()
    const controller = new AbortController()
    controller.abort()
    await expect(
      runCloudAgentLoop(
        { streamLLM, executeTool: vi.fn() },
        {
          runId: 'r',
          mode: 'fast',
          messages: [{ role: 'user', content: 'x' }],
          tools: [],
          onDelta: () => {},
          signal: controller.signal,
        },
      ),
    ).rejects.toThrow()
    expect(streamLLM).not.toHaveBeenCalled()
  })

  it('passes the abort signal into tool execution and suppresses completion after cancel', async () => {
    const streamLLM = vi.fn().mockResolvedValueOnce(
      turn({
        toolCalls: [{ id: 'c1', name: 'web.search', arguments: { query: 'x' } }],
        finishReason: 'tool_calls',
      }),
    )
    const controller = new AbortController()
    const events: string[] = []
    let toolSignal: AbortSignal | undefined
    const executeTool = vi.fn(async (_req, signal?: AbortSignal) => {
      toolSignal = signal
      controller.abort()
      return { ok: true, content: 'late result' } satisfies CloudToolResult
    })

    await expect(
      runCloudAgentLoop(
        { streamLLM, executeTool },
        {
          runId: 'r',
          mode: 'fast',
          messages: [{ role: 'user', content: 'search' }],
          tools: [WEB_TOOL_FIXTURES['web.search']],
          onDelta: () => {},
          onEvent: (event) => events.push(event.event_type),
          signal: controller.signal,
        },
      ),
    ).rejects.toThrow()

    expect(toolSignal).toBe(controller.signal)
    expect(events).toEqual(['tool.requested'])
  })
})

describe('webToolsFromCapabilities', () => {
  it('offers only configured tools, search before image', () => {
    const tools = webToolsFromCapabilities({
      'web.search': { configured: true, description: 'api search', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
      'image.generate': { configured: true, description: 'api image', inputSchema: { type: 'object', required: ['prompt'] } },
      'code.execute': { configured: true },
    })
    expect(tools.map((t) => t.name)).toEqual(['web.search', 'image.generate'])
    expect(tools[0]).toMatchObject({
      description: 'api search',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
    })
    expect(tools[1]).toMatchObject({
      description: 'api image',
      inputSchema: { type: 'object', required: ['prompt'] },
    })
  })

  it('drops unconfigured tools', () => {
    const tools = webToolsFromCapabilities({
      'web.search': { configured: false },
      'image.generate': { configured: true, description: 'api image', inputSchema: { type: 'object' } },
    })
    expect(tools.map((t) => t.name)).toEqual(['image.generate'])
  })

  it('returns empty when nothing is configured', () => {
    expect(webToolsFromCapabilities({})).toEqual([])
  })
})

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1
}

describe('imageUrlsFromResult', () => {
  it('extracts image urls from a tool result', () => {
    expect(
      imageUrlsFromResult({ ok: true, content: '', data: { images: [{ url: 'a' }, { url: 'b' }, {}] } }),
    ).toEqual(['a', 'b'])
  })

  it('returns empty for non-image results', () => {
    expect(imageUrlsFromResult({ ok: true, content: 'text' })).toEqual([])
  })
})
