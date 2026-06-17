import { describe, expect, it, vi } from 'vitest'
import {
  createLocalRun,
  authorizeLocalWorkspace,
  diagnoseLocalWorkspace,
  getLocalRunDiagnostics,
  getDesktopLocalHostConfig,
  getLocalArtifact,
  listAuthorizedWorkspaces,
  listInstalledSkills,
  createMcpServer,
  deleteMcpServer,
  createLocalSkill,
  getLocalSkillFile,
  updateLocalSkill,
  deleteLocalSkill,
  connectLocalLark,
  clearLocalLarkCache,
  discoverLocalLarkSources,
  disconnectLocalLark,
  getLocalLarkStatus,
  cancelLocalSchedule,
  createLocalSchedule,
  listLocalLarkSources,
  listLocalRuns,
  listLocalSchedules,
  listLocalTodos,
  markLocalScheduleNotified,
  probeLocalHost,
  previewLocalLark,
  quoteLocalTodoItem,
  revokeLocalWorkspace,
  resolveLocalPermission,
  setLocalCloudSession,
  clearLocalCloudSession,
  forkLocalRun,
  streamLocalRun,
  syncLocalLark,
  injectLocalRunInstruction,
  resolveLocalPlanApproval,
  updateLocalLarkSource,
  updateLocalLarkConnection,
  updateLocalTodoItem,
} from './client'

describe('desktop local host client', () => {
  it('only returns local host config when the desktop bridge exposes one', () => {
    expect(getDesktopLocalHostConfig(undefined)).toBeUndefined()
    expect(getDesktopLocalHostConfig({ platform: 'darwin' })).toBeUndefined()
    expect(
      getDesktopLocalHostConfig({
        platform: 'darwin',
        localHost: { baseURL: 'http://127.0.0.1:17371', token: 'local-token' },
      }),
    ).toEqual({ baseURL: 'http://127.0.0.1:17371', token: 'local-token' })
  })

  it('probes public health without a pairing token', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'ok',
          mode: 'daemon',
          worker: 'user',
        }),
        { status: 200 },
      ),
    )

    await expect(probeLocalHost('http://127.0.0.1:17371', fetcher)).resolves.toEqual({
      online: true,
      status: 'ok',
      mode: 'daemon',
      worker: 'user',
    })
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:17371/local/v1/health', {
      signal: expect.any(AbortSignal),
    })
  })

  it('treats failed health checks as offline', async () => {
    await expect(probeLocalHost('http://127.0.0.1:17371', vi.fn().mockRejectedValue(new Error('offline')))).resolves.toEqual({
      online: false,
    })
  })

  it('creates local runs with pairing token authorization', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'run-local',
          goal: 'Inspect workspace',
          status: 'queued',
          created_at: '2026-05-11T00:00:00Z',
          updated_at: '2026-05-11T00:00:00Z',
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      ),
    )

    await expect(
      createLocalRun(
        { goal: 'Inspect workspace', workspacePath: '/tmp/project' },
        { baseURL: 'http://127.0.0.1:17371', token: 'local-token' },
        fetcher,
      ),
    ).resolves.toMatchObject({ id: 'run-local', status: 'queued' })
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:17371/local/v1/runs',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer local-token' }),
        body: JSON.stringify({ goal: 'Inspect workspace', workspace_path: '/tmp/project', history: [] }),
      }),
    )
  })

  it('carries per-run agent settings in the run-create payload', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'run-settings',
          goal: 'Remember things',
          status: 'queued',
          created_at: '2026-05-16T00:00:00Z',
          updated_at: '2026-05-16T00:00:00Z',
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      ),
    )

    await createLocalRun(
      { goal: 'Remember things', settings: { memory: 'on' } },
      { baseURL: 'http://127.0.0.1:17371', token: 'local-token' },
      fetcher,
    )

    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:17371/local/v1/runs',
      expect.objectContaining({
        body: JSON.stringify({ goal: 'Remember things', history: [], settings: { memory: 'on' } }),
      }),
    )
  })

  it('carries the skills agent setting in the run-create payload', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'run-skills',
          goal: 'Use a skill',
          status: 'queued',
          created_at: '2026-05-16T00:00:00Z',
          updated_at: '2026-05-16T00:00:00Z',
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      ),
    )

    await createLocalRun(
      { goal: 'Use a skill', settings: { memory: 'off', skills: 'on' } },
      { baseURL: 'http://127.0.0.1:17371', token: 'local-token' },
      fetcher,
    )

    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:17371/local/v1/runs',
      expect.objectContaining({
        body: JSON.stringify({ goal: 'Use a skill', history: [], settings: { memory: 'off', skills: 'on' } }),
      }),
    )
  })

  it('carries run metadata in the run-create payload', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'run-repair',
          goal: 'Fix the failed task',
          status: 'queued',
          created_at: '2026-05-16T00:00:00Z',
          updated_at: '2026-05-16T00:00:00Z',
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      ),
    )

    await createLocalRun(
      {
        goal: 'Fix the failed task',
        metadata: {
          intent: 'repair',
          source_run_id: 'run-original',
          source_message_id: 'msg-original',
          attempt: 1,
        },
      },
      { baseURL: 'http://127.0.0.1:17371', token: 'local-token' },
      fetcher,
    )

    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:17371/local/v1/runs',
      expect.objectContaining({
        body: JSON.stringify({
          goal: 'Fix the failed task',
          history: [],
          metadata: {
            intent: 'repair',
            source_run_id: 'run-original',
            source_message_id: 'msg-original',
            attempt: 1,
          },
        }),
      }),
    )
  })

  it('maps advanced agent settings to snake_case wire keys', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'run-adv',
          goal: 'g',
          status: 'queued',
          created_at: '2026-05-16T00:00:00Z',
          updated_at: '2026-05-16T00:00:00Z',
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      ),
    )

    await createLocalRun(
      {
        goal: 'g',
        settings: {
          advanced: {
            maxModelCalls: 50,
            maxHistoryTurns: 12,
            maxModelRetries: 1,
            maxToolRetries: 4,
            researchSearchLimit: 8,
            subagents: false,
            browserHeadless: false,
            toolCritic: 'block',
            planFirst: 'auto',
            piiRedact: 'email,credit_card',
            // unset knobs must NOT appear on the wire (daemon keeps its default)
          },
        },
      },
      { baseURL: 'http://127.0.0.1:17371', token: 'local-token' },
      fetcher,
    )

    const sent = JSON.parse(String((fetcher.mock.calls[0]?.[1] as { body?: string })?.body ?? '{}'))
    expect(sent.settings).toEqual({
      max_model_calls: 50,
      max_history_turns: 12,
      max_model_retries: 1,
      max_tool_retries: 4,
      research_search_limit: 8,
      subagents: false,
      browser_headless: false,
      tool_critic: 'block',
      plan_first: 'auto',
      pii_redact: 'email,credit_card',
    })
  })

  it('omits settings entirely when only an empty advanced object is given', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'run-empty',
          goal: 'g',
          status: 'queued',
          created_at: '2026-05-16T00:00:00Z',
          updated_at: '2026-05-16T00:00:00Z',
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      ),
    )

    await createLocalRun(
      { goal: 'g', settings: { advanced: {} } },
      { baseURL: 'http://127.0.0.1:17371', token: 'local-token' },
      fetcher,
    )

    const sent = JSON.parse(String((fetcher.mock.calls[0]?.[1] as { body?: string })?.body ?? '{}'))
    expect('settings' in sent).toBe(false)
  })

  it('forks a local run from a checkpoint through the protected run API', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'run-fork',
          goal: 'Retry from checkpoint',
          status: 'queued',
          parent_run_id: 'run-source',
          created_at: '2026-06-13T00:00:00Z',
          updated_at: '2026-06-13T00:00:00Z',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )

    await expect(
      forkLocalRun(
        'run-source',
        { checkpointId: 'ckpt-1', goal: 'Retry from checkpoint', mode: 'auto' },
        { baseURL: 'http://127.0.0.1:17371', token: 'local-token' },
        fetcher,
      ),
    ).resolves.toMatchObject({ id: 'run-fork', parent_run_id: 'run-source' })

    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:17371/local/v1/runs/run-source/fork',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer local-token' }),
        body: JSON.stringify({
          checkpoint_id: 'ckpt-1',
          goal: 'Retry from checkpoint',
          model: 'auto',
        }),
      }),
    )
  })

  it('lists installed skills and roots from the local host', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          skills: [{ name: 'hunt', description: 'Diagnose', path: '/p/SKILL.md' }],
          roots: [{ source: 'shejane', path: '/u/.shejane/skills' }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    const catalog = await listInstalledSkills(
      { baseURL: 'http://127.0.0.1:17371', token: 'local-token' },
      fetcher,
    )
    expect(catalog.skills).toEqual([
      { name: 'hunt', description: 'Diagnose', path: '/p/SKILL.md' },
    ])
    expect(catalog.roots).toEqual([{ source: 'shejane', path: '/u/.shejane/skills' }])
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:17371/local/v1/skills',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('creates and deletes a SheJane-managed MCP server', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            server: {
              name: 'context7',
              transport: 'stdio',
              source: 'shejane',
              source_path: '/u/.shejane/mcp-servers.json',
              command: 'npx',
              args: ['-y', '@upstash/context7-mcp'],
              env_keys: [],
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ deleted: true, name: 'context7' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )

    await createMcpServer(
      {
        name: 'context7',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@upstash/context7-mcp'],
        env: {},
      },
      { baseURL: 'http://127.0.0.1:17371', token: 'local-token' },
      fetcher,
    )
    await deleteMcpServer(
      'context7',
      { baseURL: 'http://127.0.0.1:17371', token: 'local-token' },
      fetcher,
    )

    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:17371/local/v1/mcp-servers',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer local-token' }),
        body: JSON.stringify({
          name: 'context7',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@upstash/context7-mcp'],
          env: {},
        }),
      }),
    )
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:17371/local/v1/mcp-servers/context7',
      expect.objectContaining({
        method: 'DELETE',
        headers: expect.objectContaining({ Authorization: 'Bearer local-token' }),
      }),
    )
  })

  it('creates, loads, updates, and deletes a local skill file', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ skill: { name: 'daily', content: '# Daily' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ name: 'daily', content: '# Daily' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ skill: { name: 'daily', content: '# Updated' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ deleted: true, name: 'daily' }), { status: 200 }))

    const config = { baseURL: 'http://127.0.0.1:17371', token: 'local-token' }
    await createLocalSkill({ name: 'daily', description: 'Digest', content: '# Daily' }, config, fetcher)
    await getLocalSkillFile('daily', config, fetcher)
    await updateLocalSkill('daily', { description: '', content: '# Updated' }, config, fetcher)
    await deleteLocalSkill('daily', config, fetcher)

    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:17371/local/v1/skills',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: 'daily', description: 'Digest', content: '# Daily' }) }),
    )
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:17371/local/v1/skills/daily',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(fetcher).toHaveBeenNthCalledWith(
      3,
      'http://127.0.0.1:17371/local/v1/skills/daily',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ description: '', content: '# Updated' }) }),
    )
    expect(fetcher).toHaveBeenNthCalledWith(
      4,
      'http://127.0.0.1:17371/local/v1/skills/daily',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('sets and clears the Local Host cloud session through protected APIs', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            connected: true,
            cloud_base_url: 'http://localhost:8080',
            auth: 'bearer',
            updated_at: '2026-05-11T00:00:00Z',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ connected: false }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    await expect(
      setLocalCloudSession(
        {
          cloudBaseURL: 'http://localhost:8080',
          accessToken: 'cloud-user-token',
        },
        { baseURL: 'http://127.0.0.1:17371', token: 'local-token' },
        fetcher,
      ),
    ).resolves.toMatchObject({ connected: true, cloud_base_url: 'http://localhost:8080' })
    await expect(clearLocalCloudSession({ baseURL: 'http://127.0.0.1:17371', token: 'local-token' }, fetcher)).resolves.toEqual({
      connected: false,
    })
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:17371/local/v1/session',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer local-token' }),
        body: JSON.stringify({ cloud_base_url: 'http://localhost:8080', access_token: 'cloud-user-token' }),
      }),
    )
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:17371/local/v1/session',
      expect.objectContaining({ method: 'DELETE', headers: expect.objectContaining({ Authorization: 'Bearer local-token' }) }),
    )
  })

  it('reads and updates local Lark connector todo APIs', async () => {
    const statusPayload = {
      connection: {
        id: 'lark_conn_1',
        provider: 'lark',
        status: 'disconnected',
        tenant_label: '',
        account_label: '',
        auth_mode: 'lark_cli',
        cloud_extraction_enabled: false,
        last_checked_at: null,
        last_error_code: '',
        created_at: '2026-06-15T00:00:00Z',
        updated_at: '2026-06-15T00:00:00Z',
      },
      connector: {
        available: false,
        source: 'missing',
        executable_path: null,
      },
    }
    const sourcePayload = {
      id: 'lark_src_1',
      connection_id: 'lark_conn_1',
      provider_source_id_hash: 'hash_1',
      source_type: 'group',
      display_label: 'Project Alpha',
      sync_enabled: true,
      last_synced_at: null,
      last_message_time: null,
      created_at: '2026-06-15T00:00:00Z',
      updated_at: '2026-06-15T00:00:00Z',
    }
    const todoPayload = {
      id: 'todo_1',
      provider: 'lark',
      source_id: 'lark_src_1',
      source_message_ids: ['msg_1'],
      priority: 'today',
      status: 'open',
      title: '确认项目排期',
      summary: '',
      suggested_action: 'reply',
      due_at: null,
      confidence: 0.82,
      extraction_provider: 'rules',
      evidence_preview: '请今天确认一下排期',
      created_at: '2026-06-15T00:00:00Z',
      updated_at: '2026-06-15T00:00:00Z',
    }
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(statusPayload), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sources: [sourcePayload] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...sourcePayload, sync_enabled: false }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ todos: [todoPayload] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...todoPayload, status: 'completed' }), { status: 200 }))

    const config = { baseURL: 'http://127.0.0.1:17371', token: 'local-token' }

    await expect(getLocalLarkStatus(config, fetcher)).resolves.toMatchObject({ connection: { id: 'lark_conn_1' } })
    await expect(listLocalLarkSources(config, fetcher)).resolves.toHaveLength(1)
    await expect(updateLocalLarkSource('lark_src_1', { sync_enabled: false }, config, fetcher)).resolves.toMatchObject({
      sync_enabled: false,
    })
    await expect(listLocalTodos(config, fetcher)).resolves.toHaveLength(1)
    await expect(updateLocalTodoItem('todo_1', { status: 'completed' }, config, fetcher)).resolves.toMatchObject({
      status: 'completed',
    })

    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:17371/local/v1/lark/status',
      expect.objectContaining({ method: 'GET', headers: expect.objectContaining({ Authorization: 'Bearer local-token' }) }),
    )
    expect(fetcher).toHaveBeenNthCalledWith(
      3,
      'http://127.0.0.1:17371/local/v1/lark/sources/lark_src_1',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ sync_enabled: false }) }),
    )
    expect(fetcher).toHaveBeenNthCalledWith(
      4,
      'http://127.0.0.1:17371/local/v1/todos?provider=lark',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(fetcher).toHaveBeenNthCalledWith(
      5,
      'http://127.0.0.1:17371/local/v1/todos/todo_1',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ status: 'completed' }) }),
    )
  })

  it('discovers local Lark sources without triggering a message sync', async () => {
    const sourcePayload = {
      id: 'lark_src_1',
      connection_id: 'lark_conn_1',
      provider_source_id_hash: 'hash_1',
      source_type: 'group',
      display_label: '项目群',
      sync_enabled: false,
      last_synced_at: null,
      last_message_time: null,
      created_at: '2026-06-15T00:00:00Z',
      updated_at: '2026-06-15T00:00:00Z',
    }
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ sources: [sourcePayload] }), { status: 200 }),
    )
    const config = { baseURL: 'http://127.0.0.1:17371', token: 'local-token' }

    await expect(discoverLocalLarkSources(config, fetcher)).resolves.toEqual([sourcePayload])
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:17371/local/v1/lark/sources/discover',
      expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ Authorization: 'Bearer local-token' }) }),
    )
  })

  it('quotes a local todo through the protected local host API', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          todo_id: 'todo_1',
          text: '确认项目排期\n摘要：请今天确认。\n来源：请今天确认 [email] 的排期',
        }),
        { status: 200 },
      ),
    )
    const config = { baseURL: 'http://127.0.0.1:17371', token: 'local-token' }

    await expect(quoteLocalTodoItem('todo_1', {}, config, fetcher)).resolves.toEqual({
      todo_id: 'todo_1',
      text: '确认项目排期\n摘要：请今天确认。\n来源：请今天确认 [email] 的排期',
    })
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:17371/local/v1/todos/todo_1/quote',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({}) }),
    )
  })

  it('updates local Lark connection preferences through the protected API', async () => {
    const payload = {
      id: 'lark_conn_1',
      provider: 'lark',
      status: 'connected',
      tenant_label: 'ColdFlame',
      account_label: 'Jane',
      auth_mode: 'lark_cli',
      cloud_extraction_enabled: true,
      last_checked_at: '2026-06-15T00:00:00Z',
      last_error_code: '',
      created_at: '2026-06-15T00:00:00Z',
      updated_at: '2026-06-15T00:00:00Z',
    }
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }))
    const config = { baseURL: 'http://127.0.0.1:17371', token: 'local-token' }

    await expect(updateLocalLarkConnection({ cloud_extraction_enabled: true }, config, fetcher)).resolves.toMatchObject({
      cloud_extraction_enabled: true,
    })
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:17371/local/v1/lark/connection',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ cloud_extraction_enabled: true }),
      }),
    )
  })

  it('starts and disconnects local Lark auth through protected APIs', async () => {
    const connectPayload = {
      connection: {
        id: 'lark_conn_1',
        provider: 'lark',
        status: 'needs_auth',
        tenant_label: '',
        account_label: '',
        auth_mode: 'lark_cli',
        cloud_extraction_enabled: false,
        last_checked_at: '2026-06-15T00:00:00Z',
        last_error_code: '',
        created_at: '2026-06-15T00:00:00Z',
        updated_at: '2026-06-15T00:00:00Z',
      },
      connector: {
        available: true,
        source: 'system',
        executable_path: '/fake/lark-cli',
      },
      authorization_url: 'https://accounts.example.test/auth',
      device_code: 'dev-1',
    }
    const disconnectPayload = {
      connection: { ...connectPayload.connection, status: 'disconnected' },
      connector: connectPayload.connector,
    }
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(connectPayload), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(disconnectPayload), { status: 200 }))
    const config = { baseURL: 'http://127.0.0.1:17371', token: 'local-token' }

    await expect(connectLocalLark(config, fetcher)).resolves.toMatchObject({
      authorization_url: 'https://accounts.example.test/auth',
      connection: { status: 'needs_auth' },
    })
    await expect(disconnectLocalLark(config, fetcher)).resolves.toMatchObject({
      connection: { status: 'disconnected' },
    })

    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:17371/local/v1/lark/connect',
      expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ Authorization: 'Bearer local-token' }) }),
    )
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:17371/local/v1/lark/disconnect',
      expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ Authorization: 'Bearer local-token' }) }),
    )
  })

  it('runs cloud-redacted Lark sync by default through the protected API', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          provider: 'lark',
          extraction_provider: 'cloud_redacted',
          processed_messages: 2,
          created_todos: 1,
          skipped_messages: 1,
        }),
        { status: 200 },
      ),
    )

    await expect(syncLocalLark({ limit: 50 }, { baseURL: 'http://127.0.0.1:17371', token: 'local-token' }, fetcher)).resolves.toEqual({
      provider: 'lark',
      extraction_provider: 'cloud_redacted',
      processed_messages: 2,
      created_todos: 1,
      skipped_messages: 1,
    })
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:17371/local/v1/lark/sync',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer local-token' }),
        body: JSON.stringify({ limit: 50, extraction_provider: 'cloud_redacted', model: 'auto' }),
      }),
    )
  })

  it('streams local run events and returns completion metadata', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        'event: local.event\n' +
          'data: {"id":"event-1","event_type":"tool.completed","payload":{"tool":"file.read"}}\n\n' +
          'event: local.event\n' +
          'data: {"id":"event-2","event_type":"llm.delta","payload":{"content":"完成"}}\n\n' +
          'data: [DONE]\n\n',
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      ),
    )
    const events: string[] = []
    let content = ''

    await expect(
      streamLocalRun(
        'run-local',
        { baseURL: 'http://127.0.0.1:17371', token: 'local-token' },
        {
          onEvent: (event) => events.push(event.event_type),
          onDelta: (delta) => {
            content += delta
          },
        },
        fetcher,
      ),
    ).resolves.toEqual({ completed: true })
    expect(events).toEqual(['tool.completed', 'llm.delta'])
    expect(content).toBe('完成')
  })

  it('resolves permissions and reads artifacts through protected APIs', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'recorded' }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'recorded' }), { status: 202 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'artifact-1',
            title: 'file.read output',
            content: 'artifact content',
            tool_name: 'file.read',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )

    await expect(
      resolveLocalPermission('perm-1', 'approve', { baseURL: 'http://127.0.0.1:17371', token: 'local-token' }, fetcher),
    ).resolves.toBeUndefined()
    await expect(
      resolveLocalPermission('perm-2', 'approve', { baseURL: 'http://127.0.0.1:17371', token: 'local-token' }, { scope: 'run' }, fetcher),
    ).resolves.toBeUndefined()
    await expect(getLocalArtifact('artifact-1', { baseURL: 'http://127.0.0.1:17371', token: 'local-token' }, fetcher)).resolves.toMatchObject({
      id: 'artifact-1',
      content: 'artifact content',
    })
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:17371/local/v1/permissions/perm-1',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ decision: 'approve' }) }),
    )
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:17371/local/v1/permissions/perm-2',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ decision: 'approve', scope: 'run' }) }),
    )
    expect(fetcher).toHaveBeenNthCalledWith(
      3,
      'http://127.0.0.1:17371/local/v1/artifacts/artifact-1',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('injects mid-run steering instructions through the protected run API', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          run_id: 'run-active',
          instruction_id: 'steer-1',
          queued: true,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )

    await expect(
      injectLocalRunInstruction(
        'run-active',
        'Focus on the failing tests before editing.',
        { baseURL: 'http://127.0.0.1:17371', token: 'local-token' },
        fetcher,
      ),
    ).resolves.toMatchObject({ queued: true, instruction_id: 'steer-1' })

    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:17371/local/v1/runs/run-active/inject',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer local-token' }),
        body: JSON.stringify({ content: 'Focus on the failing tests before editing.' }),
      }),
    )
  })

  it('posts plan approval decisions with optional modification instructions', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          approval_id: 'plan-1',
          resolved: true,
          decision: 'modify',
          resumed: true,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )

    await expect(
      resolveLocalPlanApproval(
        'plan-1',
        'modify',
        'Add a verification step.',
        { baseURL: 'http://127.0.0.1:17371', token: 'local-token' },
        fetcher,
      ),
    ).resolves.toBeUndefined()

    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:17371/local/v1/plans/plan-1',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer local-token',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({ decision: 'modify', instructions: 'Add a verification step.' }),
      }),
    )
  })

  it('lists and authorizes local workspaces through protected APIs', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ workspaces: [{ id: 'workspace-1', path: '/tmp/project', label: 'project' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'workspace-2',
            path: '/tmp/other',
            label: 'other',
            created_at: '2026-05-11T00:00:00Z',
            last_used_at: '2026-05-11T00:00:00Z',
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
      )

    await expect(listAuthorizedWorkspaces({ baseURL: 'http://127.0.0.1:17371', token: 'local-token' }, fetcher)).resolves.toEqual([
      { id: 'workspace-1', path: '/tmp/project', label: 'project' },
    ])
    await expect(authorizeLocalWorkspace('/tmp/other', { baseURL: 'http://127.0.0.1:17371', token: 'local-token' }, fetcher)).resolves.toMatchObject({
      id: 'workspace-2',
      path: '/tmp/other',
    })
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:17371/local/v1/workspaces',
      expect.objectContaining({ method: 'GET', headers: expect.objectContaining({ Authorization: 'Bearer local-token' }) }),
    )
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:17371/local/v1/workspaces',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ path: '/tmp/other' }) }),
    )
  })

  it('diagnoses and revokes local workspaces through protected APIs', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            path: '/tmp/project',
            exists: true,
            is_directory: true,
            authorized: true,
            reason: 'authorized',
            workspace: { id: 'workspace-1', path: '/tmp/project', label: 'project' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'workspace-1', path: '/tmp/project', label: 'project' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )

    await expect(diagnoseLocalWorkspace('/tmp/project', { baseURL: 'http://127.0.0.1:17371', token: 'local-token' }, fetcher)).resolves.toMatchObject({
      authorized: true,
      workspace: { id: 'workspace-1' },
    })
    await expect(revokeLocalWorkspace('workspace-1', { baseURL: 'http://127.0.0.1:17371', token: 'local-token' }, fetcher)).resolves.toMatchObject({
      id: 'workspace-1',
      path: '/tmp/project',
    })
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:17371/local/v1/workspaces/diagnose',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ path: '/tmp/project' }) }),
    )
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:17371/local/v1/workspaces/workspace-1',
      expect.objectContaining({ method: 'DELETE', headers: expect.objectContaining({ Authorization: 'Bearer local-token' }) }),
    )
  })

  it('lists local runs and fetches redacted diagnostics through protected APIs', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            runs: [
              {
                id: 'run-1',
                goal: 'Resume this run',
                status: 'running',
                created_at: '2026-05-11T00:00:00Z',
                updated_at: '2026-05-11T00:00:01Z',
                events_count: 3,
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            schema_version: 1,
            exported_at: '2026-05-11T00:00:02Z',
            run: { id: 'run-1', goal: 'Resume this run', status: 'running' },
            events: [],
            permissions: [],
            artifacts: [],
            latest_checkpoint: null,
            handoff: {
              status: 'running',
              headline: 'Run is running with 0 persisted events.',
              next_actions: ['Reconnect to the stream or wait for the run to reach a terminal state.'],
              blockers: [],
              recent_event_types: [],
              ledger_state: 'fresh',
              ledger_message: null,
            },
            feature_ledger: {
              summary: 'Wire diagnostics',
              status: 'in_progress',
              acceptance_criteria: ['diagnostics exposes latest ledger'],
              decisions: [],
              files_touched: [],
              validation_commands: [],
              unresolved_risks: [],
              next_actions: ['run tests'],
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )

    await expect(listLocalRuns({ baseURL: 'http://127.0.0.1:17371', token: 'local-token' }, fetcher)).resolves.toEqual([
      expect.objectContaining({ id: 'run-1', status: 'running' }),
    ])
    await expect(getLocalRunDiagnostics('run-1', { baseURL: 'http://127.0.0.1:17371', token: 'local-token' }, fetcher)).resolves.toMatchObject({
      schema_version: 1,
      run: { id: 'run-1' },
      handoff: { status: 'running' },
      feature_ledger: { summary: 'Wire diagnostics' },
    })
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:17371/local/v1/runs',
      expect.objectContaining({ method: 'GET', headers: expect.objectContaining({ Authorization: 'Bearer local-token' }) }),
    )
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:17371/local/v1/runs/run-1/diagnostics',
      expect.objectContaining({ method: 'GET', headers: expect.objectContaining({ Authorization: 'Bearer local-token' }) }),
    )
  })

  it('manages scheduled local runs', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'sched-1',
            goal: '稍后跑',
            status: 'scheduled',
            run_at: '2026-06-13T10:00:00Z',
            created_at: '2026-06-13T09:00:00Z',
            updated_at: '2026-06-13T09:00:00Z',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            schedules: [
              {
                id: 'sched-1',
                goal: '稍后跑',
                status: 'completed',
                run_at: '2026-06-13T10:00:00Z',
                result_text: '完成了',
                created_at: '2026-06-13T09:00:00Z',
                updated_at: '2026-06-13T10:01:00Z',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'sched-1',
            goal: '稍后跑',
            status: 'completed',
            run_at: '2026-06-13T10:00:00Z',
            notified_at: '2026-06-13T10:02:00Z',
            created_at: '2026-06-13T09:00:00Z',
            updated_at: '2026-06-13T10:02:00Z',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'sched-2',
            goal: '取消',
            status: 'canceled',
            run_at: '2026-06-13T11:00:00Z',
            created_at: '2026-06-13T09:00:00Z',
            updated_at: '2026-06-13T09:10:00Z',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )

    await expect(
      createLocalSchedule(
        {
          goal: '稍后跑',
          runAt: '2026-06-13T10:00:00Z',
          mode: 'auto',
          history: [{ role: 'user', content: '背景' }],
          settings: {
            memory: 'on',
            skills: 'on',
            mcp: 'on',
            mcpDisabled: [],
            advanced: {},
          },
        },
        { baseURL: 'http://127.0.0.1:17371', token: 'local-token' },
        fetcher,
      ),
    ).resolves.toMatchObject({ id: 'sched-1', status: 'scheduled' })
    await expect(
      listLocalSchedules(
        { baseURL: 'http://127.0.0.1:17371', token: 'local-token' },
        { notifyPending: true },
        fetcher,
      ),
    ).resolves.toEqual([expect.objectContaining({ id: 'sched-1', result_text: '完成了' })])
    await expect(
      markLocalScheduleNotified('sched-1', { baseURL: 'http://127.0.0.1:17371', token: 'local-token' }, fetcher),
    ).resolves.toMatchObject({ notified_at: '2026-06-13T10:02:00Z' })
    await expect(
      cancelLocalSchedule('sched-2', { baseURL: 'http://127.0.0.1:17371', token: 'local-token' }, fetcher),
    ).resolves.toMatchObject({ status: 'canceled' })

    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:17371/local/v1/schedules',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          goal: '稍后跑',
          run_at: '2026-06-13T10:00:00Z',
          model: 'auto',
          history: [{ role: 'user', content: '背景' }],
          settings: {
            memory: 'on',
            skills: 'on',
            mcp: 'on',
          },
        }),
      }),
    )
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:17371/local/v1/schedules?notify_pending=true',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(fetcher).toHaveBeenNthCalledWith(
      3,
      'http://127.0.0.1:17371/local/v1/schedules/sched-1/notified',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(fetcher).toHaveBeenNthCalledWith(
      4,
      'http://127.0.0.1:17371/local/v1/schedules/sched-2',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('previews redacted Lark candidates and clears local Lark cache', async () => {
    const previewPayload = {
      provider: 'lark',
      processed_messages: 1,
      candidate_count: 1,
      skipped_messages: 0,
      candidates: [
        {
          message_id: 'msg_1',
          source_id: 'lark_src_1',
          source_label: '合同群',
          source_type: 'p2p',
          redacted_text: '请今天联系 [email] 确认合同',
          priority: 'today',
          suggested_action: 'reply',
          confidence: 0.8,
        },
      ],
    }
    const clearPayload = {
      cleared: true,
      deleted_sources: 1,
      deleted_messages: 1,
      deleted_todos: 1,
    }
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(previewPayload), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(clearPayload), { status: 200 }))
    const config = { baseURL: 'http://127.0.0.1:17371', token: 'local-token' }

    await expect(previewLocalLark({ limit: 20 }, config, fetcher)).resolves.toEqual(previewPayload)
    await expect(clearLocalLarkCache(config, fetcher)).resolves.toEqual(clearPayload)

    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:17371/local/v1/lark/preview',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer local-token' }),
        body: JSON.stringify({ limit: 20 }),
      }),
    )
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:17371/local/v1/lark/cache',
      expect.objectContaining({
        method: 'DELETE',
        headers: expect.objectContaining({ Authorization: 'Bearer local-token' }),
      }),
    )
  })
})
