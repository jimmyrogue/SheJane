import type { AgentRunEvent } from '../api/sse'
import type { ChatMode } from '../local-data/types'
import { streamAgentSSE } from '../streaming/streamTransport'
import type { components } from './generated'

// -- Auto-generated types ----------------------------------------------------
//
// The daemon owns these shapes via pydantic models in
// `local-host/python/local_host/api_schemas.py`. `make schemas`
// regenerates `openapi.json` + `generated.d.ts`. Don't hand-edit the
// re-exports — change the pydantic model, regenerate, commit both.
//
// `Schemas` is the union of every component schema FastAPI emitted.
// We re-export individual names as aliases so call-sites stay
// readable (`LocalRun` vs `components['schemas']['LocalRun']`).
type Schemas = components['schemas']

export type LocalRun = Schemas['LocalRun']
export type LocalCloudSession = Schemas['LocalCloudSession']
export type LocalArtifact = Schemas['LocalArtifact']
export type LocalWorkspaceAuthorization = Schemas['LocalWorkspaceAuthorization']
export type LocalWorkspaceDiagnosis = Schemas['LocalWorkspaceDiagnosis']
export type LocalRunDiagnostics = Schemas['LocalRunDiagnostics']
export type CancelRunResponse = Schemas['CancelRunResponse']
export type ClearMemoryResponse = Schemas['ClearMemoryResponse']
export type McpServerInfo = Schemas['McpServerInfo']
export type McpServerCatalog = Schemas['McpServerCatalog']
export type LocalPermissionScope = 'once' | 'run'

// -- Hand-written types (not in OpenAPI) -------------------------------------
//
// Things below this line aren't derivable from openapi.json:
//   • DesktopBridge — Electron preload contract (no HTTP involvement).
//   • LocalHostConfig — client-side fetch parameters.
//   • LocalHostProbe — the client probe returns a DERIVED `online`
//     bool, not the raw HealthResponse.
//   • LocalStreamHandlers — SSE callback shape. Event payloads live
//     in `AgentRunEvent` which is hand-written because discriminated
//     unions over `event_type` don't roundtrip cleanly through openapi.

export interface DesktopBridge {
  platform: string
  localHost?: {
    baseURL?: string
    token?: string
  }
  /** Open a file with the OS's default application. Returns "" on
   *  success or an error message string on failure (mirrors
   *  Electron's `shell.openPath` contract). Used by the right-side
   *  PptxPreview component's "Open in PowerPoint" button. */
  openFileWithDefaultApp?: (filePath: string) => Promise<string>
  /** Reveal a file in Finder / Explorer with the file highlighted
   *  in its containing folder. Returns 'ok' on success or an error
   *  string. Used by the message-bubble attachment chip's external-
   *  open button for local workspace files. */
  showItemInFolder?: (filePath: string) => Promise<string>
}

export interface LocalHostConfig {
  baseURL: string
  token?: string
}

export interface LocalHostProbe {
  online: boolean
  status?: string
  mode?: string
  worker?: string
}

export interface LocalStreamHandlers {
  onDelta: (content: string, event: AgentRunEvent) => void
  onEvent: (event: AgentRunEvent) => void
}

type Fetcher = typeof fetch

export function getDesktopLocalHostConfig(bridge: DesktopBridge | undefined = window.shejaneDesktop): LocalHostConfig | undefined {
  const baseURL = bridge?.localHost?.baseURL?.trim()
  if (!baseURL) {
    return undefined
  }
  const token = bridge?.localHost?.token?.trim() || import.meta.env.VITE_SHEJANE_LOCAL_HOST_TOKEN?.trim()
  return {
    baseURL,
    token: token || undefined,
  }
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
  mcp?: 'off' | 'on'
  /** Per-server opt-out list. When `mcp === 'on'`, every discovered
   *  server is loaded EXCEPT names in this list. When `mcp === 'off'`
   *  this is moot (no servers load at all). Wire format is snake_case
   *  `mcp_disabled` to match the daemon's run_settings reader; the
   *  serializer below handles that. */
  mcpDisabled?: string[]
}

export async function createLocalRun(
  input: {
    goal: string
    workspacePath?: string
    history?: Array<{ role: 'user' | 'assistant'; content: string }>
    parentRunId?: string
    settings?: AgentSettings
    /** UI mode the user picked. Daemon resolves 'auto' via classifier,
     *  treats 'pro' as alias for internal 'deep'. Omitted → daemon
     *  default ('auto'). */
    mode?: ChatMode
  },
  config: LocalHostConfig,
  fetcher: Fetcher = fetch,
): Promise<LocalRun> {
  // Translate camelCase → snake_case for the few keys the daemon
  // reads as snake_case (mcp_disabled). Everything else (memory /
  // skills / mcp) is already named the same on both sides.
  const settings = (() => {
    const src = input.settings
    if (!src || Object.keys(src).length === 0) return undefined
    const out: Record<string, unknown> = {}
    if (src.memory !== undefined) out.memory = src.memory
    if (src.skills !== undefined) out.skills = src.skills
    if (src.mcp !== undefined) out.mcp = src.mcp
    if (src.mcpDisabled !== undefined && src.mcpDisabled.length > 0) {
      out.mcp_disabled = src.mcpDisabled
    }
    return Object.keys(out).length === 0 ? undefined : out
  })()
  const response = await fetcher(`${normalizeBaseURL(config.baseURL)}/local/v1/runs`, {
    method: 'POST',
    headers: localHeaders(config, true),
    body: JSON.stringify({
      goal: input.goal,
      workspace_path: input.workspacePath || undefined,
      history: input.history ?? [],
      parent_run_id: input.parentRunId || undefined,
      settings,
      mode: input.mode,
    }),
  })
  return decodeLocalResponse<LocalRun>(response)
}

export interface InstalledSkill {
  name: string
  description: string
  /** Absolute path to the skill's SKILL.md on the user's disk. */
  path: string
  /** Friendly label for the root this skill was discovered in:
   *  "shejane" for `~/.shejane/skills/`, "claude" for `~/.claude/skills/`,
   *  or the last segment for a custom `SHEJANE_LOCAL_SKILLS_PATH`. */
  source?: string
  /** Absolute path of the root directory itself, e.g.
   *  "/Users/x/.shejane/skills". Used to open the folder in Finder. */
  root_path?: string
}

/** One known skill root the daemon scans — surfaced even when empty so
 *  the UI can render a section header + "drop a SKILL.md here" hint. */
export interface SkillRoot {
  source: string
  path: string
}

export interface SkillCatalog {
  skills: InstalledSkill[]
  roots: SkillRoot[]
}

export async function listInstalledSkills(
  config: LocalHostConfig,
  fetcher: Fetcher = fetch,
): Promise<SkillCatalog> {
  const response = await fetcher(`${normalizeBaseURL(config.baseURL)}/local/v1/skills`, {
    method: 'GET',
    headers: localHeaders(config, false),
  })
  const body = await decodeLocalResponse<Partial<SkillCatalog>>(response)
  return {
    skills: body.skills ?? [],
    roots: body.roots ?? [],
  }
}

/** Discover MCP servers configured on the user's machine.
 *
 *  We never install or manage MCP servers — this just walks the same
 *  config files that Claude Desktop, Cursor, and Codex already write,
 *  plus our own canonical `~/.shejane/mcp-servers.json`. Whatever's
 *  there gets surfaced so the user can see what their agent has
 *  access to. The full env values are deliberately NOT returned
 *  (would leak secrets); only `env_keys` is exposed.
 *
 *  `sources_scanned` lists every source label we attempted to read,
 *  letting the UI render empty-state hints like "No Cursor config
 *  found at ~/.cursor/mcp.json" instead of silently hiding the
 *  section. */
export async function listMcpServers(
  config: LocalHostConfig,
  fetcher: Fetcher = fetch,
): Promise<McpServerCatalog> {
  const response = await fetcher(`${normalizeBaseURL(config.baseURL)}/local/v1/mcp-servers`, {
    method: 'GET',
    headers: localHeaders(config, false),
  })
  const body = await decodeLocalResponse<Partial<McpServerCatalog>>(response)
  return {
    servers: body.servers ?? [],
    sources_scanned: body.sources_scanned ?? [],
  }
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

/** Wipe every persisted note in the agent's long-term memory namespace.
 *
 *  Backs the "清空记忆 / Clear memory" button in the agent settings
 *  dialog. The daemon walks ("notes","global") and deletes each key,
 *  returning the count so the UI can show an accurate toast. Idempotent:
 *  calling on an empty store returns `deleted_count: 0`. */
export async function clearLocalMemory(
  config: LocalHostConfig,
  fetcher: Fetcher = fetch,
): Promise<ClearMemoryResponse> {
  const response = await fetcher(`${normalizeBaseURL(config.baseURL)}/local/v1/memory`, {
    method: 'DELETE',
    headers: localHeaders(config, false),
  })
  return decodeLocalResponse<ClearMemoryResponse>(response)
}

/** Stop a streaming run. Daemon will emit `run.canceled` on the SSE
 *  channel, which the existing stream loop already handles. Idempotent:
 *  re-calling on an already-completed run is a no-op (`canceled: false`). */
export async function cancelLocalRun(
  runID: string,
  config: LocalHostConfig,
  fetcher: Fetcher = fetch,
): Promise<CancelRunResponse> {
  const response = await fetcher(`${normalizeBaseURL(config.baseURL)}/local/v1/runs/${encodeURIComponent(runID)}/cancel`, {
    method: 'POST',
    headers: localHeaders(config, false),
  })
  return decodeLocalResponse<CancelRunResponse>(response)
}

/** Fetch the structured slide outline for a .pptx file.
 *
 *  The right-side DocPreviewPanel's PptxPreview component uses this
 *  to render an outline-style view (per-slide title + bullets +
 *  notes) — pptx has no mature pure-browser renderer, so we surface
 *  structure rather than a faithful visual.
 *
 *  Backed by GET /local/v1/pptx-outline?path=... which is gated by
 *  the same workspace authorization as workspace-files.
 */
export async function fetchPptxOutline(
  path: string,
  config: LocalHostConfig,
  fetcher: Fetcher = fetch,
): Promise<{ slides: import('@/shared/local-data/types').PptxSlideOutline[]; slide_count: number }> {
  const url = `${normalizeBaseURL(config.baseURL)}/local/v1/pptx-outline?path=${encodeURIComponent(path)}`
  const response = await fetcher(url, {
    method: 'GET',
    headers: localHeaders(config, false),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText)
    throw new Error(`pptx outline fetch failed (${response.status}): ${text}`)
  }
  return response.json()
}

/** Stream a file's bytes from an authorized workspace.
 *
 *  Backs the right-side DocPreviewPanel: docx-preview and exceljs both
 *  consume ArrayBuffer, so we hand them the bytes the daemon serves
 *  from `/local/v1/workspace-files`. The daemon rejects paths that
 *  aren't inside a previously-authorized workspace, so no extra
 *  client-side gating is needed.
 */
export async function fetchWorkspaceFile(
  path: string,
  config: LocalHostConfig,
  fetcher: Fetcher = fetch,
): Promise<ArrayBuffer> {
  const url = `${normalizeBaseURL(config.baseURL)}/local/v1/workspace-files?path=${encodeURIComponent(path)}`
  const response = await fetcher(url, {
    method: 'GET',
    headers: localHeaders(config, false),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText)
    throw new Error(`workspace file fetch failed (${response.status}): ${text}`)
  }
  return response.arrayBuffer()
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
