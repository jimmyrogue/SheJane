import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { runHarness } from './runner.js'
import { InMemoryLocalHostStore } from '../state/memoryStore.js'
import type { LLMGateway, LLMGatewayRequest, LLMGatewayResponse } from '../llm/gateway.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs.length = 0
})

describe('harness runner', () => {
  it('executes native tool calls and feeds observations back to the model', async () => {
    const workspace = await tempWorkspace()
    await writeFile(join(workspace, 'notes.txt'), 'Jiandanly harness reads local files.', 'utf8')
    const store = new InMemoryLocalHostStore()
    const run = store.createRun({ goal: 'Read notes.txt and summarize it.', workspacePath: workspace })
    store.appendEvent(run.id, 'run.created', { goal: run.goal })
    const gateway = new ScriptedGateway([
      {
        requestId: 'req-1',
        reasoningContent: 'I need to read the requested local note before answering.',
        toolCalls: [
          {
            id: 'call-1',
            name: 'file.read',
            arguments: { path: 'notes.txt' },
          },
        ],
      },
      {
        requestId: 'req-2',
        content: 'The note says Jiandanly can read local files.',
      },
    ])

    await runHarness({ run, store, llmGateway: gateway, emit: () => undefined })

    expect(gateway.requests).toHaveLength(2)
    expect(gateway.requests[1].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'tool',
          toolCallId: 'call-1',
          name: 'file.read',
          content: expect.stringContaining('Jiandanly harness reads local files.'),
        }),
      ]),
    )
    expect(gateway.requests[1].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          reasoningContent: 'I need to read the requested local note before answering.',
        }),
      ]),
    )
    expect(store.getRun(run.id)?.status).toBe('completed')
    expect(store.listEvents(run.id).map((event) => event.eventType)).toEqual([
      'run.created',
      'run.started',
      'skill.selected',
      'llm.started',
      'tool.requested',
      'tool.started',
      'tool.completed',
      'verification.started',
      'verification.completed',
      'llm.started',
      'llm.delta',
      'run.completed',
    ])
  })

  it('blocks file tools outside the authorized workspace and keeps the error recoverable', async () => {
    const workspace = await tempWorkspace()
    const secret = await tempWorkspace()
    await writeFile(join(secret, 'secret.txt'), 'do not read me', 'utf8')
    const store = new InMemoryLocalHostStore()
    const run = store.createRun({ goal: 'Try to read outside the workspace.', workspacePath: workspace })
    store.appendEvent(run.id, 'run.created', { goal: run.goal })
    const gateway = new ScriptedGateway([
      {
        requestId: 'req-1',
        toolCalls: [
          {
            id: 'call-1',
            name: 'file.read',
            arguments: { path: join(secret, 'secret.txt') },
          },
        ],
      },
      {
        requestId: 'req-2',
        content: 'I cannot read files outside the authorized workspace.',
      },
    ])

    await runHarness({ run, store, llmGateway: gateway, emit: () => undefined })

    const events = store.listEvents(run.id)
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: 'tool.failed',
          payload: expect.objectContaining({
            tool: 'file.read',
            error_code: 'path_outside_workspace',
            recoverable: true,
          }),
        }),
      ]),
    )
    expect(gateway.requests[1].messages.at(-1)).toMatchObject({
      role: 'tool',
      toolCallId: 'call-1',
      content: expect.stringContaining('path_outside_workspace'),
    })
    expect(store.getRun(run.id)?.status).toBe('completed')
  })

  it('pauses shell commands for permission and executes only after approval', async () => {
    const workspace = await tempWorkspace()
    const store = new InMemoryLocalHostStore()
    const run = store.createRun({ goal: 'Run a safe command.', workspacePath: workspace })
    store.appendEvent(run.id, 'run.created', { goal: run.goal })
    const gateway = new ScriptedGateway([
      {
        requestId: 'req-1',
        toolCalls: [
          {
            id: 'call-shell',
            name: 'shell.run',
            arguments: { command: 'printf hello > shell-output.txt' },
          },
        ],
      },
      {
        requestId: 'req-2',
        content: 'The approved shell command completed.',
      },
    ])

    await runHarness({ run, store, llmGateway: gateway, emit: () => undefined })

    const permission = store.listPermissions(run.id)[0]
    expect(permission).toMatchObject({
      status: 'pending',
      toolName: 'shell.run',
    })
    expect(store.getRun(run.id)?.status).toBe('waiting_permission')
    expect(store.listEvents(run.id).map((event) => event.eventType)).toContain('permission.required')
    await expect(readFile(join(workspace, 'shell-output.txt'), 'utf8')).rejects.toThrow()

    await store.resolvePermission(permission.id, 'approve')
    await runHarness({ run: store.getRun(run.id)!, store, llmGateway: gateway, emit: () => undefined, resumePermissionID: permission.id })

    await expect(readFile(join(workspace, 'shell-output.txt'), 'utf8')).resolves.toBe('hello')
    expect(store.getRun(run.id)?.status).toBe('completed')
    expect(gateway.requests).toHaveLength(2)
    expect(gateway.requests[1].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'tool',
          toolCallId: 'call-shell',
          name: 'shell.run',
        }),
      ]),
    )
    expect(store.listEvents(run.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: 'permission.resolved' }),
        expect.objectContaining({ eventType: 'tool.completed', payload: expect.objectContaining({ tool: 'shell.run' }) }),
        expect.objectContaining({ eventType: 'run.completed', payload: expect.objectContaining({ final: 'The approved shell command completed.' }) }),
      ]),
    )
  })

  it('opens an approved workspace before running workspace-bound tools', async () => {
    const workspace = await tempWorkspace()
    await writeFile(join(workspace, 'notes.txt'), 'workspace opened successfully', 'utf8')
    const store = new InMemoryLocalHostStore()
    const run = store.createRun({ goal: 'Open this workspace and read notes.txt.' })
    store.appendEvent(run.id, 'run.created', { goal: run.goal })
    const gateway = new ScriptedGateway([
      {
        requestId: 'req-open',
        toolCalls: [
          {
            id: 'call-open',
            name: 'workspace.open',
            arguments: { path: workspace },
          },
        ],
      },
      {
        requestId: 'req-read',
        toolCalls: [
          {
            id: 'call-read',
            name: 'file.read',
            arguments: { path: 'notes.txt' },
          },
        ],
      },
      {
        requestId: 'req-final',
        content: 'The workspace note was read.',
      },
    ])

    await runHarness({ run, store, llmGateway: gateway, emit: () => undefined })
    const permission = store.listPermissions(run.id)[0]
    expect(permission).toMatchObject({ toolName: 'workspace.open', status: 'pending' })

    await store.resolvePermission(permission.id, 'approve')
    await runHarness({ run: store.getRun(run.id)!, store, llmGateway: gateway, emit: () => undefined, resumePermissionID: permission.id })

    expect(store.getRun(run.id)?.workspacePath).toBe(workspace)
    expect(gateway.requests.at(-1)?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'tool',
          toolCallId: 'call-read',
          name: 'file.read',
          content: expect.stringContaining('workspace opened successfully'),
        }),
      ]),
    )
    expect(store.getRun(run.id)?.status).toBe('completed')
  })

  it('pauses file writes for permission and writes only after approval', async () => {
    const workspace = await tempWorkspace()
    const store = new InMemoryLocalHostStore()
    const run = store.createRun({ goal: 'Create generated.txt.', workspacePath: workspace })
    store.appendEvent(run.id, 'run.created', { goal: run.goal })
    const gateway = new ScriptedGateway([
      {
        requestId: 'req-write',
        toolCalls: [
          {
            id: 'call-write',
            name: 'file.write',
            arguments: { path: 'generated.txt', content: 'hello from file.write\n' },
          },
        ],
      },
      {
        requestId: 'req-final',
        content: 'generated.txt was created.',
      },
    ])

    await runHarness({ run, store, llmGateway: gateway, emit: () => undefined })
    const permission = store.listPermissions(run.id)[0]
    expect(permission).toMatchObject({ toolName: 'file.write', status: 'pending' })
    await expect(readFile(join(workspace, 'generated.txt'), 'utf8')).rejects.toThrow()

    await store.resolvePermission(permission.id, 'approve')
    await runHarness({ run: store.getRun(run.id)!, store, llmGateway: gateway, emit: () => undefined, resumePermissionID: permission.id })

    await expect(readFile(join(workspace, 'generated.txt'), 'utf8')).resolves.toBe('hello from file.write\n')
    expect(store.listEvents(run.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: 'permission.resolved', payload: expect.objectContaining({ tool: 'file.write' }) }),
        expect.objectContaining({ eventType: 'tool.completed', payload: expect.objectContaining({ tool: 'file.write' }) }),
        expect.objectContaining({
          eventType: 'verification.completed',
          payload: expect.objectContaining({
            tool: 'file.write',
            status: 'passed',
            checks: expect.arrayContaining([expect.objectContaining({ name: 'file_write_ok', passed: true })]),
          }),
        }),
      ]),
    )
    expect(store.getRun(run.id)?.status).toBe('completed')
  })

  it('uses universal primitive permissions for writes, opens, and clipboard changes', async () => {
    const workspace = await tempWorkspace()
    const store = new InMemoryLocalHostStore()
    const run = store.createRun({ goal: 'Use universal primitives safely.', workspacePath: workspace })
    store.appendEvent(run.id, 'run.created', { goal: run.goal })
    const gateway = new ScriptedGateway([
      {
        requestId: 'req-write',
        toolCalls: [
          {
            id: 'call-write',
            name: 'fs.write',
            arguments: { path: 'primitive.txt', content: 'primitive write' },
          },
        ],
      },
      {
        requestId: 'req-open',
        toolCalls: [
          {
            id: 'call-open-url',
            name: 'open.url',
            arguments: { url: 'https://example.com' },
          },
        ],
      },
      {
        requestId: 'req-clipboard',
        toolCalls: [
          {
            id: 'call-clipboard',
            name: 'clipboard.write',
            arguments: { text: 'copy me' },
          },
        ],
      },
      {
        requestId: 'req-final',
        content: 'Primitive actions completed.',
      },
    ])
    const opened: Array<{ kind: string; target: string }> = []
    let clipboard = ''

    await runHarness({ run, store, llmGateway: gateway, emit: () => undefined })
    const writePermission = store.listPermissions(run.id)[0]
    expect(writePermission).toMatchObject({ toolName: 'fs.write', status: 'pending' })
    await store.resolvePermission(writePermission.id, 'approve')
    await runHarness({ run: store.getRun(run.id)!, store, llmGateway: gateway, emit: () => undefined, resumePermissionID: writePermission.id })

    const openPermission = store.listPermissions(run.id).at(-1)!
    expect(openPermission).toMatchObject({ toolName: 'open.url', status: 'pending' })
    await store.resolvePermission(openPermission.id, 'approve')
    await runHarness({
      run: store.getRun(run.id)!,
      store,
      llmGateway: gateway,
      emit: () => undefined,
      resumePermissionID: openPermission.id,
      toolOptions: { opener: async (target) => opened.push(target) },
    })

    const clipboardPermission = store.listPermissions(run.id).at(-1)!
    expect(clipboardPermission).toMatchObject({ toolName: 'clipboard.write', status: 'pending' })
    await store.resolvePermission(clipboardPermission.id, 'approve')
    await runHarness({
      run: store.getRun(run.id)!,
      store,
      llmGateway: gateway,
      emit: () => undefined,
      resumePermissionID: clipboardPermission.id,
      toolOptions: {
        opener: async (target) => opened.push(target),
        clipboard: {
          readText: async () => clipboard,
          writeText: async (text) => {
            clipboard = text
          },
        },
      },
    })

    await expect(readFile(join(workspace, 'primitive.txt'), 'utf8')).resolves.toBe('primitive write')
    expect(opened).toEqual([{ kind: 'url', target: 'https://example.com/' }])
    expect(clipboard).toBe('copy me')
    expect(store.getRun(run.id)?.status).toBe('completed')
  })

  it('fails fast when the model requests an unsupported tool', async () => {
    const store = new InMemoryLocalHostStore()
    const run = store.createRun({ goal: 'Use a tool that is not registered.' })
    store.appendEvent(run.id, 'run.created', { goal: run.goal })
    const gateway = new ScriptedGateway([
      {
        requestId: 'req-unknown',
        toolCalls: [{ id: 'call-unknown', name: 'file.delete', arguments: { path: 'notes.txt' } }],
      },
    ])

    await runHarness({ run, store, llmGateway: gateway, emit: () => undefined })

    expect(gateway.requests).toHaveLength(1)
    expect(store.getRun(run.id)?.status).toBe('failed')
    expect(store.listEvents(run.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: 'tool.failed',
          payload: expect.objectContaining({
            tool: 'file.delete',
            error_code: 'unknown_tool',
            recoverable: false,
          }),
        }),
        expect.objectContaining({
          eventType: 'run.failed',
          payload: expect.objectContaining({
            error_code: 'unsupported_tool',
            tool: 'file.delete',
          }),
        }),
      ]),
    )
  })

  it('stores long tool output as an artifact and sends only a reference back to the model', async () => {
    const workspace = await tempWorkspace()
    const largeContent = 'phase-2.5-artifact '.repeat(300)
    await writeFile(join(workspace, 'large.txt'), largeContent, 'utf8')
    const store = new InMemoryLocalHostStore()
    const run = store.createRun({ goal: 'Read large.txt and summarize it.', workspacePath: workspace })
    store.appendEvent(run.id, 'run.created', { goal: run.goal })
    const gateway = new ScriptedGateway([
      {
        requestId: 'req-1',
        toolCalls: [{ id: 'call-large', name: 'file.read', arguments: { path: 'large.txt', maxBytes: largeContent.length } }],
      },
      {
        requestId: 'req-2',
        content: 'The large file was summarized from an artifact reference.',
      },
    ])

    await runHarness({ run, store, llmGateway: gateway, emit: () => undefined, artifactThresholdChars: 512 })

    const artifact = store.listArtifacts(run.id)[0]
    expect(artifact).toMatchObject({
      runId: run.id,
      kind: 'tool_output',
      toolName: 'file.read',
      content: largeContent,
    })
    expect(store.listEvents(run.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: 'artifact.created', payload: expect.objectContaining({ artifact_id: artifact.id }) }),
        expect.objectContaining({ eventType: 'tool.completed', payload: expect.objectContaining({ artifact_id: artifact.id }) }),
      ]),
    )
    const toolMessage = gateway.requests[1].messages.find((message) => message.role === 'tool')
    expect(toolMessage?.content).toContain(artifact.id)
    expect(toolMessage?.content.length).toBeLessThan(largeContent.length / 2)
    expect(toolMessage?.content).not.toContain(largeContent)
  })

  it('compacts oversized context and checkpoints the compacted state before continuing', async () => {
    const store = new InMemoryLocalHostStore()
    const run = store.createRun({ goal: 'Keep context compact.' })
    store.appendEvent(run.id, 'run.created', { goal: run.goal })
    const verboseAssistantContent = 'intermediate reasoning '.repeat(80)
    const gateway = new ScriptedGateway([
      {
        requestId: 'req-1',
        content: verboseAssistantContent,
        toolCalls: [{ id: 'call-time', name: 'time.now', arguments: {} }],
      },
      {
        requestId: 'req-2',
        content: 'Done after compaction.',
      },
    ])

    await runHarness({ run, store, llmGateway: gateway, emit: () => undefined, contextLimitChars: 1200 })

    expect(store.listEvents(run.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: 'context.compacted' }),
        expect.objectContaining({ eventType: 'checkpoint.created' }),
      ]),
    )
    expect(gateway.requests[1].messages.map((message) => message.content).join('\n')).toContain('Compacted run history')
    expect(gateway.requests[1].messages.map((message) => message.content).join('\n')).not.toContain(verboseAssistantContent)
    expect(store.latestCheckpoint(run.id)?.messages.map((message) => message.content).join('\n')).toContain('Compacted run history')
  })

  it('resumes a running run from the latest checkpoint', async () => {
    const store = new InMemoryLocalHostStore()
    const run = store.createRun({ goal: 'Resume me from checkpoint.' })
    store.appendEvent(run.id, 'run.created', { goal: run.goal })
    store.updateRunStatus(run.id, 'running')
    store.createCheckpoint({
      runId: run.id,
      step: 1,
      reason: 'test_resume',
      messages: [
        { role: 'system', content: 'System policy' },
        { role: 'user', content: 'Resume me from checkpoint.' },
        { role: 'tool', toolCallId: 'call-prev', name: 'time.now', content: '2026-05-11T00:00:00.000Z' },
      ],
    })
    const gateway = new ScriptedGateway([{ requestId: 'req-resume', content: 'Resumed from checkpoint.' }])

    await runHarness({ run: store.getRun(run.id)!, store, llmGateway: gateway, emit: () => undefined })

    expect(gateway.requests[0].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'tool', toolCallId: 'call-prev', name: 'time.now' }),
      ]),
    )
    expect(store.listEvents(run.id)).toEqual(expect.arrayContaining([expect.objectContaining({ eventType: 'checkpoint.resumed' })]))
    expect(store.getRun(run.id)?.status).toBe('completed')
  })

  it('loads memory index and matching topic notes into the first model request', async () => {
    const store = new InMemoryLocalHostStore()
    store.upsertMemory({
      kind: 'index',
      title: 'Engineering habits',
      summary: 'Prefer failing tests before implementation.',
      content: 'Always verify RED before GREEN.',
    })
    store.upsertMemory({
      kind: 'topic',
      title: 'Jiandanly local harness',
      summary: 'Local Harness owns tool execution and context.',
      content: 'Do not move local file contents into the cloud control plane.',
    })
    const run = store.createRun({ goal: 'Improve the Jiandanly local harness.' })
    store.appendEvent(run.id, 'run.created', { goal: run.goal })
    const gateway = new ScriptedGateway([{ requestId: 'req-memory', content: 'Memory loaded.' }])

    await runHarness({ run, store, llmGateway: gateway, emit: () => undefined })

    const prompt = gateway.requests[0].messages.map((message) => message.content).join('\n')
    expect(prompt).toContain('Prefer failing tests before implementation.')
    expect(prompt).toContain('Do not move local file contents into the cloud control plane.')
  })

  it('emits verification events for successful and failed tool observations', async () => {
    const workspace = await tempWorkspace()
    const store = new InMemoryLocalHostStore()
    const run = store.createRun({ goal: 'Verify shell result.', workspacePath: workspace })
    store.appendEvent(run.id, 'run.created', { goal: run.goal })
    const gateway = new ScriptedGateway([
      {
        requestId: 'req-1',
        toolCalls: [{ id: 'call-shell', name: 'shell.run', arguments: { command: 'exit 7' } }],
      },
      {
        requestId: 'req-2',
        content: 'The command failed verification.',
      },
    ])

    await runHarness({ run, store, llmGateway: gateway, emit: () => undefined })
    const permission = store.listPermissions(run.id)[0]
    await store.resolvePermission(permission.id, 'approve')
    await runHarness({ run: store.getRun(run.id)!, store, llmGateway: gateway, emit: () => undefined, resumePermissionID: permission.id })

    expect(store.listEvents(run.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: 'verification.started', payload: expect.objectContaining({ tool: 'shell.run', tool_call_id: 'call-shell' }) }),
        expect.objectContaining({
          eventType: 'verification.completed',
          payload: expect.objectContaining({
            tool: 'shell.run',
            status: 'failed',
            checks: expect.arrayContaining([expect.objectContaining({ name: 'exit_code_zero', passed: false })]),
          }),
        }),
      ]),
    )
  })

  it('executes approved MCP calls through the local runtime adapter and feeds the observation back', async () => {
    const serverPath = await writeFakeMCPServer()
    const store = new InMemoryLocalHostStore()
    const run = store.createRun({ goal: 'Use an allowlisted MCP docs search.' })
    store.appendEvent(run.id, 'run.created', { goal: run.goal })
    const gateway = new ScriptedGateway([
      {
        requestId: 'req-1',
        toolCalls: [
          {
            id: 'call-mcp',
            name: 'mcp.call',
            arguments: { server: 'local-docs', tool: 'safe.search', input: { q: 'harness' } },
          },
        ],
      },
      {
        requestId: 'req-2',
        content: 'The MCP search returned harness documentation.',
      },
    ])

    await runHarness({ run, store, llmGateway: gateway, emit: () => undefined })
    const permission = store.listPermissions(run.id)[0]
    expect(permission).toMatchObject({ toolName: 'mcp.call', status: 'pending' })

    await store.resolvePermission(permission.id, 'approve')
    await runHarness({
      run: store.getRun(run.id)!,
      store,
      llmGateway: gateway,
      emit: () => undefined,
      resumePermissionID: permission.id,
      toolOptions: {
        mcpAllowlist: ['local-docs.safe.search'],
        mcpServers: {
          'local-docs': {
            command: process.execPath,
            args: [serverPath],
          },
        },
      },
    })

    expect(gateway.requests[1].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'tool',
          toolCallId: 'call-mcp',
          name: 'mcp.call',
          content: 'MCP result for harness',
        }),
      ]),
    )
    expect(store.listEvents(run.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: 'permission.resolved', payload: expect.objectContaining({ tool: 'mcp.call' }) }),
        expect.objectContaining({ eventType: 'tool.completed', payload: expect.objectContaining({ tool: 'mcp.call' }) }),
        expect.objectContaining({
          eventType: 'verification.completed',
          payload: expect.objectContaining({
            tool: 'mcp.call',
            status: 'passed',
            checks: expect.arrayContaining([expect.objectContaining({ name: 'mcp_runtime_available', passed: true })]),
          }),
        }),
      ]),
    )
    expect(store.getRun(run.id)?.status).toBe('completed')
  })

  it('runs concurrency-safe tool calls in parallel while preserving observation order', async () => {
    const store = new InMemoryLocalHostStore()
    const run = store.createRun({ goal: 'Fetch two public pages.' })
    store.appendEvent(run.id, 'run.created', { goal: run.goal })
    const gateway = new ScriptedGateway([
      {
        requestId: 'req-1',
        toolCalls: [
          { id: 'fetch-a', name: 'web.fetch', arguments: { url: 'https://example.com/a' } },
          { id: 'fetch-b', name: 'web.fetch', arguments: { url: 'https://example.com/b' } },
        ],
      },
      {
        requestId: 'req-2',
        content: 'Both pages were fetched.',
      },
    ])
    let activeFetches = 0
    let maxActiveFetches = 0
    const fetcher = async (input: string | URL | Request) => {
      activeFetches += 1
      maxActiveFetches = Math.max(maxActiveFetches, activeFetches)
      await new Promise((resolve) => setTimeout(resolve, 25))
      activeFetches -= 1
      return new Response(`content from ${String(input)}`, {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      })
    }

    await runHarness({
      run,
      store,
      llmGateway: gateway,
      emit: () => undefined,
      toolOptions: {
        fetcher: fetcher as typeof fetch,
        resolveHostname: async () => ['93.184.216.34'],
      },
    })

    expect(maxActiveFetches).toBe(2)
    expect(gateway.requests[1].messages.filter((message) => message.role === 'tool')).toMatchObject([
      { toolCallId: 'fetch-a', name: 'web.fetch', content: expect.stringContaining('content from https://example.com/a') },
      { toolCallId: 'fetch-b', name: 'web.fetch', content: expect.stringContaining('content from https://example.com/b') },
    ])
    expect(store.getRun(run.id)?.status).toBe('completed')
  })

  it('marks the run failed when the model gateway throws', async () => {
    const store = new InMemoryLocalHostStore()
    const run = store.createRun({ goal: 'Handle model failures.' })
    store.appendEvent(run.id, 'run.created', { goal: run.goal })

    await expect(runHarness({ run, store, llmGateway: new FailingGateway('gateway unavailable'), emit: () => undefined })).resolves.toBeUndefined()

    expect(store.getRun(run.id)?.status).toBe('failed')
    expect(store.listEvents(run.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: 'run.failed',
          payload: expect.objectContaining({
            error_code: 'llm_failed',
            message: 'gateway unavailable',
          }),
        }),
      ]),
    )
  })
})

class ScriptedGateway implements LLMGateway {
  readonly requests: LLMGatewayRequest[] = []
  private index = 0

  constructor(private readonly responses: LLMGatewayResponse[]) {}

  async call(request: LLMGatewayRequest): Promise<LLMGatewayResponse> {
    this.requests.push(request)
    const response = this.responses[this.index]
    this.index += 1
    if (!response) {
      throw new Error('No scripted response left')
    }
    return response
  }
}

class FailingGateway implements LLMGateway {
  constructor(private readonly message: string) {}

  async call(): Promise<LLMGatewayResponse> {
    throw new Error(this.message)
  }
}

async function tempWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'jiandanly-harness-'))
  tempDirs.push(dir)
  return dir
}

async function writeFakeMCPServer(): Promise<string> {
  const dir = await tempWorkspace()
  const serverPath = join(dir, 'fake-mcp-server.mjs')
  await writeFile(
    serverPath,
    `
      import { createInterface } from 'node:readline'

      const rl = createInterface({ input: process.stdin })
      function send(message) {
        process.stdout.write(JSON.stringify(message) + '\\n')
      }

      rl.on('line', (line) => {
        const message = JSON.parse(line)
        if (message.method === 'initialize') {
          send({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: { name: 'fake-local-docs', version: '0.1.0' }
            }
          })
          return
        }
        if (message.method === 'notifications/initialized') {
          return
        }
        if (message.method === 'tools/call') {
          send({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              content: [{ type: 'text', text: 'MCP result for ' + message.params.arguments.q }],
              isError: false
            }
          })
        }
      })
    `,
    'utf8',
  )
  return serverPath
}
