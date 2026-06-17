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
export type LocalScheduledRun = Schemas['LocalScheduledRun']
export type LocalCloudSession = Schemas['LocalCloudSession']
export type LocalArtifact = Schemas['LocalArtifact']
export type LocalWorkspaceAuthorization = Schemas['LocalWorkspaceAuthorization']
export type LocalWorkspaceDiagnosis = Schemas['LocalWorkspaceDiagnosis']
export type LocalRunDiagnostics = Schemas['LocalRunDiagnostics']
export type LocalLarkConnection = Schemas['LocalLarkConnection']
export type LocalLarkConnectResponse = Schemas['LocalLarkConnectResponse']
export type LocalLarkConnectorStatus = Schemas['LocalLarkConnectorStatus']
export type LocalLarkPreviewCandidate = Schemas['LocalLarkPreviewCandidate']
export type LocalLarkSource = Schemas['LocalLarkSource']
export type LocalLarkStatus = Schemas['LocalLarkStatus']
export type LocalTodoItem = Schemas['LocalTodoItem']
export type PreviewLocalLarkRequest = Partial<Schemas['PreviewLocalLarkRequest']>
export type PreviewLocalLarkResponse = Schemas['PreviewLocalLarkResponse']
export type ClearLocalLarkCacheResponse = Schemas['ClearLocalLarkCacheResponse']
export type QuoteLocalTodoRequest = Partial<Schemas['QuoteLocalTodoRequest']>
export type QuoteLocalTodoResponse = Schemas['QuoteLocalTodoResponse']
type GeneratedSyncLocalLarkRequest = Schemas['SyncLocalLarkRequest']
export type SyncLocalLarkRequest = Partial<GeneratedSyncLocalLarkRequest>
export type SyncLocalLarkResponse = Schemas['SyncLocalLarkResponse']
export type UpdateLocalLarkConnectionRequest = Schemas['UpdateLocalLarkConnectionRequest']
export type UpdateLocalLarkSourceRequest = Schemas['UpdateLocalLarkSourceRequest']
export type UpdateLocalTodoItemRequest = Schemas['UpdateLocalTodoItemRequest']
export type CancelRunResponse = Schemas['CancelRunResponse']
export type InjectRunInstructionResponse = Schemas['InjectRunInstructionResponse']
export type ClearMemoryResponse = Schemas['ClearMemoryResponse']
export type McpServerInfo = Schemas['McpServerInfo']
export type McpServerCatalog = Schemas['McpServerCatalog']
export type McpServerWriteRequest = Schemas['McpServerWriteRequest']
export type McpServerWriteResponse = Schemas['McpServerWriteResponse']
export type McpServerDeleteResponse = Schemas['McpServerDeleteResponse']
export type SkillFile = Schemas['SkillFile']
export type SkillWriteRequest = Schemas['SkillWriteRequest']
export type SkillWriteResponse = Schemas['SkillWriteResponse']
export type SkillDeleteResponse = Schemas['SkillDeleteResponse']
export type LocalPermissionScope = 'once' | 'run'
export type LocalPlanApprovalDecision = 'approve' | 'modify' | 'reject'

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
/**
 * Advanced per-run knobs surfaced in the settings dialog's "Advanced" section.
 * Every field is optional: an unset field is omitted from the wire payload so
 * the daemon keeps its own env/default value. Keys mirror what
 * `runs._apply_advanced_overrides` reads on the daemon (snake_case on the wire;
 * the serializer below translates).
 */
export interface AdvancedAgentSettings {
  /** Hard cap on LLM calls per run (runaway guard). Daemon default 20. */
  maxModelCalls?: number
  /** Prior user/assistant messages forwarded into a new local run. Daemon default 40. */
  maxHistoryTurns?: number
  /** Retries for transient model gateway failures. Daemon default 2. */
  maxModelRetries?: number
  /** Retries for a failing tool before giving up. Daemon default 2. */
  maxToolRetries?: number
  /** Results the research / deep-search path requests per query. Daemon default 3. */
  researchSearchLimit?: number
  /** LLM tool-preselection: keep the N most-relevant tools. 0 = off. */
  toolSelectorMax?: number
  /** deepagents subagents (the `task` tool). Daemon default on. */
  subagents?: boolean
  /** End-of-run LLM critic reflection (extra cost). Daemon default off. */
  reflect?: boolean
  /** Run the browser tool headless. Daemon default on. */
  browserHeadless?: boolean
  /** Mid-loop tool-result critic. Daemon default off. */
  toolCritic?: 'off' | 'watch' | 'nudge' | 'block'
  /** Prompt-injection input guard. Daemon default observe. */
  inputGuard?: 'observe' | 'block'
  /** Plan-first middleware. Daemon default off. */
  planFirst?: 'off' | 'auto' | 'always'
  /** Comma-separated PII types to redact (e.g. "email,credit_card"). */
  piiRedact?: string
}

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
  /** Advanced knobs (settings dialog → "Advanced"). Omitted fields keep
   *  the daemon's env/default value. */
  advanced?: AdvancedAgentSettings
}

export type LocalRunMetadata = Record<string, unknown>

function serializeAgentSettings(settings?: AgentSettings): Record<string, unknown> | undefined {
  const src = settings
  if (!src || Object.keys(src).length === 0) return undefined
  const out: Record<string, unknown> = {}
  if (src.memory !== undefined) out.memory = src.memory
  if (src.skills !== undefined) out.skills = src.skills
  if (src.mcp !== undefined) out.mcp = src.mcp
  if (src.mcpDisabled !== undefined && src.mcpDisabled.length > 0) {
    out.mcp_disabled = src.mcpDisabled
  }
  // Advanced knobs -> flat snake_case keys the daemon's run_settings
  // reader understands. Only defined fields ship, so an untouched knob
  // leaves the daemon's own default in force.
  const adv = src.advanced
  if (adv) {
    if (adv.maxModelCalls !== undefined) out.max_model_calls = adv.maxModelCalls
    if (adv.maxHistoryTurns !== undefined) out.max_history_turns = adv.maxHistoryTurns
    if (adv.maxModelRetries !== undefined) out.max_model_retries = adv.maxModelRetries
    if (adv.maxToolRetries !== undefined) out.max_tool_retries = adv.maxToolRetries
    if (adv.researchSearchLimit !== undefined) out.research_search_limit = adv.researchSearchLimit
    if (adv.toolSelectorMax !== undefined) out.tool_selector_max = adv.toolSelectorMax
    if (adv.subagents !== undefined) out.subagents = adv.subagents
    if (adv.reflect !== undefined) out.reflect = adv.reflect
    if (adv.browserHeadless !== undefined) out.browser_headless = adv.browserHeadless
    if (adv.toolCritic !== undefined) out.tool_critic = adv.toolCritic
    if (adv.inputGuard !== undefined) out.input_guard = adv.inputGuard
    if (adv.planFirst !== undefined) out.plan_first = adv.planFirst
    if (adv.piiRedact !== undefined && adv.piiRedact.trim() !== '') {
      out.pii_redact = adv.piiRedact.trim()
    }
  }
  return Object.keys(out).length === 0 ? undefined : out
}

export async function createLocalRun(
  input: {
    goal: string
    workspacePath?: string
    history?: Array<{ role: 'user' | 'assistant'; content: string }>
    parentRunId?: string
    settings?: AgentSettings
    metadata?: LocalRunMetadata
    /** The model the user picked: 'auto' or a catalog model id. The daemon
     *  forwards it to the cloud, which resolves 'auto'/unknown → default.
     *  Omitted → daemon default ('auto'). */
    mode?: ChatMode
  },
  config: LocalHostConfig,
  fetcher: Fetcher = fetch,
): Promise<LocalRun> {
  // Translate camelCase → snake_case for the few keys the daemon
  // reads as snake_case (mcp_disabled). Everything else (memory /
  // skills / mcp) is already named the same on both sides.
  const settings = serializeAgentSettings(input.settings)
  const response = await fetcher(`${normalizeBaseURL(config.baseURL)}/local/v1/runs`, {
    method: 'POST',
    headers: localHeaders(config, true),
    body: JSON.stringify({
      goal: input.goal,
      workspace_path: input.workspacePath || undefined,
      history: input.history ?? [],
      parent_run_id: input.parentRunId || undefined,
      settings,
      metadata: input.metadata && Object.keys(input.metadata).length > 0 ? input.metadata : undefined,
      model: input.mode,
    }),
  })
  return decodeLocalResponse<LocalRun>(response)
}

export async function forkLocalRun(
  runID: string,
  input: {
    checkpointId: string
    goal?: string
    mode?: ChatMode
    settings?: AgentSettings
    metadata?: LocalRunMetadata
  },
  config: LocalHostConfig,
  fetcher: Fetcher = fetch,
): Promise<LocalRun> {
  const response = await fetcher(`${normalizeBaseURL(config.baseURL)}/local/v1/runs/${encodeURIComponent(runID)}/fork`, {
    method: 'POST',
    headers: localHeaders(config, true),
    body: JSON.stringify({
      checkpoint_id: input.checkpointId,
      goal: input.goal || undefined,
      model: input.mode || undefined,
      settings: input.settings && Object.keys(input.settings).length > 0 ? input.settings : undefined,
      metadata: input.metadata && Object.keys(input.metadata).length > 0 ? input.metadata : undefined,
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

export async function createMcpServer(
  input: McpServerWriteRequest,
  config: LocalHostConfig,
  fetcher: Fetcher = fetch,
): Promise<McpServerWriteResponse> {
  const response = await fetcher(`${normalizeBaseURL(config.baseURL)}/local/v1/mcp-servers`, {
    method: 'POST',
    headers: localHeaders(config, true),
    body: JSON.stringify(input),
  })
  return decodeLocalResponse<McpServerWriteResponse>(response)
}

export async function updateMcpServer(
  name: string,
  input: McpServerWriteRequest,
  config: LocalHostConfig,
  fetcher: Fetcher = fetch,
): Promise<McpServerWriteResponse> {
  const response = await fetcher(`${normalizeBaseURL(config.baseURL)}/local/v1/mcp-servers/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: localHeaders(config, true),
    body: JSON.stringify(input),
  })
  return decodeLocalResponse<McpServerWriteResponse>(response)
}

export async function deleteMcpServer(
  name: string,
  config: LocalHostConfig,
  fetcher: Fetcher = fetch,
): Promise<McpServerDeleteResponse> {
  const response = await fetcher(`${normalizeBaseURL(config.baseURL)}/local/v1/mcp-servers/${encodeURIComponent(name)}`, {
    method: 'DELETE',
    headers: localHeaders(config, false),
  })
  return decodeLocalResponse<McpServerDeleteResponse>(response)
}

export async function createLocalSkill(
  input: SkillWriteRequest,
  config: LocalHostConfig,
  fetcher: Fetcher = fetch,
): Promise<SkillWriteResponse> {
  const response = await fetcher(`${normalizeBaseURL(config.baseURL)}/local/v1/skills`, {
    method: 'POST',
    headers: localHeaders(config, true),
    body: JSON.stringify(input),
  })
  return decodeLocalResponse<SkillWriteResponse>(response)
}

export async function getLocalSkillFile(
  name: string,
  config: LocalHostConfig,
  fetcher: Fetcher = fetch,
): Promise<SkillFile> {
  const response = await fetcher(`${normalizeBaseURL(config.baseURL)}/local/v1/skills/${encodeURIComponent(name)}`, {
    method: 'GET',
    headers: localHeaders(config, false),
  })
  return decodeLocalResponse<SkillFile>(response)
}

export async function updateLocalSkill(
  name: string,
  input: SkillWriteRequest,
  config: LocalHostConfig,
  fetcher: Fetcher = fetch,
): Promise<SkillWriteResponse> {
  const response = await fetcher(`${normalizeBaseURL(config.baseURL)}/local/v1/skills/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: localHeaders(config, true),
    body: JSON.stringify(input),
  })
  return decodeLocalResponse<SkillWriteResponse>(response)
}

export async function deleteLocalSkill(
  name: string,
  config: LocalHostConfig,
  fetcher: Fetcher = fetch,
): Promise<SkillDeleteResponse> {
  const response = await fetcher(`${normalizeBaseURL(config.baseURL)}/local/v1/skills/${encodeURIComponent(name)}`, {
    method: 'DELETE',
    headers: localHeaders(config, false),
  })
  return decodeLocalResponse<SkillDeleteResponse>(response)
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

export async function getLocalLarkStatus(
  config: LocalHostConfig,
  fetcher: Fetcher = fetch,
): Promise<LocalLarkStatus> {
  const response = await fetcher(`${normalizeBaseURL(config.baseURL)}/local/v1/lark/status`, {
    method: 'GET',
    headers: localHeaders(config, false),
  })
  return decodeLocalResponse<LocalLarkStatus>(response)
}

export async function listLocalLarkSources(
  config: LocalHostConfig,
  fetcher: Fetcher = fetch,
): Promise<LocalLarkSource[]> {
  const response = await fetcher(`${normalizeBaseURL(config.baseURL)}/local/v1/lark/sources`, {
    method: 'GET',
    headers: localHeaders(config, false),
  })
  const body = await decodeLocalResponse<{ sources?: LocalLarkSource[] }>(response)
  return body.sources ?? []
}

export async function discoverLocalLarkSources(
  config: LocalHostConfig,
  fetcher: Fetcher = fetch,
): Promise<LocalLarkSource[]> {
  const response = await fetcher(`${normalizeBaseURL(config.baseURL)}/local/v1/lark/sources/discover`, {
    method: 'POST',
    headers: localHeaders(config, false),
  })
  const body = await decodeLocalResponse<{ sources?: LocalLarkSource[] }>(response)
  return body.sources ?? []
}

export async function updateLocalLarkSource(
  sourceID: string,
  input: UpdateLocalLarkSourceRequest,
  config: LocalHostConfig,
  fetcher: Fetcher = fetch,
): Promise<LocalLarkSource> {
  const response = await fetcher(`${normalizeBaseURL(config.baseURL)}/local/v1/lark/sources/${encodeURIComponent(sourceID)}`, {
    method: 'PATCH',
    headers: localHeaders(config, true),
    body: JSON.stringify(input),
  })
  return decodeLocalResponse<LocalLarkSource>(response)
}

export async function updateLocalLarkConnection(
  input: UpdateLocalLarkConnectionRequest,
  config: LocalHostConfig,
  fetcher: Fetcher = fetch,
): Promise<LocalLarkConnection> {
  const response = await fetcher(`${normalizeBaseURL(config.baseURL)}/local/v1/lark/connection`, {
    method: 'PATCH',
    headers: localHeaders(config, true),
    body: JSON.stringify(input),
  })
  return decodeLocalResponse<LocalLarkConnection>(response)
}

export async function listLocalTodos(
  config: LocalHostConfig,
  fetcher: Fetcher = fetch,
): Promise<LocalTodoItem[]> {
  const response = await fetcher(`${normalizeBaseURL(config.baseURL)}/local/v1/todos?provider=lark`, {
    method: 'GET',
    headers: localHeaders(config, false),
  })
  const body = await decodeLocalResponse<{ todos?: LocalTodoItem[] }>(response)
  return body.todos ?? []
}

export async function updateLocalTodoItem(
  todoID: string,
  input: UpdateLocalTodoItemRequest,
  config: LocalHostConfig,
  fetcher: Fetcher = fetch,
): Promise<LocalTodoItem> {
  const response = await fetcher(`${normalizeBaseURL(config.baseURL)}/local/v1/todos/${encodeURIComponent(todoID)}`, {
    method: 'PATCH',
    headers: localHeaders(config, true),
    body: JSON.stringify(input),
  })
  return decodeLocalResponse<LocalTodoItem>(response)
}

export async function quoteLocalTodoItem(
  todoID: string,
  input: QuoteLocalTodoRequest,
  config: LocalHostConfig,
  fetcher: Fetcher = fetch,
): Promise<QuoteLocalTodoResponse> {
  const response = await fetcher(`${normalizeBaseURL(config.baseURL)}/local/v1/todos/${encodeURIComponent(todoID)}/quote`, {
    method: 'POST',
    headers: localHeaders(config, true),
    body: JSON.stringify(input),
  })
  return decodeLocalResponse<QuoteLocalTodoResponse>(response)
}

export async function connectLocalLark(
  config: LocalHostConfig,
  fetcher: Fetcher = fetch,
): Promise<LocalLarkConnectResponse> {
  const response = await fetcher(`${normalizeBaseURL(config.baseURL)}/local/v1/lark/connect`, {
    method: 'POST',
    headers: localHeaders(config, false),
  })
  return decodeLocalResponse<LocalLarkConnectResponse>(response)
}

export async function disconnectLocalLark(
  config: LocalHostConfig,
  fetcher: Fetcher = fetch,
): Promise<LocalLarkStatus> {
  const response = await fetcher(`${normalizeBaseURL(config.baseURL)}/local/v1/lark/disconnect`, {
    method: 'POST',
    headers: localHeaders(config, false),
  })
  return decodeLocalResponse<LocalLarkStatus>(response)
}

export async function syncLocalLark(
  input: SyncLocalLarkRequest,
  config: LocalHostConfig,
  fetcher: Fetcher = fetch,
): Promise<SyncLocalLarkResponse> {
  const body: GeneratedSyncLocalLarkRequest = {
    limit: input.limit ?? 100,
    extraction_provider: input.extraction_provider ?? 'cloud_redacted',
    model: input.model ?? 'auto',
  }
  const response = await fetcher(`${normalizeBaseURL(config.baseURL)}/local/v1/lark/sync`, {
    method: 'POST',
    headers: localHeaders(config, true),
    body: JSON.stringify(body),
  })
  return decodeLocalResponse<SyncLocalLarkResponse>(response)
}

export async function previewLocalLark(
  input: PreviewLocalLarkRequest,
  config: LocalHostConfig,
  fetcher: Fetcher = fetch,
): Promise<PreviewLocalLarkResponse> {
  const response = await fetcher(`${normalizeBaseURL(config.baseURL)}/local/v1/lark/preview`, {
    method: 'POST',
    headers: localHeaders(config, true),
    body: JSON.stringify({ limit: input.limit ?? 100 }),
  })
  return decodeLocalResponse<PreviewLocalLarkResponse>(response)
}

export async function clearLocalLarkCache(
  config: LocalHostConfig,
  fetcher: Fetcher = fetch,
): Promise<ClearLocalLarkCacheResponse> {
  const response = await fetcher(`${normalizeBaseURL(config.baseURL)}/local/v1/lark/cache`, {
    method: 'DELETE',
    headers: localHeaders(config, false),
  })
  return decodeLocalResponse<ClearLocalLarkCacheResponse>(response)
}

export async function listLocalRuns(config: LocalHostConfig, fetcher: Fetcher = fetch): Promise<LocalRun[]> {
  const response = await fetcher(`${normalizeBaseURL(config.baseURL)}/local/v1/runs`, {
    method: 'GET',
    headers: localHeaders(config, false),
  })
  const body = await decodeLocalResponse<{ runs?: LocalRun[] }>(response)
  return body.runs ?? []
}

export async function listLocalSchedules(
  config: LocalHostConfig,
  options: { notifyPending?: boolean; status?: LocalScheduledRun['status'] } = {},
  fetcher: Fetcher = fetch,
): Promise<LocalScheduledRun[]> {
  const params = new URLSearchParams()
  if (options.notifyPending) {
    params.set('notify_pending', 'true')
  }
  if (options.status) {
    params.set('status', options.status)
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : ''
  const response = await fetcher(`${normalizeBaseURL(config.baseURL)}/local/v1/schedules${suffix}`, {
    method: 'GET',
    headers: localHeaders(config, false),
  })
  const body = await decodeLocalResponse<{ schedules?: LocalScheduledRun[] }>(response)
  return body.schedules ?? []
}

export async function createLocalSchedule(
  input: {
    goal: string
    runAt: string
    workspacePath?: string
    mode?: ChatMode
    history?: Array<{ role: string; content: string }>
    settings?: AgentSettings
    metadata?: LocalRunMetadata
  },
  config: LocalHostConfig,
  fetcher: Fetcher = fetch,
): Promise<LocalScheduledRun> {
  const response = await fetcher(`${normalizeBaseURL(config.baseURL)}/local/v1/schedules`, {
    method: 'POST',
    headers: localHeaders(config, true),
    body: JSON.stringify({
      goal: input.goal,
      run_at: input.runAt,
      workspace_path: input.workspacePath || undefined,
      model: input.mode || 'auto',
      history: input.history ?? [],
      settings: serializeAgentSettings(input.settings),
      metadata: input.metadata && Object.keys(input.metadata).length > 0 ? input.metadata : undefined,
    }),
  })
  return decodeLocalResponse<LocalScheduledRun>(response)
}

export async function cancelLocalSchedule(
  scheduleID: string,
  config: LocalHostConfig,
  fetcher: Fetcher = fetch,
): Promise<LocalScheduledRun> {
  const response = await fetcher(`${normalizeBaseURL(config.baseURL)}/local/v1/schedules/${encodeURIComponent(scheduleID)}`, {
    method: 'DELETE',
    headers: localHeaders(config, false),
  })
  return decodeLocalResponse<LocalScheduledRun>(response)
}

export async function markLocalScheduleNotified(
  scheduleID: string,
  config: LocalHostConfig,
  fetcher: Fetcher = fetch,
): Promise<LocalScheduledRun> {
  const response = await fetcher(`${normalizeBaseURL(config.baseURL)}/local/v1/schedules/${encodeURIComponent(scheduleID)}/notified`, {
    method: 'POST',
    headers: localHeaders(config, false),
  })
  return decodeLocalResponse<LocalScheduledRun>(response)
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

export async function injectLocalRunInstruction(
  runID: string,
  content: string,
  config: LocalHostConfig,
  fetcher: Fetcher = fetch,
): Promise<InjectRunInstructionResponse> {
  const response = await fetcher(`${normalizeBaseURL(config.baseURL)}/local/v1/runs/${encodeURIComponent(runID)}/inject`, {
    method: 'POST',
    headers: localHeaders(config, true),
    body: JSON.stringify({ content }),
  })
  return decodeLocalResponse<InjectRunInstructionResponse>(response)
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

export async function resolveLocalPlanApproval(
  requestID: string,
  decision: LocalPlanApprovalDecision,
  instructions: string | undefined,
  config: LocalHostConfig,
  fetcher: Fetcher = fetch,
): Promise<void> {
  const body: { decision: LocalPlanApprovalDecision; instructions?: string } = { decision }
  const note = instructions?.trim()
  if (note) {
    body.instructions = note
  }
  const response = await fetcher(`${normalizeBaseURL(config.baseURL)}/local/v1/plans/${encodeURIComponent(requestID)}`, {
    method: 'POST',
    headers: localHeaders(config, true),
    body: JSON.stringify(body),
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
