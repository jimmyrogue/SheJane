import { describe, expect, it, vi } from 'vitest'
import {
  createLocalRun,
  authorizeLocalWorkspace,
  diagnoseLocalWorkspace,
  getLocalRunDiagnostics,
  getDesktopLocalHostConfig,
  getLocalArtifact,
  installSkill,
  listAuthorizedWorkspaces,
  listInstalledSkills,
  listLocalRuns,
  searchSkillRegistry,
  probeLocalHost,
  revokeLocalWorkspace,
  resolveLocalPermission,
  setLocalCloudSession,
  clearLocalCloudSession,
  streamLocalRun,
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

  it('lists installed skills from the local host', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ skills: [{ name: 'hunt', description: 'Diagnose', path: '/p/SKILL.md' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const skills = await listInstalledSkills({ baseURL: 'http://127.0.0.1:17371', token: 'local-token' }, fetcher)
    expect(skills).toEqual([{ name: 'hunt', description: 'Diagnose', path: '/p/SKILL.md' }])
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:17371/local/v1/skills',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('searches the skill registry with an encoded query', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ skills: [{ id: 'a/b/c', skillId: 'c', name: 'C', installs: 3, source: 'a/b' }], count: 1 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    const result = await searchSkillRegistry('type script', { baseURL: 'http://127.0.0.1:17371', token: 'local-token' }, fetcher)
    expect(result.skills).toHaveLength(1)
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:17371/local/v1/skills/registry?q=type%20script',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('posts a skill install request and surfaces failure detail without throwing', async () => {
    const okFetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, code: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    )
    const ok = await installSkill(
      { source: 'anthropics/skills', skillId: 'skill-creator' },
      { baseURL: 'http://127.0.0.1:17371', token: 'local-token' },
      okFetcher,
    )
    expect(ok.ok).toBe(true)
    expect(okFetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:17371/local/v1/skills/install',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ source: 'anthropics/skills', skillId: 'skill-creator' }),
      }),
    )

    const failFetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: false, stderr: 'boom' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const failed = await installSkill(
      { source: 'anthropics/skills', skillId: 'skill-creator' },
      { baseURL: 'http://127.0.0.1:17371', token: 'local-token' },
      failFetcher,
    )
    expect(failed.ok).toBe(false)
    expect(failed.stderr).toBe('boom')
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
})
