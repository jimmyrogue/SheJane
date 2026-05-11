import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { runHarness } from './harness/runner.js'
import type { LLMGateway } from './llm/gateway.js'
import { localHostTools } from './tools/registry.js'
import {
  localHostVersion,
  type LocalEvent,
  type LocalHostStore,
  type LocalRun,
  type SerializedArtifact,
  type SerializedEvent,
  type SerializedRun,
  type WorkspaceAuthorization,
  type WorkspaceDiagnosis,
} from './types.js'

const maxBodyBytes = 64 * 1024
const terminalStatuses = new Set(['completed', 'failed', 'canceled'])

export interface LocalHostServerOptions {
  pairingToken: string
  store: LocalHostStore
  llmGateway?: LLMGateway
}

export function createLocalHostServer(options: LocalHostServerOptions): Server {
  return createServer((request, response) => {
    handleRequest(request, response, options).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'Internal server error'
      writeJSON(response, 500, { error: message })
    })
  })
}

async function handleRequest(request: IncomingMessage, response: ServerResponse, options: LocalHostServerOptions): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')

  if (request.method === 'OPTIONS') {
    writeCORS(response)
    response.writeHead(204).end()
    return
  }

  if (request.method === 'GET' && url.pathname === '/local/v1/health') {
    writeJSON(response, 200, {
      status: 'ok',
      version: localHostVersion,
      mode: 'daemon',
      supervisor: 'external',
      worker: 'user',
      loopback_only: true,
    })
    return
  }

  if (!isAuthorized(request, options.pairingToken)) {
    writeJSON(response, 401, { error: 'pairing_required' })
    return
  }

  if (request.method === 'GET' && url.pathname === '/local/v1/tools') {
    writeJSON(response, 200, { tools: localHostTools })
    return
  }

  if (request.method === 'GET' && url.pathname === '/local/v1/workspaces') {
    writeJSON(response, 200, { workspaces: options.store.listAuthorizedWorkspaces().map(serializeWorkspace) })
    return
  }

  if (request.method === 'POST' && url.pathname === '/local/v1/workspaces') {
    const body = await readJSONBody<{ path?: unknown; label?: unknown }>(request)
    const rawPath = typeof body.path === 'string' ? body.path.trim() : ''
    if (!rawPath) {
      writeJSON(response, 400, { error: 'workspace_path_required' })
      return
    }
    const workspacePath = resolve(rawPath)
    const checked = await validateWorkspaceDirectory(workspacePath)
    if (!checked.ok) {
      writeJSON(response, 400, { error: checked.error, message: checked.message })
      return
    }
    const label = typeof body.label === 'string' ? body.label : undefined
    const workspace = options.store.authorizeWorkspace({ path: workspacePath, label: label || basename(workspacePath) })
    writeJSON(response, 201, serializeWorkspace(workspace))
    return
  }

  if (request.method === 'POST' && url.pathname === '/local/v1/workspaces/diagnose') {
    const body = await readJSONBody<{ path?: unknown }>(request)
    const rawPath = typeof body.path === 'string' ? body.path.trim() : ''
    if (!rawPath) {
      writeJSON(response, 400, { error: 'workspace_path_required' })
      return
    }
    const diagnosis = await diagnoseWorkspace(resolve(rawPath), options.store)
    writeJSON(response, 200, serializeWorkspaceDiagnosis(diagnosis))
    return
  }

  const workspaceMatch = url.pathname.match(/^\/local\/v1\/workspaces\/([^/]+)$/)
  if (request.method === 'DELETE' && workspaceMatch) {
    const workspace = options.store.revokeWorkspace(decodeURIComponent(workspaceMatch[1]))
    if (!workspace) {
      writeJSON(response, 404, { error: 'workspace_not_found' })
      return
    }
    writeJSON(response, 200, serializeWorkspace(workspace))
    return
  }

  if (request.method === 'POST' && url.pathname === '/local/v1/runs') {
    const body = await readJSONBody<{ goal?: unknown; workspace_path?: unknown; workspacePath?: unknown }>(request)
    const goal = typeof body.goal === 'string' ? body.goal.trim() : ''
    if (!goal) {
      writeJSON(response, 400, { error: 'goal_required' })
      return
    }
    const workspacePath =
      typeof body.workspace_path === 'string'
        ? resolve(body.workspace_path)
        : typeof body.workspacePath === 'string'
          ? resolve(body.workspacePath)
          : undefined
    if (workspacePath && !options.store.findAuthorizedWorkspace(workspacePath)) {
      writeJSON(response, 403, {
        error: 'workspace_not_authorized',
        message: 'Authorize this workspace before creating a local run.',
      })
      return
    }
    const run = options.store.createRun({ goal, workspacePath })
    options.store.appendEvent(run.id, 'run.created', { goal, workspace_path: workspacePath })
    writeJSON(response, 201, serializeRun(run, options.store.countEvents(run.id)))
    return
  }

  const runMatch = url.pathname.match(/^\/local\/v1\/runs\/([^/]+)$/)
  if (request.method === 'GET' && runMatch) {
    const run = options.store.getRun(runMatch[1])
    if (!run) {
      writeJSON(response, 404, { error: 'run_not_found' })
      return
    }
    writeJSON(response, 200, serializeRun(run, options.store.countEvents(run.id)))
    return
  }

  const streamMatch = url.pathname.match(/^\/local\/v1\/runs\/([^/]+)\/stream$/)
  if (request.method === 'GET' && streamMatch) {
    const run = options.store.getRun(streamMatch[1])
    if (!run) {
      writeJSON(response, 404, { error: 'run_not_found' })
      return
    }
    await streamRun(response, run, options)
    return
  }

  const cancelMatch = url.pathname.match(/^\/local\/v1\/runs\/([^/]+)\/cancel$/)
  if (request.method === 'POST' && cancelMatch) {
    const run = options.store.getRun(cancelMatch[1])
    if (!run) {
      writeJSON(response, 404, { error: 'run_not_found' })
      return
    }
    if (!terminalStatuses.has(run.status)) {
      const now = new Date().toISOString()
      options.store.updateRunStatus(run.id, 'canceled', { canceledAt: now })
      options.store.appendEvent(run.id, 'run.canceled', { reason: 'user_cancelled' })
    }
    const next = options.store.getRun(run.id)
    writeJSON(response, 200, serializeRun(next ?? run, options.store.countEvents(run.id)))
    return
  }

  const permissionMatch = url.pathname.match(/^\/local\/v1\/permissions\/([^/]+)$/)
  if (request.method === 'POST' && permissionMatch) {
    const body = await readJSONBody<{ decision?: unknown }>(request)
    const decision = body.decision === 'approve' ? 'approve' : body.decision === 'deny' ? 'deny' : undefined
    if (!decision) {
      writeJSON(response, 400, { error: 'permission_decision_required' })
      return
    }
    const permission = options.store.permissionByID(permissionMatch[1])
    if (!permission) {
      writeJSON(response, 404, { error: 'permission_not_found' })
      return
    }
    const resolved = await options.store.resolvePermission(permission.id, decision)
    if (!resolved) {
      writeJSON(response, 404, { error: 'permission_not_found' })
      return
    }
    const run = options.store.getRun(permission.runId)
    if (!run) {
      writeJSON(response, 404, { error: 'run_not_found' })
      return
    }
    await runHarness({
      run,
      store: options.store,
      llmGateway: options.llmGateway,
      emit: () => undefined,
      resumePermissionID: permission.id,
    })
    writeJSON(response, 202, {
      request_id: permissionMatch[1],
      decision,
      status: 'recorded',
    })
    return
  }

  const artifactMatch = url.pathname.match(/^\/local\/v1\/artifacts\/([^/]+)$/)
  if (request.method === 'GET' && artifactMatch) {
    const artifact = options.store.getArtifact(artifactMatch[1])
    if (!artifact) {
      writeJSON(response, 404, {
        artifact_id: artifactMatch[1],
        error: 'artifact_not_found',
      })
      return
    }
    writeJSON(response, 200, serializeArtifact(artifact))
    return
  }

  writeJSON(response, 404, { error: 'not_found' })
}

async function streamRun(response: ServerResponse, run: LocalRun, options: LocalHostServerOptions): Promise<void> {
  writeCORS(response)
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  })

  const store = options.store
  const events = store.listEvents(run.id)
  for (const event of events) {
    writeSSE(response, event)
  }

  if (run.status === 'queued' || run.status === 'running') {
    await runHarness({
      run,
      store,
      llmGateway: options.llmGateway,
      emit: (event) => writeSSE(response, event),
    })
  }

  response.write('data: [DONE]\n\n')
  response.end()
}

function writeSSE(response: ServerResponse, event: LocalEvent): void {
  response.write(`event: local.event\n`)
  response.write(`data: ${JSON.stringify(serializeEvent(event))}\n\n`)
}

function isAuthorized(request: IncomingMessage, pairingToken: string): boolean {
  const authorization = request.headers.authorization
  if (authorization === `Bearer ${pairingToken}`) {
    return true
  }
  return request.headers['x-jiandanly-local-token'] === pairingToken
}

async function readJSONBody<T>(request: IncomingMessage): Promise<T> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maxBodyBytes) {
      throw new Error('Request body too large')
    }
    chunks.push(buffer)
  }
  if (!chunks.length) {
    return {} as T
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T
}

function serializeRun(run: LocalRun, eventsCount?: number): SerializedRun {
  return {
    id: run.id,
    goal: run.goal,
    workspace_path: run.workspacePath,
    status: run.status,
    created_at: run.createdAt,
    updated_at: run.updatedAt,
    completed_at: run.completedAt,
    canceled_at: run.canceledAt,
    events_count: eventsCount,
  }
}

function serializeEvent(event: LocalEvent): SerializedEvent {
  return {
    id: event.id,
    run_id: event.runId,
    seq: event.seq,
    event_type: event.eventType,
    payload: event.payload,
    created_at: event.createdAt,
  }
}

function serializeArtifact(artifact: ReturnType<LocalHostStore['getArtifact']> extends infer T ? NonNullable<T> : never): SerializedArtifact {
  return {
    id: artifact.id,
    run_id: artifact.runId,
    kind: artifact.kind,
    title: artifact.title,
    content: artifact.content,
    content_type: artifact.contentType,
    bytes: artifact.bytes,
    tool_call_id: artifact.toolCallId,
    tool_name: artifact.toolName,
    metadata: artifact.metadata,
    created_at: artifact.createdAt,
  }
}

function serializeWorkspace(workspace: WorkspaceAuthorization) {
  return {
    id: workspace.id,
    path: workspace.path,
    label: workspace.label,
    created_at: workspace.createdAt,
    last_used_at: workspace.lastUsedAt,
  }
}

function serializeWorkspaceDiagnosis(diagnosis: WorkspaceDiagnosis) {
  return {
    path: diagnosis.path,
    exists: diagnosis.exists,
    is_directory: diagnosis.isDirectory,
    authorized: diagnosis.authorized,
    reason: diagnosis.reason,
    workspace: diagnosis.workspace ? serializeWorkspace(diagnosis.workspace) : undefined,
  }
}

async function diagnoseWorkspace(path: string, store: LocalHostStore): Promise<WorkspaceDiagnosis> {
  const authorization = store.findAuthorizedWorkspace(path)
  try {
    const info = await stat(path)
    if (!info.isDirectory()) {
      return {
        path,
        exists: true,
        isDirectory: false,
        authorized: false,
        reason: 'not_directory',
        workspace: authorization,
      }
    }
    return {
      path,
      exists: true,
      isDirectory: true,
      authorized: Boolean(authorization),
      reason: authorization ? 'authorized' : 'not_authorized',
      workspace: authorization,
    }
  } catch {
    return {
      path,
      exists: false,
      isDirectory: false,
      authorized: false,
      reason: 'not_found',
      workspace: authorization,
    }
  }
}

async function validateWorkspaceDirectory(path: string): Promise<{ ok: true } | { ok: false; error: string; message: string }> {
  try {
    const info = await stat(path)
    if (!info.isDirectory()) {
      return { ok: false, error: 'workspace_not_directory', message: 'Workspace path must be a directory.' }
    }
    return { ok: true }
  } catch {
    return { ok: false, error: 'workspace_not_found', message: 'Workspace path does not exist.' }
  }
}

function writeJSON(response: ServerResponse, status: number, body: unknown): void {
  writeCORS(response)
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

function writeCORS(response: ServerResponse): void {
  response.setHeader('Access-Control-Allow-Origin', '*')
  response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Jiandanly-Local-Token')
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
}
