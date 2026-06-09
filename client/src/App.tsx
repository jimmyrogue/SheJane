import { IconLayoutSidebarLeftExpand, IconTrash, IconX } from '@tabler/icons-react'
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { toast } from 'sonner'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  SheJaneAPI,
  type AuthPayload,
  type UserDocument,
  type WalletBalance,
} from './shared/api/client'
import { createAuthClient } from './shared/api/authClient'
import { uploadWithProgress } from './shared/api/uploadWithProgress'
import { createChatStore, timelineItem } from './features/chat/chatStore'
import { webToolsFromCapabilities, type CloudToolDefinition } from './shared/cloudAgentLoop'
import { AuthScreen } from './features/auth/AuthScreen'
import { ArtifactPanel } from './features/chat/components/ArtifactPanel'
import { DocPreviewPanel } from './features/chat/components/DocPreviewPanel'
import { ChatThread } from './features/chat/components/ChatThread'
import { Composer } from './features/chat/components/Composer'
import { deriveAgentHistory } from './features/chat/conversationHistory'
import { parseSkillDraft } from './features/chat/skillDraft'
import { ConversationSidebar } from './features/chat/components/ConversationSidebar'
import { SpendHistoryDialog } from './features/billing/SpendHistoryDialog'
import { DiagnosticsPanel } from './features/chat/components/DiagnosticsPanel'
import { PendingApprovalBar } from './features/chat/components/PendingApprovalBar'
import { PendingQuestionBar } from './features/chat/components/PendingQuestionBar'
import { MCPView } from './features/mcp/MCPView'
import { SkillsView } from './features/skills/SkillsView'
import { findConversationPendingApproval } from './features/chat/pendingApproval'
import { findConversationPendingQuestion } from './features/chat/pendingQuestion'
import type { AgentRunEvent } from './shared/api/sse'
import { I18nProvider, useI18n, type Translator } from './shared/i18n/i18n'
import { createLocalID, LocalConversationStore } from './shared/local-data/localConversations'
import type { AgentTimelineItem, ChatMessage, ChatMode, CloudOfficeAttachmentRef, Conversation, ConversationProject, ConversationWorkspace, LocalOfficeFileRef, OpenDocument } from './shared/local-data/types'
import {
  authorizeLocalWorkspace,
  cancelLocalRun,
  clearLocalMemory,
  createLocalRun,
  diagnoseLocalWorkspace,
  fetchWorkspaceFile,
  getLocalRunDiagnostics,
  getDesktopLocalHostConfig,
  answerLocalQuestion,
  getLocalArtifact,
  listAuthorizedWorkspaces,
  listInstalledSkills,
  listLocalRuns,
  listMcpServers,
  probeLocalHost,
  resolveLocalPermission,
  setLocalCloudSession,
  streamLocalRun,
  type AdvancedAgentSettings,
  type AgentSettings,
  type LocalArtifact,
  type LocalCloudSession,
  type LocalHostConfig,
  type LocalHostProbe,
  type LocalPermissionScope,
  type LocalRun as LocalHarnessRun,
  type LocalRunDiagnostics,
  type LocalWorkspaceDiagnosis,
  type LocalWorkspaceAuthorization,
} from './shared/local-host/client'

const documentMaxBytes = 30 * 1024 * 1024
const appNoticeToastID = 'shejane-app-notice'
const sidebarWidthStorageKey = 'shejane.sidebar.width.v1'
const sidebarCollapsedStorageKey = 'shejane.sidebar.collapsed.v1'
// v7 — dropped the codeExec field. Cloud code execution is now always
// on (no user-facing toggle): in practice every test confirmed the
// flow works, and the original opt-in friction was hurting first-run
// experience more than it was protecting privacy (files are only
// uploaded when the LLM explicitly calls code.execute with files_in,
// which already passes through the daemon-side sensitive-filename
// blacklist + size cap). Bumping the storage key wipes any leftover
// `codeExec: 'off'` from v6 storage so legacy users don't end up
// silently disabled.
const agentSettingsStorageKey = 'shejane.agentSettings.v7'
const chatModeStorageKey = 'shejane.chatMode.v1'
const defaultAgentSettings: Required<AgentSettings> = {
  memory: 'on',
  skills: 'on',
  mcp: 'on',
  mcpDisabled: [],
  // Empty = every advanced knob inherits the daemon's own default. The user
  // only ever populates the fields they explicitly change in the panel.
  advanced: {},
}
const defaultChatMode: ChatMode = 'auto'
const defaultSidebarWidth = 220
const minSidebarWidth = 176
const maxSidebarWidth = 340
const sidebarKeyboardStep = 12

interface ConversationRenderContext {
  navigationVersionAtStart: number
}

interface PendingConversationRender {
  conversation: Conversation
  context: ConversationRenderContext
}

function clampSidebarWidth(width: number): number {
  return Math.min(maxSidebarWidth, Math.max(minSidebarWidth, Math.round(width)))
}

function readSidebarWidth(): number {
  if (typeof window === 'undefined') {
    return defaultSidebarWidth
  }
  try {
    const rawWidth = window.localStorage.getItem(sidebarWidthStorageKey)
    if (!rawWidth) {
      return defaultSidebarWidth
    }
    const parsedWidth = Number(rawWidth)
    return Number.isFinite(parsedWidth) ? clampSidebarWidth(parsedWidth) : defaultSidebarWidth
  } catch {
    return defaultSidebarWidth
  }
}

function readSidebarCollapsed(): boolean {
  if (typeof window === 'undefined') {
    return false
  }
  try {
    return window.localStorage.getItem(sidebarCollapsedStorageKey) === '1'
  } catch {
    return false
  }
}

function writeSidebarCollapsed(collapsed: boolean) {
  try {
    window.localStorage.setItem(sidebarCollapsedStorageKey, collapsed ? '1' : '0')
  } catch {
    // Local storage can be unavailable in restricted browser contexts.
  }
}

function writeSidebarWidth(width: number) {
  try {
    window.localStorage.setItem(sidebarWidthStorageKey, String(clampSidebarWidth(width)))
  } catch {
    // Local storage can be unavailable in restricted browser contexts.
  }
}

function readAdvancedAgentSettings(raw: unknown): AdvancedAgentSettings {
  // Defensive read — localStorage can be hand-edited / stale. Keep only
  // well-typed, in-range values; everything else falls back to the daemon
  // default by being omitted.
  if (!raw || typeof raw !== 'object') {
    return {}
  }
  const a = raw as Record<string, unknown>
  const out: AdvancedAgentSettings = {}
  if (typeof a.maxModelCalls === 'number' && Number.isFinite(a.maxModelCalls)) {
    out.maxModelCalls = a.maxModelCalls
  }
  if (typeof a.maxToolRetries === 'number' && Number.isFinite(a.maxToolRetries)) {
    out.maxToolRetries = a.maxToolRetries
  }
  if (typeof a.researchSearchLimit === 'number' && Number.isFinite(a.researchSearchLimit)) {
    out.researchSearchLimit = a.researchSearchLimit
  }
  if (typeof a.toolSelectorMax === 'number' && Number.isFinite(a.toolSelectorMax)) {
    out.toolSelectorMax = a.toolSelectorMax
  }
  if (typeof a.subagents === 'boolean') out.subagents = a.subagents
  if (typeof a.reflect === 'boolean') out.reflect = a.reflect
  if (typeof a.browserHeadless === 'boolean') out.browserHeadless = a.browserHeadless
  if (a.toolCritic === 'off' || a.toolCritic === 'watch' || a.toolCritic === 'nudge' || a.toolCritic === 'block') {
    out.toolCritic = a.toolCritic
  }
  if (a.inputGuard === 'observe' || a.inputGuard === 'block') {
    out.inputGuard = a.inputGuard
  }
  if (a.planFirst === 'off' || a.planFirst === 'auto' || a.planFirst === 'always') {
    out.planFirst = a.planFirst
  }
  if (typeof a.piiRedact === 'string') out.piiRedact = a.piiRedact
  return out
}

function readAgentSettings(): Required<AgentSettings> {
  if (typeof window === 'undefined') {
    return { ...defaultAgentSettings }
  }
  try {
    const raw = window.localStorage.getItem(agentSettingsStorageKey)
    if (!raw) {
      return { ...defaultAgentSettings }
    }
    const parsed = JSON.parse(raw) as Partial<AgentSettings>
    return {
      // memory/skills/mcp default 'on'. Only an explicit 'off' disables;
      // a missing field reads as the new default rather than the old one.
      memory: parsed.memory === 'off' ? 'off' : 'on',
      skills: parsed.skills === 'off' ? 'off' : 'on',
      mcp: parsed.mcp === 'off' ? 'off' : 'on',
      // Defensive: anything non-string in the persisted list gets
      // dropped. Empty array if missing.
      mcpDisabled: Array.isArray(parsed.mcpDisabled)
        ? parsed.mcpDisabled.filter((name): name is string => typeof name === 'string')
        : [],
      advanced: readAdvancedAgentSettings((parsed as { advanced?: unknown }).advanced),
    }
  } catch {
    return { ...defaultAgentSettings }
  }
}

function writeAgentSettings(settings: Required<AgentSettings>) {
  try {
    window.localStorage.setItem(agentSettingsStorageKey, JSON.stringify(settings))
  } catch {
    // Local storage can be unavailable in restricted browser contexts.
  }
}

function readChatMode(): ChatMode {
  if (typeof window === 'undefined') {
    return defaultChatMode
  }
  try {
    const raw = window.localStorage.getItem(chatModeStorageKey)
    if (raw === 'fast' || raw === 'pro' || raw === 'auto') {
      return raw
    }
  } catch {
    // Local storage can be unavailable in restricted browser contexts.
  }
  return defaultChatMode
}

function writeChatMode(mode: ChatMode) {
  try {
    window.localStorage.setItem(chatModeStorageKey, mode)
  } catch {
    // Local storage can be unavailable in restricted browser contexts.
  }
}


export function App() {
  return (
    <I18nProvider>
      <AppContent />
      <Toaster position="top-center" offset={52} duration={3200} visibleToasts={1} />
    </I18nProvider>
  )
}

function AppContent() {
  const { t } = useI18n()
  const api = useMemo(() => new SheJaneAPI(), [])
  // Stable reference so SpendHistoryDialog's fetch-on-open effect doesn't
  // re-run on every parent render.
  const fetchSpendHistory = useMemo(() => () => api.transactions(), [api])
  const authClient = useMemo(() => createAuthClient(api), [api])
  const [auth, setAuth] = useState<AuthPayload | null>(null)
  // Per-user IndexedDB so switching accounts in the same Electron window does
  // not leak the previous user's conversations.
  const localData = useMemo(
    () => new LocalConversationStore(`shejane-local:${auth?.user?.id ?? 'anonymous'}`),
    [auth?.user?.id],
  )
  const chat = useMemo(() => createChatStore({ localData, api, t }), [api, localData, t])
  const pendingConversationRendersRef = useRef<Map<string, PendingConversationRender>>(new Map())
  const liveRenderTimerRef = useRef<number>()
  const activeIDRef = useRef<string | undefined>()
  const navigationVersionRef = useRef(0)
  const sidebarResizeStateRef = useRef<{ startX: number, startWidth: number } | null>(null)

  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeID, setActiveID] = useState<string>()
  const [draft, setDraft] = useState('')
  // User-selected model mode (persisted in localStorage). 'auto' lets the
  // daemon's classifier decide fast vs pro; 'fast' / 'pro' are explicit.
  const [mode, setMode] = useState<ChatMode>(readChatMode)
  function changeMode(next: ChatMode): void {
    setMode(next)
    writeChatMode(next)
  }
  const [documents, setDocuments] = useState<UserDocument[]>([])
  const [attachedDocumentID, setAttachedDocumentID] = useState<string>()
  const [attachedPreview, setAttachedPreview] = useState<string>()
  const [balance, setBalance] = useState<WalletBalance | null>(null)
  const [isSending, setIsSending] = useState(false)
  const [pendingDeleteMessageID, setPendingDeleteMessageID] = useState<string>()
  const [spendHistoryOpen, setSpendHistoryOpen] = useState(false)
  const [emailBannerDismissed, setEmailBannerDismissed] = useState(false)
  const [emailVerifySent, setEmailVerifySent] = useState(false)
  const [isUploading, setIsUploading] = useState(false)
  // 0..100 during an S3 PUT, undefined when idle. Fed by the XHR
  // upload progress listener in uploadDocument(); rendered as a
  // ring + percent overlay on the attachment chip so users get
  // continuous feedback for slow cross-border uploads (typical
  // China → AWS Singapore takes tens of seconds even with Transfer
  // Acceleration). Without it the chip just spins indefinitely and
  // users wonder if the app froze.
  const [uploadProgress, setUploadProgress] = useState<number | undefined>(undefined)
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsed)
  const [agentSettings, setAgentSettings] = useState<Required<AgentSettings>>(readAgentSettings)
  const [mainView, setMainView] = useState<'chat' | 'skills' | 'mcp'>('chat')
  const [isResizingSidebar, setIsResizingSidebar] = useState(false)
  // Web build only: cloud tools (image gen / web search) the model may call
  // via the client-orchestrated loop. Empty on desktop (the daemon owns tools)
  // and until capabilities are fetched / when none are configured.
  const [webTools, setWebTools] = useState<CloudToolDefinition[]>([])
  const [localHost, setLocalHost] = useState<LocalHostProbe | null>(null)
  const [localHostConfig, setLocalHostConfig] = useState<LocalHostConfig | null>(null)
  const [localCloudSession, setLocalCloudSessionState] = useState<LocalCloudSession | null>(null)
  const [pendingWorkspace, setPendingWorkspace] = useState<ConversationWorkspace | undefined>()
  /** Project (= workspace) the user picked in the composer before a
   *  conversation existed. Drained when `sendMessage` creates the
   *  first conversation; cleared on new-chat / select. Mirrors the
   *  `pendingWorkspace` slot — they're set together when the picker
   *  resolves, since "project" in this product means "this chat is
   *  bound to that workspace directory". */
  const [pendingProject, setPendingProject] = useState<ConversationProject | undefined>()
  const [authorizedWorkspaces, setAuthorizedWorkspaces] = useState<LocalWorkspaceAuthorization[]>([])
  const [localRuns, setLocalRuns] = useState<LocalHarnessRun[]>([])
  const [artifactPreview, setArtifactPreview] = useState<LocalArtifact | null>(null)
  const [activeDocument, setActiveDocument] = useState<OpenDocument | null>(null)
  // Bumped on `doc.changed` (Phase 2 territory) to force the renderer to
  // re-fetch the file bytes. Phase 1 only needs the initial open path.
  const [docPreviewRefreshKey, setDocPreviewRefreshKey] = useState(0)
  const [runDiagnostics, setRunDiagnostics] = useState<LocalRunDiagnostics | null>(null)

  /** Open the right-side DocPreviewPanel for a workspace-resident office
   *  file. Called from `appendLocalRunEvent` (when office.read completes)
   *  and from MessageBubble (when the user clicks a file ref in agent
   *  text). The caller hands us a LocalOfficeFileRef; we wrap it into an
   *  OpenDocument by binding `fetchWorkspaceFile` as the byte loader.
   *
   *  Bumping the refresh key forces a re-fetch even when the same path
   *  was already open — needed once Phase 2 edits land so the panel
   *  refreshes after every write. */
  function openOfficeDocument(ref: LocalOfficeFileRef) {
    if (!localHostConfig) {
      setNotice(t('app.notice.localHostDisconnected'))
      return
    }
    const cfg = localHostConfig
    setActiveDocument({
      sourceKey: `local:${ref.path}`,
      kind: ref.kind,
      name: ref.name,
      tooltip: ref.path,
      // PptxPreview doesn't actually need the bytes (it calls the
      // outline endpoint), but the panel API still requires a loader
      // — point at fetchWorkspaceFile for consistency; if a future
      // "download" affordance lands it can reuse this.
      loadBytes: () => fetchWorkspaceFile(ref.path, cfg),
      localPath: ref.path,
    })
    setDocPreviewRefreshKey((k) => k + 1)
  }

  /** Open the preview panel for a CLOUD-uploaded previewable file
   *  (.docx, .xlsx, .pdf). Used by MessageBubble for attachment-chip
   *  clicks. The byte loader hits the Go API's document-source
   *  endpoint; PdfPreview wraps the bytes in a blob URL for
   *  Chromium's built-in PDF viewer. */
  function openCloudOfficeDocument(spec: CloudOfficeAttachmentRef) {
    // Look up the full document record (if still in the user's
    // recent list) to surface its server-captured metadata —
    // pdfinfo's page count / author drive the preview header
    // badge. Missing from the list (old/expired) → undefined,
    // and the header simply omits the badge.
    const record = documents.find((document) => document.id === spec.documentId)
    setActiveDocument({
      sourceKey: `cloud:${spec.documentId}`,
      kind: spec.kind,
      name: spec.name,
      tooltip: spec.name,
      loadBytes: () => api.fetchDocumentBytes(spec.documentId),
      metadata: record?.metadata,
    })
    setDocPreviewRefreshKey((k) => k + 1)
  }

  /** Download a cloud attachment to the user's Downloads folder with
   *  its original filename. Powers the small "external open" button
   *  next to every message-bubble attachment chip — the escape hatch
   *  for files we can't preview in-app AND for power users who'd
   *  rather open the file in their native app (e.g. .docx in real
   *  Word with track-changes).
   *
   *  Implementation: fetch bytes via the existing authenticated
   *  endpoint, wrap in a blob, click a synthetic <a download> with
   *  the original filename. No Electron bridge needed — Chromium's
   *  download path handles this and writes to the OS default
   *  Downloads directory.
   *
   *  Cloud files have no stable local path so `showItemInFolder`
   *  isn't an option; the closest faithful mapping of "open the
   *  containing folder" is "let the user find it in Downloads".
   */
  async function openAttachmentExternally(ref: { documentId: string; name: string }) {
    try {
      const bytes = await api.fetchDocumentBytes(ref.documentId)
      const blob = new Blob([bytes])
      const url = URL.createObjectURL(blob)
      const anchor = window.document.createElement('a')
      anchor.href = url
      anchor.download = ref.name
      // Append + click + remove pattern: some Chromium builds need the
      // element to be in the DOM for the download to fire reliably.
      window.document.body.appendChild(anchor)
      anchor.click()
      window.document.body.removeChild(anchor)
      // Revoke a tick later so the download has time to grab the
      // URL before we invalidate it.
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : t('app.notice.downloadFailed'))
    }
  }

  function setNotice(message: string) {
    if (!message.trim()) {
      toast.dismiss(appNoticeToastID)
      return
    }
    toast.message(message, {
      id: appNoticeToastID,
      duration: 3200,
    })
  }

  // Web build only: discover which cloud tools are configured so the client
  // tool loop advertises only working ones. Desktop owns tools via the daemon,
  // so it skips this entirely.
  useEffect(() => {
    if (window.shejaneDesktop || !auth?.access_token) {
      setWebTools([])
      return
    }
    let cancelled = false
    void api
      .agentToolCapabilities()
      .then((caps) => {
        if (!cancelled) setWebTools(webToolsFromCapabilities(caps))
      })
      .catch(() => {
        if (!cancelled) setWebTools([])
      })
    return () => {
      cancelled = true
    }
  }, [api, auth?.access_token])

  useEffect(() => {
    writeSidebarWidth(sidebarWidth)
  }, [sidebarWidth])

  useEffect(() => {
    writeSidebarCollapsed(sidebarCollapsed)
  }, [sidebarCollapsed])

  /** Mirror the visible sidebar width onto `:root` so the sonner
   *  toaster — which portals to <body> and therefore can't inherit the
   *  `--sidebar-width` set on `.app-shell` — can offset its
   *  horizontal centering to land over the chat area, not the whole
   *  viewport. Collapsed sidebar → 0px; expanded → the same
   *  clamp(176, sidebarWidth, 340) used in styles.css. */
  useEffect(() => {
    const visible = sidebarCollapsed ? 0 : Math.min(340, Math.max(176, sidebarWidth))
    document.documentElement.style.setProperty('--toast-center-offset', `${visible / 2}px`)
  }, [sidebarWidth, sidebarCollapsed])

  /** Global Cmd/Ctrl+N → start a fresh conversation. Bypasses the
   *  OS-level "new window" intent because in this app it's a chat
   *  shell, not a browser. setState fns are stable across renders so
   *  the closure here stays correct without deps. */
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey
      if (!mod || event.shiftKey || event.altKey) {
        return
      }
      if (event.key !== 'n' && event.key !== 'N') {
        return
      }
      event.preventDefault()
      navigationVersionRef.current += 1
      setActiveConversationID(undefined)
      setPendingWorkspace(undefined)
      setPendingProject(undefined)
      setDraft('')
      setMainView('chat')
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  /** Listen for the tray's "New Chat" menu item — the main process
   *  sends `shejane:new-chat` after bringing the window forward. */
  useEffect(() => {
    const unsubscribe = window.shejaneDesktop?.onNewChatRequest?.(() => {
      navigationVersionRef.current += 1
      setActiveConversationID(undefined)
      setPendingWorkspace(undefined)
      setPendingProject(undefined)
      setDraft('')
      setMainView('chat')
    })
    return unsubscribe
  }, [])

  useEffect(() => {
    if (!isResizingSidebar) {
      return undefined
    }

    document.body.classList.add('sidebar-resizing')

    function handlePointerMove(event: PointerEvent) {
      const resizeState = sidebarResizeStateRef.current
      if (!resizeState || !Number.isFinite(event.clientX)) {
        return
      }
      const nextWidth = clampSidebarWidth(resizeState.startWidth + event.clientX - resizeState.startX)
      setSidebarWidth(nextWidth)
    }

    function finishResize() {
      sidebarResizeStateRef.current = null
      setIsResizingSidebar(false)
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', finishResize)
    window.addEventListener('pointercancel', finishResize)

    return () => {
      document.body.classList.remove('sidebar-resizing')
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', finishResize)
      window.removeEventListener('pointercancel', finishResize)
    }
  }, [isResizingSidebar])

  useEffect(() => {
    return () => {
      if (liveRenderTimerRef.current !== undefined) {
        window.clearTimeout(liveRenderTimerRef.current)
      }
      pendingConversationRendersRef.current.clear()
    }
  }, [])

  useEffect(() => {
    activeIDRef.current = activeID
  }, [activeID])

  useEffect(() => {
    void localData.list().then((items) => {
      setConversations(items)
      setActiveConversationID(items[0]?.id)
    })
  }, [localData])


  // Reset transient session state when the signed-in user changes, so leftovers
  // from the previous account (draft, attached doc, etc.) don't bleed across.
  useEffect(() => {
    setDraft('')
    setAttachedDocumentID(undefined)
    setAttachedPreview(undefined)
    setPendingWorkspace(undefined)
    setPendingProject(undefined)
    setDocuments([])
  }, [auth?.user?.id])

  // Let the API client silently renew an expired access token mid-session
  // (15-min TTL) using the long-lived refresh cookie, instead of bouncing
  // the user to "登录已过期". A genuinely-dead refresh token drops to login.
  useEffect(() => {
    api.setTokenRefresher(async () => {
      try {
        const payload = await authClient.refresh()
        api.setAccessToken(payload.access_token)
        setAuth(payload)
        return payload.access_token
      } catch {
        setAuth(null)
        return null
      }
    })
  }, [api, authClient])

  useEffect(() => {
    authClient
      .refresh()
      .then((payload) => {
        api.setAccessToken(payload.access_token)
        setAuth(payload)
        return Promise.all([api.balance(), api.listDocuments()])
      })
      .then(([wallet, items]) => {
        setBalance(wallet)
        setDocuments(items)
      })
      .catch(() => undefined)
  }, [api, authClient])

  // One-shot: if the app was opened from an email verification link
  // (CLIENT_BASE_URL/verify?token=…), confirm it. The endpoint is
  // unauthenticated, so this works signed-in or out. On success we clear the
  // banner optimistically + notify, then strip the token from the URL.
  useEffect(() => {
    const token = readVerifyTokenFromURL()
    if (!token) {
      return
    }
    void api
      .confirmEmailVerification({ token })
      .then(() => {
        setAuth((current) =>
          current ? { ...current, user: { ...current.user, email_verified: true } } : current,
        )
        setNotice(t('topbar.verifySuccess'))
      })
      .catch(() => setNotice(t('topbar.verifyFailed')))
      .finally(() => {
        if (typeof window !== 'undefined') {
          window.history.replaceState({}, '', window.location.pathname)
        }
      })
  }, [api, t])

  useEffect(() => {
    const config = getDesktopLocalHostConfig()
    if (!config) {
      return
    }
    setLocalHostConfig(config)
    let disposed = false
    void probeLocalHost(config.baseURL).then((probe) => {
      if (!disposed) {
        setLocalHost(probe)
      }
    })
    if (config.token) {
      void Promise.all([listAuthorizedWorkspaces(config), listLocalRuns(config)])
        .then(([workspaces, runs]) => {
          if (!disposed) {
            setAuthorizedWorkspaces(workspaces)
            setLocalRuns(runs)
          }
        })
        .catch(() => undefined)
    }
    return () => {
      disposed = true
    }
  }, [])

  useEffect(() => {
    if (!auth?.access_token || !localHost?.online || !localHostConfig?.token) {
      if (!auth) {
        setLocalCloudSessionState(null)
      }
      return
    }
    let disposed = false
    void setLocalCloudSession(
      {
        cloudBaseURL: api.baseURL,
        accessToken: auth.access_token,
      },
      localHostConfig,
    )
      .then((session) => {
        if (!disposed) {
          setLocalCloudSessionState(session)
        }
      })
      .catch(() => {
        if (!disposed) {
          setLocalCloudSessionState({ connected: false })
        }
      })
    return () => {
      disposed = true
    }
  }, [api, auth, localHost?.online, localHostConfig])

  const activeConversation = conversations.find((conversation) => conversation.id === activeID)
  // Any assistant message that's still streaming OR paused at HITL
  // counts as an "active" run from the user's perspective — the daemon
  // can still be told to cancel it. Used to keep the composer's stop
  // button visible during permission/question pauses, because the
  // isSending state flips to false the moment the SSE stream blocks.
  // Matches the precondition list in cancelActiveLocalRun below so
  // the button and the cancel function agree on what's cancelable.
  const hasActiveLocalRun = Boolean(
    activeConversation?.messages.some(
      (msg) =>
        msg.role === 'assistant' &&
        msg.runOrigin === 'local' &&
        Boolean(msg.runId) &&
        (msg.status === 'streaming' || msg.status === 'waiting_permission' || msg.status === 'waiting_input'),
    ),
  )
  const pendingApproval = findConversationPendingApproval(activeConversation, t)
  const pendingQuestion = pendingApproval ? null : findConversationPendingQuestion(activeConversation)
  const attachedDocument = documents.find((document) => document.id === attachedDocumentID)
  const activeWorkspace = activeConversation?.workspace ?? pendingWorkspace
  const selectedWorkspace = activeWorkspace ? findWorkspaceByPath(authorizedWorkspaces, activeWorkspace.path) : undefined
  const localProject = activeWorkspace
    ? {
        label: selectedWorkspace?.label ?? activeWorkspace.label,
        path: activeWorkspace.path,
        authorized: Boolean(selectedWorkspace || activeWorkspace.authorized),
      }
    : undefined

  async function handleAuth(payload: AuthPayload) {
    api.setAccessToken(payload.access_token)
    setAuth(payload)
    const [wallet, items] = await Promise.all([api.balance(), api.listDocuments()])
    setBalance(wallet)
    setDocuments(items)
  }

  async function refreshConversations(nextActiveID?: string, options: { preserveEmptyActive?: boolean } = {}) {
    const items = await localData.list()
    setConversations(items)
    setActiveConversationID(nextActiveID ?? (options.preserveEmptyActive ? undefined : items[0]?.id))
  }

  function startNewConversation() {
    navigationVersionRef.current += 1
    setActiveConversationID(undefined)
    setPendingWorkspace(undefined)
    setPendingProject(undefined)
    setDraft('')
    setMainView('chat')
  }

  function selectConversation(id: string) {
    navigationVersionRef.current += 1
    setPendingWorkspace(undefined)
    setPendingProject(undefined)
    setActiveConversationID(id)
    setMainView('chat')
  }

  function setActiveConversationID(nextActiveID: string | undefined) {
    activeIDRef.current = nextActiveID
    setActiveID(nextActiveID)
  }

  function createConversationRenderContext(): ConversationRenderContext {
    return { navigationVersionAtStart: navigationVersionRef.current }
  }

  async function refreshConversationsAfterStream(conversationID: string, context: ConversationRenderContext) {
    const userNavigatedWhileStreaming = navigationVersionRef.current !== context.navigationVersionAtStart
    await refreshConversations(userNavigatedWhileStreaming ? activeIDRef.current : conversationID, {
      preserveEmptyActive: userNavigatedWhileStreaming && !activeIDRef.current,
    })
  }

  function scheduleConversationRender(conversation: Conversation, context: ConversationRenderContext) {
    pendingConversationRendersRef.current.set(conversation.id, {
      conversation: cloneConversation(conversation),
      context,
    })
    if (liveRenderTimerRef.current !== undefined) {
      return
    }
    liveRenderTimerRef.current = window.setTimeout(() => {
      liveRenderTimerRef.current = undefined
      const pending = Array.from(pendingConversationRendersRef.current.values())
      pendingConversationRendersRef.current.clear()
      if (!pending.length) {
        return
      }
      setConversations((items) => pending.reduce((nextItems, item) => upsertConversation(nextItems, item.conversation), items))
      const focusTarget = pending.find(
        (item) =>
          activeIDRef.current === item.conversation.id ||
          navigationVersionRef.current === item.context.navigationVersionAtStart,
      )
      if (focusTarget) {
        setActiveConversationID(focusTarget.conversation.id)
      }
    }, 33)
  }

  async function sendMessage() {
    if (!auth) {
      setNotice(t('app.notice.loginBeforeSending'))
      return
    }
    if (attachedDocument && attachedDocument.status !== 'ready') {
      setNotice(t('app.notice.documentNotReady'))
      return
    }
    const content = draft
    // Snapshot the attachment before we optimistically clear it so we
    // can roll back if the send fails. The chip used to linger until
    // the assistant stream finished — that read as "the file's still
    // attached for some reason" to users. Clearing right after the
    // draft mirrors the message-bar behaviour: the prompt + its
    // attachment vanish from the composer the instant Enter fires;
    // the catch path restores both if the request never landed.
    const sentDocumentID = attachedDocumentID
    const sentPreview = attachedPreview
    setIsSending(true)
    setNotice('')
    setDraft('')
    setAttachedDocumentID(undefined)
    setAttachedPreview(undefined)
    const renderContext = createConversationRenderContext()
    try {
      // Image attachments go through the tool-capable local harness (so the
      // agent can image.edit them); other documents keep the cloud text path.
      const attachedIsImage = Boolean(attachedDocument && attachedDocument.content_type.startsWith('image/'))
      const canUseLocalHarness =
        (!attachedDocument || attachedIsImage) && Boolean(localHost?.online && localHostConfig?.token && localCloudSession?.connected)
      const conversation = canUseLocalHarness
        ? await sendLocalHarnessMessage(content, renderContext)
        : await chat.sendMessage({
            conversationId: activeID,
            content: parseSkillDraft(content).text,
            mode,
            scene: 'chat',
            document: attachedDocument
              ? {
                  id: attachedDocument.id,
                  name: attachedDocument.original_name,
                  contentType: attachedDocument.content_type,
                }
              : undefined,
            // Web build: drive the client tool loop (image gen / web search)
            // for plain prompts. Document Q&A keeps the single-completion path.
            cloudTools: attachedDocument ? undefined : webTools,
            onConversationUpdate: (nextConversation) => scheduleConversationRender(nextConversation, renderContext),
          })
      await refreshConversationsAfterStream(conversation.id, renderContext)
      setBalance(await api.balance())
    } catch (error) {
      setDraft((current) => current || content)
      // Only restore the attachment if the user hasn't picked a new
      // one in the meantime (same guard the draft uses) — otherwise
      // we'd clobber the new pick on a failed retry.
      setAttachedDocumentID((current) => current ?? sentDocumentID)
      setAttachedPreview((current) => current ?? sentPreview)
      setNotice(error instanceof Error ? error.message : t('app.notice.sendFailed'))
      const userNavigatedWhileStreaming = navigationVersionRef.current !== renderContext.navigationVersionAtStart
      await refreshConversations(userNavigatedWhileStreaming ? activeIDRef.current : activeID, {
        preserveEmptyActive: userNavigatedWhileStreaming && !activeIDRef.current,
      })
    } finally {
      setIsSending(false)
    }
  }

  /** Truncate the active conversation to before `userMessageID`, persist,
   *  then start a fresh run with `text` via the conversation's path (local
   *  harness when available, else cloud). Shared by regenerate (text = the
   *  original user message) and edit-resend (text = the edited message).
   *  Both run paths rebuild model context purely from the supplied history,
   *  so a client-side truncate + fresh run is all that's needed — there is
   *  no server-side transcript to mutate. Re-running re-bills credits. */
  async function resendFromUserMessage(userMessageID: string, text: string, preferLocal: boolean) {
    if (!activeID) {
      return
    }
    const conversation = await localData.get(activeID)
    if (!conversation) {
      return
    }
    const index = conversation.messages.findIndex((message) => message.id === userMessageID)
    if (index < 0) {
      return
    }
    conversation.messages = conversation.messages.slice(0, index)
    conversation.updatedAt = new Date().toISOString()
    await localData.save(conversation)
    await refreshConversations(activeID)

    const renderContext = createConversationRenderContext()
    setIsSending(true)
    setNotice('')
    try {
      const canUseLocalHarness =
        preferLocal && Boolean(localHost?.online && localHostConfig?.token && localCloudSession?.connected)
      const next = canUseLocalHarness
        ? await sendLocalHarnessMessage(text, renderContext, agentSettings)
        : await chat.sendMessage({
            conversationId: activeID,
            content: parseSkillDraft(text).text,
            mode,
            scene: 'chat',
            cloudTools: webTools,
            onConversationUpdate: (nextConversation) => scheduleConversationRender(nextConversation, renderContext),
          })
      await refreshConversationsAfterStream(next.id, renderContext)
      setBalance(await api.balance())
    } catch (error) {
      setNotice(error instanceof Error ? error.message : t('app.notice.sendFailed'))
      await refreshConversations(activeID)
    } finally {
      setIsSending(false)
    }
  }

  function handleRegenerateMessage(assistantMessageID: string) {
    if (!activeConversation) {
      return
    }
    const messages = activeConversation.messages
    const assistantIndex = messages.findIndex((message) => message.id === assistantMessageID)
    if (assistantIndex < 0) {
      return
    }
    // The user turn that produced this reply is the nearest preceding user message.
    let userIndex = -1
    for (let i = assistantIndex - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        userIndex = i
        break
      }
    }
    if (userIndex < 0) {
      return
    }
    const userMessage = messages[userIndex]
    const preferLocal = messages[assistantIndex].runOrigin !== 'cloud'
    void resendFromUserMessage(userMessage.id, userMessage.content, preferLocal)
  }

  function handleEditResendMessage(userMessageID: string, newText: string) {
    if (!activeConversation) {
      return
    }
    const lastAssistant = [...activeConversation.messages].reverse().find((message) => message.role === 'assistant')
    const preferLocal = lastAssistant ? lastAssistant.runOrigin !== 'cloud' : true
    void resendFromUserMessage(userMessageID, newText, preferLocal)
  }

  async function handleDeleteMessage(messageID: string) {
    if (!activeID) {
      return
    }
    const conversation = await localData.get(activeID)
    if (!conversation) {
      return
    }
    // Don't mutate a conversation with an in-flight run: the streaming send
    // holds its own conversation snapshot and would re-save (un-delete) on
    // completion. The delete button is already disabled while runActive; this
    // guards the case where the confirm dialog was opened before a run began.
    if (conversation.messages.some((message) => message.status === 'streaming' || message.status === 'pending')) {
      return
    }
    const index = conversation.messages.findIndex((message) => message.id === messageID)
    if (index < 0) {
      return
    }
    const target = conversation.messages[index]
    // Deleting a user message also drops its paired assistant reply (keeps
    // turns coherent); deleting an assistant message drops just it.
    const removeCount =
      target.role === 'user' && conversation.messages[index + 1]?.role === 'assistant' ? 2 : 1
    conversation.messages = [
      ...conversation.messages.slice(0, index),
      ...conversation.messages.slice(index + removeCount),
    ]
    conversation.updatedAt = new Date().toISOString()
    await localData.save(conversation)
    await refreshConversations(activeID)
  }

  async function sendLocalHarnessMessage(
    content: string,
    context: ConversationRenderContext,
    settingsOverride?: Required<AgentSettings>,
  ): Promise<Conversation> {
    if (!localHostConfig) {
      throw new Error(t('app.notice.localHostDisconnected'))
    }
    const {
      text: parsedText,
      skills: draftSkills,
      functions: draftFunctions,
      mcps: draftMcps,
    } = parseSkillDraft(content)
    const text = parsedText.trim()
    if (!text) {
      throw new Error(t('app.notice.emptyMessage'))
    }

    const timestamp = new Date().toISOString()
    const conversation = (activeID ? await localData.get(activeID) : undefined) ?? createConversation(text, timestamp, t('chat.newConversation'))
    // Composer's project picker can run before the first message, in
    // which case the workspace + project sit in pending* slots until
    // we materialize the conversation here.
    if (!conversation.workspace && pendingWorkspace) {
      conversation.workspace = { ...pendingWorkspace }
    }
    if (!conversation.project && pendingProject) {
      conversation.project = { ...pendingProject }
    }
    const userMessage: ChatMessage = {
      id: createLocalID('msg'),
      role: 'user',
      content: text,
      createdAt: timestamp,
      status: 'done',
      attachments:
        !settingsOverride && attachedDocument
          ? [
              {
                documentId: attachedDocument.id,
                name: attachedDocument.original_name,
                contentType: attachedDocument.content_type,
                previewDataUrl: attachedPreview,
              },
            ]
          : undefined,
    }
    const assistantMessage: ChatMessage = {
      id: createLocalID('msg'),
      role: 'assistant',
      content: '',
      createdAt: timestamp,
      status: 'streaming',
      runOrigin: 'local',
      agentEvents: [],
    }

    const priorMessages = conversation.messages
    conversation.messages = [...priorMessages, userMessage, assistantMessage]
    conversation.updatedAt = timestamp
    await localData.save(conversation)
    scheduleConversationRender(conversation, context)

    const parentRunId = [...priorMessages]
      .reverse()
      .find((message) => message.role === 'assistant' && message.runOrigin === 'local' && Boolean(message.runId))?.runId

    const skillsForRun = !settingsOverride ? draftSkills : []
    const functionsForRun = !settingsOverride ? draftFunctions : []
    const mcpsForRun = !settingsOverride ? draftMcps : []
    const directives: string[] = []
    if (functionsForRun.includes('image')) {
      directives.push(t('functions.imageDirective'))
    }
    if (skillsForRun.length > 0) {
      directives.push(t('skills.useDirective', { names: skillsForRun.join('、') }))
    }
    if (mcpsForRun.length > 0) {
      directives.push(t('mcp.useDirective', { names: mcpsForRun.join('、') }))
    }
    if (!settingsOverride && attachedDocument && attachedDocument.content_type.startsWith('image/')) {
      directives.push(
        t('functions.imageEditDirective', { documentId: attachedDocument.id, name: attachedDocument.original_name }),
      )
    }
    const goal = directives.length > 0 ? `${directives.join('\n\n')}\n\n${text}` : text
    // Layered settings overrides — later wins. settingsOverride is used
    // for things like the auto-retry path that wants the user's bare
    // settings without slash-injected forcing.
    let effectiveSettings: Required<AgentSettings> = settingsOverride ?? agentSettings
    if (skillsForRun.length > 0) {
      effectiveSettings = { ...effectiveSettings, skills: 'on' as const }
    }
    if (mcpsForRun.length > 0) {
      // Force MCP on AND make sure none of the explicitly referenced
      // servers are in the disabled list (the user just asked for
      // them by typing /name — the previous "off" state is overridden
      // for THIS run only; the persistent toggle on the MCP tab
      // stays untouched).
      const requested = new Set(mcpsForRun)
      effectiveSettings = {
        ...effectiveSettings,
        mcp: 'on' as const,
        mcpDisabled: effectiveSettings.mcpDisabled.filter((name) => !requested.has(name)),
      }
    }

    try {
      const run = await createLocalRun(
        {
          goal,
          workspacePath: conversation.workspace?.path.trim() || undefined,
          history: deriveAgentHistory(priorMessages),
          parentRunId,
          settings: effectiveSettings,
          mode,
        },
        localHostConfig,
      )
      assistantMessage.runId = run.id
      setLocalRuns((items) => upsertLocalRun(items, run))
      scheduleConversationRender(conversation, context)
      const seenEventIDs = new Set<string>()
      const toolArgsByCallId: ToolArgsByCallId = new Map()
      await streamLocalRun(run.id, localHostConfig, {
        onEvent: (event) => {
          appendLocalRunEvent(assistantMessage, event, seenEventIDs, toolArgsByCallId, t, openOfficeDocument)
          scheduleConversationRender(conversation, context)
        },
        onDelta: (delta, event) => {
          appendLocalDelta(assistantMessage, delta, event, seenEventIDs)
          scheduleConversationRender(conversation, context)
        },
      })
      finalizeLocalRunStatus(assistantMessage)
      scheduleConversationRender(conversation, context)
      // OS-level notification when the user has switched away — the
      // main process suppresses it if the window is still focused, so
      // we can call unconditionally on every terminal state.
      if (assistantMessage.status === 'done') {
        notifyAgentCompleted(assistantMessage, t)
      } else if (assistantMessage.status === 'error') {
        notifyAgentFailed(assistantMessage, t)
      }
    } catch (error) {
      assistantMessage.status = 'error'
      assistantMessage.content = error instanceof Error ? error.message : t('app.notice.localRunFailed')
      scheduleConversationRender(conversation, context)
      // A network/HTTP drop (vs an in-band run.failed event) lands here —
      // still notify so a blurred window learns the run died.
      notifyAgentFailed(assistantMessage, t)
      throw error
    } finally {
      conversation.updatedAt = new Date().toISOString()
      await localData.save(conversation)
    }

    return conversation
  }

  /** Stop whatever local run is currently streaming for the active
   *  conversation. The daemon emits `run.canceled` on its SSE channel,
   *  the existing stream loop finalizes the message, and the bubble
   *  settles into its canceled state. No-op if nothing is in flight. */
  async function cancelActiveLocalRun() {
    if (!activeConversation || !localHostConfig) {
      return
    }
    // Most-recent local assistant message that's still streaming or
    // waiting for HITL — that's the in-flight run from the user's PoV.
    const streamingMessage = [...activeConversation.messages]
      .reverse()
      .find(
        (msg) =>
          msg.role === 'assistant' &&
          msg.runOrigin === 'local' &&
          Boolean(msg.runId) &&
          (msg.status === 'streaming' || msg.status === 'waiting_permission' || msg.status === 'waiting_input'),
      )
    if (!streamingMessage?.runId) {
      return
    }
    try {
      await cancelLocalRun(streamingMessage.runId, localHostConfig)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : t('app.notice.sendFailed'))
    }
  }

  async function handlePermissionDecision(messageID: string, requestID: string, decision: 'approve' | 'deny', scope: LocalPermissionScope = 'once') {
    if (!activeID || !localHostConfig) {
      setNotice(t('app.notice.localHostDisconnected'))
      return
    }
    const conversation = await localData.get(activeID)
    const message = conversation?.messages.find((item) => item.id === messageID)
    if (!conversation || !message?.runId) {
      setNotice(t('app.notice.missingLocalTask'))
      return
    }

    setNotice('')
    message.status = 'streaming'
    // The resume stream replays the run's full event history from seq 1, so
    // rebuild the answer from that replay instead of appending onto the text
    // the user already saw (otherwise the prior stream is shown twice).
    message.content = ''
    const renderContext = createConversationRenderContext()
    const seenEventIDs = new Set((message.agentEvents ?? []).map((event) => event.eventId).filter(Boolean) as string[])
    const toolArgsByCallId: ToolArgsByCallId = new Map()
    try {
      await resolveLocalPermission(requestID, decision, localHostConfig, { scope })
      // Decision-acknowledgement toast so the user sees their click landed —
      // the bar disappears the moment the resume stream starts, otherwise
      // there's no feedback at all.
      toast.success(
        decision === 'approve'
          ? t(scope === 'run' ? 'app.notice.permissionRunApproved' : 'app.notice.permissionApproved')
          : t('app.notice.permissionDenied'),
        { id: 'permission-decision', duration: 2000 },
      )
      await streamLocalRun(message.runId, localHostConfig, {
        onEvent: (event) => {
          appendLocalRunEvent(message, event, seenEventIDs, toolArgsByCallId, t, openOfficeDocument)
          scheduleConversationRender(conversation, renderContext)
        },
        onDelta: (delta, event) => {
          appendLocalDelta(message, delta, event, seenEventIDs)
          scheduleConversationRender(conversation, renderContext)
        },
      })
      finalizeLocalRunStatus(message)
      scheduleConversationRender(conversation, renderContext)
    } catch (error) {
      message.status = 'error'
      message.content = error instanceof Error ? error.message : t('app.notice.localPermissionFailed')
      setNotice(message.content)
      scheduleConversationRender(conversation, renderContext)
    } finally {
      conversation.updatedAt = new Date().toISOString()
      await localData.save(conversation)
      await refreshConversationsAfterStream(conversation.id, renderContext)
    }
  }

  async function handleQuestionAnswer(messageID: string, requestID: string, answers: Record<string, string[]>) {
    if (!activeID || !localHostConfig) {
      setNotice(t('app.notice.localHostDisconnected'))
      return
    }
    const conversation = await localData.get(activeID)
    const message = conversation?.messages.find((item) => item.id === messageID)
    if (!conversation || !message?.runId) {
      setNotice(t('app.notice.missingLocalTask'))
      return
    }

    setNotice('')
    message.status = 'streaming'
    // Resume replays the full event history; rebuild from the replay rather
    // than appending onto already-shown text.
    message.content = ''
    const renderContext = createConversationRenderContext()
    const seenEventIDs = new Set((message.agentEvents ?? []).map((event) => event.eventId).filter(Boolean) as string[])
    const toolArgsByCallId: ToolArgsByCallId = new Map()
    try {
      await answerLocalQuestion(requestID, answers, localHostConfig)
      toast.success(t('app.notice.questionAnswered'), { id: 'question-answer', duration: 2000 })
      await streamLocalRun(message.runId, localHostConfig, {
        onEvent: (event) => {
          appendLocalRunEvent(message, event, seenEventIDs, toolArgsByCallId, t, openOfficeDocument)
          scheduleConversationRender(conversation, renderContext)
        },
        onDelta: (delta, event) => {
          appendLocalDelta(message, delta, event, seenEventIDs)
          scheduleConversationRender(conversation, renderContext)
        },
      })
      finalizeLocalRunStatus(message)
      scheduleConversationRender(conversation, renderContext)
    } catch (error) {
      message.status = 'error'
      message.content = error instanceof Error ? error.message : t('app.notice.localPermissionFailed')
      setNotice(message.content)
      scheduleConversationRender(conversation, renderContext)
    } finally {
      conversation.updatedAt = new Date().toISOString()
      await localData.save(conversation)
      await refreshConversationsAfterStream(conversation.id, renderContext)
    }
  }

  async function openLocalArtifact(artifactID: string) {
    if (!localHostConfig) {
      setNotice(t('app.notice.localHostDisconnected'))
      return
    }
    setNotice('')
    try {
      setArtifactPreview(await getLocalArtifact(artifactID, localHostConfig))
    } catch (error) {
      setNotice(error instanceof Error ? error.message : t('app.notice.artifactReadFailed'))
    }
  }

  async function recoverLocalRun(run: LocalHarnessRun) {
    if (!localHostConfig) {
      setNotice(t('app.notice.localHostDisconnected'))
      return
    }
    const timestamp = new Date().toISOString()
    const conversation = createConversation(run.goal, timestamp, t('chat.newConversation'))
    const userMessage: ChatMessage = {
      id: createLocalID('msg'),
      role: 'user',
      content: t('app.notice.recoverLocalRun', { goal: run.goal }),
      createdAt: timestamp,
      status: 'done',
    }
    const assistantMessage: ChatMessage = {
      id: createLocalID('msg'),
      role: 'assistant',
      content: '',
      createdAt: timestamp,
      status: 'streaming',
      runId: run.id,
      runOrigin: 'local',
      agentEvents: [],
    }
    conversation.messages = [userMessage, assistantMessage]
    await localData.save(conversation)
    const renderContext = createConversationRenderContext()
    scheduleConversationRender(conversation, renderContext)
    setNotice('')
    try {
      const seenEventIDs = new Set<string>()
      const toolArgsByCallId: ToolArgsByCallId = new Map()
      await streamLocalRun(run.id, localHostConfig, {
        onEvent: (event) => {
          appendLocalRunEvent(assistantMessage, event, seenEventIDs, toolArgsByCallId, t, openOfficeDocument)
          scheduleConversationRender(conversation, renderContext)
        },
        onDelta: (delta, event) => {
          appendLocalDelta(assistantMessage, delta, event, seenEventIDs)
          scheduleConversationRender(conversation, renderContext)
        },
      })
      finalizeLocalRunStatus(assistantMessage)
      scheduleConversationRender(conversation, renderContext)
      const freshRuns = await listLocalRuns(localHostConfig)
      setLocalRuns(freshRuns)
    } catch (error) {
      assistantMessage.status = 'error'
      assistantMessage.content = error instanceof Error ? error.message : t('app.notice.recoverLocalRunFailed')
      setNotice(assistantMessage.content)
      scheduleConversationRender(conversation, renderContext)
    } finally {
      conversation.updatedAt = new Date().toISOString()
      await localData.save(conversation)
      await refreshConversationsAfterStream(conversation.id, renderContext)
    }
  }

  async function exportLocalRunDiagnostics(run: LocalHarnessRun) {
    if (!localHostConfig) {
      setNotice(t('app.notice.localHostDisconnected'))
      return
    }
    try {
      const diagnostics = await getLocalRunDiagnostics(run.id, localHostConfig)
      downloadLocalRunDiagnostics(diagnostics)
      setNotice(t('app.notice.diagnosticsExported', { id: diagnostics.run.id }))
    } catch (error) {
      setNotice(error instanceof Error ? error.message : t('app.notice.diagnosticsExportFailed'))
    }
  }

  async function openLocalRunDiagnostics(runID: string) {
    if (!localHostConfig) {
      setNotice(t('app.notice.localHostDisconnected'))
      return
    }
    try {
      setRunDiagnostics(await getLocalRunDiagnostics(runID, localHostConfig))
      setNotice('')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : t('app.notice.diagnosticsReadFailed'))
    }
  }

  function exportCurrentRunDiagnostics() {
    if (!runDiagnostics) {
      return
    }
    downloadLocalRunDiagnostics(runDiagnostics)
    setNotice(t('app.notice.diagnosticsExported', { id: runDiagnostics.run.id }))
  }

  async function chooseWorkspaceDirectory(): Promise<string | undefined> {
    const selectedPath = await window.shejaneDesktop?.selectWorkspaceDirectory?.()
    if (!selectedPath) {
      return undefined
    }
    return selectedPath
  }

  /** Composer's project-picker handler — opens the OS directory picker
   *  and binds the chosen workspace as this chat's project. Two paths:
   *
   *  - **No active conversation yet** (user clicked "新对话" but hasn't
   *    sent the first message): stash the project + workspace as
   *    pending. The next `sendMessage` will pick them up when it
   *    creates the conversation, so the user sees the locked chip in
   *    the composer immediately without us writing an empty chat to
   *    IndexedDB.
   *
   *  - **Active conversation exists**: bind workspace + project to it
   *    in-place. Idempotent enough — but the composer-side guard
   *    (locked chip when `projectName` is set) means this should not
   *    fire twice for one conversation.
   *
   *  Returns silently if the user cancels the OS picker. Surfaces a
   *  toast on daemon-side errors (e.g. not yet paired). */
  async function selectProjectForActiveConversation() {
    if (!localHostConfig?.token) {
      setNotice(t('app.notice.localHostNotPairedAuthorize'))
      return
    }
    const picked = await chooseWorkspaceDirectory()
    if (!picked) return
    try {
      const ws = await authorizeLocalWorkspace(picked, localHostConfig)
      setAuthorizedWorkspaces((items) => upsertWorkspace(items, ws))
      const name = pathBasename(ws.path) || ws.label || ws.path
      const workspace: ConversationWorkspace = {
        path: ws.path,
        label: ws.label,
        authorized: true,
        authorizationId: ws.id,
      }
      const project: ConversationProject = { name }
      if (activeIDRef.current) {
        await updateConversationMetadata(activeIDRef.current, (item) => {
          item.project = project
          item.workspace = workspace
        })
      } else {
        setPendingWorkspace(workspace)
        setPendingProject(project)
      }
      setNotice(t('project.notice.bound', { name }))
    } catch (err) {
      setNotice(err instanceof Error ? err.message : t('app.notice.workspaceAuthorizeFailed'))
    }
  }

  async function authorizeWorkspace(path: string): Promise<LocalWorkspaceAuthorization> {
    if (!localHostConfig?.token) {
      throw new Error(t('app.notice.localHostNotPairedAuthorize'))
    }
    const nextPath = path.trim()
    if (!nextPath) {
      throw new Error(t('app.notice.emptyWorkspacePath'))
    }
    const workspace = await authorizeLocalWorkspace(nextPath, localHostConfig)
    setAuthorizedWorkspaces((items) => upsertWorkspace(items, workspace))
    await saveActiveConversationWorkspace({
      path: workspace.path,
      label: workspace.label,
      authorized: true,
      authorizationId: workspace.id,
    })
    setNotice(t('app.notice.workspaceBound', { label: workspace.label }))
    return workspace
  }

  async function diagnoseWorkspace(path: string): Promise<LocalWorkspaceDiagnosis> {
    if (!localHostConfig?.token) {
      throw new Error(t('app.notice.localHostNotPairedDiagnose'))
    }
    const nextPath = path.trim()
    if (!nextPath) {
      throw new Error(t('app.notice.emptyWorkspacePath'))
    }
    return diagnoseLocalWorkspace(nextPath, localHostConfig)
  }

  async function saveActiveConversationWorkspace(workspace: ConversationWorkspace | undefined) {
    if (!activeID) {
      setPendingWorkspace(workspace)
      return
    }
    const timestamp = new Date().toISOString()
    const conversation = (await localData.get(activeID)) ?? createConversation(t('chat.newConversation'), timestamp, t('chat.newConversation'))
    if (workspace) {
      conversation.workspace = workspace
    } else {
      delete conversation.workspace
    }
    conversation.updatedAt = timestamp
    await localData.save(conversation)
    setActiveConversationID(conversation.id)
    setConversations((items) => upsertConversation(items, cloneConversation(conversation)))
  }

  async function updateConversationMetadata(
    conversationID: string,
    update: (conversation: Conversation) => void,
    options: { touch?: boolean } = {},
  ): Promise<Conversation | undefined> {
    const conversation = await localData.get(conversationID)
    if (!conversation) {
      setNotice(t('app.notice.conversationMissing'))
      return undefined
    }
    update(conversation)
    if (options.touch ?? true) {
      conversation.updatedAt = new Date().toISOString()
    }
    await localData.save(conversation)
    await refreshConversations(activeIDRef.current, { preserveEmptyActive: !activeIDRef.current })
    return conversation
  }

  async function togglePinConversation(conversationID: string) {
    const conversation = await updateConversationMetadata(
      conversationID,
      (item) => {
        item.pinned = !item.pinned
      },
      { touch: false },
    )
    if (conversation) {
      setNotice(t(conversation.pinned ? 'app.notice.conversationPinned' : 'app.notice.conversationUnpinned', { title: conversation.title }))
    }
  }

  async function renameConversation(conversationID: string, title: string) {
    const nextTitle = title.trim()
    if (!nextTitle) {
      return
    }
    const conversation = await updateConversationMetadata(conversationID, (item) => {
      item.title = nextTitle
    })
    if (conversation) {
      setNotice(t('app.notice.conversationRenamed', { title: conversation.title }))
    }
  }

  async function deleteConversationData(conversationID: string) {
    const conversation = await localData.get(conversationID)
    if (!conversation) {
      setNotice(t('app.notice.conversationMissing'))
      return
    }
    const deletedActive = activeIDRef.current === conversationID
    await localData.delete(conversationID)
    if (deletedActive) {
      setPendingWorkspace(undefined)
      setPendingProject(undefined)
    }
    await refreshConversations(deletedActive ? undefined : activeIDRef.current, {
      preserveEmptyActive: !deletedActive && !activeIDRef.current,
    })
    setNotice(t('app.notice.conversationDeleted', { title: conversation.title }))
  }

  async function exportConversationData(conversationID: string) {
    const conversation = await localData.get(conversationID)
    if (!conversation) {
      setNotice(t('app.notice.conversationMissing'))
      return
    }
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      conversations: [conversation],
    } as const
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `shejane-conversation-${safeFilename(conversation.title)}-${new Date().toISOString().slice(0, 10)}.json`
    link.click()
    URL.revokeObjectURL(url)
    setNotice(t('app.notice.conversationExported', { title: conversation.title }))
  }

  async function importLocalData(file: File | undefined) {
    if (!file) {
      return
    }
    await localData.importAll(await file.text())
    await refreshConversations()
    setNotice(t('app.notice.localDataImported'))
  }

  async function uploadDocument(file: File | undefined) {
    if (!file) {
      return
    }
    if (!auth) {
      setNotice(t('app.notice.loginBeforeUpload'))
      return
    }
    const contentType = normalizeDocumentContentType(file)
    if (!contentType) {
      setNotice(t('app.notice.unsupportedDocument'))
      return
    }
    if (file.size <= 0 || file.size > documentMaxBytes) {
      setNotice(t('app.notice.documentTooLarge'))
      return
    }
    setNotice('')
    setIsUploading(true)
    setUploadProgress(0)
    try {
      const upload = await api.createDocumentUpload({
        filename: file.name,
        content_type: contentType,
        size_bytes: file.size,
      })
      setDocuments((items) => upsertDocument(items, upload.document))
      setAttachedDocumentID(upload.document.id)
      // XHR-based PUT so we can render a progress ring on the
      // attachment chip. Slow cross-border S3 uploads (typical
      // China → Singapore, even with Transfer Acceleration on)
      // would otherwise just spin for ~30s with no feedback and
      // the user would assume the app is frozen.
      const uploadResponse = await uploadWithProgress({
        method: upload.upload.method,
        url: upload.upload.url,
        headers: upload.upload.headers,
        body: file,
        onProgress: ({ percent }) => {
          setUploadProgress(Number.isFinite(percent) ? percent : undefined)
        },
      })
      if (!uploadResponse.ok) {
        throw new Error(t('app.notice.s3UploadFailed', { status: uploadResponse.status }))
      }
      const completed = await api.completeDocument(upload.document.id)
      setDocuments((items) => upsertDocument(items, completed))
      setAttachedDocumentID(completed.id)
      setAttachedPreview(await makeImageThumbnail(file))
      setNotice(t('app.notice.documentReady'))
    } catch (error) {
      setNotice(error instanceof Error ? error.message : t('app.notice.documentUploadFailed'))
    } finally {
      setIsUploading(false)
      setUploadProgress(undefined)
    }
  }

  async function deleteDocument(document: UserDocument) {
    const deleted = await api.deleteDocument(document.id)
    setDocuments((items) => items.filter((item) => item.id !== deleted.id))
    setAttachedDocumentID((current) => {
      if (current === deleted.id) {
        setAttachedPreview(undefined)
        return undefined
      }
      return current
    })
    setNotice(t('app.notice.documentDeleted'))
  }

  if (!auth) {
    return (
      <AuthScreen
        onAuthed={handleAuth}
        authClient={authClient}
        onRequestPasswordReset={(email) => api.requestPasswordReset({ email })}
        onConfirmPasswordReset={(token, password) => api.confirmPasswordReset({ token, password })}
      />
    )
  }

  // Desktop = the Electron build (preload injects window.shejaneDesktop). The
  // web build (app.shejane.com) has NO local daemon, so the whole local-agent
  // surface — skills, MCP, workspace — can never work there and must be hidden.
  const isDesktop = !!window.shejaneDesktop
  const shellClassName = isDesktop ? 'app-window-shell electron-window-shell' : 'app-window-shell'
  const appShellStyle = { '--sidebar-width': `${sidebarWidth}px` } as CSSProperties

  function beginSidebarResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return
    }
    if (!Number.isFinite(event.clientX)) {
      return
    }
    event.preventDefault()
    sidebarResizeStateRef.current = {
      startX: event.clientX,
      startWidth: sidebarWidth,
    }
    setIsResizingSidebar(true)
  }

  function handleSidebarResizeKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      setSidebarWidth((current) => clampSidebarWidth(current - sidebarKeyboardStep))
      return
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault()
      setSidebarWidth((current) => clampSidebarWidth(current + sidebarKeyboardStep))
      return
    }
    if (event.key === 'Home') {
      event.preventDefault()
      setSidebarWidth(minSidebarWidth)
      return
    }
    if (event.key === 'End') {
      event.preventDefault()
      setSidebarWidth(maxSidebarWidth)
    }
  }

  function collapseSidebar() {
    setSidebarCollapsed(true)
  }

  function expandSidebar() {
    setSidebarCollapsed(false)
  }

  // Open the Stripe checkout / top-up page. The cloud API returns a
  // checkout_url (a real Stripe session when configured, a dev success
  // stub otherwise); window.open is intercepted by the Electron main
  // process (setWindowOpenHandler → shell.openExternal) so it lands in
  // the user's default browser, and works normally on the web.
  async function startRecharge() {
    try {
      const { checkout_url } = await api.createSubscriptionCheckout()
      if (!checkout_url) {
        throw new Error('missing checkout url')
      }
      window.open(checkout_url, '_blank', 'noopener,noreferrer')
    } catch {
      setNotice(t('billing.rechargeFailed'))
    }
  }

  async function resendVerificationEmail() {
    try {
      await api.requestEmailVerification()
      setEmailVerifySent(true)
    } catch {
      setNotice(t('topbar.bannerEmailResendFailed'))
    }
  }

  return (
    <TooltipProvider>
      <main className={shellClassName}>
        <div className="window-drag-layer" aria-hidden="true" />
        <div className="app-shell" style={appShellStyle} data-collapsed={sidebarCollapsed ? 'true' : undefined}>
          <ConversationSidebar
            conversations={conversations}
            activeID={activeID}
            balance={balance}
            userEmail={auth.user.email}
            onNewConversation={startNewConversation}
            onSelectConversation={selectConversation}
            onExportConversation={(conversationID) => void exportConversationData(conversationID)}
            onImportLocalData={(file) => void importLocalData(file)}
            onTogglePinConversation={(conversationID) => void togglePinConversation(conversationID)}
            onRenameConversation={(conversationID, title) => void renameConversation(conversationID, title)}
            onDeleteConversation={(conversationID) => void deleteConversationData(conversationID)}
            onCollapseSidebar={collapseSidebar}
            isDesktop={isDesktop}
            onOpenSkills={() => setMainView('skills')}
            onOpenMcp={() => setMainView('mcp')}
            activeView={mainView}
            onLogout={() => {
              void authClient.logout().finally(() => setAuth(null))
            }}
            onRecharge={() => void startRecharge()}
            onShowSpendHistory={() => setSpendHistoryOpen(true)}
            agentSettings={agentSettings}
            onAgentSettingsChange={(next) => {
              setAgentSettings(next)
              writeAgentSettings(next)
            }}
            onClearMemory={
              localHostConfig
                ? async () => {
                    try {
                      const result = await clearLocalMemory(localHostConfig)
                      toast.success(
                        t('app.notice.memoryCleared', { count: result.deleted_count }),
                        { id: appNoticeToastID },
                      )
                      return result.deleted_count
                    } catch (error) {
                      const message = error instanceof Error ? error.message : String(error)
                      toast.error(t('app.notice.memoryClearFailed', { message }), {
                        id: appNoticeToastID,
                      })
                      throw error
                    }
                  }
                : undefined
            }
          />

          <div
            className="sidebar-resize-handle"
            role="separator"
            aria-label={t('app.resizeSidebar')}
            aria-orientation="vertical"
            aria-valuemin={minSidebarWidth}
            aria-valuemax={maxSidebarWidth}
            aria-valuenow={sidebarWidth}
            data-resizing={isResizingSidebar ? 'true' : undefined}
            tabIndex={0}
            onKeyDown={handleSidebarResizeKeyDown}
            onPointerDown={beginSidebarResize}
          />

          {/* `key={mainView}` remounts this wrapper on view change so the
              `.view-transition` enter animation fires on every switch. */}
          <div className="view-transition" key={mainView}>
          {mainView === 'skills' ? (
            <SkillsView
              listInstalled={() =>
                localHostConfig
                  ? listInstalledSkills(localHostConfig)
                  : Promise.resolve({ skills: [], roots: [] })
              }
              onOpenFolder={(path) => {
                const bridge = window.shejaneDesktop
                if (bridge?.openFileWithDefaultApp) {
                  void bridge.openFileWithDefaultApp(path)
                }
              }}
            />
          ) : mainView === 'mcp' ? (
            <MCPView
              listCatalog={() =>
                localHostConfig
                  ? listMcpServers(localHostConfig)
                  : Promise.resolve({ servers: [], sources_scanned: [] })
              }
              disabledServers={agentSettings.mcpDisabled}
              onDisabledChange={(next) => {
                const updated: Required<AgentSettings> = { ...agentSettings, mcpDisabled: next }
                setAgentSettings(updated)
                writeAgentSettings(updated)
              }}
              onOpenFolder={(path) => {
                const bridge = window.shejaneDesktop
                if (bridge?.openFileWithDefaultApp) {
                  void bridge.openFileWithDefaultApp(path)
                }
              }}
            />
          ) : (
          <section className="workspace">
            <header className="topbar">
              {sidebarCollapsed ? (
                <button
                  type="button"
                  className="topbar-expand-button"
                  title={t('app.expandSidebar')}
                  aria-label={t('app.expandSidebar')}
                  onClick={expandSidebar}
                >
                  <IconLayoutSidebarLeftExpand size={16} aria-hidden="true" />
                </button>
              ) : null}
              <div className="chat-toolbar-title">
                <span>{activeConversation?.title ?? t('app.newChat')}</span>
              </div>
              {/* Daemon status dot is meaningless on web (no daemon ever). */}
              {isDesktop ? (
                <div className="topbar-status">
                  <span
                    className={`topbar-daemon-dot${localHost?.online ? ' is-online' : ' is-offline'}`}
                    title={localHostStatusLabel(localHost, localHostConfig, localCloudSession, t)}
                    aria-label={localHostStatusLabel(localHost, localHostConfig, localCloudSession, t)}
                  />
                </div>
              ) : null}
            </header>
            {/* Offline banner only on desktop — on web the daemon is never
             *  expected, so it would show permanently. Credits-empty banner
             *  still applies to web (cloud chat bills credits too). */}
            {isDesktop && !localHost?.online ? (
              <div className="status-banner status-banner-warning" role="status">
                <span className="status-banner-text">{t('topbar.bannerDaemonOffline')}</span>
              </div>
            ) : balance && totalCredits(balance) <= 0 ? (
              <div className="status-banner status-banner-warning" role="status">
                <span className="status-banner-text">{t('topbar.bannerCreditsEmpty')}</span>
                <button type="button" className="status-banner-action" onClick={() => void startRecharge()}>
                  {t('sidebar.account.recharge')}
                </button>
              </div>
            ) : null}
            {/* Advisory (non-blocking) email-verification nudge. Only shown
             *  when the server explicitly reports the email as unverified
             *  (=== false, so older payloads without the field don't nag). */}
            {auth.user.email_verified === false && !emailBannerDismissed ? (
              <div className="status-banner status-banner-info" role="status">
                <span className="status-banner-text">{t('topbar.bannerEmailUnverified')}</span>
                <button
                  type="button"
                  className="status-banner-action"
                  disabled={emailVerifySent}
                  onClick={() => void resendVerificationEmail()}
                >
                  {emailVerifySent ? t('topbar.bannerEmailSent') : t('topbar.bannerEmailResend')}
                </button>
                <button
                  type="button"
                  className="status-banner-dismiss"
                  aria-label={t('topbar.bannerDismiss')}
                  onClick={() => setEmailBannerDismissed(true)}
                >
                  <IconX size={14} aria-hidden="true" />
                </button>
              </div>
            ) : null}

            <ChatThread
              conversation={activeConversation}
              onOpenArtifact={(artifactID) => void openLocalArtifact(artifactID)}
              onOpenDiagnostics={(runID) => void openLocalRunDiagnostics(runID)}
              onPreviewLocalFile={openOfficeDocument}
              onPreviewCloudAttachment={openCloudOfficeDocument}
              onOpenAttachmentExternally={(ref) => void openAttachmentExternally(ref)}
              onPickSuggestion={setDraft}
              onRegenerateMessage={handleRegenerateMessage}
              onEditResendMessage={handleEditResendMessage}
              onDeleteMessage={setPendingDeleteMessageID}
            />

            <ArtifactPanel artifact={artifactPreview} onClose={() => setArtifactPreview(null)} />
            <DocPreviewPanel
              doc={activeDocument}
              refreshKey={docPreviewRefreshKey}
              onClose={() => setActiveDocument(null)}
            />
            <DiagnosticsPanel diagnostics={runDiagnostics} onClose={() => setRunDiagnostics(null)} onExport={exportCurrentRunDiagnostics} />

            <AlertDialog
              open={Boolean(pendingDeleteMessageID)}
              onOpenChange={(open) => !open && setPendingDeleteMessageID(undefined)}
            >
              <AlertDialogContent className="conversation-delete-dialog">
                <AlertDialogHeader className="conversation-delete-header">
                  <AlertDialogMedia className="conversation-delete-media">
                    <IconTrash aria-hidden="true" />
                  </AlertDialogMedia>
                  <AlertDialogTitle>{t('message.deleteConfirmTitle')}</AlertDialogTitle>
                  <AlertDialogDescription>{t('message.deleteConfirmBody')}</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter className="conversation-delete-footer">
                  <AlertDialogCancel variant="outline" autoFocus onClick={() => setPendingDeleteMessageID(undefined)}>
                    <span className="conversation-delete-button-label">{t('sidebar.dialog.cancel')}</span>
                  </AlertDialogCancel>
                  <AlertDialogAction
                    variant="destructive"
                    onClick={() => {
                      if (pendingDeleteMessageID) {
                        void handleDeleteMessage(pendingDeleteMessageID)
                        setPendingDeleteMessageID(undefined)
                      }
                    }}
                  >
                    <span className="conversation-delete-button-label">{t('message.delete')}</span>
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>

            <SpendHistoryDialog
              open={spendHistoryOpen}
              onOpenChange={setSpendHistoryOpen}
              fetchTransactions={fetchSpendHistory}
            />

            <div className="composer-dock">
              <PendingApprovalBar
                approval={pendingApproval}
                onDecision={(messageID, requestID, decision, scope) => void handlePermissionDecision(messageID, requestID, decision, scope)}
              />

              <PendingQuestionBar
                key={pendingQuestion?.requestID ?? 'no-question'}
                question={pendingQuestion}
                onAnswer={(messageID, requestID, answers) => void handleQuestionAnswer(messageID, requestID, answers)}
                onSkip={(messageID, requestID) => {
                  // Skip = answer the daemon with empty answer lists for each
                  // question. user.ask falls through its parse logic and
                  // returns "" to the agent, which then has to decide
                  // whether to make a reasonable assumption or re-ask.
                  if (!pendingQuestion) return
                  const skipAnswers: Record<string, string[]> = {}
                  for (const item of pendingQuestion.questions) {
                    skipAnswers[item.question] = []
                  }
                  void handleQuestionAnswer(messageID, requestID, skipAnswers)
                }}
                onCancel={() => void cancelActiveLocalRun()}
              />

              <Composer
              draft={draft}
              onDraftChange={setDraft}
              isSending={isSending}
              hasActiveLocalRun={hasActiveLocalRun}
              attachedDocument={attachedDocument}
              attachedPreview={attachedPreview}
              isUploading={isUploading}
              uploadProgress={uploadProgress}
              onUploadDocument={(file) => void uploadDocument(file)}
              onDetachDocument={() => {
                setAttachedDocumentID(undefined)
                setAttachedPreview(undefined)
              }}
              onSend={() => void sendMessage()}
              onStop={() => void cancelActiveLocalRun()}
              listSkills={async () => {
                if (!localHostConfig) return []
                const catalog = await listInstalledSkills(localHostConfig)
                return catalog.skills
              }}
              listMcpServers={
                localHostConfig
                  ? async () => {
                      const catalog = await listMcpServers(localHostConfig)
                      return catalog.servers
                    }
                  : undefined
              }
              mode={mode}
              onModeChange={changeMode}
              projectName={activeConversation?.project?.name ?? pendingProject?.name}
              onSelectProject={() => void selectProjectForActiveConversation()}
              isDesktop={isDesktop}
              slashCommandsEnabled={isDesktop || webTools.some((tool) => tool.name === 'image.generate')}
              />
            </div>
          </section>
          )}
          </div>
        </div>
      </main>
    </TooltipProvider>
  )
}

function localHostStatusLabel(
  localHost: LocalHostProbe | null,
  config: LocalHostConfig | null,
  session: LocalCloudSession | null,
  t: Translator,
): string {
  if (!localHost?.online) {
    return t('app.localStatus.cloudOnly')
  }
  if (!config?.token) {
    return t('app.localStatus.unpaired')
  }
  if (!session?.connected) {
    return t('app.localStatus.loginPending')
  }
  return t('app.localStatus.connected')
}

/** Tracks the assembled `arguments` for each `tool_call_id` within a
 *  single SSE stream session. Populated when the daemon emits a
 *  `tool.requested` event (which carries the full assembled args);
 *  read back when the matching `tool.completed` / `tool.failed`
 *  arrives so the renderer can show the same rich detail for the
 *  completed row. Lives on the call site as a plain Map alongside
 *  `seenEventIDs` — same per-session-scope discipline. */
export type ToolArgsByCallId = Map<string, Record<string, unknown>>

function appendLocalRunEvent(
  message: ChatMessage,
  event: AgentRunEvent,
  seenEventIDs: Set<string>,
  toolArgsByCallId: ToolArgsByCallId,
  t: Translator,
  onOfficeFileOpened?: (ref: LocalOfficeFileRef) => void,
) {
  if (event.event_type === 'llm.delta') {
    return
  }
  // Accumulate DeepSeek-style thinking-mode `reasoning_content` into a
  // dedicated `message.reasoning` field. This is kept ONLY for backend
  // round-trip (DeepSeek API requires reasoning_content to be passed
  // back on subsequent calls). The UI never renders the reasoning text
  // itself — MessageBubble only uses (reasoning != null && streaming)
  // to show an ephemeral "Thinking…" indicator above the bubble.
  // Dedupe on event.id so a re-streamed replay doesn't double-append.
  if (event.event_type === 'llm.reasoning') {
    if (event.id && seenEventIDs.has(event.id)) {
      return
    }
    if (event.id) {
      seenEventIDs.add(event.id)
    }
    const chunk = String((event.payload ?? {}).content ?? '')
    if (chunk) {
      message.reasoning = (message.reasoning ?? '') + chunk
    }
    return
  }
  // Per-call usage streams as llm.usage; accumulate it onto the message so
  // the usage chip updates live. Dedupe on event.id (re-stream replay).
  // run.completed later overwrites with the authoritative turn total.
  if (event.event_type === 'llm.usage') {
    if (event.id && seenEventIDs.has(event.id)) {
      return
    }
    if (event.id) {
      seenEventIDs.add(event.id)
    }
    const payload = event.payload ?? {}
    const input = Number(payload.input_tokens) || 0
    const output = Number(payload.output_tokens) || 0
    const credits = Number(payload.credits_cost) || 0
    if (input > 0 || output > 0) {
      message.tokens = (message.tokens ?? 0) + input + output
    }
    if (credits > 0) {
      message.creditsCost = (message.creditsCost ?? 0) + credits
    }
    return
  }
  const alreadySeen = Boolean(event.id && seenEventIDs.has(event.id))
  if (event.id) {
    seenEventIDs.add(event.id)
  }
  if (event.event_type === 'run.completed') {
    const payload = event.payload ?? {}
    const input = Number(payload.input_tokens) || 0
    const output = Number(payload.output_tokens) || 0
    const credits = Number(payload.credits_cost) || 0
    // Authoritative per-turn totals (sum of the turn's llm.usage events).
    if (input > 0 || output > 0) {
      message.tokens = input + output
    }
    if (credits > 0) {
      message.creditsCost = credits
    }
  }
  if (event.event_type === 'mode.selected') {
    const payload = event.payload ?? {}
    const resolved = payload.resolved_mode === 'pro' ? 'pro' : 'fast'
    message.runMode = {
      resolved,
      reason: String(payload.reason ?? ''),
    }
  }
  // Tool args propagation. Daemon emits `tool.requested` events
  // carrying the fully assembled tool args. Cache them by
  // tool_call_id so the matching `tool.completed` / `tool.failed`
  // (which only carry the result, not the original args) can borrow
  // them and the renderer keeps showing the same rich detail through
  // the lifecycle. See event_translator._tool_requested_events_from_update.
  if (event.event_type === 'tool.requested') {
    const payload = event.payload ?? {}
    const id = String(payload.tool_call_id ?? '')
    const args = payload.arguments
    if (id && args && typeof args === 'object' && !Array.isArray(args)) {
      toolArgsByCallId.set(id, args as Record<string, unknown>)
    }
  } else if (event.event_type === 'tool.completed' || event.event_type === 'tool.failed') {
    const payload = event.payload ?? {}
    const id = String(payload.tool_call_id ?? '')
    const cached = id ? toolArgsByCallId.get(id) : undefined
    if (cached && !payload.arguments) {
      event = { ...event, payload: { ...payload, arguments: cached } }
    }
    // Side effect: detect a successful office WRITE and refresh the
    // right-side document preview panel to the freshly-edited copy.
    // Result shape from any office.* write tool:
    //   {ok, original_path, edited_path, kind, summary}
    // Reads (office.read / office.outline) intentionally do NOT
    // auto-open the preview — that was noisy. Preview opens only on:
    //   1. user clicking a filename in agent text
    //   2. user clicking an attachment chip
    //   3. an edit completing (this branch)
    if (event.event_type === 'tool.completed' && !alreadySeen) {
      const detected = detectOfficeFileEdited(event.payload)
      if (detected) {
        onOfficeFileOpened?.(detected)
      }
    }
  }
  const item = timelineItem(event, t)
  if (item) {
    if (!alreadySeen) {
      message.agentEvents = [...(message.agentEvents ?? []), item]
    }
    // When the run pauses for a user.ask, any prose the model streamed before
    // calling the tool is just stalling chatter (incl. guardrail-rejected
    // clarification text). Drop it so the message bubble only shows the real
    // answer that streams in after the user responds. This must run on the
    // resume replay too (the event is "already seen"), otherwise the rebuilt
    // content keeps the pre-question chatter.
    if (item.type === 'question.asked') {
      message.content = ''
    }
  }
}

/** Tool names that emit the copy-on-first-write Phase 2 result shape:
 *  `{ok, original_path, edited_path, kind, summary}`. The renderer
 *  follows `edited_path` so the preview shows the freshly-edited copy
 *  rather than the untouched original. Keep this list in sync with
 *  `local_host/tools/office.py:OFFICE_WRITE_TOOLS`. */
const OFFICE_WRITE_TOOL_NAMES = new Set<string>([
  // Phase 2 — docx/xlsx
  'office.find_replace',
  'office.insert_paragraph',
  'office.update_paragraph',
  'office.delete_paragraph',
  'office.apply_style',
  'office.set_cells',
  'office.set_formula',
  'office.set_cell_format',
  'office.merge_cells',
  'office.add_row',
  // Phase 3 — pptx
  'office.create_pptx',
  'office.add_slide',
  'office.update_slide',
  'office.delete_slide',
  'office.reorder_slides',
  'office.set_slide_title',
  'office.set_slide_bullets',
  'office.set_slide_notes',
  'office.add_image_to_slide',
])

/** Inspect a `tool.completed` payload and return a LocalOfficeFileRef
 *  when the underlying tool was a successful office.* WRITE — the
 *  ref points at the `.edited.<ext>` copy that now holds the changes.
 *
 *  Returns null for unknown tools, non-success results, and missing
 *  edited_path (so a malformed result silently degrades to "don't
 *  switch the preview"). */
function detectOfficeFileEdited(payload: AgentRunEvent['payload']): LocalOfficeFileRef | null {
  if (!payload) return null
  const toolName = String((payload as Record<string, unknown>).tool ?? (payload as Record<string, unknown>).name ?? '')
  if (!OFFICE_WRITE_TOOL_NAMES.has(toolName)) return null
  const result = (payload as Record<string, unknown>).result
  const resultObj =
    result && typeof result === 'object' && !Array.isArray(result) ? (result as Record<string, unknown>) : null
  if (!resultObj) return null
  if (String(resultObj.ok ?? '') !== 'true') return null
  const editedPath = String(resultObj.edited_path ?? '')
  if (!editedPath) return null
  const kindRaw = String(resultObj.kind ?? '')
  const lower = editedPath.toLowerCase()
  const kind: LocalOfficeFileRef['kind'] =
    kindRaw === 'word' || kindRaw === 'excel' || kindRaw === 'powerpoint'
      ? kindRaw
      : lower.endsWith('.xlsx')
        ? 'excel'
        : lower.endsWith('.pptx')
          ? 'powerpoint'
          : 'word'
  const name = editedPath.split(/[\\/]/).pop() || editedPath
  return { path: editedPath, kind, name }
}

function appendLocalDelta(message: ChatMessage, delta: string, event: AgentRunEvent, seenEventIDs: Set<string>) {
  if (event.id && seenEventIDs.has(event.id)) {
    return
  }
  if (event.id) {
    seenEventIDs.add(event.id)
  }
  message.content += delta
}

function totalCredits(balance: WalletBalance): number {
  return Math.max(0, (balance.monthly_remaining ?? 0) + (balance.extra_credits_balance ?? 0))
}

/** Token from an email-verification link (CLIENT_BASE_URL/verify?token=…).
 *  Gated on the /verify path so it never collides with the /reset?token= link
 *  consumed by AuthScreen. */
function readVerifyTokenFromURL(): string {
  if (typeof window === 'undefined') {
    return ''
  }
  try {
    if (!window.location.pathname.includes('/verify')) {
      return ''
    }
    return new URLSearchParams(window.location.search).get('token') ?? ''
  } catch {
    return ''
  }
}

/** Fire a system notification when an assistant turn finishes. The
 *  Electron main process internally drops the call when the window is
 *  focused, so this is safe to call on every completion. We trim the
 *  body so the OS doesn't have to deal with a multi-screen reply. */
function notifyAgentCompleted(message: ChatMessage, t: Translator): void {
  const bridge = window.shejaneDesktop
  if (!bridge?.notify) {
    return
  }
  const raw = (message.content || '').trim().replace(/\s+/g, ' ')
  const body = raw.length > 140 ? `${raw.slice(0, 140)}…` : raw
  void bridge.notify({
    title: t('notify.agentCompleted.title'),
    body: body || t('notify.agentCompleted.empty'),
  })
}

/** Fire a system notification when an assistant turn FAILS. Mirrors
 *  notifyAgentCompleted (main suppresses it while focused). The body
 *  prefers the run.failed event's message, falling back to the bubble
 *  content (set to the error message on a network/HTTP drop). */
function notifyAgentFailed(message: ChatMessage, t: Translator): void {
  const bridge = window.shejaneDesktop
  if (!bridge?.notify) {
    return
  }
  const failureEvent = [...(message.agentEvents ?? [])].reverse().find((event) => event.type === 'run.failed')
  const raw = (failureEvent?.label || message.content || '').trim().replace(/\s+/g, ' ')
  const body = raw.length > 140 ? `${raw.slice(0, 140)}…` : raw
  void bridge.notify({
    title: t('notify.agentFailed.title'),
    body: body || t('notify.agentFailed.empty'),
  })
}

function finalizeLocalRunStatus(message: ChatMessage) {
  const events = message.agentEvents ?? []
  if (events.some((event) => event.type === 'run.failed')) {
    message.status = 'error'
    return
  }
  if (events.some((event) => event.type === 'run.completed')) {
    message.status = 'done'
    return
  }
  if (hasPendingPermission(events)) {
    message.status = 'waiting_permission'
    return
  }
  message.status = hasPendingQuestion(events) ? 'waiting_input' : 'done'
}

function hasPendingPermission(events: AgentTimelineItem[]): boolean {
  const pending = new Set<string>()
  for (const event of events) {
    if (event.type === 'permission.required' && event.permissionRequestId) {
      pending.add(event.permissionRequestId)
    }
    if (event.type === 'permission.resolved' && event.permissionRequestId) {
      pending.delete(event.permissionRequestId)
    }
  }
  return pending.size > 0
}

function hasPendingQuestion(events: AgentTimelineItem[]): boolean {
  const pending = new Set<string>()
  for (const event of events) {
    if (event.type === 'question.asked' && event.questionRequestId) {
      pending.add(event.questionRequestId)
    }
    if (event.type === 'question.answered' && event.questionRequestId) {
      pending.delete(event.questionRequestId)
    }
  }
  return pending.size > 0
}

function downloadLocalRunDiagnostics(diagnostics: LocalRunDiagnostics) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(diagnostics, null, 2)], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `shejane-local-run-${diagnostics.run.id}-diagnostics.json`
  link.click()
  URL.revokeObjectURL(url)
}

function upsertDocument(items: UserDocument[], document: UserDocument): UserDocument[] {
  return [document, ...items.filter((item) => item.id !== document.id)]
}

function upsertWorkspace(items: LocalWorkspaceAuthorization[], workspace: LocalWorkspaceAuthorization): LocalWorkspaceAuthorization[] {
  return [workspace, ...items.filter((item) => item.id !== workspace.id && item.path !== workspace.path)]
}

function upsertLocalRun(items: LocalHarnessRun[], run: LocalHarnessRun): LocalHarnessRun[] {
  return [run, ...items.filter((item) => item.id !== run.id)]
}

function upsertConversation(items: Conversation[], conversation: Conversation): Conversation[] {
  return sortConversationsForSidebar([conversation, ...items.filter((item) => item.id !== conversation.id)])
}

function cloneConversation(conversation: Conversation): Conversation {
  return {
    ...conversation,
    project: conversation.project ? { ...conversation.project } : undefined,
    workspace: conversation.workspace ? { ...conversation.workspace } : undefined,
    messages: conversation.messages.map((message) => ({
      ...message,
      agentEvents: message.agentEvents ? [...message.agentEvents] : undefined,
    })),
  }
}

function sortConversationsForSidebar(items: Conversation[]): Conversation[] {
  return [...items].sort((a, b) => {
    if (Boolean(a.pinned) !== Boolean(b.pinned)) {
      return a.pinned ? -1 : 1
    }
    return b.updatedAt.localeCompare(a.updatedAt)
  })
}

function findWorkspaceByPath(items: LocalWorkspaceAuthorization[], path: string): LocalWorkspaceAuthorization | undefined {
  const normalized = path.trim()
  return normalized ? items.find((item) => pathInsideWorkspace(item.path, normalized)) : undefined
}

function pathInsideWorkspace(root: string, target: string): boolean {
  const normalizedRoot = trimPath(root)
  const normalizedTarget = trimPath(target)
  if (!normalizedRoot || !normalizedTarget) {
    return false
  }
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}/`) || normalizedTarget.startsWith(`${normalizedRoot}\\`)
}

function trimPath(path: string): string {
  return path.trim().replace(/[\\/]+$/u, '')
}

function safeFilename(value: string): string {
  return value.trim().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 48) || 'conversation'
}

function createConversation(firstMessage: string, timestamp: string, fallbackTitle: string): Conversation {
  return {
    id: createLocalID('conv'),
    title: firstMessage.slice(0, 24) || fallbackTitle,
    archived: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    messages: [],
  }
}

/** Cross-platform basename: strips trailing separators then returns the
 *  segment after the last "/" or "\\". Used as the default name for a
 *  project conversation when the user picks a directory.
 */
function pathBasename(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, '')
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed
}

async function makeImageThumbnail(file: File): Promise<string | undefined> {
  if (!file.type.startsWith('image/')) {
    return undefined
  }
  try {
    const bitmap = await createImageBitmap(file)
    const maxDim = 768
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height))
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      return undefined
    }
    ctx.drawImage(bitmap, 0, 0, width, height)
    return canvas.toDataURL('image/webp', 0.82)
  } catch {
    return undefined
  }
}

function normalizeDocumentContentType(file: File): string {
  const byType = file.type.toLowerCase()
  if (byType === 'application/pdf') {
    return byType
  }
  if (byType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    return byType
  }
  if (byType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
    return byType
  }
  if (byType === 'image/png' || byType === 'image/jpeg' || byType === 'image/webp') {
    return byType
  }
  const name = file.name.toLowerCase()
  if (name.endsWith('.pdf')) {
    return 'application/pdf'
  }
  if (name.endsWith('.docx')) {
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  }
  if (name.endsWith('.xlsx')) {
    return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  }
  if (name.endsWith('.png')) {
    return 'image/png'
  }
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) {
    return 'image/jpeg'
  }
  if (name.endsWith('.webp')) {
    return 'image/webp'
  }
  return ''
}
