import type { AgentRunEvent } from '../api/sse'
import { streamAgentSSE } from '../streaming/streamTransport'

export interface DesktopBridge {
  platform: string
  localHost?: {
    baseURL?: string
    token?: string
  }
}

export interface LocalHostConfig {
  baseURL: string
  token?: string
}

export type LocalPermissionScope = 'once' | 'run'

export interface LocalHostProbe {
  online: boolean
  status?: string
  mode?: string
  worker?: string
}

export interface LocalRun {
  id: string
  goal: string
  status: string
  workspace_path?: string
  created_at: string
  updated_at: string
  completed_at?: string
  canceled_at?: string
  events_count?: number
}

export interface LocalArtifact {
  id: string
  title: string
  content: string
  tool_name?: string
  created_at?: string
}

export interface LocalWorkspaceAuthorization {
  id: string
  path: string
  label: string
  created_at?: string
  last_used_at?: string
}

export interface LocalWorkspaceDiagnosis {
  path: string
  exists: boolean
  is_directory: boolean
  authorized: boolean
  reason: 'authorized' | 'not_authorized' | 'not_found' | 'not_directory'
  workspace?: LocalWorkspaceAuthorization
}

export interface LocalRunDiagnostics {
  schema_version: 1
  exported_at: string
  local_host_version?: string
  run: LocalRun
  events: AgentRunEvent[]
  permissions: Array<{
    id: string
    run_id: string
    tool_call_id: string
    tool_name: string
    arguments: Record<string, unknown>
    status: string
    scope?: LocalPermissionScope
    created_at: string
    resolved_at?: string
  }>
  artifacts: Array<{
    id: string
    run_id: string
    kind: string
    title: string
    content_type: string
    bytes: number
    tool_call_id?: string
    tool_name?: string
    metadata?: Record<string, unknown>
    created_at: string
  }>
  latest_checkpoint: {
    id: string
    run_id?: string
    step: number
    reason: string
    messages_count: number
    created_at?: string
  } | null
}

export interface LocalCloudSession {
  connected: boolean
  cloud_base_url?: string
  auth?: 'bearer'
  updated_at?: string
}

export interface LocalStreamHandlers {
  onDelta: (content: string, event: AgentRunEvent) => void
  onEvent: (event: AgentRunEvent) => void
}

type Fetcher = typeof fetch

export function getDesktopLocalHostConfig(bridge: DesktopBridge | undefined = window.jiandanDesktop): LocalHostConfig | undefined {
  const baseURL = bridge?.localHost?.baseURL?.trim()
  if (!baseURL) {
    return undefined
  }
  const token = bridge?.localHost?.token?.trim() || import.meta.env.VITE_JIANDANLY_LOCAL_HOST_TOKEN?.trim()
  return {
    baseURL,
    token: token || undefined,
  }
}

export function getDesktopLocalHostBaseURL(bridge: DesktopBridge | undefined = window.jiandanDesktop): string | undefined {
  return getDesktopLocalHostConfig(bridge)?.baseURL
}

export async function probeLocalHost(baseURL: string, fetcher: Fetcher = fetch): Promise<LocalHostProbe> {
  const controller = new AbortController()
  // `globalThis.setTimeout` so this works in both browser (Electron
  // renderer) and Node (contract tests against a live daemon, which
  // run under vitest's node env).
  const timeout = globalThis.setTimeout(() => controller.abort(), 1200)
  try {
    const response = await fetcher(`${baseURL.replace(/\/$/, '')}/local/v1/health`, {
      signal: controller.signal,
    })
    if (!response.ok) {
      return { online: false }
    }
    const body = (await response.json()) as { status?: string; mode?: string; worker?: string }
    return {
      online: body.status === 'ok',
      status: body.status,
      mode: body.mode,
      worker: body.worker,
    }
  } catch {
    return { online: false }
  } finally {
    globalThis.clearTimeout(timeout)
  }
}

/**
 * User-configurable per-run agent settings. Sent with every run-create request
 * and applied by local-host (overriding its env defaults). Open-ended shape so
 * more knobs can be surfaced later; only `memory` is exposed today.
 */
export interface AgentSettings {
  memory?: 'off' | 'on'
  skills?: 'off' | 'on'
}

export async function createLocalRun(
  input: {
    goal: string
    workspacePath?: string
    history?: Array<{ role: 'user' | 'assistant'; content: string }>
    parentRunId?: string
    settings?: AgentSettings
  },
  config: LocalHostConfig,
  fetcher: Fetcher = fetch,
): Promise<LocalRun> {
  const settings =
    input.settings && Object.keys(input.settings).length > 0 ? input.settings : undefined
  const response = await fetcher(`${normalizeBaseURL(config.baseURL)}/local/v1/runs`, {
    method: 'POST',
    headers: localHeaders(config, true),
    body: JSON.stringify({
      goal: input.goal,
      workspace_path: input.workspacePath || undefined,
      history: input.history ?? [],
      parent_run_id: input.parentRunId || undefined,
      settings,
    }),
  })
  return decodeLocalResponse<LocalRun>(response)
}

export interface InstalledSkill {
  name: string
  description: string
  path: string
}

export interface RegistrySkill {
  id: string
  skillId: string
  name: string
  installs: number
  source: string
}

export interface SkillInstallOutcome {
  ok: boolean
  code?: number | null
  stdout?: string
  stderr?: string
  error?: string
}

export async function listInstalledSkills(
  config: LocalHostConfig,
  fetcher: Fetcher = fetch,
): Promise<InstalledSkill[]> {
  const response = await fetcher(`${normalizeBaseURL(config.baseURL)}/local/v1/skills`, {
    method: 'GET',
    headers: localHeaders(config, false),
  })
  const body = await decodeLocalResponse<{ skills?: InstalledSkill[] }>(response)
  return body.skills ?? []
}

export async function searchSkillRegistry(
  query: string,
  config: LocalHostConfig,
  fetcher: Fetcher = fetch,
): Promise<{ skills: RegistrySkill[]; error?: string }> {
  const response = await fetcher(
    `${normalizeBaseURL(config.baseURL)}/local/v1/skills/registry?q=${encodeURIComponent(query)}`,
    { method: 'GET', headers: localHeaders(config, false) },
  )
  const body = await decodeLocalResponse<{ skills?: RegistrySkill[]; error?: string }>(response)
  return { skills: body.skills ?? [], error: body.error }
}

export async function installSkill(
  input: { source: string; skillId: string },
  config: LocalHostConfig,
  fetcher: Fetcher = fetch,
): Promise<SkillInstallOutcome> {
  const response = await fetcher(`${normalizeBaseURL(config.baseURL)}/local/v1/skills/install`, {
    method: 'POST',
    headers: localHeaders(config, true),
    body: JSON.stringify({ source: input.source, skillId: input.skillId }),
  })
  let body: SkillInstallOutcome
  try {
    body = (await response.json()) as SkillInstallOutcome
  } catch {
    body = { ok: false, error: `Local Host HTTP ${response.status}` }
  }
  return { ...body, ok: response.ok && body.ok !== false }
}

export async function setLocalCloudSession(
  input: { cloudBaseURL: string; accessToken: string },
  config: LocalHostConfig,
  fetcher: Fetcher = fetch,
): Promise<LocalCloudSession> {
  const response = await fetcher(`${normalizeBaseURL(config.baseURL)}/local/v1/session`, {
    method: 'POST',
    headers: localHeaders(config, true),
    body: JSON.stringify({
      cloud_base_url: input.cloudBaseURL,
      access_token: input.accessToken,
    }),
  })
  return decodeLocalResponse<LocalCloudSession>(response)
}

export async function clearLocalCloudSession(config: LocalHostConfig, fetcher: Fetcher = fetch): Promise<LocalCloudSession> {
  const response = await fetcher(`${normalizeBaseURL(config.baseURL)}/local/v1/session`, {
    method: 'DELETE',
    headers: localHeaders(config, false),
  })
  return decodeLocalResponse<LocalCloudSession>(response)
}

export async function listLocalRuns(config: LocalHostConfig, fetcher: Fetcher = fetch): Promise<LocalRun[]> {
  const response = await fetcher(`${normalizeBaseURL(config.baseURL)}/local/v1/runs`, {
    method: 'GET',
    headers: localHeaders(config, false),
  })
  const body = await decodeLocalResponse<{ runs?: LocalRun[] }>(response)
  return body.runs ?? []
}

export async function getLocalRunDiagnostics(
  runID: string,
  config: LocalHostConfig,
  fetcher: Fetcher = fetch,
): Promise<LocalRunDiagnostics> {
  const response = await fetcher(`${normalizeBaseURL(config.baseURL)}/local/v1/runs/${encodeURIComponent(runID)}/diagnostics`, {
    method: 'GET',
    headers: localHeaders(config, false),
  })
  return decodeLocalResponse<LocalRunDiagnostics>(response)
}

export async function listAuthorizedWorkspaces(config: LocalHostConfig, fetcher: Fetcher = fetch): Promise<LocalWorkspaceAuthorization[]> {
  const response = await fetcher(`${normalizeBaseURL(config.baseURL)}/local/v1/workspaces`, {
    method: 'GET',
    headers: localHeaders(config, false),
  })
  const body = await decodeLocalResponse<{ workspaces?: LocalWorkspaceAuthorization[] }>(response)
  return body.workspaces ?? []
}

export async function authorizeLocalWorkspace(
  path: string,
  config: LocalHostConfig,
  fetcher: Fetcher = fetch,
): Promise<LocalWorkspaceAuthorization> {
  const response = await fetcher(`${normalizeBaseURL(config.baseURL)}/local/v1/workspaces`, {
    method: 'POST',
    headers: localHeaders(config, true),
    body: JSON.stringify({ path }),
  })
  return decodeLocalResponse<LocalWorkspaceAuthorization>(response)
}

export async function diagnoseLocalWorkspace(
  path: string,
  config: LocalHostConfig,
  fetcher: Fetcher = fetch,
): Promise<LocalWorkspaceDiagnosis> {
  const response = await fetcher(`${normalizeBaseURL(config.baseURL)}/local/v1/workspaces/diagnose`, {
    method: 'POST',
    headers: localHeaders(config, true),
    body: JSON.stringify({ path }),
  })
  return decodeLocalResponse<LocalWorkspaceDiagnosis>(response)
}

export async function revokeLocalWorkspace(
  workspaceID: string,
  config: LocalHostConfig,
  fetcher: Fetcher = fetch,
): Promise<LocalWorkspaceAuthorization> {
  const response = await fetcher(`${normalizeBaseURL(config.baseURL)}/local/v1/workspaces/${encodeURIComponent(workspaceID)}`, {
    method: 'DELETE',
    headers: localHeaders(config, false),
  })
  return decodeLocalResponse<LocalWorkspaceAuthorization>(response)
}

export async function streamLocalRun(
  runID: string,
  config: LocalHostConfig,
  handlers: LocalStreamHandlers,
  fetcher: Fetcher = fetch,
): Promise<{ completed: boolean }> {
  const response = await fetcher(`${normalizeBaseURL(config.baseURL)}/local/v1/runs/${encodeURIComponent(runID)}/stream`, {
    method: 'GET',
    headers: localHeaders(config, false),
  })
  if (!response.ok || !response.body) {
    throw new Error(await localErrorMessage(response))
  }
  const result = await streamAgentSSE(response, {
    onEvent: (event) => handlers.onEvent(event),
    onDelta: (content, event) => handlers.onDelta(content, event),
  })
  return { completed: result.completed }
}

export async function resolveLocalPermission(
  requestID: string,
  decision: 'approve' | 'deny',
  config: LocalHostConfig,
  optionsOrFetcher: { scope?: LocalPermissionScope } | Fetcher = {},
  maybeFetcher: Fetcher = fetch,
): Promise<void> {
  const options = typeof optionsOrFetcher === 'function' ? {} : optionsOrFetcher
  const fetcher = typeof optionsOrFetcher === 'function' ? optionsOrFetcher : maybeFetcher
  const scope = options.scope === 'run' ? 'run' : 'once'
  const response = await fetcher(`${normalizeBaseURL(config.baseURL)}/local/v1/permissions/${encodeURIComponent(requestID)}`, {
    method: 'POST',
    headers: localHeaders(config, true),
    body: JSON.stringify(scope === 'run' ? { decision, scope } : { decision }),
  })
  if (!response.ok) {
    throw new Error(await localErrorMessage(response))
  }
}

export async function answerLocalQuestion(
  requestID: string,
  answers: Record<string, string[]>,
  config: LocalHostConfig,
  fetcher: Fetcher = fetch,
): Promise<void> {
  const response = await fetcher(`${normalizeBaseURL(config.baseURL)}/local/v1/questions/${encodeURIComponent(requestID)}`, {
    method: 'POST',
    headers: localHeaders(config, true),
    body: JSON.stringify({ answers }),
  })
  if (!response.ok) {
    throw new Error(await localErrorMessage(response))
  }
}

export async function getLocalArtifact(artifactID: string, config: LocalHostConfig, fetcher: Fetcher = fetch): Promise<LocalArtifact> {
  const response = await fetcher(`${normalizeBaseURL(config.baseURL)}/local/v1/artifacts/${encodeURIComponent(artifactID)}`, {
    method: 'GET',
    headers: localHeaders(config, false),
  })
  return decodeLocalResponse<LocalArtifact>(response)
}

function localHeaders(config: LocalHostConfig, withContentType: boolean): HeadersInit {
  const headers: HeadersInit = withContentType ? { 'Content-Type': 'application/json' } : {}
  if (config.token) {
    headers.Authorization = `Bearer ${config.token}`
  }
  return headers
}

function normalizeBaseURL(baseURL: string): string {
  return baseURL.replace(/\/$/, '')
}

async function decodeLocalResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(await localErrorMessage(response))
  }
  return (await response.json()) as T
}

async function localErrorMessage(response: Response): Promise<string> {
  try {
    // FastAPI's `HTTPException(detail=...)` puts the message in `detail`;
    // some daemon routes use `{error}` or `{message}`. Accept all three —
    // otherwise the UI shows the generic `Local Host HTTP 4xx` for every
    // failure and the actual reason ("goal required", "permission not
    // found", etc.) gets lost.
    const body = (await response.json()) as {
      detail?: string
      error?: string
      message?: string
    }
    return body.message || body.error || body.detail || `Local Host HTTP ${response.status}`
  } catch {
    return `Local Host HTTP ${response.status}`
  }
}
