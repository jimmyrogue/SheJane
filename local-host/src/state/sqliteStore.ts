import { randomUUID } from 'node:crypto'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
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

const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite')
type DatabaseSyncInstance = InstanceType<typeof DatabaseSync>

interface RunRow {
  id: string
  goal: string
  workspace_path: string | null
  status: RunStatus
  created_at: string
  updated_at: string
  completed_at: string | null
  canceled_at: string | null
}

interface EventRow {
  id: string
  run_id: string
  seq: number
  event_type: string
  payload_json: string
  created_at: string
}

interface PermissionRow {
  id: string
  run_id: string
  tool_call_id: string
  tool_name: string
  arguments_json: string
  status: 'pending' | 'approved' | 'denied'
  scope?: PermissionScope
  created_at: string
  resolved_at: string | null
}

interface ArtifactRow {
  id: string
  run_id: string
  kind: ArtifactKind
  title: string
  content: string
  content_type: string
  bytes: number
  tool_call_id: string | null
  tool_name: string | null
  metadata_json: string
  created_at: string
}

interface CheckpointRow {
  id: string
  run_id: string
  step: number
  reason: string
  messages_json: string
  created_at: string
}

interface MemoryRow {
  id: string
  kind: MemoryKind
  title: string
  summary: string
  content: string
  created_at: string
  updated_at: string
}

interface WorkspaceRow {
  id: string
  path: string
  label: string
  created_at: string
  last_used_at: string
}

export class SQLiteLocalHostStore implements LocalHostStore {
  private readonly db: DatabaseSyncInstance

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new DatabaseSync(dbPath)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS local_runs (
        id TEXT PRIMARY KEY,
        goal TEXT NOT NULL,
        workspace_path TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        canceled_at TEXT
      );
      CREATE TABLE IF NOT EXISTS local_events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(run_id, seq),
        FOREIGN KEY(run_id) REFERENCES local_runs(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_local_events_run_seq ON local_events(run_id, seq);
      CREATE TABLE IF NOT EXISTS local_permissions (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        arguments_json TEXT NOT NULL,
        status TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'once',
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        FOREIGN KEY(run_id) REFERENCES local_runs(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_local_permissions_run ON local_permissions(run_id, created_at);
      CREATE TABLE IF NOT EXISTS local_artifacts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        content_type TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        tool_call_id TEXT,
        tool_name TEXT,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(run_id) REFERENCES local_runs(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_local_artifacts_run ON local_artifacts(run_id, created_at);
      CREATE TABLE IF NOT EXISTS local_checkpoints (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        step INTEGER NOT NULL,
        reason TEXT NOT NULL,
        messages_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(run_id) REFERENCES local_runs(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_local_checkpoints_run ON local_checkpoints(run_id, created_at);
      CREATE TABLE IF NOT EXISTS local_memory (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_local_memory_kind ON local_memory(kind, updated_at);
      CREATE TABLE IF NOT EXISTS local_workspaces (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_local_workspaces_last_used ON local_workspaces(last_used_at);
    `)
    ensureColumn(this.db, 'local_permissions', 'scope', "TEXT NOT NULL DEFAULT 'once'")
  }

  authorizeWorkspace(input: { path: string; label?: string }): WorkspaceAuthorization {
    const path = resolve(input.path)
    const now = new Date().toISOString()
    const existing = this.db.prepare('SELECT * FROM local_workspaces WHERE path = ?').get(path) as WorkspaceRow | undefined
    const workspace: WorkspaceAuthorization = {
      id: existing?.id ?? randomUUID(),
      path,
      label: input.label?.trim() || existing?.label || basename(path) || path,
      createdAt: existing?.created_at ?? now,
      lastUsedAt: now,
    }
    this.db
      .prepare(
        `INSERT INTO local_workspaces (id, path, label, created_at, last_used_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           label = excluded.label,
           last_used_at = excluded.last_used_at`,
      )
      .run(workspace.id, workspace.path, workspace.label, workspace.createdAt, workspace.lastUsedAt)
    return workspace
  }

  listAuthorizedWorkspaces(): WorkspaceAuthorization[] {
    const rows = this.db.prepare('SELECT * FROM local_workspaces ORDER BY last_used_at DESC').all() as unknown as WorkspaceRow[]
    return rows.map(deserializeWorkspace)
  }

  findAuthorizedWorkspace(path: string): WorkspaceAuthorization | undefined {
    const target = resolve(path)
    return this.listAuthorizedWorkspaces().find((workspace) => pathInsideRoot(workspace.path, target))
  }

  revokeWorkspace(id: string): WorkspaceAuthorization | undefined {
    const row = this.db.prepare('SELECT * FROM local_workspaces WHERE id = ?').get(id) as WorkspaceRow | undefined
    if (!row) {
      return undefined
    }
    this.db.prepare('DELETE FROM local_workspaces WHERE id = ?').run(id)
    return deserializeWorkspace(row)
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
    this.db
      .prepare(
        `INSERT INTO local_runs (id, goal, workspace_path, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(run.id, run.goal, run.workspacePath ?? null, run.status, run.createdAt, run.updatedAt)
    return run
  }

  listRuns(limit = 20): LocalRun[] {
    const normalizedLimit = Math.max(1, Math.min(limit, 100))
    const rows = this.db.prepare('SELECT * FROM local_runs ORDER BY updated_at DESC LIMIT ?').all(normalizedLimit) as unknown as RunRow[]
    return rows.map(deserializeRun)
  }

  getRun(id: string): LocalRun | undefined {
    const row = this.db.prepare('SELECT * FROM local_runs WHERE id = ?').get(id) as RunRow | undefined
    return row ? deserializeRun(row) : undefined
  }

  updateRunWorkspace(id: string, workspacePath: string): LocalRun | undefined {
    const run = this.getRun(id)
    if (!run) {
      return undefined
    }
    this.db
      .prepare('UPDATE local_runs SET workspace_path = ?, updated_at = ? WHERE id = ?')
      .run(resolve(workspacePath), new Date().toISOString(), id)
    return this.getRun(id)
  }

  countEvents(runID: string): number {
    const row = this.db.prepare('SELECT count(*) AS count FROM local_events WHERE run_id = ?').get(runID) as { count: number }
    return Number(row.count)
  }

  listEvents(runID: string): LocalEvent[] {
    const rows = this.db.prepare('SELECT * FROM local_events WHERE run_id = ? ORDER BY seq ASC').all(runID) as unknown as EventRow[]
    return rows.map(deserializeEvent)
  }

  appendEvent(runID: string, eventType: string, payload: Record<string, unknown> = {}): LocalEvent {
    if (!this.getRun(runID)) {
      throw new Error(`Run not found: ${runID}`)
    }
    const nextSeqRow = this.db.prepare('SELECT coalesce(max(seq), 0) + 1 AS next_seq FROM local_events WHERE run_id = ?').get(runID) as {
      next_seq: number
    }
    const event: LocalEvent = {
      id: randomUUID(),
      runId: runID,
      seq: Number(nextSeqRow.next_seq),
      eventType,
      payload,
      createdAt: new Date().toISOString(),
    }
    this.db
      .prepare(
        `INSERT INTO local_events (id, run_id, seq, event_type, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(event.id, event.runId, event.seq, event.eventType, JSON.stringify(event.payload), event.createdAt)
    return event
  }

  updateRunStatus(id: string, status: RunStatus, metadata: { completedAt?: string; canceledAt?: string } = {}): LocalRun | undefined {
    const run = this.getRun(id)
    if (!run) {
      return undefined
    }
    const updatedAt = new Date().toISOString()
    this.db
      .prepare(
        `UPDATE local_runs
         SET status = ?, updated_at = ?, completed_at = coalesce(?, completed_at), canceled_at = coalesce(?, canceled_at)
         WHERE id = ?`,
      )
      .run(status, updatedAt, metadata.completedAt ?? null, metadata.canceledAt ?? null, id)
    return this.getRun(id)
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
    this.db
      .prepare(
        `INSERT INTO local_permissions (id, run_id, tool_call_id, tool_name, arguments_json, status, scope, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(permission.id, permission.runId, permission.toolCallId, permission.toolName, JSON.stringify(permission.arguments), permission.status, permission.scope, permission.createdAt)
    return permission
  }

  permissionByID(id: string): PermissionRequest | undefined {
    const row = this.db.prepare('SELECT * FROM local_permissions WHERE id = ?').get(id) as PermissionRow | undefined
    return row ? deserializePermission(row) : undefined
  }

  listPermissions(runID: string): PermissionRequest[] {
    const rows = this.db.prepare('SELECT * FROM local_permissions WHERE run_id = ? ORDER BY created_at ASC').all(runID) as unknown as PermissionRow[]
    return rows.map(deserializePermission)
  }

  resolvePermission(id: string, decision: PermissionDecision, scope: PermissionScope = 'once'): PermissionRequest | undefined {
    const status = decision === 'approve' ? 'approved' : 'denied'
    const resolvedScope = decision === 'approve' ? scope : 'once'
    const resolvedAt = new Date().toISOString()
    this.db.prepare('UPDATE local_permissions SET status = ?, scope = ?, resolved_at = ? WHERE id = ?').run(status, resolvedScope, resolvedAt, id)
    return this.permissionByID(id)
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
    this.db
      .prepare(
        `INSERT INTO local_artifacts
           (id, run_id, kind, title, content, content_type, bytes, tool_call_id, tool_name, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        artifact.id,
        artifact.runId,
        artifact.kind,
        artifact.title,
        artifact.content,
        artifact.contentType,
        artifact.bytes,
        artifact.toolCallId ?? null,
        artifact.toolName ?? null,
        JSON.stringify(artifact.metadata),
        artifact.createdAt,
      )
    return artifact
  }

  getArtifact(id: string): LocalArtifact | undefined {
    const row = this.db.prepare('SELECT * FROM local_artifacts WHERE id = ?').get(id) as ArtifactRow | undefined
    return row ? deserializeArtifact(row) : undefined
  }

  listArtifacts(runID: string): LocalArtifact[] {
    const rows = this.db.prepare('SELECT * FROM local_artifacts WHERE run_id = ? ORDER BY created_at ASC').all(runID) as unknown as ArtifactRow[]
    return rows.map(deserializeArtifact)
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
    this.db
      .prepare(
        `INSERT INTO local_checkpoints (id, run_id, step, reason, messages_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(checkpoint.id, checkpoint.runId, checkpoint.step, checkpoint.reason, JSON.stringify(checkpoint.messages), checkpoint.createdAt)
    return checkpoint
  }

  latestCheckpoint(runID: string): LocalCheckpoint | undefined {
    const row = this.db
      .prepare('SELECT * FROM local_checkpoints WHERE run_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(runID) as CheckpointRow | undefined
    return row ? deserializeCheckpoint(row) : undefined
  }

  upsertMemory(input: { id?: string; kind: MemoryKind; title: string; summary: string; content: string }): LocalMemoryEntry {
    const now = new Date().toISOString()
    const id = input.id ?? randomUUID()
    const existing = this.db.prepare('SELECT * FROM local_memory WHERE id = ?').get(id) as MemoryRow | undefined
    const entry: LocalMemoryEntry = {
      id,
      kind: input.kind,
      title: input.title,
      summary: input.summary,
      content: input.content,
      createdAt: existing?.created_at ?? now,
      updatedAt: now,
    }
    this.db
      .prepare(
        `INSERT INTO local_memory (id, kind, title, summary, content, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind,
           title = excluded.title,
           summary = excluded.summary,
           content = excluded.content,
           updated_at = excluded.updated_at`,
      )
      .run(entry.id, entry.kind, entry.title, entry.summary, entry.content, entry.createdAt, entry.updatedAt)
    return entry
  }

  listMemoryIndex(): LocalMemoryEntry[] {
    const rows = this.db.prepare('SELECT * FROM local_memory WHERE kind = ? ORDER BY title ASC').all('index') as unknown as MemoryRow[]
    return rows.map(deserializeMemory)
  }

  searchMemoryTopics(query: string, limit = 3): LocalMemoryEntry[] {
    const tokens = tokenize(query)
    const rows = this.db.prepare('SELECT * FROM local_memory WHERE kind = ?').all('topic') as unknown as MemoryRow[]
    return rows
      .map(deserializeMemory)
      .map((entry) => ({ entry, score: scoreMemory(entry, tokens) }))
      .filter((scored) => scored.score > 0)
      .sort((left, right) => right.score - left.score || left.entry.title.localeCompare(right.entry.title))
      .slice(0, limit)
      .map((scored) => scored.entry)
  }

  close(): void {
    this.db.close()
  }
}

function pathInsideRoot(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function deserializeRun(row: RunRow): LocalRun {
  return {
    id: row.id,
    goal: row.goal,
    workspacePath: row.workspace_path ?? undefined,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? undefined,
    canceledAt: row.canceled_at ?? undefined,
  }
}

function deserializeEvent(row: EventRow): LocalEvent {
  return {
    id: row.id,
    runId: row.run_id,
    seq: row.seq,
    eventType: row.event_type,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    createdAt: row.created_at,
  }
}

function deserializePermission(row: PermissionRow): PermissionRequest {
  return {
    id: row.id,
    runId: row.run_id,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    arguments: JSON.parse(row.arguments_json) as Record<string, unknown>,
    status: row.status,
    scope: row.scope === 'run' ? 'run' : 'once',
    createdAt: row.created_at,
    resolvedAt: row.resolved_at ?? undefined,
  }
}

function ensureColumn(db: DatabaseSyncInstance, tableName: string, columnName: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as unknown as Array<{ name: string }>
  if (columns.some((column) => column.name === columnName)) {
    return
  }
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`)
}

function deserializeArtifact(row: ArtifactRow): LocalArtifact {
  return {
    id: row.id,
    runId: row.run_id,
    kind: row.kind,
    title: row.title,
    content: row.content,
    contentType: row.content_type,
    bytes: row.bytes,
    toolCallId: row.tool_call_id ?? undefined,
    toolName: row.tool_name ?? undefined,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    createdAt: row.created_at,
  }
}

function deserializeCheckpoint(row: CheckpointRow): LocalCheckpoint {
  return {
    id: row.id,
    runId: row.run_id,
    step: row.step,
    reason: row.reason,
    messages: JSON.parse(row.messages_json) as StoredHarnessMessage[],
    createdAt: row.created_at,
  }
}

function deserializeMemory(row: MemoryRow): LocalMemoryEntry {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    summary: row.summary,
    content: row.content,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function deserializeWorkspace(row: WorkspaceRow): WorkspaceAuthorization {
  return {
    id: row.id,
    path: row.path,
    label: row.label,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  }
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
