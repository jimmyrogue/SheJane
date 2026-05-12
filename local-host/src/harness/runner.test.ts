import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runHarness } from './runner.js'
import { InMemoryLocalHostStore } from '../state/memoryStore.js'
import type { LLMGateway, LLMGatewayRequest, LLMGatewayResponse } from '../llm/gateway.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs.length = 0
  vi.restoreAllMocks()
  delete process.env.JIANDANLY_LOCAL_HOST_DEBUG
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

  it('auto-approves the same permission type for the rest of the run when approved with run scope', async () => {
    const workspace = await tempWorkspace()
    const store = new InMemoryLocalHostStore()
    const run = store.createRun({ goal: 'Run two safe commands.', workspacePath: workspace })
    store.appendEvent(run.id, 'run.created', { goal: run.goal })
    const gateway = new ScriptedGateway([
      {
        requestId: 'req-first-shell',
        toolCalls: [{ id: 'call-shell-1', name: 'shell.run', arguments: { command: 'printf first > first.txt' } }],
      },
      {
        requestId: 'req-second-shell',
        toolCalls: [{ id: 'call-shell-2', name: 'shell.run', arguments: { command: 'printf second > second.txt' } }],
      },
      {
        requestId: 'req-final',
        content: 'Both commands completed.',
      },
    ])

    await runHarness({ run, store, llmGateway: gateway, emit: () => undefined })
    const permission = store.listPermissions(run.id)[0]
    expect(permission).toMatchObject({ toolName: 'shell.run', status: 'pending' })

    await store.resolvePermission(permission.id, 'approve', 'run')
    await runHarness({ run: store.getRun(run.id)!, store, llmGateway: gateway, emit: () => undefined, resumePermissionID: permission.id })

    await expect(readFile(join(workspace, 'first.txt'), 'utf8')).resolves.toBe('first')
    await expect(readFile(join(workspace, 'second.txt'), 'utf8')).resolves.toBe('second')
    expect(store.listPermissions(run.id)).toHaveLength(1)
    expect(store.listEvents(run.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: 'permission.auto_approved',
          payload: expect.objectContaining({ tool: 'shell.run', scope: 'run' }),
        }),
        expect.objectContaining({ eventType: 'run.completed', payload: expect.objectContaining({ final: 'Both commands completed.' }) }),
      ]),
    )
  })

  it('does not send incomplete multi-tool permission turns back to the model', async () => {
    const workspace = await tempWorkspace()
    const store = new InMemoryLocalHostStore()
    const run = store.createRun({ goal: 'Run an approved command, then continue safely.', workspacePath: workspace })
    store.appendEvent(run.id, 'run.created', { goal: run.goal })
    const gateway = new PairingValidatingGateway([
      {
        requestId: 'req-multi-tool',
        toolCalls: [
          {
            id: 'call-shell',
            name: 'shell.run',
            arguments: { command: 'printf hello > shell-output.txt' },
          },
          {
            id: 'call-time',
            name: 'time.now',
            arguments: {},
          },
        ],
      },
      {
        requestId: 'req-final',
        content: 'The approved command completed and the incomplete sibling call was not replayed.',
      },
    ])

    await runHarness({ run, store, llmGateway: gateway, emit: () => undefined })
    const permission = store.listPermissions(run.id)[0]
    expect(permission).toMatchObject({ toolName: 'shell.run', status: 'pending' })

    await store.resolvePermission(permission.id, 'approve')
    await runHarness({ run: store.getRun(run.id)!, store, llmGateway: gateway, emit: () => undefined, resumePermissionID: permission.id })

    expect(store.getRun(run.id)?.status).toBe('completed')
    expect(gateway.requests).toHaveLength(2)
    expect(gateway.requests[1].messages).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          toolCalls: expect.arrayContaining([expect.objectContaining({ id: 'call-time' })]),
        }),
      ]),
    )
    expect(gateway.requests[1].messages.map((message) => message.content).join('\n')).toContain('Incomplete tool-call turn was summarized')
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

  it('emits browser and environment observation events with permission boundaries', async () => {
    const store = new InMemoryLocalHostStore()
    const run = store.createRun({ goal: 'Open a page, observe it, then inspect the environment.' })
    store.appendEvent(run.id, 'run.created', { goal: run.goal })
    const gateway = new ScriptedGateway([
      {
        requestId: 'req-browser-open',
        toolCalls: [{ id: 'call-browser-open', name: 'browser.open', arguments: { url: 'https://example.com/report' } }],
      },
      {
        requestId: 'req-browser-snapshot',
        toolCalls: [{ id: 'call-browser-snapshot', name: 'browser.snapshot', arguments: { maxTextCharacters: 128 } }],
      },
      {
        requestId: 'req-environment',
        toolCalls: [{ id: 'call-environment', name: 'environment.observe', arguments: {} }],
      },
      {
        requestId: 'req-final',
        content: 'Environment observed.',
      },
    ])
    const toolOptions = {
      resolveHostname: async () => ['93.184.216.34'],
      browser: {
        open: async () => ({
          url: 'https://example.com/report',
          title: 'Example Report',
          visibleText: 'Quarterly report content.',
          links: [{ text: 'Source', url: 'https://example.com/source' }],
          forms: [],
          buttons: ['Download'],
        }),
        snapshot: async () => ({
          url: 'https://example.com/report',
          title: 'Example Report',
          visibleText: 'Quarterly report content.',
          links: [{ text: 'Source', url: 'https://example.com/source' }],
          forms: [],
          buttons: ['Download'],
        }),
        close: async () => undefined,
      },
      environment: {
        observe: async () => ({
          platform: 'darwin',
          foregroundApp: 'Preview',
          windowTitle: 'Invoice.pdf',
          screenPermission: 'unknown',
        }),
      },
    }

    await runHarness({ run, store, llmGateway: gateway, emit: () => undefined, toolOptions })
    const browserPermission = store.listPermissions(run.id)[0]
    expect(browserPermission).toMatchObject({ toolName: 'browser.open', status: 'pending' })
    await store.resolvePermission(browserPermission.id, 'approve')
    await runHarness({ run: store.getRun(run.id)!, store, llmGateway: gateway, emit: () => undefined, resumePermissionID: browserPermission.id, toolOptions })

    const environmentPermission = store.listPermissions(run.id).at(-1)!
    expect(environmentPermission).toMatchObject({ toolName: 'environment.observe', status: 'pending' })
    await store.resolvePermission(environmentPermission.id, 'approve')
    await runHarness({ run: store.getRun(run.id)!, store, llmGateway: gateway, emit: () => undefined, resumePermissionID: environmentPermission.id, toolOptions })

    expect(store.listEvents(run.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: 'ui.action.requested',
          payload: expect.objectContaining({ tool: 'browser.open', request_id: browserPermission.id }),
        }),
        expect.objectContaining({
          eventType: 'browser.observed',
          payload: expect.objectContaining({ tool: 'browser.open', title: 'Example Report', url: 'https://example.com/report' }),
        }),
        expect.objectContaining({
          eventType: 'browser.observed',
          payload: expect.objectContaining({ tool: 'browser.snapshot', title: 'Example Report', url: 'https://example.com/report' }),
        }),
        expect.objectContaining({
          eventType: 'environment.observed',
          payload: expect.objectContaining({ platform: 'darwin', foreground_app: 'Preview', window_title: 'Invoice.pdf' }),
        }),
        expect.objectContaining({
          eventType: 'verification.completed',
          payload: expect.objectContaining({
            tool: 'browser.snapshot',
            checks: expect.arrayContaining([expect.objectContaining({ name: 'browser_snapshot_ok', passed: true })]),
          }),
        }),
      ]),
    )
    expect(store.getRun(run.id)?.status).toBe('completed')
  })

  it('runs a Playwright-style browser search, snapshot, and screenshot loop with artifact references', async () => {
    const store = new InMemoryLocalHostStore()
    const run = store.createRun({ goal: 'Search the web and capture evidence.' })
    store.appendEvent(run.id, 'run.created', { goal: run.goal })
    const gateway = new ScriptedGateway([
      {
        requestId: 'req-search',
        toolCalls: [{ id: 'call-search', name: 'browser.search', arguments: { query: 'Jiandanly harness' } }],
      },
      {
        requestId: 'req-snapshot',
        toolCalls: [{ id: 'call-snapshot', name: 'browser.snapshot', arguments: { maxTextCharacters: 200 } }],
      },
      {
        requestId: 'req-screenshot',
        toolCalls: [{ id: 'call-screenshot', name: 'browser.screenshot', arguments: {} }],
      },
      {
        requestId: 'req-final',
        content: 'Found a browser result and captured a screenshot artifact.',
      },
    ])
    const snapshot = {
      url: 'https://www.bing.com/search?q=Jiandanly%20harness',
      title: 'Jiandanly harness - Search',
      visibleText: 'Jiandanly Local Harness result',
      links: [{ text: 'Jiandanly', url: 'https://example.com/jiandanly' }],
      forms: [],
      buttons: [],
      elements: [{ ref: 'result-1', role: 'link', name: 'Jiandanly', text: 'Jiandanly', href: 'https://example.com/jiandanly' }],
    }
    const toolOptions = {
      resolveHostname: async () => ['204.79.197.200'],
      browser: {
        search: async () => snapshot,
        open: async () => snapshot,
        snapshot: async () => snapshot,
        screenshot: async () => ({ content: 'png-bytes', contentType: 'image/png', bytes: 9, title: 'Search screenshot' }),
        click: async () => snapshot,
        type: async () => snapshot,
        scroll: async () => snapshot,
        close: async () => undefined,
      },
    } as any

    await runHarness({ run, store, llmGateway: gateway, emit: () => undefined, toolOptions })
    const permission = store.listPermissions(run.id)[0]
    expect(permission).toMatchObject({ toolName: 'browser.search', status: 'pending' })

    await store.resolvePermission(permission.id, 'approve')
    await runHarness({ run: store.getRun(run.id)!, store, llmGateway: gateway, emit: () => undefined, resumePermissionID: permission.id, toolOptions })

    const artifact = store.listArtifacts(run.id)[0]
    expect(artifact).toMatchObject({
      kind: 'tool_output',
      toolName: 'browser.screenshot',
      title: 'Search screenshot',
      contentType: 'image/png',
      content: 'png-bytes',
    })
    expect(gateway.requests.at(-1)?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'tool', name: 'browser.screenshot', content: expect.stringContaining(artifact.id) }),
      ]),
    )
    expect(store.listEvents(run.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: 'browser.observed', payload: expect.objectContaining({ tool: 'browser.search', title: 'Jiandanly harness - Search' }) }),
        expect.objectContaining({ eventType: 'artifact.created', payload: expect.objectContaining({ artifact_id: artifact.id, tool: 'browser.screenshot' }) }),
        expect.objectContaining({
          eventType: 'verification.completed',
          payload: expect.objectContaining({
            tool: 'browser.search',
            status: 'passed',
            checks: expect.arrayContaining([expect.objectContaining({ name: 'browser_search_ok', passed: true })]),
          }),
        }),
        expect.objectContaining({
          eventType: 'verification.completed',
          payload: expect.objectContaining({
            tool: 'browser.screenshot',
            status: 'passed',
            checks: expect.arrayContaining([expect.objectContaining({ name: 'browser_screenshot_ok', passed: true })]),
          }),
        }),
      ]),
    )
    expect(store.getRun(run.id)?.status).toBe('completed')
  })

  it('collects source evidence from browser.read and stores long page text as an artifact', async () => {
    const store = new InMemoryLocalHostStore()
    const run = store.createRun({ goal: 'Open a source, read it, and answer with evidence.' })
    store.appendEvent(run.id, 'run.created', { goal: run.goal })
    const gateway = new ScriptedGateway([
      {
        requestId: 'req-open',
        toolCalls: [{ id: 'call-open-source', name: 'browser.open', arguments: { url: 'https://example.com/source' } }],
      },
      {
        requestId: 'req-read',
        toolCalls: [{ id: 'call-read-source', name: 'browser.read', arguments: { maxTextCharacters: 12000 } }],
      },
      {
        requestId: 'req-final',
        content: 'Answered with the collected source.',
      },
    ])
    const longText = `Example Source Report\n${'Evidence paragraph. '.repeat(120)}`
    const snapshot = {
      url: 'https://example.com/source',
      title: 'Example Source Report',
      description: 'Source description.',
      visibleText: longText,
      links: [{ text: 'Related source', url: 'https://example.com/related' }],
      forms: [],
      buttons: [],
      elements: [],
    }
    const toolOptions = {
      resolveHostname: async () => ['93.184.216.34'],
      browser: {
        search: async () => snapshot,
        open: async () => snapshot,
        snapshot: async () => snapshot,
        screenshot: async () => ({ content: 'png-bytes', contentType: 'image/png', bytes: 9, title: 'Source screenshot' }),
        click: async () => snapshot,
        type: async () => snapshot,
        scroll: async () => snapshot,
        close: async () => undefined,
      },
    } as any

    await runHarness({ run, store, llmGateway: gateway, emit: () => undefined, toolOptions, artifactThresholdChars: 512 })
    const permission = store.listPermissions(run.id)[0]
    expect(permission).toMatchObject({ toolName: 'browser.open', status: 'pending' })
    await store.resolvePermission(permission.id, 'approve')
    await runHarness({ run: store.getRun(run.id)!, store, llmGateway: gateway, emit: () => undefined, resumePermissionID: permission.id, toolOptions, artifactThresholdChars: 512 })

    const readArtifact = store.listArtifacts(run.id).find((artifact) => artifact.toolName === 'browser.read')
    expect(readArtifact).toMatchObject({
      kind: 'tool_output',
      title: 'browser.read output',
      toolCallId: 'call-read-source',
      content: expect.stringContaining('Evidence paragraph.'),
    })
    expect(gateway.requests.at(-1)?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'tool',
          name: 'browser.read',
          content: expect.stringContaining(readArtifact!.id),
        }),
      ]),
    )
    expect(gateway.requests.at(-1)?.messages.map((message) => message.content).join('\n')).not.toContain('Evidence paragraph. Evidence paragraph. Evidence paragraph.')
    expect(store.listEvents(run.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: 'source.collected',
          payload: expect.objectContaining({
            tool: 'browser.read',
            title: 'Example Source Report',
            url: 'https://example.com/source',
            artifact_id: readArtifact!.id,
            observation_status: 'usable',
          }),
        }),
        expect.objectContaining({
          eventType: 'verification.completed',
          payload: expect.objectContaining({
            tool: 'browser.read',
            status: 'passed',
            checks: expect.arrayContaining([expect.objectContaining({ name: 'browser_read_usable', passed: true, detail: 'usable' })]),
          }),
        }),
      ]),
    )
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

  it('uses a no-tool finalization round instead of failing when the step budget is exhausted', async () => {
    const store = new InMemoryLocalHostStore()
    const run = store.createRun({ goal: 'Search several sources and answer from what you have.' })
    store.appendEvent(run.id, 'run.created', { goal: run.goal })
    const gateway = new ScriptedGateway([
      {
        requestId: 'req-1',
        toolCalls: [{ id: 'call-time-1', name: 'time.now', arguments: {} }],
      },
      {
        requestId: 'req-2',
        toolCalls: [{ id: 'call-time-2', name: 'time.now', arguments: {} }],
      },
      {
        requestId: 'req-final',
        content: 'I reached the tool budget and can still answer from the gathered observations.',
      },
    ])

    await runHarness({ run, store, llmGateway: gateway, emit: () => undefined, maxSteps: 2 })

    expect(gateway.requests).toHaveLength(3)
    expect(gateway.requests[2].tools).toEqual([])
    expect(gateway.requests[2].messages.at(-1)?.content).toContain('tool step budget is exhausted')
    expect(store.getRun(run.id)?.status).toBe('completed')
    expect(store.listEvents(run.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: 'run.budget_warning', payload: expect.objectContaining({ max_steps: 2, last_tool: 'time.now' }) }),
        expect.objectContaining({
          eventType: 'run.completed',
          payload: expect.objectContaining({
            final: 'I reached the tool budget and can still answer from the gathered observations.',
            reason: 'max_steps_finalized',
          }),
        }),
      ]),
    )
    expect(store.listEvents(run.id).some((event) => event.eventType === 'run.failed')).toBe(false)
  })

  it('does not impose a default hard step limit on long-running local harness runs', async () => {
    const store = new InMemoryLocalHostStore()
    const run = store.createRun({ goal: 'Keep gathering evidence until the model has enough.' })
    store.appendEvent(run.id, 'run.created', { goal: run.goal })
    const toolResponses = Array.from({ length: 13 }, (_, index) => ({
      requestId: `req-tool-${index + 1}`,
      toolCalls: [{ id: `call-time-${index + 1}`, name: 'time.now', arguments: {} }],
    }))
    const gateway = new ScriptedGateway([
      ...toolResponses,
      {
        requestId: 'req-final',
        content: 'Completed after more than the old default step limit.',
      },
    ])

    await runHarness({ run, store, llmGateway: gateway, emit: () => undefined })

    expect(gateway.requests).toHaveLength(14)
    expect(gateway.requests[13].tools.length).toBeGreaterThan(0)
    expect(store.getRun(run.id)?.status).toBe('completed')
    expect(store.listEvents(run.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: 'run.completed', payload: expect.objectContaining({ final: 'Completed after more than the old default step limit.' }) }),
      ]),
    )
    expect(store.listEvents(run.id).some((event) => event.eventType === 'run.failed')).toBe(false)
  })

  it('emits soft long-running warnings without forcing finalization', async () => {
    const store = new InMemoryLocalHostStore()
    const run = store.createRun({ goal: 'Continue after soft warnings.' })
    store.appendEvent(run.id, 'run.created', { goal: run.goal })
    const gateway = new ScriptedGateway([
      { requestId: 'req-1', toolCalls: [{ id: 'call-time-1', name: 'time.now', arguments: {} }] },
      { requestId: 'req-2', toolCalls: [{ id: 'call-time-2', name: 'time.now', arguments: {} }] },
      { requestId: 'req-3', content: 'Final answer after a soft warning.' },
    ])

    await runHarness({ run, store, llmGateway: gateway, emit: () => undefined, stepWarningInterval: 2 })

    expect(gateway.requests).toHaveLength(3)
    expect(gateway.requests[2].tools.length).toBeGreaterThan(0)
    expect(gateway.requests[2].messages.at(-1)?.content).toContain('This run has used 2 tool-use turns')
    expect(store.getRun(run.id)?.status).toBe('completed')
    expect(store.listEvents(run.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: 'run.budget_warning', payload: expect.objectContaining({ reason: 'long_running', step: 2 }) }),
      ]),
    )
  })

  it('stops the loop when a running task is canceled between turns', async () => {
    const store = new InMemoryLocalHostStore()
    const run = store.createRun({ goal: 'Stop when canceled.' })
    store.appendEvent(run.id, 'run.created', { goal: run.goal })
    const gateway = new CancelOnFirstCallGateway(store, run.id)

    await runHarness({ run, store, llmGateway: gateway, emit: () => undefined })

    expect(gateway.requests).toHaveLength(1)
    expect(store.getRun(run.id)?.status).toBe('canceled')
    expect(store.listEvents(run.id).some((event) => event.eventType === 'tool.requested')).toBe(false)
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
    const gateway = new PairingValidatingGateway([{ requestId: 'req-resume', content: 'Resumed from checkpoint.' }])

    await runHarness({ run: store.getRun(run.id)!, store, llmGateway: gateway, emit: () => undefined })

    expect(gateway.requests[0].messages).not.toEqual(expect.arrayContaining([expect.objectContaining({ role: 'tool' })]))
    expect(gateway.requests[0].messages.map((message) => message.content).join('\n')).toContain('Orphan tool observation was summarized')
    expect(gateway.requests[0].messages.map((message) => message.content).join('\n')).toContain('2026-05-11T00:00:00.000Z')
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

  it('writes sanitized debug logs for failed tool observations when local debug is enabled', async () => {
    process.env.JIANDANLY_LOCAL_HOST_DEBUG = '1'
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const store = new InMemoryLocalHostStore()
    const run = store.createRun({ goal: 'Search without Tavily config.' })
    store.appendEvent(run.id, 'run.created', { goal: run.goal })
    const gateway = new ScriptedGateway([
      {
        requestId: 'req-search',
        toolCalls: [{ id: 'call-search', name: 'web.search', arguments: { query: 'private search token' } }],
      },
      {
        requestId: 'req-final',
        content: 'Search is unavailable.',
      },
    ])

    await runHarness({ run, store, llmGateway: gateway, emit: () => undefined })

    const serialized = warn.mock.calls.map((call) => call.map(String).join(' ')).join('\n')
    expect(serialized).toContain('[jiandanly:local-host]')
    expect(serialized).toContain('tool.failed')
    expect(serialized).toContain('web.search')
    expect(serialized).toContain('web_search_disabled')
    expect(serialized).not.toContain('private search token')
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

class PairingValidatingGateway extends ScriptedGateway {
  override async call(request: LLMGatewayRequest): Promise<LLMGatewayResponse> {
    assertToolCallPairing(request.messages)
    return super.call(request)
  }
}

class FailingGateway implements LLMGateway {
  constructor(private readonly message: string) {}

  async call(): Promise<LLMGatewayResponse> {
    throw new Error(this.message)
  }
}

class CancelOnFirstCallGateway implements LLMGateway {
  readonly requests: LLMGatewayRequest[] = []

  constructor(private readonly store: InMemoryLocalHostStore, private readonly runID: string) {}

  async call(request: LLMGatewayRequest): Promise<LLMGatewayResponse> {
    this.requests.push(request)
    this.store.updateRunStatus(this.runID, 'canceled', { canceledAt: new Date().toISOString() })
    this.store.appendEvent(this.runID, 'run.canceled', { reason: 'test_cancel' })
    return {
      requestId: 'req-canceled',
      toolCalls: [{ id: 'call-time-after-cancel', name: 'time.now', arguments: {} }],
    }
  }
}

function assertToolCallPairing(messages: LLMGatewayRequest['messages']): void {
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    const required = new Set((message.toolCalls ?? []).map((call) => call.id))
    if (required.size === 0) {
      if (message.role === 'tool') {
        throw new Error(`Orphan tool message ${message.toolCallId ?? 'unknown'}`)
      }
      continue
    }
    let cursor = index + 1
    while (cursor < messages.length && messages[cursor].role === 'tool') {
      const toolCallID = messages[cursor].toolCallId
      if (toolCallID) {
        required.delete(toolCallID)
      }
      cursor += 1
    }
    if (required.size > 0) {
      throw new Error(`Missing tool messages for ${[...required].join(', ')}`)
    }
    index = cursor - 1
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
