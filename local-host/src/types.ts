export const localHostVersion = '0.1.0'

export type RunStatus = 'queued' | 'running' | 'waiting_permission' | 'completed' | 'failed' | 'canceled'
export type PermissionPolicy = 'allow' | 'ask' | 'deny'

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  isReadOnly: boolean
  isDestructive: boolean
  isConcurrencySafe: boolean
  maxResultSize: number
  permissionPolicy: PermissionPolicy
}

export interface LocalRun {
  id: string
  goal: string
  workspacePath?: string
  status: RunStatus
  createdAt: string
  updatedAt: string
  completedAt?: string
  canceledAt?: string
}

export type PermissionDecision = 'approve' | 'deny'
export type PermissionStatus = 'pending' | 'approved' | 'denied'

export interface PermissionRequest {
  id: string
  runId: string
  toolCallId: string
  toolName: string
  arguments: Record<string, unknown>
  status: PermissionStatus
  createdAt: string
  resolvedAt?: string
}

export interface StoredHarnessMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolCallId?: string
  name?: string
  toolCalls?: Array<{
    id: string
    name: string
    arguments: Record<string, unknown>
  }>
}

export type ArtifactKind = 'tool_output'

export interface LocalArtifact {
  id: string
  runId: string
  kind: ArtifactKind
  title: string
  content: string
  contentType: string
  bytes: number
  toolCallId?: string
  toolName?: string
  metadata: Record<string, unknown>
  createdAt: string
}

export interface LocalCheckpoint {
  id: string
  runId: string
  step: number
  reason: string
  messages: StoredHarnessMessage[]
  createdAt: string
}

export type MemoryKind = 'index' | 'topic'

export interface LocalMemoryEntry {
  id: string
  kind: MemoryKind
  title: string
  summary: string
  content: string
  createdAt: string
  updatedAt: string
}

export interface WorkspaceAuthorization {
  id: string
  path: string
  label: string
  createdAt: string
  lastUsedAt: string
}

export interface WorkspaceDiagnosis {
  path: string
  exists: boolean
  isDirectory: boolean
  authorized: boolean
  reason: 'authorized' | 'not_authorized' | 'not_found' | 'not_directory'
  workspace?: WorkspaceAuthorization
}

export interface LocalEvent {
  id: string
  runId: string
  seq: number
  eventType: string
  payload: Record<string, unknown>
  createdAt: string
}

export interface SerializedRun {
  id: string
  goal: string
  workspace_path?: string
  status: RunStatus
  created_at: string
  updated_at: string
  completed_at?: string
  canceled_at?: string
  events_count?: number
}

export interface SerializedEvent {
  id: string
  run_id: string
  seq: number
  event_type: string
  payload: Record<string, unknown>
  created_at: string
}

export interface SerializedArtifact {
  id: string
  run_id: string
  kind: ArtifactKind
  title: string
  content: string
  content_type: string
  bytes: number
  tool_call_id?: string
  tool_name?: string
  metadata: Record<string, unknown>
  created_at: string
}

export interface LocalHostStore {
  authorizeWorkspace(input: { path: string; label?: string }): WorkspaceAuthorization
  listAuthorizedWorkspaces(): WorkspaceAuthorization[]
  findAuthorizedWorkspace(path: string): WorkspaceAuthorization | undefined
  revokeWorkspace(id: string): WorkspaceAuthorization | undefined
  createRun(input: { goal: string; workspacePath?: string }): LocalRun
  getRun(id: string): LocalRun | undefined
  countEvents(runID: string): number
  listEvents(runID: string): LocalEvent[]
  appendEvent(runID: string, eventType: string, payload?: Record<string, unknown>): LocalEvent
  updateRunStatus(id: string, status: RunStatus, metadata?: { completedAt?: string; canceledAt?: string }): LocalRun | undefined
  createPermission(input: { runId: string; toolCallId: string; toolName: string; arguments: Record<string, unknown> }): PermissionRequest
  permissionByID(id: string): PermissionRequest | undefined
  listPermissions(runID: string): PermissionRequest[]
  resolvePermission(id: string, decision: PermissionDecision): Promise<PermissionRequest | undefined> | PermissionRequest | undefined
  createArtifact(input: {
    runId: string
    kind: ArtifactKind
    title: string
    content: string
    contentType: string
    toolCallId?: string
    toolName?: string
    metadata?: Record<string, unknown>
  }): LocalArtifact
  getArtifact(id: string): LocalArtifact | undefined
  listArtifacts(runID: string): LocalArtifact[]
  createCheckpoint(input: { runId: string; step: number; reason: string; messages: StoredHarnessMessage[] }): LocalCheckpoint
  latestCheckpoint(runID: string): LocalCheckpoint | undefined
  upsertMemory(input: { id?: string; kind: MemoryKind; title: string; summary: string; content: string }): LocalMemoryEntry
  listMemoryIndex(): LocalMemoryEntry[]
  searchMemoryTopics(query: string, limit?: number): LocalMemoryEntry[]
  close?(): void
}
