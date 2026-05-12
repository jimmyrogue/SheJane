import { randomUUID } from 'node:crypto'
import { basename, isAbsolute, relative, resolve } from 'node:path'
import type {
  ArtifactKind,
  LocalArtifact,
  LocalCheckpoint,
  LocalEvent,
  LocalHostStore,
  LocalMemoryEntry,
  LocalRun,
  MemoryKind,
  PermissionDecision,
  PermissionRequest,
  PermissionScope,
  RunStatus,
  StoredHarnessMessage,
  WorkspaceAuthorization,
} from '../types.js'

export class InMemoryLocalHostStore implements LocalHostStore {
  private readonly runs = new Map<string, LocalRun>()
  private readonly events = new Map<string, LocalEvent[]>()
  private readonly permissions = new Map<string, PermissionRequest>()
  private readonly artifacts = new Map<string, LocalArtifact>()
  private readonly checkpoints = new Map<string, LocalCheckpoint[]>()
  private readonly memory = new Map<string, LocalMemoryEntry>()
  private readonly workspaces = new Map<string, WorkspaceAuthorization>()

  authorizeWorkspace(input: { path: string; label?: string }): WorkspaceAuthorization {
    const path = resolve(input.path)
    const existing = this.findExactWorkspace(path)
    const now = new Date().toISOString()
    const workspace: WorkspaceAuthorization = {
      id: existing?.id ?? randomUUID(),
      path,
      label: input.label?.trim() || basename(path) || path,
      createdAt: existing?.createdAt ?? now,
      lastUsedAt: now,
    }
    this.workspaces.set(workspace.id, workspace)
    return workspace
  }

  listAuthorizedWorkspaces(): WorkspaceAuthorization[] {
    return [...this.workspaces.values()].sort((left, right) => right.lastUsedAt.localeCompare(left.lastUsedAt))
  }

  findAuthorizedWorkspace(path: string): WorkspaceAuthorization | undefined {
    const target = resolve(path)
    return this.listAuthorizedWorkspaces().find((workspace) => pathInsideRoot(workspace.path, target))
  }

  revokeWorkspace(id: string): WorkspaceAuthorization | undefined {
    const workspace = this.workspaces.get(id)
    if (!workspace) {
      return undefined
    }
    this.workspaces.delete(id)
    return workspace
  }

  createRun(input: { goal: string; workspacePath?: string }): LocalRun {
    const now = new Date().toISOString()
    const run: LocalRun = {
      id: randomUUID(),
      goal: input.goal,
      workspacePath: input.workspacePath,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
    }
    this.runs.set(run.id, run)
    this.events.set(run.id, [])
    return run
  }

  listRuns(limit = 20): LocalRun[] {
    return [...this.runs.values()]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, Math.max(1, Math.min(limit, 100)))
  }

  getRun(id: string): LocalRun | undefined {
    return this.runs.get(id)
  }

  updateRunWorkspace(id: string, workspacePath: string): LocalRun | undefined {
    const run = this.runs.get(id)
    if (!run) {
      return undefined
    }
    const next: LocalRun = {
      ...run,
      workspacePath: resolve(workspacePath),
      updatedAt: new Date().toISOString(),
    }
    this.runs.set(id, next)
    return next
  }

  countEvents(runID: string): number {
    return this.events.get(runID)?.length ?? 0
  }

  listEvents(runID: string): LocalEvent[] {
    return [...(this.events.get(runID) ?? [])].sort((left, right) => left.seq - right.seq)
  }

  appendEvent(runID: string, eventType: string, payload: Record<string, unknown> = {}): LocalEvent {
    const existing = this.events.get(runID)
    if (!existing) {
      throw new Error(`Run not found: ${runID}`)
    }
    const event: LocalEvent = {
      id: randomUUID(),
      runId: runID,
      seq: existing.length + 1,
      eventType,
      payload,
      createdAt: new Date().toISOString(),
    }
    existing.push(event)
    return event
  }

  updateRunStatus(id: string, status: RunStatus, metadata: { completedAt?: string; canceledAt?: string } = {}): LocalRun | undefined {
    const run = this.runs.get(id)
    if (!run) {
      return undefined
    }
    const next: LocalRun = {
      ...run,
      status,
      completedAt: metadata.completedAt ?? run.completedAt,
      canceledAt: metadata.canceledAt ?? run.canceledAt,
      updatedAt: new Date().toISOString(),
    }
    this.runs.set(id, next)
    return next
  }

  createPermission(input: { runId: string; toolCallId: string; toolName: string; arguments: Record<string, unknown> }): PermissionRequest {
    const permission: PermissionRequest = {
      id: randomUUID(),
      runId: input.runId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      arguments: input.arguments,
      status: 'pending',
      scope: 'once',
      createdAt: new Date().toISOString(),
    }
    this.permissions.set(permission.id, permission)
    return permission
  }

  permissionByID(id: string): PermissionRequest | undefined {
    return this.permissions.get(id)
  }

  listPermissions(runID: string): PermissionRequest[] {
    return [...this.permissions.values()].filter((permission) => permission.runId === runID)
  }

  resolvePermission(id: string, decision: PermissionDecision, scope: PermissionScope = 'once'): PermissionRequest | undefined {
    const permission = this.permissions.get(id)
    if (!permission) {
      return undefined
    }
    const next: PermissionRequest = {
      ...permission,
      status: decision === 'approve' ? 'approved' : 'denied',
      scope: decision === 'approve' ? scope : 'once',
      resolvedAt: new Date().toISOString(),
    }
    this.permissions.set(id, next)
    return next
  }

  createArtifact(input: {
    runId: string
    kind: ArtifactKind
    title: string
    content: string
    contentType: string
    toolCallId?: string
    toolName?: string
    metadata?: Record<string, unknown>
  }): LocalArtifact {
    const artifact: LocalArtifact = {
      id: randomUUID(),
      runId: input.runId,
      kind: input.kind,
      title: input.title,
      content: input.content,
      contentType: input.contentType,
      bytes: Buffer.byteLength(input.content),
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      metadata: input.metadata ?? {},
      createdAt: new Date().toISOString(),
    }
    this.artifacts.set(artifact.id, artifact)
    return artifact
  }

  getArtifact(id: string): LocalArtifact | undefined {
    return this.artifacts.get(id)
  }

  listArtifacts(runID: string): LocalArtifact[] {
    return [...this.artifacts.values()].filter((artifact) => artifact.runId === runID)
  }

  createCheckpoint(input: { runId: string; step: number; reason: string; messages: StoredHarnessMessage[] }): LocalCheckpoint {
    const checkpoint: LocalCheckpoint = {
      id: randomUUID(),
      runId: input.runId,
      step: input.step,
      reason: input.reason,
      messages: structuredClone(input.messages),
      createdAt: new Date().toISOString(),
    }
    const existing = this.checkpoints.get(input.runId) ?? []
    existing.push(checkpoint)
    this.checkpoints.set(input.runId, existing)
    return checkpoint
  }

  latestCheckpoint(runID: string): LocalCheckpoint | undefined {
    return this.checkpoints.get(runID)?.at(-1)
  }

  upsertMemory(input: { id?: string; kind: MemoryKind; title: string; summary: string; content: string }): LocalMemoryEntry {
    const now = new Date().toISOString()
    const existing = input.id ? this.memory.get(input.id) : undefined
    const entry: LocalMemoryEntry = {
      id: input.id ?? randomUUID(),
      kind: input.kind,
      title: input.title,
      summary: input.summary,
      content: input.content,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    this.memory.set(entry.id, entry)
    return entry
  }

  listMemoryIndex(): LocalMemoryEntry[] {
    return [...this.memory.values()]
      .filter((entry) => entry.kind === 'index')
      .sort((left, right) => left.title.localeCompare(right.title))
  }

  searchMemoryTopics(query: string, limit = 3): LocalMemoryEntry[] {
    const tokens = tokenize(query)
    return [...this.memory.values()]
      .filter((entry) => entry.kind === 'topic')
      .map((entry) => ({ entry, score: scoreMemory(entry, tokens) }))
      .filter((scored) => scored.score > 0)
      .sort((left, right) => right.score - left.score || left.entry.title.localeCompare(right.entry.title))
      .slice(0, limit)
      .map((scored) => scored.entry)
  }

  private findExactWorkspace(path: string): WorkspaceAuthorization | undefined {
    return [...this.workspaces.values()].find((workspace) => workspace.path === path)
  }
}

function pathInsideRoot(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
}

function scoreMemory(entry: LocalMemoryEntry, tokens: string[]): number {
  const haystack = `${entry.title}\n${entry.summary}\n${entry.content}`.toLowerCase()
  return tokens.reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0)
}
