import { parseAgentSSEBuffer, type AgentRunEvent } from '../api/sse'

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
  const timeout = window.setTimeout(() => controller.abort(), 1200)
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
    window.clearTimeout(timeout)
  }
}

export async function createLocalRun(
  input: { goal: string; workspacePath?: string },
  config: LocalHostConfig,
  fetcher: Fetcher = fetch,
): Promise<LocalRun> {
  const response = await fetcher(`${normalizeBaseURL(config.baseURL)}/local/v1/runs`, {
    method: 'POST',
    headers: localHeaders(config, true),
    body: JSON.stringify({
      goal: input.goal,
      workspace_path: input.workspacePath || undefined,
    }),
  })
  return decodeLocalResponse<LocalRun>(response)
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
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let done = false
  let completed = false
  while (!done) {
    const result = await reader.read()
    done = result.done
    buffer += decoder.decode(result.value ?? new Uint8Array(), { stream: !done })
    const parsed = parseAgentSSEBuffer(buffer)
    buffer = parsed.rest
    for (const parsedEvent of parsed.events) {
      if (parsedEvent.type !== 'agent') {
        if (parsedEvent.type === 'done') {
          completed = true
        }
        continue
      }
      handlers.onEvent(parsedEvent.event)
      if (parsedEvent.event.event_type === 'llm.delta') {
        const content = parsedEvent.event.payload?.content
        if (typeof content === 'string') {
          handlers.onDelta(content, parsedEvent.event)
        }
      }
    }
  }
  return { completed }
}

export async function resolveLocalPermission(
  requestID: string,
  decision: 'approve' | 'deny',
  config: LocalHostConfig,
  fetcher: Fetcher = fetch,
): Promise<void> {
  const response = await fetcher(`${normalizeBaseURL(config.baseURL)}/local/v1/permissions/${encodeURIComponent(requestID)}`, {
    method: 'POST',
    headers: localHeaders(config, true),
    body: JSON.stringify({ decision }),
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
    const body = (await response.json()) as { error?: string; message?: string }
    return body.message || body.error || `Local Host HTTP ${response.status}`
  } catch {
    return `Local Host HTTP ${response.status}`
  }
}
