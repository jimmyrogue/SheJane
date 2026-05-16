import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createLocalHostServer } from './server.js'
import { InMemoryLocalHostStore } from './state/memoryStore.js'
import type { LLMGateway, LLMGatewayRequest, LLMGatewayResponse } from './llm/gateway.js'

const token = 'test-pairing-token'
const servers: Server[] = []
const tempDirs: string[] = []

// These integration tests don't exercise Phase 5 dynamic routing; pin it off
// so the production default (auto) doesn't add a classifier round-trip.
beforeEach(() => {
  process.env.JIANDANLY_LOCAL_ROUTING = 'off'
})

afterEach(async () => {
  delete process.env.JIANDANLY_LOCAL_ROUTING
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error)
              return
            }
            resolve()
          })
        }),
    ),
  )
  servers.length = 0
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs.length = 0
})

describe('local host daemon foundation', () => {
  it('exposes public health but protects paired local APIs', async () => {
    const baseURL = await startServer()

    const health = await fetch(`${baseURL}/local/v1/health`)
    expect(health.status).toBe(200)
    await expect(health.json()).resolves.toMatchObject({
      status: 'ok',
      mode: 'daemon',
      worker: 'user',
    })

    const unpairedTools = await fetch(`${baseURL}/local/v1/tools`)
    expect(unpairedTools.status).toBe(401)

    const pairedTools = await fetch(`${baseURL}/local/v1/tools`, {
      headers: authHeaders(),
    })
    expect(pairedTools.status).toBe(200)
    const body = await pairedTools.json()
    expect(body.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'file.read',
          isReadOnly: true,
          permissionPolicy: 'allow',
        }),
        expect.objectContaining({
          name: 'shell.run',
          isDestructive: true,
          permissionPolicy: 'ask',
        }),
      ]),
    )
  })

  it('creates a run, streams durable events, and completes the run shell', async () => {
    const baseURL = await startServer()

    const created = await fetch(`${baseURL}/local/v1/runs`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: 'Summarize this workspace foundation.' }),
    })
    expect(created.status).toBe(201)
    const run = await created.json()
    expect(run).toMatchObject({
      status: 'queued',
      goal: 'Summarize this workspace foundation.',
    })

    const stream = await fetch(`${baseURL}/local/v1/runs/${run.id}/stream`, {
      headers: authHeaders(),
    })
    expect(stream.status).toBe(200)
    const events = parseSSE(await stream.text())
    expect(events.map((event) => event.event_type)).toEqual(['run.created', 'run.started', 'skill.selected', 'llm.started', 'llm.delta', 'run.completed'])
    expect(events.at(-1)?.payload).toMatchObject({
      final: expect.stringContaining('Local Agent Harness'),
    })

    const fetched = await fetch(`${baseURL}/local/v1/runs/${run.id}`, {
      headers: authHeaders(),
    })
    await expect(fetched.json()).resolves.toMatchObject({
      id: run.id,
      status: 'completed',
      events_count: 6,
    })
  })

  it('keeps cancellation recoverable and replays cancel events', async () => {
    const baseURL = await startServer()
    const created = await fetch(`${baseURL}/local/v1/runs`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: 'Do not start this run.' }),
    })
    const run = await created.json()

    const canceled = await fetch(`${baseURL}/local/v1/runs/${run.id}/cancel`, {
      method: 'POST',
      headers: authHeaders(),
    })
    expect(canceled.status).toBe(200)
    await expect(canceled.json()).resolves.toMatchObject({
      id: run.id,
      status: 'canceled',
    })

    const stream = await fetch(`${baseURL}/local/v1/runs/${run.id}/stream`, {
      headers: authHeaders(),
    })
    const events = parseSSE(await stream.text())
    expect(events.map((event) => event.event_type)).toEqual(['run.created', 'run.canceled'])
  })

  it('runs the harness loop through the stream endpoint with an injected LLM gateway', async () => {
    const workspace = await tempWorkspace()
    await writeFile(join(workspace, 'todo.txt'), 'ship phase 2.4', 'utf8')
    const gateway = new ScriptedGateway([
      {
        requestId: 'req-1',
        toolCalls: [{ id: 'call-1', name: 'file.read', arguments: { path: 'todo.txt' } }],
      },
      { requestId: 'req-2', content: 'todo.txt says ship phase 2.4' },
    ])
    const baseURL = await startServer(gateway)
    await authorizeWorkspace(baseURL, workspace)
    const created = await fetch(`${baseURL}/local/v1/runs`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: 'Read the todo file.', workspace_path: workspace }),
    })
    const run = await created.json()

    const stream = await fetch(`${baseURL}/local/v1/runs/${run.id}/stream`, {
      headers: authHeaders(),
    })
    const events = parseSSE(await stream.text())

    expect(events.map((event) => event.event_type)).toEqual([
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
    expect(events.at(-1)?.payload.final).toBe('todo.txt says ship phase 2.4')
  })

  it('accepts a paired cloud session without persisting or returning the access token', async () => {
    const cloudCalls: Array<{ authorization?: string; body: unknown }> = []
    const cloudBaseURL = await startCloudGateway(async (request, response) => {
      if (request.method === 'GET' && request.url === '/api/v1/agent/tool-capabilities') {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ code: 0, message: 'ok', data: { tools: { 'web.search': { configured: false, provider: 'tavily', credits_cost: 20, requires_auth: true } } } }))
        return
      }
      let raw = ''
      for await (const chunk of request) {
        raw += chunk
      }
      cloudCalls.push({
        authorization: request.headers.authorization,
        body: JSON.parse(raw),
      })
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({
        code: 0,
        message: 'ok',
        data: {
          requestId: 'cloud-req-1',
          content: '云端 session 已接通',
          toolCalls: [],
        },
      }))
    })
    const baseURL = await startServer()

    const initialSession = await fetch(`${baseURL}/local/v1/session`, {
      headers: authHeaders(),
    })
    expect(initialSession.status).toBe(200)
    await expect(initialSession.json()).resolves.toEqual({ connected: false })

    const session = await fetch(`${baseURL}/local/v1/session`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ cloud_base_url: cloudBaseURL, access_token: 'cloud-user-token' }),
    })
    expect(session.status).toBe(200)
    const sessionBody = await session.json()
    expect(sessionBody).toMatchObject({
      connected: true,
      cloud_base_url: cloudBaseURL,
      auth: 'bearer',
    })
    expect(JSON.stringify(sessionBody)).not.toContain('cloud-user-token')

    const created = await fetch(`${baseURL}/local/v1/runs`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: 'Use cloud session.' }),
    })
    const run = await created.json()
    const stream = await fetch(`${baseURL}/local/v1/runs/${run.id}/stream`, {
      headers: authHeaders(),
    })
    const events = parseSSE(await stream.text())

    expect(events.at(-1)?.event_type).toBe('run.completed')
    expect(events.at(-1)?.payload.final).toBe('云端 session 已接通')
    expect(cloudCalls).toHaveLength(1)
    expect(cloudCalls[0].authorization).toBe('Bearer cloud-user-token')
    expect(cloudCalls[0].body).toMatchObject({
      run_id: run.id,
      mode: 'fast',
    })

    const cleared = await fetch(`${baseURL}/local/v1/session`, {
      method: 'DELETE',
      headers: authHeaders(),
    })
    expect(cleared.status).toBe(200)
    await expect(cleared.json()).resolves.toEqual({ connected: false })
  })

  it('resolves shell permissions through the permission endpoint', async () => {
    const workspace = await tempWorkspace()
    const gateway = new ScriptedGateway([
      {
        requestId: 'req-1',
        toolCalls: [{ id: 'call-shell', name: 'shell.run', arguments: { command: 'printf approved > approved.txt' } }],
      },
      { requestId: 'req-2', content: 'Approved command completed.' },
    ])
    const baseURL = await startServer(gateway)
    await authorizeWorkspace(baseURL, workspace)
    const created = await fetch(`${baseURL}/local/v1/runs`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: 'Run command.', workspace_path: workspace }),
    })
    const run = await created.json()
    const stream = await fetch(`${baseURL}/local/v1/runs/${run.id}/stream`, { headers: authHeaders() })
    const events = parseSSE(await stream.text())
    const permission = events.find((event) => event.event_type === 'permission.required')
    expect(permission?.payload.request_id).toEqual(expect.any(String))

    const approved = await fetch(`${baseURL}/local/v1/permissions/${permission?.payload.request_id}`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approve', scope: 'run' }),
    })
    expect(approved.status).toBe(202)
    await expect(approved.json()).resolves.toMatchObject({ decision: 'approve', scope: 'run', status: 'recorded' })
    const resumed = await fetch(`${baseURL}/local/v1/runs/${run.id}/stream`, { headers: authHeaders() })
    const resumedEvents = parseSSE(await resumed.text())
    expect(resumedEvents.at(-1)?.event_type).toBe('run.completed')
    await expect(readFile(join(workspace, 'approved.txt'), 'utf8')).resolves.toBe('approved')
  })

  it('answers a user.ask question through the questions endpoint and resumes the run', async () => {
    const gateway = new ScriptedGateway([
      {
        requestId: 'req-1',
        toolCalls: [
          {
            id: 'call-ask',
            name: 'user.ask',
            arguments: {
              questions: [
                { question: 'Pick one', header: 'Pick', options: [{ label: 'A' }, { label: 'B' }] },
              ],
            },
          },
        ],
      },
      { requestId: 'req-2', content: 'Chose A.' },
    ])
    const baseURL = await startServer(gateway)
    const created = await fetch(`${baseURL}/local/v1/runs`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: 'Decide something.' }),
    })
    const run = await created.json()
    const stream = await fetch(`${baseURL}/local/v1/runs/${run.id}/stream`, { headers: authHeaders() })
    const events = parseSSE(await stream.text())
    const asked = events.find((event) => event.event_type === 'question.asked')
    expect(asked?.payload.request_id).toEqual(expect.any(String))
    const requestID = String(asked?.payload.request_id)

    const unknown = await fetch(`${baseURL}/local/v1/questions/does-not-exist`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers: { 'Pick one': ['A'] } }),
    })
    expect(unknown.status).toBe(404)

    const invalid = await fetch(`${baseURL}/local/v1/questions/${requestID}`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers: {} }),
    })
    expect(invalid.status).toBe(400)

    const answered = await fetch(`${baseURL}/local/v1/questions/${requestID}`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers: { 'Pick one': ['A'] } }),
    })
    expect(answered.status).toBe(202)
    await expect(answered.json()).resolves.toMatchObject({ status: 'recorded' })

    const resumed = await fetch(`${baseURL}/local/v1/runs/${run.id}/stream`, { headers: authHeaders() })
    const resumedEvents = parseSSE(await resumed.text())
    expect(resumedEvents.map((event) => event.event_type)).toContain('question.answered')
    expect(resumedEvents.at(-1)?.event_type).toBe('run.completed')
  })

  it('does not execute a resolved permission request more than once', async () => {
    const workspace = await tempWorkspace()
    const gateway = new ScriptedGateway([
      {
        requestId: 'req-1',
        toolCalls: [{ id: 'call-shell', name: 'shell.run', arguments: { command: 'printf x >> approved.txt' } }],
      },
      { requestId: 'req-2', content: 'Approved command completed once.' },
    ])
    const baseURL = await startServer(gateway)
    await authorizeWorkspace(baseURL, workspace)
    const created = await fetch(`${baseURL}/local/v1/runs`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: 'Run command once.', workspace_path: workspace }),
    })
    const run = await created.json()
    const stream = await fetch(`${baseURL}/local/v1/runs/${run.id}/stream`, { headers: authHeaders() })
    const events = parseSSE(await stream.text())
    const permission = events.find((event) => event.event_type === 'permission.required')
    const requestID = String(permission?.payload.request_id)

    const approved = await fetch(`${baseURL}/local/v1/permissions/${requestID}`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approve', scope: 'run' }),
    })
    expect(approved.status).toBe(202)
    const resumed = await fetch(`${baseURL}/local/v1/runs/${run.id}/stream`, { headers: authHeaders() })
    const resumedEvents = parseSSE(await resumed.text())
    expect(resumedEvents.at(-1)?.event_type).toBe('run.completed')
    await expect(readFile(join(workspace, 'approved.txt'), 'utf8')).resolves.toBe('x')

    const duplicate = await fetch(`${baseURL}/local/v1/permissions/${requestID}`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approve', scope: 'run' }),
    })
    expect(duplicate.status).toBe(200)
    await expect(duplicate.json()).resolves.toMatchObject({ decision: 'approve', scope: 'run', status: 'already_resolved' })
    await expect(readFile(join(workspace, 'approved.txt'), 'utf8')).resolves.toBe('x')
  })

  it('does not start a duplicate runner when a stream reconnects during permission resume', async () => {
    const workspace = await tempWorkspace()
    const gateway = new DelayedSecondGateway()
    const baseURL = await startServer(gateway)
    await authorizeWorkspace(baseURL, workspace)
    const created = await fetch(`${baseURL}/local/v1/runs`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: 'Run a slow approved command.', workspace_path: workspace }),
    })
    const run = await created.json()
    const stream = await fetch(`${baseURL}/local/v1/runs/${run.id}/stream`, { headers: authHeaders() })
    const events = parseSSE(await stream.text())
    const permission = events.find((event) => event.event_type === 'permission.required')
    const requestID = String(permission?.payload.request_id)

    const approved = fetch(`${baseURL}/local/v1/permissions/${requestID}`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approve', scope: 'run' }),
    })
    await gateway.waitForSecondRequest()

    const resumed = fetch(`${baseURL}/local/v1/runs/${run.id}/stream`, { headers: authHeaders() })
    await delay(25)
    expect(gateway.requests).toHaveLength(2)

    gateway.releaseSecondRequest()
    expect((await approved).status).toBe(202)
    const resumedEvents = parseSSE(await (await resumed).text())
    expect(resumedEvents.filter((event) => event.event_type === 'run.completed')).toHaveLength(1)
    expect(gateway.requests).toHaveLength(2)
    await expect(readFile(join(workspace, 'approved.txt'), 'utf8')).resolves.toBe('slow')
  })

  it('serves large tool output artifacts through the artifact endpoint', async () => {
    const workspace = await tempWorkspace()
    const largeContent = 'artifact-api '.repeat(900)
    await writeFile(join(workspace, 'large.txt'), largeContent, 'utf8')
    const gateway = new ScriptedGateway([
      {
        requestId: 'req-1',
        toolCalls: [{ id: 'call-large', name: 'file.read', arguments: { path: 'large.txt', maxBytes: largeContent.length } }],
      },
      { requestId: 'req-2', content: 'Large output stored.' },
    ])
    const baseURL = await startServer(gateway)
    await authorizeWorkspace(baseURL, workspace)
    const created = await fetch(`${baseURL}/local/v1/runs`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: 'Read a large file.', workspace_path: workspace }),
    })
    const run = await created.json()

    const stream = await fetch(`${baseURL}/local/v1/runs/${run.id}/stream`, { headers: authHeaders() })
    const events = parseSSE(await stream.text())
    const artifactEvent = events.find((event) => event.event_type === 'artifact.created')
    expect(artifactEvent?.payload.artifact_id).toEqual(expect.any(String))

    const artifact = await fetch(`${baseURL}/local/v1/artifacts/${artifactEvent?.payload.artifact_id}`, {
      headers: authHeaders(),
    })
    expect(artifact.status).toBe(200)
    await expect(artifact.json()).resolves.toMatchObject({
      id: artifactEvent?.payload.artifact_id,
      kind: 'tool_output',
      content: largeContent,
      tool_name: 'file.read',
    })
  })

  it('persists authorized workspaces and rejects unapproved workspace paths', async () => {
    const workspace = await tempWorkspace()
    const baseURL = await startServer()

    const rejected = await fetch(`${baseURL}/local/v1/runs`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: 'Read local files.', workspace_path: workspace }),
    })
    expect(rejected.status).toBe(403)
    await expect(rejected.json()).resolves.toMatchObject({ error: 'workspace_not_authorized' })

    const authorized = await fetch(`${baseURL}/local/v1/workspaces`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: workspace }),
    })
    expect(authorized.status).toBe(201)
    await expect(authorized.json()).resolves.toMatchObject({
      path: workspace,
      label: workspace.split('/').at(-1),
    })

    const listed = await fetch(`${baseURL}/local/v1/workspaces`, {
      headers: authHeaders(),
    })
    expect(listed.status).toBe(200)
    await expect(listed.json()).resolves.toMatchObject({
      workspaces: [expect.objectContaining({ path: workspace })],
    })

    const created = await fetch(`${baseURL}/local/v1/runs`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: 'Read local files.', workspace_path: workspace }),
    })
    expect(created.status).toBe(201)
    await expect(created.json()).resolves.toMatchObject({ workspace_path: workspace })
  })

  it('diagnoses and revokes workspace authorization', async () => {
    const workspace = await tempWorkspace()
    const baseURL = await startServer()

    const authorized = await fetch(`${baseURL}/local/v1/workspaces`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: workspace }),
    })
    const authorizedWorkspace = await authorized.json()

    const diagnosed = await fetch(`${baseURL}/local/v1/workspaces/diagnose`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: workspace }),
    })
    expect(diagnosed.status).toBe(200)
    await expect(diagnosed.json()).resolves.toMatchObject({
      path: workspace,
      exists: true,
      is_directory: true,
      authorized: true,
      reason: 'authorized',
      workspace: expect.objectContaining({ id: authorizedWorkspace.id, path: workspace }),
    })

    const revoked = await fetch(`${baseURL}/local/v1/workspaces/${authorizedWorkspace.id}`, {
      method: 'DELETE',
      headers: authHeaders(),
    })
    expect(revoked.status).toBe(200)
    await expect(revoked.json()).resolves.toMatchObject({
      id: authorizedWorkspace.id,
      path: workspace,
    })

    const afterRevoke = await fetch(`${baseURL}/local/v1/workspaces/diagnose`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: workspace }),
    })
    await expect(afterRevoke.json()).resolves.toMatchObject({
      path: workspace,
      exists: true,
      is_directory: true,
      authorized: false,
      reason: 'not_authorized',
    })

    const rejected = await fetch(`${baseURL}/local/v1/runs`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: 'Read local files after revoke.', workspace_path: workspace }),
    })
    expect(rejected.status).toBe(403)
  })

  it('lists local runs and exports redacted run diagnostics', async () => {
    const workspace = await tempWorkspace()
    const largeContent = 'diagnostic-secret-output '.repeat(600)
    await writeFile(join(workspace, 'large.txt'), largeContent, 'utf8')
    const gateway = new ScriptedGateway([
      {
        requestId: 'req-1',
        toolCalls: [{ id: 'call-large', name: 'file.read', arguments: { path: 'large.txt', maxBytes: largeContent.length } }],
      },
      { requestId: 'req-2', content: 'Export diagnostics.' },
    ])
    const baseURL = await startServer(gateway)
    await authorizeWorkspace(baseURL, workspace)

    const created = await fetch(`${baseURL}/local/v1/runs`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: 'Export a diagnostic bundle.', workspace_path: workspace }),
    })
    const run = await created.json()
    const stream = await fetch(`${baseURL}/local/v1/runs/${run.id}/stream`, { headers: authHeaders() })
    await stream.text()

    const listed = await fetch(`${baseURL}/local/v1/runs?limit=5`, { headers: authHeaders() })
    expect(listed.status).toBe(200)
    await expect(listed.json()).resolves.toMatchObject({
      runs: [expect.objectContaining({ id: run.id, status: 'completed', events_count: expect.any(Number) })],
    })

    const diagnostics = await fetch(`${baseURL}/local/v1/runs/${run.id}/diagnostics`, { headers: authHeaders() })
    expect(diagnostics.status).toBe(200)
    const body = await diagnostics.json()
    expect(body).toMatchObject({
      schema_version: 1,
      run: expect.objectContaining({ id: run.id, status: 'completed' }),
      events: expect.arrayContaining([expect.objectContaining({ event_type: 'artifact.created' })]),
      artifacts: [expect.objectContaining({ tool_name: 'file.read', bytes: largeContent.length })],
      // Completed runs now persist a final structured transcript checkpoint
      // (used to seed follow-up runs for cross-turn tool replay).
      latest_checkpoint: expect.objectContaining({ reason: 'run_final' }),
    })
    expect(JSON.stringify(body)).not.toContain(largeContent)
    expect(body.artifacts[0]).not.toHaveProperty('content')
  })
})

async function startServer(llmGateway?: LLMGateway): Promise<string> {
  const server = createLocalHostServer({
    pairingToken: token,
    store: new InMemoryLocalHostStore(),
    llmGateway,
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  servers.push(server)
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Expected TCP server address')
  }
  return `http://127.0.0.1:${address.port}`
}

async function startCloudGateway(handler: Parameters<typeof createServer>[0]): Promise<string> {
  const server = createServer(handler)
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  servers.push(server)
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Expected TCP server address')
  }
  return `http://127.0.0.1:${address.port}`
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
  }
}

async function authorizeWorkspace(baseURL: string, workspace: string): Promise<void> {
  const response = await fetch(`${baseURL}/local/v1/workspaces`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: workspace }),
  })
  expect(response.status).toBe(201)
}

function parseSSE(body: string): Array<{ event_type: string; payload: Record<string, unknown> }> {
  return body
    .split('\n\n')
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk && chunk !== 'data: [DONE]')
    .map((chunk) => {
      const dataLine = chunk
        .split('\n')
        .find((line) => line.startsWith('data: '))
      if (!dataLine) {
        throw new Error(`Missing data line in ${chunk}`)
      }
      return JSON.parse(dataLine.slice('data: '.length))
    })
}

class ScriptedGateway implements LLMGateway {
  private index = 0

  constructor(private readonly responses: LLMGatewayResponse[]) {}

  async call(request: LLMGatewayRequest): Promise<LLMGatewayResponse> {
    void request
    const response = this.responses[this.index]
    this.index += 1
    if (!response) {
      throw new Error('No scripted response left')
    }
    return response
  }
}

class DelayedSecondGateway implements LLMGateway {
  readonly requests: LLMGatewayRequest[] = []
  private secondStarted!: () => void
  private secondRelease!: () => void
  private readonly secondStartedPromise = new Promise<void>((resolve) => {
    this.secondStarted = resolve
  })
  private readonly secondReleasePromise = new Promise<void>((resolve) => {
    this.secondRelease = resolve
  })

  async call(request: LLMGatewayRequest): Promise<LLMGatewayResponse> {
    this.requests.push(request)
    if (this.requests.length === 1) {
      return {
        requestId: 'req-permission',
        toolCalls: [{ id: 'call-shell', name: 'shell.run', arguments: { command: 'printf slow > approved.txt' } }],
      }
    }
    if (this.requests.length === 2) {
      this.secondStarted()
      await this.secondReleasePromise
      return { requestId: 'req-final', content: 'Approved slow command completed.' }
    }
    throw new Error('Duplicate runner requested an extra model call')
  }

  waitForSecondRequest(): Promise<void> {
    return this.secondStartedPromise
  }

  releaseSecondRequest(): void {
    this.secondRelease()
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function tempWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'jiandanly-local-host-'))
  tempDirs.push(dir)
  return dir
}
