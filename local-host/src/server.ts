import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { runHarness } from './harness/runner.js'
import type { LLMGateway } from './llm/gateway.js'
import { LocalCloudSessionManager } from './llm/cloudSession.js'
import { logLocalHostError } from './debugLogger.js'
import type { ToolExecutionOptions } from './tools/executor.js'
import { localHostTools } from './tools/registry.js'
import {
  localHostVersion,
  type LocalArtifact,
  type LocalCheckpoint,
  type LocalEvent,
  type LocalHostStore,
  type LocalRunDiagnostics,
  type PermissionRequest,
  type LocalRun,
  type UserQuestionItem,
  type StoredHarnessMessage,
  type SerializedArtifact,
  type SerializedArtifactSummary,
  type SerializedCheckpointSummary,
  type SerializedEvent,
  type SerializedRun,
  type WorkspaceAuthorization,
  type WorkspaceDiagnosis,
} from './types.js'

const maxBodyBytes = 64 * 1024
const terminalStatuses = new Set(['completed', 'failed', 'canceled'])
const pausedForUserStatuses = new Set(['waiting_permission', 'waiting_input'])

export interface LocalHostServerOptions {
  pairingToken: string
  store: LocalHostStore
  llmGateway?: LLMGateway
  cloudSession?: LocalCloudSessionManager
}

export function createLocalHostServer(options: LocalHostServerOptions): Server {
  const resolvedOptions = {
    ...options,
    cloudSession: options.cloudSession ?? new LocalCloudSessionManager(),
    toolOptionsByRun: new Map<string, ToolExecutionOptions>(),
    activeRuns: new Map<string, Promise<void>>(),
  }
  return createServer((request, response) => {
    handleRequest(request, response, resolvedOptions).catch((error: unknown) => {
      logLocalHostError('request.failed', error, {
        method: request.method,
        url: request.url,
      })
      const message = error instanceof Error ? error.message : 'Internal server error'
      writeJSON(response, 500, { error: message })
    })
  })
}

type ResolvedLocalHostServerOptions = LocalHostServerOptions & {
  cloudSession: LocalCloudSessionManager
  toolOptionsByRun: Map<string, ToolExecutionOptions>
  activeRuns: Map<string, Promise<void>>
}

async function handleRequest(request: IncomingMessage, response: ServerResponse, options: ResolvedLocalHostServerOptions): Promise<void> {
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

  if (request.method === 'GET' && url.pathname === '/local/v1/session') {
    writeJSON(response, 200, options.cloudSession.state())
    return
  }

  if (request.method === 'POST' && url.pathname === '/local/v1/session') {
    const body = await readJSONBody<{ cloud_base_url?: unknown; access_token?: unknown }>(request)
    const accessToken = typeof body.access_token === 'string' ? body.access_token : ''
    const cloudBaseURL = typeof body.cloud_base_url === 'string' ? body.cloud_base_url : undefined
    try {
      const state = options.cloudSession.setSession({ cloudBaseURL, accessToken })
      clearCloudToolGateways(options)
      writeJSON(response, 200, state)
    } catch (error) {
      writeJSON(response, 400, {
        error: error instanceof Error ? error.message : 'cloud_session_invalid',
      })
    }
    return
  }

  if (request.method === 'DELETE' && url.pathname === '/local/v1/session') {
    const state = options.cloudSession.clearSession()
    clearCloudToolGateways(options)
    writeJSON(response, 200, state)
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

  if (request.method === 'GET' && url.pathname === '/local/v1/runs') {
    const limit = parseLimit(url.searchParams.get('limit'))
    const runs = options.store.listRuns(limit).map((run) => serializeRun(run, options.store.countEvents(run.id)))
    writeJSON(response, 200, { runs })
    return
  }

  if (request.method === 'POST' && url.pathname === '/local/v1/runs') {
    const body = await readJSONBody<{ goal?: unknown; workspace_path?: unknown; workspacePath?: unknown; history?: unknown; parent_run_id?: unknown; parentRunId?: unknown }>(request)
    const goal = typeof body.goal === 'string' ? body.goal.trim() : ''
    if (!goal) {
      writeJSON(response, 400, { error: 'goal_required' })
      return
    }
    const history = sanitizeRunHistory(body.history)
    const parentRunId =
      typeof body.parent_run_id === 'string' && body.parent_run_id.trim()
        ? body.parent_run_id.trim()
        : typeof body.parentRunId === 'string' && body.parentRunId.trim()
          ? body.parentRunId.trim()
          : undefined
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
    const run = options.store.createRun({ goal, workspacePath, history, parentRunId })
    options.store.appendEvent(run.id, 'run.created', {
      goal,
      workspace_path: workspacePath,
      history_messages: history?.length ?? 0,
      parent_run_id: parentRunId ?? null,
    })
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

  const diagnosticsMatch = url.pathname.match(/^\/local\/v1\/runs\/([^/]+)\/diagnostics$/)
  if (request.method === 'GET' && diagnosticsMatch) {
    const run = options.store.getRun(diagnosticsMatch[1])
    if (!run) {
      writeJSON(response, 404, { error: 'run_not_found' })
      return
    }
    writeJSON(response, 200, buildRunDiagnostics(run, options.store))
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
    const body = await readJSONBody<{ decision?: unknown; scope?: unknown }>(request)
    const decision = body.decision === 'approve' ? 'approve' : body.decision === 'deny' ? 'deny' : undefined
    const scope = body.scope === 'run' ? 'run' : 'once'
    if (!decision) {
      writeJSON(response, 400, { error: 'permission_decision_required' })
      return
    }
    const permission = options.store.permissionByID(permissionMatch[1])
    if (!permission) {
      writeJSON(response, 404, { error: 'permission_not_found' })
      return
    }
    if (permission.status !== 'pending') {
      writeJSON(response, 200, {
        request_id: permissionMatch[1],
        decision: permission.status === 'approved' ? 'approve' : 'deny',
        scope: permission.scope,
        status: 'already_resolved',
      })
      return
    }
    const resolved = await options.store.resolvePermission(permission.id, decision, scope)
    if (!resolved) {
      writeJSON(response, 404, { error: 'permission_not_found' })
      return
    }
    const run = options.store.getRun(permission.runId)
    if (!run) {
      writeJSON(response, 404, { error: 'run_not_found' })
      return
    }
    startManagedRun(options, run, permission.id)
    writeJSON(response, 202, {
      request_id: permissionMatch[1],
      decision,
      scope: resolved.scope,
      status: 'recorded',
    })
    return
  }

  const questionMatch = url.pathname.match(/^\/local\/v1\/questions\/([^/]+)$/)
  if (request.method === 'POST' && questionMatch) {
    const body = await readJSONBody<{ answers?: unknown }>(request)
    const question = options.store.userQuestionByID(questionMatch[1])
    if (!question) {
      writeJSON(response, 404, { error: 'question_not_found' })
      return
    }
    if (question.status !== 'pending') {
      writeJSON(response, 200, {
        request_id: questionMatch[1],
        status: 'already_answered',
      })
      return
    }
    const answers = normalizeQuestionAnswers(body.answers, question.questions)
    if (!answers) {
      writeJSON(response, 400, { error: 'invalid_answers' })
      return
    }
    options.store.answerUserQuestion(question.id, answers)
    const run = options.store.getRun(question.runId)
    if (!run) {
      writeJSON(response, 404, { error: 'run_not_found' })
      return
    }
    startManagedRun(options, run, undefined, question.id)
    writeJSON(response, 202, {
      request_id: questionMatch[1],
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

function normalizeQuestionAnswers(
  raw: unknown,
  questions: UserQuestionItem[],
): Record<string, string[]> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null
  }
  const source = raw as Record<string, unknown>
  const answers: Record<string, string[]> = {}
  for (const item of questions) {
    const value = source[item.question]
    if (!Array.isArray(value)) {
      return null
    }
    const choices = value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    if (choices.length === 0) {
      return null
    }
    answers[item.question] = choices.map((choice) => choice.trim())
  }
  return answers
}

function startManagedRun(
  options: ResolvedLocalHostServerOptions,
  run: LocalRun,
  resumePermissionID?: string,
  resumeQuestionID?: string,
): Promise<void> {
  const existing = options.activeRuns.get(run.id)
  if (existing) {
    return existing
  }
  const task = runHarness({
    run,
    store: options.store,
    llmGateway: currentLLMGateway(options),
    emit: () => undefined,
    resumePermissionID,
    resumeQuestionID,
    toolOptions: toolOptionsForRun(options, run.id),
  })
    .catch((error: unknown) => {
      logLocalHostError('run.failed', error, { run_id: run.id })
      const fresh = options.store.getRun(run.id)
      if (fresh && !terminalStatuses.has(fresh.status)) {
        options.store.updateRunStatus(run.id, 'failed')
        options.store.appendEvent(run.id, 'run.failed', {
          error_code: 'runner_failed',
          message: error instanceof Error ? error.message : 'Local runner failed.',
        })
      }
    })
    .finally(() => {
      options.activeRuns.delete(run.id)
      cleanupRunToolOptions(options, run.id)
    })
  options.activeRuns.set(run.id, task)
  return task
}

async function streamRun(response: ServerResponse, run: LocalRun, options: ResolvedLocalHostServerOptions): Promise<void> {
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
  let nextSeq = events.length > 0 ? Math.max(...events.map((event) => event.seq)) + 1 : 1

  if (run.status === 'queued' || run.status === 'running') {
    startManagedRun(options, run)
  }

  while (!response.destroyed) {
    const freshEvents = store.listEvents(run.id).filter((event) => event.seq >= nextSeq)
    for (const event of freshEvents) {
      writeSSE(response, event)
      nextSeq = event.seq + 1
    }

    const freshRun = store.getRun(run.id)
    const activeTask = options.activeRuns.get(run.id)
    if (!activeTask && (!freshRun || terminalStatuses.has(freshRun.status) || pausedForUserStatuses.has(freshRun.status))) {
      break
    }
    await Promise.race([sleep(100), activeTask?.catch(() => undefined) ?? sleep(100)])
  }

  response.write('data: [DONE]\n\n')
  response.end()
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function toolOptionsForRun(options: ResolvedLocalHostServerOptions, runID: string): ToolExecutionOptions {
  let toolOptions = options.toolOptionsByRun.get(runID)
  if (!toolOptions) {
    toolOptions = {}
    options.toolOptionsByRun.set(runID, toolOptions)
  }
  toolOptions.cloudToolGateway = toolOptions.cloudToolGateway ?? options.cloudSession.toolGateway()
  return toolOptions
}

function cleanupRunToolOptions(options: ResolvedLocalHostServerOptions, runID: string): void {
  const status = options.store.getRun(runID)?.status
  if (status && terminalStatuses.has(status)) {
    options.toolOptionsByRun.delete(runID)
  }
}

function clearCloudToolGateways(options: ResolvedLocalHostServerOptions): void {
  for (const toolOptions of options.toolOptionsByRun.values()) {
    delete toolOptions.cloudToolGateway
    delete toolOptions.cloudToolCapabilities
  }
}

function currentLLMGateway(options: ResolvedLocalHostServerOptions): LLMGateway | undefined {
  return options.llmGateway ?? options.cloudSession.gateway()
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

// Defensive cap mirroring the client-side trim, so a misbehaving/old client
// can never blow the model context window via the run-creation `history`.
const MAX_HISTORY_MESSAGES = 40
const MAX_HISTORY_MESSAGE_CHARS = 8000
const MAX_HISTORY_TOTAL_CHARS = 24000

function sanitizeRunHistory(raw: unknown): StoredHarnessMessage[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined
  }
  const cleaned: StoredHarnessMessage[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      continue
    }
    const role = (item as { role?: unknown }).role
    const content = (item as { content?: unknown }).content
    if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string') {
      continue
    }
    const trimmed = content.trim().slice(0, MAX_HISTORY_MESSAGE_CHARS)
    if (!trimmed) {
      continue
    }
    cleaned.push({ role, content: trimmed })
  }
  let recent = cleaned.slice(-MAX_HISTORY_MESSAGES)
  let total = recent.reduce((sum, message) => sum + message.content.length, 0)
  while (recent.length > 1 && total > MAX_HISTORY_TOTAL_CHARS) {
    total -= recent[0].content.length
    recent = recent.slice(1)
  }
  return recent.length > 0 ? recent : undefined
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

function serializeArtifactSummary(artifact: LocalArtifact): SerializedArtifactSummary {
  return {
    id: artifact.id,
    run_id: artifact.runId,
    kind: artifact.kind,
    title: artifact.title,
    content_type: artifact.contentType,
    bytes: artifact.bytes,
    tool_call_id: artifact.toolCallId,
    tool_name: artifact.toolName,
    metadata: artifact.metadata,
    created_at: artifact.createdAt,
  }
}

function serializeCheckpointSummary(checkpoint: LocalCheckpoint): SerializedCheckpointSummary {
  return {
    id: checkpoint.id,
    run_id: checkpoint.runId,
    step: checkpoint.step,
    reason: checkpoint.reason,
    messages_count: checkpoint.messages.length,
    created_at: checkpoint.createdAt,
  }
}

function serializePermission(permission: PermissionRequest) {
  return {
    id: permission.id,
    run_id: permission.runId,
    tool_call_id: permission.toolCallId,
    tool_name: permission.toolName,
    arguments: permission.arguments,
    status: permission.status,
    scope: permission.scope,
    created_at: permission.createdAt,
    resolved_at: permission.resolvedAt,
  }
}

function buildRunDiagnostics(run: LocalRun, store: LocalHostStore): LocalRunDiagnostics {
  const latestCheckpoint = store.latestCheckpoint(run.id)
  return {
    schema_version: 1,
    exported_at: new Date().toISOString(),
    local_host_version: localHostVersion,
    run: serializeRun(run, store.countEvents(run.id)),
    events: store.listEvents(run.id).map((event) => serializeEvent({
      ...event,
      payload: redactDiagnosticPayload(event.payload),
    })),
    permissions: store.listPermissions(run.id).map(serializePermission),
    artifacts: store.listArtifacts(run.id).map(serializeArtifactSummary),
    latest_checkpoint: latestCheckpoint ? serializeCheckpointSummary(latestCheckpoint) : null,
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

function parseLimit(value: string | null): number {
  if (!value) {
    return 20
  }
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(1, Math.min(Math.floor(parsed), 100)) : 20
}

function redactDiagnosticPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return redactDiagnosticValue(payload) as Record<string, unknown>
}

function redactDiagnosticValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactDiagnosticValue)
  }
  if (!value || typeof value !== 'object') {
    return value
  }
  const output: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    if ((key === 'stdout' || key === 'stderr') && typeof child === 'string') {
      output[key] = `[redacted ${child.length} chars]`
      continue
    }
    output[key] = redactDiagnosticValue(child)
  }
  return output
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
