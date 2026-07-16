import { describe, expect, it, vi } from 'vitest'

import {
  createLocalRun,
  deliverPendingRuntimeCommands,
  discoverLocalModels,
  getLocalArtifactContent,
  parseAgentSSEBuffer,
  parseRuntimeModelSpec,
  RuntimeHTTPError,
  SheJaneRuntimeClient,
  streamLocalRun,
  updateRuntimeSettings,
} from './index'

describe('getLocalArtifactContent', () => {
  it('downloads the authenticated artifact body without JSON decoding', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([0, 1, 2, 255]), {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      }),
    )

    const body = await getLocalArtifactContent(
      'artifact/blob id',
      { baseURL: 'http://127.0.0.1:17371/', token: 'runtime-token' },
      fetcher,
    )

    expect(new Uint8Array(await body.arrayBuffer())).toEqual(new Uint8Array([0, 1, 2, 255]))
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:17371/local/v1/artifacts/artifact%2Fblob%20id/content',
      {
        method: 'GET',
        headers: { Authorization: 'Bearer runtime-token' },
      },
    )
  })
})

describe('createLocalRun plugin selection', () => {
  it('serializes explicit references and one plugin command', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'run_plugin' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    await createLocalRun(
      {
        commandId: 'cmd_plugin_run',
        clientMessageId: 'msg_plugin_run',
        goal: 'use plugin',
        mode: 'local:test:model',
        pluginRefs: [
          {
            pluginId: 'dev.shejane.fixture.archive',
            expectedDigest: `sha256:${'a'.repeat(64)}`,
          },
        ],
        pluginCommand: {
          pluginId: 'dev.shejane.fixture.archive',
          commandId: 'archive.extract',
        },
      },
      { baseURL: 'http://127.0.0.1:17371', token: 'runtime-token' },
      fetcher,
    )

    const request = fetcher.mock.calls[0][1] as RequestInit
    const body = JSON.parse(String(request.body))
    expect(body.goal).toBe('use plugin')
    expect(body.user_input).toBeUndefined()
    expect(body.required_capabilities).toContain('plugins')
    expect(body.plugin_refs).toEqual([
      {
        plugin_id: 'dev.shejane.fixture.archive',
        required: true,
        expected_digest: `sha256:${'a'.repeat(64)}`,
      },
    ])
    expect(body.plugin_command).toEqual({
      plugin_id: 'dev.shejane.fixture.archive',
      command_id: 'archive.extract',
    })
  })
})

describe('plugin command outbox delivery', () => {
  it('replays plugin commands in order through the shared Runtime command endpoint', async () => {
    const pluginId = 'dev.shejane.fixture.archive'
    const digest = `sha256:${'a'.repeat(64)}`
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            type: 'plugin.install',
            command_id: 'cmd-install',
            plugin_id: pluginId,
            version: '0.1.0',
            digest,
            installed: true,
            enabled: false,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            type: 'plugin.enable',
            command_id: 'cmd-enable',
            plugin_id: pluginId,
            digest,
            enabled: true,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            type: 'plugin.model.bind',
            command_id: 'cmd-bind',
            plugin_id: pluginId,
            digest,
            model_binding_revision: 1,
            model_binding: {
              id: 'vision-default',
              requested_model: 'local:vision:vision-a',
              provider_id: 'vision',
              provider_version: 1,
              model_id: 'vision-a',
            },
          }),
          { status: 200 },
        ),
      )
    const settle = vi.fn().mockResolvedValue(undefined)
    const report = await deliverPendingRuntimeCommands(
      [
        {
          type: 'plugin.install',
          commandId: 'cmd-install',
          createdAt: '2026-07-16T00:00:00Z',
          input: { sourcePath: '/tmp/archive.shejane-plugin', allowUnsigned: true },
        },
        {
          type: 'plugin.enable',
          commandId: 'cmd-enable',
          createdAt: '2026-07-16T00:00:01Z',
          input: { pluginId, expectedDigest: digest },
        },
        {
          type: 'plugin.model.bind',
          commandId: 'cmd-bind',
          createdAt: '2026-07-16T00:00:02Z',
          input: {
            pluginId,
            bindingId: 'vision-default',
            model: 'local:vision:vision-a',
            expectedDigest: digest,
          },
        },
      ],
      { baseURL: 'http://127.0.0.1:17371', token: 'runtime-token' },
      settle,
      fetcher,
    )

    expect(report).toEqual({ delivered: 3, failures: [] })
    expect(settle).toHaveBeenCalledTimes(3)
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toMatchObject({
      type: 'plugin.install',
      command_id: 'cmd-install',
    })
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toMatchObject({
      type: 'plugin.enable',
      command_id: 'cmd-enable',
      plugin_id: pluginId,
    })
    expect(JSON.parse(String(fetcher.mock.calls[2][1]?.body))).toEqual({
      type: 'plugin.model.bind',
      command_id: 'cmd-bind',
      plugin_id: pluginId,
      binding_id: 'vision-default',
      model: 'local:vision:vision-a',
      expected_digest: digest,
    })
  })
})

describe('parseRuntimeModelSpec', () => {
  it('accepts only concrete Runtime model identifiers', () => {
    expect(parseRuntimeModelSpec(' local:openai:gpt-4.1 ')).toBe('local:openai:gpt-4.1')
    expect(parseRuntimeModelSpec('auto')).toBeUndefined()
    expect(parseRuntimeModelSpec('local::gpt-4.1')).toBeUndefined()
    expect(parseRuntimeModelSpec('local:open ai:gpt-4.1')).toBeUndefined()
    expect(parseRuntimeModelSpec('local:openai:gpt 4.1')).toBeUndefined()
  })
})

describe('SheJaneRuntimeClient', () => {
  it('normalizes the Runtime URL and applies caller-provided authentication', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ protocol_version: 1, capabilities: ['agent.run'] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const client = new SheJaneRuntimeClient({
      baseURL: 'http://127.0.0.1:17371/',
      token: 'runtime-token',
      fetcher,
    })

    await client.getRuntimeInfo()

    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:17371/local/v1/runtime',
      expect.objectContaining({ headers: { Authorization: 'Bearer runtime-token' } }),
    )
  })

  it('discovers provider models without exposing Runtime credentials', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        models: [{ model_id: 'openai/gpt-4.1', display_name: 'GPT-4.1' }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    const models = await discoverLocalModels(
      { provider_id: 'openrouter', base_url: 'https://openrouter.ai/api/v1' },
      { baseURL: 'http://127.0.0.1:17371', token: 'runtime-token' },
      fetcher,
    )

    expect(models).toEqual([{ model_id: 'openai/gpt-4.1', display_name: 'GPT-4.1' }])
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:17371/local/v1/model-providers/discover-models',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          provider_id: 'openrouter',
          base_url: 'https://openrouter.ai/api/v1',
        }),
      }),
    )
  })

  it('lists plugins and installs one through the Runtime command endpoint', async () => {
    const plugin = {
      id: 'dev.shejane.fixture.archive',
      name: 'Archive fixture',
      version: '0.1.0',
      digest: `sha256:${'a'.repeat(64)}`,
      publisher: { id: 'dev.shejane', name: 'SheJane' },
      execution_kind: 'wasi',
      signature_status: 'unsigned',
      compatibility: 'compatible',
      enabled: false,
      retired: false,
    }
    const receipt = {
      type: 'plugin.install',
      command_id: 'cmd-1',
      plugin_id: plugin.id,
      version: plugin.version,
      digest: plugin.digest,
      installed: true,
      enabled: false,
    }
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ plugins: [plugin] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(receipt), { status: 200 }))
    const client = new SheJaneRuntimeClient({
      baseURL: 'http://127.0.0.1:17371',
      token: 'runtime-token',
      fetcher,
    })

    await expect(client.listPlugins()).resolves.toEqual([plugin])
    await expect(client.installPlugin('cmd-1', '/tmp/archive.shejane-plugin', {
      allowUnsigned: true,
    })).resolves.toEqual(receipt)
    expect(fetcher).toHaveBeenNthCalledWith(2, 'http://127.0.0.1:17371/local/v1/commands', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer runtime-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'plugin.install',
        command_id: 'cmd-1',
        source_path: '/tmp/archive.shejane-plugin',
        allow_unsigned: true,
      }),
    })
  })

  it('lists and refreshes a signed plugin source', async () => {
    const source = {
      source_id: 'dev.shejane.source',
      name: 'SheJane source',
      index_url: 'https://example.test/index.json',
      key_id: `ed25519:sha256:${'a'.repeat(64)}`,
      index_sha256: 'b'.repeat(64),
      package_count: 1,
      revision: 1,
      updated_at: '2026-07-16T00:00:00+00:00',
    }
    const receipt = {
      type: 'plugin.source.refresh',
      command_id: 'cmd-source-refresh',
      source_id: source.source_id,
      revision: 1,
      index_sha256: source.index_sha256,
      package_count: 1,
      changed: false,
    }
    const installReceipt = {
      type: 'plugin.source.install',
      command_id: 'cmd-source-install',
      source_id: source.source_id,
      source_revision: 1,
      plugin_id: 'dev.shejane.archive',
      version: '1.0.0',
      digest: `sha256:${'c'.repeat(64)}`,
      installed: true,
      enabled: false,
    }
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ sources: [source] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(receipt), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(installReceipt), { status: 200 }))
    const client = new SheJaneRuntimeClient({
      baseURL: 'http://127.0.0.1:17371',
      token: 'runtime-token',
      fetcher,
    })

    await expect(client.listPluginSources()).resolves.toEqual([source])
    await expect(client.refreshPluginSource(
      'cmd-source-refresh',
      source.source_id,
      source.revision,
    )).resolves.toEqual(receipt)
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({
      type: 'plugin.source.refresh',
      command_id: 'cmd-source-refresh',
      source_id: source.source_id,
      expected_revision: 1,
    })
    await expect(client.installPluginFromSource('cmd-source-install', {
      sourceId: source.source_id,
      expectedRevision: 1,
      pluginId: 'dev.shejane.archive',
      version: '1.0.0',
      executionKind: 'wasi',
      platform: 'any',
      packageDigest: installReceipt.digest,
      expectedActiveDigest: `sha256:${'e'.repeat(64)}`,
    })).resolves.toEqual(installReceipt)
    expect(JSON.parse(String(fetcher.mock.calls[2][1]?.body))).toEqual({
      type: 'plugin.source.install',
      command_id: 'cmd-source-install',
      source_id: source.source_id,
      expected_revision: 1,
      plugin_id: 'dev.shejane.archive',
      version: '1.0.0',
      execution_kind: 'wasi',
      platform: 'any',
      package_digest: installReceipt.digest,
      expected_active_digest: `sha256:${'e'.repeat(64)}`,
    })
  })

  it('installs an exact shared runtime asset through the command endpoint', async () => {
    const digest = `sha256:${'b'.repeat(64)}`
    const receipt = {
      type: 'plugin.runtime_asset.install',
      command_id: 'cmd-asset-1',
      asset_id: 'org.libreoffice.runtime',
      version: '25.8.7',
      platform: 'darwin/arm64',
      digest,
      installed: true,
    }
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(receipt), { status: 200 }))
    const client = new SheJaneRuntimeClient({
      baseURL: 'http://127.0.0.1:17371',
      token: 'runtime-token',
      fetcher,
    })

    await expect(client.installRuntimeAsset(
      'cmd-asset-1',
      '/tmp/libreoffice.shejane-runtime-asset',
      digest,
    )).resolves.toEqual(receipt)
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
      type: 'plugin.runtime_asset.install',
      command_id: 'cmd-asset-1',
      source_path: '/tmp/libreoffice.shejane-runtime-asset',
      expected_digest: digest,
    })
  })

  it('parses durable events and the terminal sentinel across one buffer', () => {
    const parsed = parseAgentSSEBuffer(
      'data: {"event_type":"run.completed","run_id":"run-1","seq":4}\n\ndata: [DONE]\n\n',
    )

    expect(parsed.rest).toBe('')
    expect(parsed.events).toEqual([
      {
        type: 'agent',
        event: { event_type: 'run.completed', run_id: 'run-1', seq: 4 },
      },
      { type: 'done' },
    ])
  })

  it('rejects JSON events that do not satisfy the Runtime envelope', () => {
    expect(() => parseAgentSSEBuffer('data: {"payload":{"content":"lost"}}\n\n'))
      .toThrow(/event_type/)
  })
})

describe('streamLocalRun', () => {
  it('preserves Runtime status and error code when the SSE handshake fails', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      detail: { code: 'run_not_found', message: 'run does not exist' },
    }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    }))

    await expect(streamLocalRun(
      'run-missing',
      { baseURL: 'http://127.0.0.1:17371', token: 'runtime-token' },
      { onEvent: () => undefined, onDelta: () => undefined },
      fetcher,
    )).rejects.toMatchObject({
      name: RuntimeHTTPError.name,
      status: 404,
      code: 'run_not_found',
      message: 'run does not exist',
    })
  })
})

describe('Runtime validation errors', () => {
  it('preserves sanitized FastAPI field errors without exposing rejected input', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      detail: [{ loc: ['body', 'memory'], msg: 'Input should be on or off', type: 'literal_error' }],
    }), {
      status: 422,
      headers: { 'Content-Type': 'application/json' },
    }))

    await expect(updateRuntimeSettings(
      { memory: 'off' },
      { baseURL: 'http://127.0.0.1:17371', token: 'runtime-token' },
      fetcher,
    )).rejects.toMatchObject({
      name: RuntimeHTTPError.name,
      status: 422,
      message: 'body.memory: Input should be on or off',
    })
  })
})
