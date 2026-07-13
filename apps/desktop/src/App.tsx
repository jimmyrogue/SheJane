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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { timelineItem } from './features/chat/chatStore'
import { ArtifactPanel } from './features/chat/components/ArtifactPanel'
import { DocPreviewPanel } from './features/chat/components/DocPreviewPanel'
import { ChatThread } from './features/chat/components/ChatThread'
import { Composer } from './features/chat/components/Composer'
import type { ModelOption } from './features/chat/components/ModeSelector'
import { deriveAgentHistory } from './features/chat/conversationHistory'
import { recentRecoverableFailures } from './features/chat/recoverableFailures'
import {
  beginRecoveryAction,
  createRecoveryState,
  endRecoveryAction,
  latestRunFailureEvent,
  nextRepairAttempt,
  nextRetryAttempt,
  recoveryTargetKey,
  type AgentFailureAction,
  type RecoveryTarget,
} from './features/chat/recovery'
import { parseSkillDraft } from './features/chat/skillDraft'
import { ConversationSidebar } from './features/chat/components/ConversationSidebar'
import { DiagnosticsPanel } from './features/chat/components/DiagnosticsPanel'
import { PendingApprovalBar } from './features/chat/components/PendingApprovalBar'
import { PendingPlanApprovalBar } from './features/chat/components/PendingPlanApprovalBar'
import { PendingQuestionBar } from './features/chat/components/PendingQuestionBar'
import { ConnectionsView } from './features/connections/ConnectionsView'
import { MCPView } from './features/mcp/MCPView'
import { SettingsView } from './features/settings/SettingsView'
import { SkillsView } from './features/skills/SkillsView'
import { findConversationPendingApproval } from './features/chat/pendingApproval'
import { findConversationPendingPlanApproval } from './features/chat/pendingPlanApproval'
import { findConversationPendingQuestion } from './features/chat/pendingQuestion'
import type { AgentRunEvent } from '@shejane/runtime-client'
import { I18nProvider, useI18n, type Translator } from './shared/i18n/i18n'
import { createLocalID, LocalConversationStore } from './shared/local-data/localConversations'
import type { AgentTimelineItem, ChatMessage, ChatMode, Conversation, ConversationProject, ConversationWorkspace, LocalOfficeFileRef, OpenDocument } from './shared/local-data/types'
import {
  authorizeLocalWorkspace,
  answerLocalQuestionCommand,
  cancelLocalRunCommand,
  clearLocalMemory,
  createLocalSkill,
  createLocalRun,
  deliverPendingRuntimeCommands,
  createMcpServer,
  deleteLocalSkill,
  deleteLocalThread,
  deleteMcpServer,
  diagnoseLocalWorkspace,
  fetchWorkspaceFile,
  forkLocalRun,
  getLocalRunDiagnostics,
  getLocalThreadSnapshot,
  getDesktopLocalHostConfig,
  hasLocalHostAuthorization,
  getLocalArtifact,
  getLocalSkillFile,
  listAuthorizedWorkspaces,
  listInstalledSkills,
  listLocalRuns,
  listLocalThreads,
  listLocalThreadChanges,
  listLocalRuntimeModels,
  listLocalSchedules,
  listMcpServers,
  LocalStreamCursorResetRequiredError,
  markLocalScheduleNotified,
  injectLocalRunInstruction,
  probeLocalHost,
  resolveLocalPlanCommand,
  resolveLocalPermissionCommand,
  reconcileLocalToolCommand,
  streamLocalRun,
  updateLocalSkill,
  updateLocalThread,
  updateMcpServer,
  type AdvancedAgentSettings,
  type AgentSettings,
  type CreateLocalRunInput,
  type LocalArtifact,
  type LocalHostConfig,
  type LocalToolReconciliationDecision,
  type LocalHostProbe,
  type LocalPlanApprovalDecision,
  type LocalPermissionScope,
  LOCAL_RUNTIME_PROTOCOL_VERSION,
  type PendingRunForkCommand,
  type PendingRunStartCommand,
  type PendingRunCancelCommand,
  type PendingQuestionAnswerCommand,
  type PendingPermissionResolveCommand,
  type PendingPlanResolveCommand,
  type PendingToolReconcileCommand,
  type PendingRuntimeCommand,
  type RuntimeCommandResult,
  type LocalRun as LocalHarnessRun,
  type LocalRunDiagnostics,
  type LocalRunMetadata,
  type LocalScheduledRun,
  type LocalWorkspaceDiagnosis,
  type LocalWorkspaceAuthorization,
} from './shared/local-host/client'
import { projectRuntimeThread } from './features/chat/runtimeProjection'

const appNoticeToastID = 'shejane-app-notice'
const sidebarWidthStorageKey = 'shejane.sidebar.width.v2'
const sidebarCollapsedStorageKey = 'shejane.sidebar.collapsed.v1'
const runtimeThreadIDsStorageKey = 'shejane.runtime-thread-ids.v1'
const scheduledRunNotificationPollMs = 30_000
const pendingCommandRetryMs = 2_000
interface LocalHarnessRunOptions {
  parentRunId?: string
  metadata?: LocalRunMetadata
  initialAgentEvents?: AgentTimelineItem[]
  replaceFromClientId?: string
}

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
// Concrete Runtime model selection. Stale values are reconciled against the
// Runtime catalog after connection.
const chatModeStorageKey = 'shejane.chatMode.v2'
const defaultAgentSettings: Required<AgentSettings> = {
  memory: 'on',
  skills: 'on',
  mcp: 'on',
  mcpDisabled: [],
  // Empty = every advanced knob inherits the daemon's own default. The user
  // only ever populates the fields they explicitly change in the panel.
  advanced: {},
}
const defaultChatMode: ChatMode = ''
const defaultSidebarWidth = 252
const minSidebarWidth = 190
const maxSidebarWidth = 340
const sidebarKeyboardStep = 12
const sidebarMotionMs = 220
type NoticeOptions = Omit<NonNullable<Parameters<typeof toast.message>[1]>, 'id'>

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
  if (typeof a.subagents === 'boolean') out.subagents = a.subagents
  if (typeof a.browserHeadless === 'boolean') out.browserHeadless = a.browserHeadless
  if (a.inputGuard === 'observe' || a.inputGuard === 'block') {
    out.inputGuard = a.inputGuard
  }
  if (a.planFirst === 'off' || a.planFirst === 'auto' || a.planFirst === 'always') {
    out.planFirst = a.planFirst
  }
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
    const raw = window.localStorage.getItem(chatModeStorageKey)?.trim()
    // The Runtime catalog reconciles selections that are no longer available.
    if (raw) {
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
  const { t, locale } = useI18n()
  const isDesktop = Boolean(window.shejaneDesktop)
  const localData = useMemo(() => new LocalConversationStore('shejane-local:runtime:local-owner'), [])
  const pendingConversationRendersRef = useRef<Map<string, PendingConversationRender>>(new Map())
  const liveRenderTimerRef = useRef<number>()
  const activeIDRef = useRef<string | undefined>()
  const navigationVersionRef = useRef(0)
  const conversationInitializationCompleteRef = useRef(false)
  const recoveryStateRef = useRef(createRecoveryState())
  const startupRecoveryNoticeShownRef = useRef(false)
  const sidebarResizeStateRef = useRef<{ startX: number, startWidth: number } | null>(null)
  const sidebarMotionTimerRef = useRef<number>()
  const runtimeThreadCursorRef = useRef(0)
  const runtimeThreadIDsRef = useRef(new Set<string>())
  const questionAnswersInFlightRef = useRef(new Set<string>())
  const permissionDecisionsInFlightRef = useRef(new Set<string>())
  const planDecisionsInFlightRef = useRef(new Set<string>())
  const toolReconciliationsInFlightRef = useRef(new Set<string>())
  const checkpointForksInFlightRef = useRef(new Set<string>())

  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeID, setActiveID] = useState<string>()
  const [draft, setDraft] = useState('')
  // Concrete Runtime model selection persisted in localStorage.
  const [mode, setMode] = useState<ChatMode>(readChatMode)
  function changeMode(next: ChatMode): void {
    setMode(next)
    writeChatMode(next)
  }
  const [isSending, setIsSending] = useState(false)
  const [checkpointForking, setCheckpointForking] = useState(false)
  const [pendingDeleteMessageID, setPendingDeleteMessageID] = useState<string>()
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsed)
  const [sidebarMotion, setSidebarMotion] = useState<'idle' | 'closing' | 'opening'>('idle')
  const [agentSettings, setAgentSettings] = useState<Required<AgentSettings>>(readAgentSettings)
  const [mainView, setMainView] = useState<'chat' | 'skills' | 'mcp' | 'connections' | 'settings'>('chat')
  const [isResizingSidebar, setIsResizingSidebar] = useState(false)
  const [sidebarSearchRequestVersion, setSidebarSearchRequestVersion] = useState(0)
  const [keyboardHelpOpen, setKeyboardHelpOpen] = useState(false)
  // Runtime model catalog feeding the composer picker.
  const [models, setModels] = useState<ModelOption[]>([])
  const [modelCatalogVersion, setModelCatalogVersion] = useState(0)
  const [localHost, setLocalHost] = useState<LocalHostProbe | null>(null)
  const [localHostConfig, setLocalHostConfig] = useState<LocalHostConfig | null>(null)
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
  const [pendingCommandDeliveryVersion, setPendingCommandDeliveryVersion] = useState(0)
  const scheduledNotificationIDs = useRef(new Set<string>())
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

  function setNotice(message: string, options: NoticeOptions = {}) {
    if (!message.trim()) {
      toast.dismiss(appNoticeToastID)
      return
    }
    toast.dismiss(appNoticeToastID)
    toast.message(message, {
      duration: 3200,
      ...options,
      id: appNoticeToastID,
    })
  }

  // Runtime owns the complete BYOK model catalog.
  useEffect(() => {
    if (!localHostConfig) {
      setModels([])
      return
    }
    let cancelled = false
    void listLocalRuntimeModels(localHostConfig).then((localCatalog) => {
        if (cancelled) return
        const catalog: ModelOption[] = localCatalog
          .filter((model) => model.available)
          .map((model) => ({
            id: model.spec,
            label: model.display_name,
            description: t('settings.models.localDescription'),
            vendor: model.provider_name,
            vendor_info: t('settings.models.localVendorInfo'),
            capability_tier: 'balanced',
          }))
        setModels(catalog)
        setMode((current) => {
          if (catalog.some((m) => m.id === current)) return current
          const next: ChatMode = catalog[0]?.id ?? ''
          writeChatMode(next)
          return next
        })
      }).catch(() => setModels([]))
    return () => {
      cancelled = true
    }
  }, [localHostConfig, modelCatalogVersion, t])

  useEffect(() => {
    writeSidebarWidth(sidebarWidth)
  }, [sidebarWidth])

  useEffect(() => {
    writeSidebarCollapsed(sidebarCollapsed)
  }, [sidebarCollapsed])

  useEffect(() => {
    return () => {
      if (sidebarMotionTimerRef.current) {
        window.clearTimeout(sidebarMotionTimerRef.current)
      }
    }
  }, [])

  /** Mirror the visible sidebar width onto `:root` so the sonner
   *  toaster — which portals to <body> and therefore can't inherit the
   *  `--sidebar-width` set on `.app-shell` — can offset its
   *  horizontal centering to land over the chat area, not the whole
   *  viewport. Collapsed sidebar → 0px; expanded → the same
   *  clamp(190, sidebarWidth, 340) used in styles.css. */
  useEffect(() => {
    const visible = sidebarCollapsed ? 0 : Math.min(maxSidebarWidth, Math.max(minSidebarWidth, sidebarWidth))
    document.documentElement.style.setProperty('--toast-center-offset', `${visible / 2}px`)
  }, [sidebarWidth, sidebarCollapsed])

  /** Global app shortcuts. Bypass browser/OS defaults only for app-level
   *  actions that are already visible in the shell. */
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey
      const key = event.key.toLowerCase()
      if (mod && !event.shiftKey && !event.altKey && key === 'n') {
        event.preventDefault()
        startNewConversation()
        return
      }
      if (mod && !event.shiftKey && !event.altKey && key === 'k') {
        event.preventDefault()
        expandSidebar()
        setMainView('chat')
        setSidebarSearchRequestVersion((version) => version + 1)
        return
      }
      if (!mod && !event.altKey && event.key === '?' && !isEditableKeyboardTarget(event.target)) {
        event.preventDefault()
        setKeyboardHelpOpen(true)
      }
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
    let disposed = false
    const navigationVersion = navigationVersionRef.current
    const maySelectInitialConversation = !conversationInitializationCompleteRef.current
    void localData.list().then((items) => {
      if (disposed) {
        return
      }
      conversationInitializationCompleteRef.current = true
      setConversations((current) => {
        if (!isDesktop) {
          return items
        }
        const merged = new Map(current.map((item) => [item.id, item]))
        for (const item of items) {
          const existing = merged.get(item.id)
          if (!existing || item.updatedAt > existing.updatedAt) {
            merged.set(item.id, item)
          }
        }
        return sortConversationsForSidebar(Array.from(merged.values()))
      })
      if (
        maySelectInitialConversation &&
        navigationVersionRef.current === navigationVersion
      ) {
        setActiveConversationID(items[0]?.id)
      }
      const [failure] = !startupRecoveryNoticeShownRef.current
        ? recentRecoverableFailures(items, 1)
        : []
      if (failure) {
        startupRecoveryNoticeShownRef.current = true
        setNotice(t('app.notice.recoverableFailureAfterRestart'), {
          duration: 8000,
          action: {
            label: t('agent.failureAction.openChat'),
            onClick: () => {
              setActiveConversationID(failure.target.conversationID)
              setMainView('chat')
            },
          },
        })
      }
    })
    return () => {
      disposed = true
    }
  }, [localData, t])

  useEffect(() => {
    const desktop = window.shejaneDesktop
    const config = getDesktopLocalHostConfig()
    if (!config) {
      return
    }
    setLocalHostConfig(config)
    if (desktop?.localHost?.ready === false) {
      setLocalHost({ online: false })
      return
    }
    let disposed = false
    void probeLocalHost(config.baseURL).then((probe) => {
      if (!disposed) {
        setLocalHost(probe)
      }
    })
    if (hasLocalHostAuthorization(config)) {
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
    if (!isDesktop || !localHost?.online || !hasLocalHostAuthorization(localHostConfig)) {
      return
    }
    let disposed = false
    let retryTimer: number | undefined
    const config = localHostConfig
    const deliver = async () => {
      try {
        const commands = await localData.listPendingRuntimeCommands()
        if (disposed || commands.length === 0) return
        const delivered = await deliverPendingRuntimeCommands(
          commands,
          config,
          (command, run) => settleDeliveredLocalRunCommand(command, run, config).then(() => undefined),
        )
        if (!disposed && delivered < commands.length) {
          retryTimer = window.setTimeout(() => void deliver(), pendingCommandRetryMs)
        }
      } catch {
        if (!disposed) {
          retryTimer = window.setTimeout(() => void deliver(), pendingCommandRetryMs)
        }
      }
    }
    void deliver()
    return () => {
      disposed = true
      if (retryTimer !== undefined) window.clearTimeout(retryTimer)
    }
  }, [isDesktop, localData, localHost?.online, localHostConfig, pendingCommandDeliveryVersion])

  useEffect(() => {
    if (!isDesktop || !localHost?.online || !hasLocalHostAuthorization(localHostConfig)) {
      return
    }
    let disposed = false
    let polling = false
    let interval: number | undefined
    const applyProjected = (projected: Conversation[], deleted = new Set<string>()) => {
      if (disposed || (projected.length === 0 && deleted.size === 0)) return
      setConversations((current) => {
        const merged = new Map(
          current.filter((item) => !deleted.has(item.id)).map((item) => [item.id, item]),
        )
        for (const item of projected) merged.set(item.id, item)
        return sortConversationsForSidebar(Array.from(merged.values()))
      })
    }
    const pollChanges = async () => {
      if (polling) return
      polling = true
      try {
        const result = await listLocalThreadChanges(runtimeThreadCursorRef.current, localHostConfig)
        if (disposed) return
        if (result.resetRequired) {
          const previousThreadIDs = new Set(runtimeThreadIDsRef.current)
          const projected = await syncRuntimeThreadCache(localHostConfig)
          const deleted = new Set(
            [...previousThreadIDs].filter((threadID) => !runtimeThreadIDsRef.current.has(threadID)),
          )
          applyProjected(projected, deleted)
          return
        }
        const latest = new Map(result.changes.map((change) => [change.thread_id, change]))
        const deleted = new Set(
          [...latest.values()]
            .filter((change) => change.change_type === 'thread.deleted')
            .map((change) => change.thread_id),
        )
        await Promise.all([...deleted].map((threadID) => localData.delete(threadID)))
        const existing = new Map((await localData.list()).map((item) => [item.id, item]))
        const snapshots = await mapWithConcurrency(
          [...latest.keys()].filter((threadID) => !deleted.has(threadID)),
          4,
          (threadID) => getLocalThreadSnapshot(threadID, localHostConfig),
        )
        const projected = snapshots.map((snapshot) =>
          projectRuntimeThread(snapshot, existing.get(snapshot.thread.id), t),
        )
        const saved = await Promise.all(
          projected.map((conversation) => localData.saveRuntimeProjection(conversation)),
        )
        const visibleProjected = projected.filter((_conversation, index) => saved[index])
        const nextRuntimeThreadIDs = new Set(runtimeThreadIDsRef.current)
        for (const threadID of latest.keys()) nextRuntimeThreadIDs.add(threadID)
        for (const threadID of deleted) nextRuntimeThreadIDs.delete(threadID)
        storeRuntimeThreadIDs(nextRuntimeThreadIDs)
        runtimeThreadIDsRef.current = nextRuntimeThreadIDs
        runtimeThreadCursorRef.current = Math.max(runtimeThreadCursorRef.current, result.cursor)
        applyProjected(visibleProjected, deleted)
      } catch {
        // Cursor polling is a cache refresh. The next pass retries from the
        // last committed cursor; it never changes Runtime truth.
      } finally {
        polling = false
      }
    }
    void syncRuntimeThreadCache(localHostConfig)
      .then((projected) => {
        applyProjected(projected)
        if (!disposed) {
          interval = window.setInterval(() => void pollChanges(), 2000)
        }
      })
      .catch(() => {
        if (!disposed) {
          interval = window.setInterval(() => void pollChanges(), 2000)
        }
      })
    return () => {
      disposed = true
      if (interval !== undefined) window.clearInterval(interval)
    }
  }, [isDesktop, localHost?.online, localHostConfig])

  useEffect(() => {
    if (!localHost?.online || !hasLocalHostAuthorization(localHostConfig)) {
      return
    }
    let disposed = false
    const config = localHostConfig
    const poll = async () => {
      try {
        const schedules = await listLocalSchedules(config, { notifyPending: true })
        if (disposed || schedules.length === 0) {
          return
        }
        for (const schedule of schedules) {
          if (scheduledNotificationIDs.current.has(schedule.id)) {
            continue
          }
          scheduledNotificationIDs.current.add(schedule.id)
          notifyScheduledRun(schedule, t)
          await markLocalScheduleNotified(schedule.id, config)
        }
        const freshRuns = await listLocalRuns(config)
        if (!disposed) {
          setLocalRuns(freshRuns)
        }
      } catch {
        // Best-effort observer; the next poll will retry.
      }
    }
    void poll()
    const interval = window.setInterval(() => void poll(), scheduledRunNotificationPollMs)
    return () => {
      disposed = true
      window.clearInterval(interval)
    }
  }, [localHost?.online, localHostConfig, t])

  const activeConversation = conversations.find((conversation) => conversation.id === activeID)
  // A local daemon run can stay cancelable after `isSending` flips false
  // because HITL permission/question pauses block the SSE stream while the
  // daemon run remains alive. Web cloud tool loops are cancelable during the
  // active send promise via `isSending`; after reload they need the separate
  // orphan-streaming recovery path, not a stale Stop button.
  const hasActiveRun = Boolean(
    activeConversation?.messages.some(
      (msg) =>
        msg.role === 'assistant' &&
        msg.runOrigin === 'local' &&
        Boolean(msg.runId) &&
        (msg.status === 'streaming' || msg.status === 'waiting_permission' || msg.status === 'waiting_input'),
    ),
  )
  const pendingApproval = findConversationPendingApproval(activeConversation, t)
  const pendingPlanApproval = pendingApproval ? null : findConversationPendingPlanApproval(activeConversation)
  const pendingQuestion = pendingApproval || pendingPlanApproval ? null : findConversationPendingQuestion(activeConversation)
  const activeWorkspace = activeConversation?.workspace ?? pendingWorkspace
  const selectedWorkspace = activeWorkspace ? findWorkspaceByPath(authorizedWorkspaces, activeWorkspace.path) : undefined
  const localProject = activeWorkspace
    ? {
        label: selectedWorkspace?.label ?? activeWorkspace.label,
        path: activeWorkspace.path,
        authorized: Boolean(selectedWorkspace || activeWorkspace.authorized),
      }
    : undefined

  async function refreshConversations(nextActiveID?: string, options: { preserveEmptyActive?: boolean } = {}) {
    const items = await localData.list()
    setConversations(items)
    setActiveConversationID(nextActiveID ?? (options.preserveEmptyActive ? undefined : items[0]?.id))
  }

  async function syncRuntimeThreadCache(config: LocalHostConfig): Promise<Conversation[]> {
    const { threads, cursor } = await listLocalThreads(config)
    const nextThreadIDs = new Set(threads.map((thread) => thread.id))
    const removedThreadIDs = [...loadRuntimeThreadIDs()].filter((id) => !nextThreadIDs.has(id))
    await Promise.all(removedThreadIDs.map((id) => localData.delete(id)))
    const existing = new Map((await localData.list()).map((item) => [item.id, item]))
    const snapshots = await mapWithConcurrency(
      threads,
      4,
      (thread) => getLocalThreadSnapshot(thread.id, config),
    )
    const projected = snapshots.map((snapshot) =>
      projectRuntimeThread(snapshot, existing.get(snapshot.thread.id), t),
    )
    const saved = await Promise.all(
      projected.map((conversation) => localData.saveRuntimeProjection(conversation)),
    )
    const visibleProjected = projected.filter((_conversation, index) => saved[index])
    storeRuntimeThreadIDs(nextThreadIDs)
    runtimeThreadIDsRef.current = nextThreadIDs
    runtimeThreadCursorRef.current = Math.max(runtimeThreadCursorRef.current, cursor)
    return visibleProjected
  }

  async function settleDeliveredLocalRunCommand(
    command: PendingRuntimeCommand,
    result: RuntimeCommandResult,
    config: LocalHostConfig,
  ): Promise<boolean> {
    if (
      command.type === 'question.answer' ||
      command.type === 'permission.resolve' ||
      command.type === 'plan.resolve' ||
      command.type === 'tool.reconcile'
    ) {
      await localData.deletePendingRuntimeCommand(command.commandId)
      const projected = await syncRuntimeThreadCache(config)
      setConversations((items) =>
        projected.reduce((next, conversation) => upsertConversation(next, conversation), items),
      )
      return true
    }
    if (command.type === 'run.cancel') {
      await localData.deletePendingRuntimeCommand(command.commandId)
      return true
    }
    const run = result as LocalHarnessRun
    const threadID = command.input.threadId
    if (threadID) {
      const nextRuntimeThreadIDs = new Set(runtimeThreadIDsRef.current).add(threadID)
      storeRuntimeThreadIDs(nextRuntimeThreadIDs)
      runtimeThreadIDsRef.current = nextRuntimeThreadIDs
    }
    const [pending, conversation] = await Promise.all([
      localData.getPendingRuntimeCommand(command.commandId),
      threadID ? localData.get(threadID) : Promise.resolve(undefined),
    ])
    if (pending?.canceledAt || (threadID && !conversation)) {
      if (threadID) {
        await cancelLocalRunCommand(`cancel_${run.id}`, run.id, config)
        await streamLocalRun(run.id, config, { onDelta: () => undefined, onEvent: () => undefined })
        await deleteLocalThread(threadID, config)
        const nextRuntimeThreadIDs = new Set(runtimeThreadIDsRef.current)
        nextRuntimeThreadIDs.delete(threadID)
        storeRuntimeThreadIDs(nextRuntimeThreadIDs)
        runtimeThreadIDsRef.current = nextRuntimeThreadIDs
      }
      if (threadID) {
        await localData.settleCanceledLocalRunCommand(threadID, command.commandId)
      } else {
        await localData.deletePendingRuntimeCommand(command.commandId)
      }
      return false
    }
    await localData.deletePendingRuntimeCommand(command.commandId)
    return true
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
    const content = draft
    // Snapshot the attachment before we optimistically clear it so we
    // can roll back if the send fails. The chip used to linger until
    // the assistant stream finished — that read as "the file's still
    // attached for some reason" to users. Clearing right after the
    // draft mirrors the message-bar behaviour: the prompt + its
    // attachment vanish from the composer the instant Enter fires;
    // the catch path restores both if the request never landed.
    setIsSending(true)
    setNotice('')
    setDraft('')
    const renderContext = createConversationRenderContext()
    try {
      if (!localHost?.online || !hasLocalHostAuthorization(localHostConfig)) {
        throw new Error(t('app.notice.localHostDisconnected'))
      }
      if (!models.some((model) => model.id === mode)) {
        throw new Error(t('app.notice.localModelUnavailable'))
      }
      const conversation = await sendLocalHarnessMessage(content, renderContext)
      await refreshConversationsAfterStream(conversation.id, renderContext)
    } catch (error) {
      setDraft((current) => current || content)
      setNotice(error instanceof Error ? error.message : t('app.notice.sendFailed'))
      const userNavigatedWhileStreaming = navigationVersionRef.current !== renderContext.navigationVersionAtStart
      await refreshConversations(userNavigatedWhileStreaming ? activeIDRef.current : activeID, {
        preserveEmptyActive: userNavigatedWhileStreaming && !activeIDRef.current,
      })
    } finally {
      setIsSending(false)
    }
  }

  /** Optimistically truncate the cache, then ask Runtime to create an
   *  immutable replacement branch from `userMessageID`. The authoritative
   *  snapshot later confirms the visible branch. */
  async function resendFromUserMessage(
    userMessageID: string,
    text: string,
    preferLocal: boolean,
    localRunOptions?: LocalHarnessRunOptions,
    targetConversationID = activeIDRef.current,
  ) {
    if (!targetConversationID) {
      return
    }
    const conversation = await localData.get(targetConversationID)
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
    if (activeIDRef.current !== targetConversationID) {
      navigationVersionRef.current += 1
      setPendingWorkspace(undefined)
      setPendingProject(undefined)
      setActiveConversationID(targetConversationID)
      setMainView('chat')
    }
    await refreshConversations(targetConversationID)

    const renderContext = createConversationRenderContext()
    setIsSending(true)
    setNotice('')
    try {
      const next = await sendLocalHarnessMessage(
        text,
        renderContext,
        agentSettings,
        { ...localRunOptions, replaceFromClientId: userMessageID },
        targetConversationID,
      )
      await refreshConversationsAfterStream(next.id, renderContext)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : t('app.notice.sendFailed'))
      await refreshConversations(targetConversationID)
    } finally {
      setIsSending(false)
    }
  }

  function recoveryTargetFor(assistantMessageID: string): RecoveryTarget | undefined {
    if (!activeConversation) {
      return undefined
    }
    return { conversationID: activeConversation.id, assistantMessageID }
  }

  async function retryRecoveryTarget(target: RecoveryTarget) {
    if (!beginRecoveryAction(recoveryStateRef.current, 'retry', target)) {
      setNotice(t('app.notice.recoveryRetryAlreadyRunning'))
      return
    }
    try {
      await regenerateMessageInConversation(target.conversationID, target.assistantMessageID)
    } finally {
      endRecoveryAction(recoveryStateRef.current, 'retry', target)
    }
  }

  function recoveryRetryAction(target: RecoveryTarget) {
    return {
      label: t('agent.failureAction.retry'),
      onClick: () => void retryRecoveryTarget(target),
    }
  }

  function handleRegenerateMessage(assistantMessageID: string) {
    const target = recoveryTargetFor(assistantMessageID)
    if (!target) {
      return
    }
    void retryRecoveryTarget(target)
  }

  async function regenerateMessageInConversation(conversationID: string, assistantMessageID: string) {
    const conversation = await localData.get(conversationID)
    if (!conversation) {
      return
    }
    const messages = conversation.messages
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
    const assistantMessage = messages[assistantIndex]
    void resendFromUserMessage(
      userMessage.id,
      userMessage.content,
      true,
      retryRunOptionsFor(assistantMessage),
      conversationID,
    )
  }

  function retryRunOptionsFor(assistantMessage: ChatMessage): LocalHarnessRunOptions | undefined {
    const failure = latestRunFailureEvent(assistantMessage)
    if (!failure) {
      return undefined
    }
    const attempt = nextRetryAttempt(assistantMessage)
    const retryAction = t('agent.retryAttemptLabel', { attempt })
    return {
      parentRunId: assistantMessage.runId,
      metadata: {
        intent: 'retry',
        source_run_id: assistantMessage.runId,
        source_message_id: assistantMessage.id,
        attempt,
        failure_category: failure.failureCategory,
        failure_action_kind: failure.failureActionKind,
      },
      initialAgentEvents: [
        {
          type: 'ui.action.requested',
          label: t('agent.uiActionRequestedLabel', { action: retryAction }),
          retryAttempt: attempt,
          retrySourceRunId: assistantMessage.runId,
          retrySourceMessageId: assistantMessage.id,
        },
      ],
    }
  }

  async function repairRecoveryTarget(target: RecoveryTarget) {
    if (!beginRecoveryAction(recoveryStateRef.current, 'repair', target)) {
      setNotice(t('app.notice.recoveryRetryAlreadyRunning'))
      return
    }
    try {
      const conversation = await localData.get(target.conversationID)
      if (!conversation) {
        return
      }
      const messages = conversation.messages
      const assistantIndex = messages.findIndex((message) => message.id === target.assistantMessageID)
      if (assistantIndex < 0) {
        return
      }
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
      const assistantMessage = messages[assistantIndex]
      const userMessage = messages[userIndex]
      const failure = latestRunFailureEvent(assistantMessage)
      const attempt = nextRepairAttempt(assistantMessage)
      const repairAction = t('agent.repairAttemptLabel', { attempt })
      const initialAgentEvents: AgentTimelineItem[] = [
        {
          type: 'ui.action.requested',
          label: t('agent.uiActionRequestedLabel', { action: repairAction }),
          repairAttempt: attempt,
          repairSourceRunId: assistantMessage.runId,
          repairSourceMessageId: assistantMessage.id,
        },
      ]
      await resendFromUserMessage(
        userMessage.id,
        userMessage.content,
        true,
        {
          parentRunId: assistantMessage.runId,
          metadata: {
            intent: 'repair',
            source_run_id: assistantMessage.runId,
            source_message_id: assistantMessage.id,
            attempt,
            failure_category: failure?.failureCategory,
            failure_action_kind: failure?.failureActionKind,
          },
          initialAgentEvents,
        },
        target.conversationID,
      )
    } finally {
      endRecoveryAction(recoveryStateRef.current, 'repair', target)
    }
  }

  function handleAgentFailureAction(action: AgentFailureAction, assistantMessageID: string) {
    const recoveryTarget = recoveryTargetFor(assistantMessageID)
    if (!recoveryTarget) {
      return
    }
    if (action === 'retry') {
      void retryRecoveryTarget(recoveryTarget)
      return
    }
    if (action === 'repair') {
      void repairRecoveryTarget(recoveryTarget)
      return
    }
    if (action === 'workspace') {
      void selectProjectForActiveConversation(recoveryTarget)
      return
    }
    if (action === 'diagnostics') {
      const runID = activeConversation?.messages.find((message) => message.id === assistantMessageID)?.runId
      if (runID) {
        void openLocalRunDiagnostics(runID, recoveryTarget)
      }
    }
  }

  function handleEditResendMessage(userMessageID: string, newText: string) {
    if (!activeConversation) {
      return
    }
    void resendFromUserMessage(userMessageID, newText, true)
  }

  async function handleDeleteMessage(messageID: string) {
    if (!activeID) {
      return
    }
    const conversation = await localData.get(activeID)
    const message = conversation?.messages.find((item) => item.id === messageID)
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
    runOptions?: LocalHarnessRunOptions,
    targetConversationID = activeIDRef.current,
  ): Promise<Conversation> {
    const runLocalHostConfig = localHostConfig ?? getDesktopLocalHostConfig()
    if (!runLocalHostConfig) {
      throw new Error(t('app.notice.localHostDisconnected'))
    }
    if (!localHostConfig) {
      setLocalHostConfig(runLocalHostConfig)
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
    const commandId = createLocalID('cmd')
    const conversation = (targetConversationID ? await localData.get(targetConversationID) : undefined) ?? createConversation(text, timestamp, t('chat.newConversation'))
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
      commandId,
      role: 'user',
      content: text,
      createdAt: timestamp,
      status: 'done',
    }
    const assistantMessage: ChatMessage = {
      id: createLocalID('msg'),
      role: 'assistant',
      content: '',
      createdAt: timestamp,
      status: 'pending',
      runOrigin: 'local',
      agentEvents: runOptions?.initialAgentEvents ? [...runOptions.initialAgentEvents] : [],
    }

    const priorMessages = conversation.messages
    conversation.messages = [...priorMessages, userMessage, assistantMessage]
    conversation.updatedAt = timestamp
    scheduleConversationRender(conversation, context)

    const parentRunId = runOptions?.parentRunId ?? [...priorMessages]
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

    const runInput: CreateLocalRunInput = {
      commandId,
      clientMessageId: userMessage.id,
      threadId: conversation.id,
      assistantMessageId: assistantMessage.id,
      userInput: text,
      threadTitle: conversation.title,
      threadMetadata: {
        archived: conversation.archived,
        pinned: conversation.pinned ?? false,
        project: conversation.project,
        workspace: conversation.workspace,
      },
      userItemMetadata: {
        attachments: userMessage.attachments ?? [],
      },
      replaceFromClientId: runOptions?.replaceFromClientId,
      goal,
      workspacePath: conversation.workspace?.path.trim() || undefined,
      history: runtimeThreadIDsRef.current.has(conversation.id)
        ? undefined
        : deriveAgentHistory(priorMessages),
      parentRunId,
      settings: effectiveSettings,
      metadata: runOptions?.metadata,
      mode,
    }
    const pendingCommand: PendingRunStartCommand = {
      type: 'run.start',
      commandId,
      createdAt: timestamp,
      input: runInput,
    }
    await localData.saveWithPendingRuntimeCommand(conversation, pendingCommand)

    let keepConversation = true
    try {
      const run = await createLocalRun(runInput, runLocalHostConfig)
      Object.assign(assistantMessage, { runId: run.id, status: 'streaming' as const })
      keepConversation = await settleDeliveredLocalRunCommand(pendingCommand, run, runLocalHostConfig)
      if (!keepConversation) return conversation
      setLocalRuns((items) => upsertLocalRun(items, run))
      scheduleConversationRender(conversation, context)
      await streamLocalMessage(
        run.id,
        runLocalHostConfig,
        conversation,
        assistantMessage,
        t,
        openOfficeDocument,
        () => scheduleConversationRender(conversation, context),
      )
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
    } catch {
      setPendingCommandDeliveryVersion((version) => version + 1)
      assistantMessage.status = assistantMessage.runId ? 'streaming' : 'pending'
    } finally {
      if (keepConversation && await localData.get(conversation.id)) {
        try {
          const snapshot = await getLocalThreadSnapshot(conversation.id, runLocalHostConfig)
          Object.assign(conversation, projectRuntimeThread(snapshot, conversation, t))
        } catch {
          conversation.updatedAt = new Date().toISOString()
        }
        if (await localData.saveRuntimeProjection(conversation)) {
          scheduleConversationRender(conversation, context)
        }
      }
    }

    return conversation
  }

  /** Stop whatever cancelable run is currently active for the active
   *  conversation. Local daemon runs emit `run.canceled` on their SSE
   *  channel. */
  async function cancelActiveRun() {
    if (!activeConversation) {
      return
    }
    // Most-recent assistant message that's still cancelable — that's the
    // in-flight run from the user's PoV.
    const activeMessage = [...activeConversation.messages]
      .reverse()
      .find(
        (msg) =>
          msg.role === 'assistant' &&
          Boolean(msg.runId) &&
          msg.runOrigin === 'local' &&
          (msg.status === 'streaming' || msg.status === 'waiting_permission' || msg.status === 'waiting_input'),
      )
    if (!activeMessage?.runId) {
      return
    }
    try {
      if (!localHostConfig) {
        return
      }
      const existing = (await localData.listPendingRuntimeCommands()).find(
        (command): command is PendingRunCancelCommand =>
          command.type === 'run.cancel' && command.input.runId === activeMessage.runId,
      )
      const command = existing ?? {
        type: 'run.cancel' as const,
        commandId: `cancel_${activeMessage.runId}`,
        createdAt: new Date().toISOString(),
        input: { runId: activeMessage.runId, threadId: activeConversation.id },
      }
      if (!existing) await localData.savePendingRuntimeCommand(command)
      try {
        await cancelLocalRunCommand(command.commandId, command.input.runId, localHostConfig)
        await localData.deletePendingRuntimeCommand(command.commandId)
      } catch (error) {
        setPendingCommandDeliveryVersion((version) => version + 1)
        throw error
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : t('app.notice.sendFailed'))
    }
  }

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== 'Escape') {
        return
      }
      if (keyboardHelpOpen) {
        event.preventDefault()
        setKeyboardHelpOpen(false)
        return
      }
      if (isSending || hasActiveRun) {
        event.preventDefault()
        void cancelActiveRun()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [keyboardHelpOpen, isSending, hasActiveRun])

  async function appendInstructionToActiveRun() {
    const content = draft.trim()
    if (!content) {
      setNotice(t('app.notice.emptyMessage'))
      return
    }
    if (!activeConversation || !localHostConfig) {
      setNotice(t('app.notice.localHostDisconnected'))
      return
    }
    const activeMessage = [...activeConversation.messages]
      .reverse()
      .find(
        (msg) =>
          msg.role === 'assistant' &&
          msg.runOrigin === 'local' &&
          Boolean(msg.runId) &&
          (msg.status === 'streaming' || msg.status === 'waiting_permission' || msg.status === 'waiting_input'),
      )
    if (!activeMessage?.runId) {
      setNotice(t('app.notice.missingLocalTask'))
      return
    }

    setNotice('')
    setDraft('')
    try {
      await injectLocalRunInstruction(activeMessage.runId, content, localHostConfig)
      toast.success(t('app.notice.steeringQueued'), { id: 'steering-queued', duration: 2200 })
    } catch (error) {
      setDraft((current) => current || content)
      setNotice(error instanceof Error ? error.message : t('app.notice.steeringFailed'))
    }
  }

  async function handlePermissionDecision(
    messageID: string,
    requestID: string,
    decision: 'approve' | 'edit' | 'deny',
    scope: LocalPermissionScope = 'once',
    editedAction?: { name: string, args: Record<string, unknown> },
  ) {
    if (permissionDecisionsInFlightRef.current.has(requestID)) return
    permissionDecisionsInFlightRef.current.add(requestID)
    try {
      await handlePermissionDecisionOnce(
        messageID,
        requestID,
        decision,
        scope,
        editedAction,
      )
    } finally {
      permissionDecisionsInFlightRef.current.delete(requestID)
    }
  }

  async function handlePermissionDecisionOnce(
    messageID: string,
    requestID: string,
    decision: 'approve' | 'edit' | 'deny',
    scope: LocalPermissionScope,
    editedAction?: { name: string, args: Record<string, unknown> },
  ) {
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
    const contentBeforeDecision = message.content
    let commandAccepted = false
    message.status = 'streaming'
    const renderContext = createConversationRenderContext()
    try {
      const existing = (await localData.listPendingRuntimeCommands()).find(
        (command): command is PendingPermissionResolveCommand =>
          command.type === 'permission.resolve' && command.input.permissionId === requestID,
      )
      const command = existing ?? {
        type: 'permission.resolve' as const,
        commandId: `resolve_${requestID}`,
        createdAt: new Date().toISOString(),
        input: {
          permissionId: requestID,
          decision,
          scope,
          editedAction,
          runId: message.runId,
          threadId: conversation.id,
        },
      }
      if (!existing) await localData.savePendingRuntimeCommand(command)
      try {
        await resolveLocalPermissionCommand(
          command.commandId,
          command.input.permissionId,
          command.input.decision,
          { scope: command.input.scope, editedAction: command.input.editedAction },
          localHostConfig,
        )
        commandAccepted = true
        await localData.deletePendingRuntimeCommand(command.commandId)
      } catch (error) {
        setPendingCommandDeliveryVersion((version) => version + 1)
        throw error
      }
      // Decision-acknowledgement toast so the user sees their click landed —
      // the bar disappears the moment the resume stream starts, otherwise
      // there's no feedback at all.
      toast.success(
        command.input.decision === 'approve' || command.input.decision === 'edit'
          ? t(command.input.scope === 'run' ? 'app.notice.permissionRunApproved' : 'app.notice.permissionApproved')
          : t('app.notice.permissionDenied'),
        { id: 'permission-decision', duration: 2000 },
      )
      await streamLocalMessage(
        message.runId,
        localHostConfig,
        conversation,
        message,
        t,
        openOfficeDocument,
        () => scheduleConversationRender(conversation, renderContext),
      )
      finalizeLocalRunStatus(message)
      scheduleConversationRender(conversation, renderContext)
    } catch (error) {
      message.status = commandAccepted ? 'streaming' : 'waiting_permission'
      if (!commandAccepted) message.content = contentBeforeDecision
      setNotice(error instanceof Error ? error.message : t('app.notice.localPermissionFailed'))
      scheduleConversationRender(conversation, renderContext)
    } finally {
      conversation.updatedAt = new Date().toISOString()
      await localData.save(conversation)
      await refreshConversationsAfterStream(conversation.id, renderContext)
    }
  }

  async function handleToolReconciliation(
    messageID: string,
    requestID: string,
    decision: LocalToolReconciliationDecision,
  ) {
    if (toolReconciliationsInFlightRef.current.has(requestID)) return
    toolReconciliationsInFlightRef.current.add(requestID)
    try {
      await handleToolReconciliationOnce(messageID, requestID, decision)
    } finally {
      toolReconciliationsInFlightRef.current.delete(requestID)
    }
  }

  async function handleToolReconciliationOnce(
    messageID: string,
    requestID: string,
    decision: LocalToolReconciliationDecision,
  ) {
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
    const contentBeforeDecision = message.content
    let commandAccepted = false
    message.status = 'streaming'
    const renderContext = createConversationRenderContext()
    try {
      const existing = (await localData.listPendingRuntimeCommands()).find(
        (command): command is PendingToolReconcileCommand =>
          command.type === 'tool.reconcile' && command.input.operationId === requestID,
      )
      const command = existing ?? {
        type: 'tool.reconcile' as const,
        commandId: `reconcile_${requestID}`,
        createdAt: new Date().toISOString(),
        input: {
          operationId: requestID,
          decision,
          runId: message.runId,
          threadId: conversation.id,
        },
      }
      if (!existing) await localData.savePendingRuntimeCommand(command)
      try {
        await reconcileLocalToolCommand(
          command.commandId,
          command.input.operationId,
          command.input.decision,
          localHostConfig,
        )
        commandAccepted = true
        await localData.deletePendingRuntimeCommand(command.commandId)
      } catch (error) {
        setPendingCommandDeliveryVersion((version) => version + 1)
        throw error
      }
      await streamLocalMessage(
        message.runId,
        localHostConfig,
        conversation,
        message,
        t,
        openOfficeDocument,
        () => scheduleConversationRender(conversation, renderContext),
      )
      finalizeLocalRunStatus(message)
      scheduleConversationRender(conversation, renderContext)
    } catch (error) {
      message.status = commandAccepted ? 'streaming' : 'waiting_permission'
      if (!commandAccepted) message.content = contentBeforeDecision
      setNotice(error instanceof Error ? error.message : t('app.notice.localPermissionFailed'))
      scheduleConversationRender(conversation, renderContext)
    } finally {
      conversation.updatedAt = new Date().toISOString()
      await localData.save(conversation)
      await refreshConversationsAfterStream(conversation.id, renderContext)
    }
  }

  async function handleQuestionAnswer(
    messageID: string,
    requestID: string,
    answers: Record<string, string[]>,
  ) {
    if (questionAnswersInFlightRef.current.has(requestID)) return
    questionAnswersInFlightRef.current.add(requestID)
    try {
      await handleQuestionAnswerOnce(messageID, requestID, answers)
    } finally {
      questionAnswersInFlightRef.current.delete(requestID)
    }
  }

  async function handleQuestionAnswerOnce(messageID: string, requestID: string, answers: Record<string, string[]>) {
    if (!activeID) {
      setNotice(t('app.notice.missingLocalTask'))
      return
    }
    const conversation = await localData.get(activeID)
    const message = conversation?.messages.find((item) => item.id === messageID)
    if (!localHostConfig) {
      setNotice(t('app.notice.localHostDisconnected'))
      return
    }
    if (!conversation || !message?.runId) {
      setNotice(t('app.notice.missingLocalTask'))
      return
    }

    setNotice('')
    const contentBeforeAnswer = message.content
    let commandAccepted = false
    message.status = 'streaming'
    const renderContext = createConversationRenderContext()
    try {
      const existing = (await localData.listPendingRuntimeCommands()).find(
        (command): command is PendingQuestionAnswerCommand =>
          command.type === 'question.answer' && command.input.questionId === requestID,
      )
      const command = existing ?? {
        type: 'question.answer' as const,
        commandId: `answer_${requestID}`,
        createdAt: new Date().toISOString(),
        input: {
          questionId: requestID,
          answers,
          runId: message.runId,
          threadId: conversation.id,
        },
      }
      if (!existing) await localData.savePendingRuntimeCommand(command)
      try {
        await answerLocalQuestionCommand(
          command.commandId,
          command.input.questionId,
          command.input.answers,
          localHostConfig,
        )
        commandAccepted = true
        await localData.deletePendingRuntimeCommand(command.commandId)
      } catch (error) {
        setPendingCommandDeliveryVersion((version) => version + 1)
        throw error
      }
      toast.success(t('app.notice.questionAnswered'), { id: 'question-answer', duration: 2000 })
      await streamLocalMessage(
        message.runId,
        localHostConfig,
        conversation,
        message,
        t,
        openOfficeDocument,
        () => scheduleConversationRender(conversation, renderContext),
      )
      finalizeLocalRunStatus(message)
      scheduleConversationRender(conversation, renderContext)
    } catch (error) {
      message.status = commandAccepted ? 'streaming' : 'waiting_input'
      if (!commandAccepted) message.content = contentBeforeAnswer
      setNotice(error instanceof Error ? error.message : t('app.notice.localPermissionFailed'))
      scheduleConversationRender(conversation, renderContext)
    } finally {
      conversation.updatedAt = new Date().toISOString()
      await localData.save(conversation)
      await refreshConversationsAfterStream(conversation.id, renderContext)
    }
  }

  async function handlePlanApprovalDecision(
    messageID: string,
    requestID: string,
    decision: LocalPlanApprovalDecision,
    instructions?: string,
  ) {
    if (planDecisionsInFlightRef.current.has(requestID)) return
    planDecisionsInFlightRef.current.add(requestID)
    try {
      await handlePlanApprovalDecisionOnce(
        messageID,
        requestID,
        decision,
        instructions,
      )
    } finally {
      planDecisionsInFlightRef.current.delete(requestID)
    }
  }

  async function handlePlanApprovalDecisionOnce(
    messageID: string,
    requestID: string,
    decision: LocalPlanApprovalDecision,
    instructions?: string,
  ) {
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
    const contentBeforeDecision = message.content
    let commandAccepted = false
    message.status = 'streaming'
    const renderContext = createConversationRenderContext()
    try {
      const existing = (await localData.listPendingRuntimeCommands()).find(
        (command): command is PendingPlanResolveCommand =>
          command.type === 'plan.resolve' && command.input.approvalId === requestID,
      )
      const command = existing ?? {
        type: 'plan.resolve' as const,
        commandId: `resolve_plan_${requestID}`,
        createdAt: new Date().toISOString(),
        input: {
          approvalId: requestID,
          decision,
          instructions: instructions?.trim() || undefined,
          runId: message.runId,
          threadId: conversation.id,
        },
      }
      if (!existing) await localData.savePendingRuntimeCommand(command)
      try {
        await resolveLocalPlanCommand(
          command.commandId,
          command.input.approvalId,
          command.input.decision,
          command.input.instructions,
          localHostConfig,
        )
        commandAccepted = true
        await localData.deletePendingRuntimeCommand(command.commandId)
      } catch (error) {
        setPendingCommandDeliveryVersion((version) => version + 1)
        throw error
      }
      const noticeKey =
        command.input.decision === 'approve'
          ? 'app.notice.planApproved'
          : command.input.decision === 'modify'
            ? 'app.notice.planModified'
            : 'app.notice.planRejected'
      toast.success(t(noticeKey), { id: 'plan-approval-decision', duration: 2000 })
      await streamLocalMessage(
        message.runId,
        localHostConfig,
        conversation,
        message,
        t,
        openOfficeDocument,
        () => scheduleConversationRender(conversation, renderContext),
      )
      finalizeLocalRunStatus(message)
      scheduleConversationRender(conversation, renderContext)
    } catch (error) {
      message.status = commandAccepted ? 'streaming' : 'waiting_input'
      if (!commandAccepted) message.content = contentBeforeDecision
      setNotice(error instanceof Error ? error.message : t('app.notice.localPermissionFailed'))
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
      await streamLocalMessage(
        run.id,
        localHostConfig,
        conversation,
        assistantMessage,
        t,
        openOfficeDocument,
        () => scheduleConversationRender(conversation, renderContext),
      )
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

  async function openLocalRunDiagnostics(runID: string, recoveryTarget?: RecoveryTarget) {
    if (!localHostConfig) {
      setNotice(t('app.notice.localHostDisconnected'))
      return
    }
    try {
      setRunDiagnostics(await getLocalRunDiagnostics(runID, localHostConfig))
      if (recoveryTarget) {
        setNotice(t('app.notice.diagnosticsOpenedWithRetry'), {
          duration: 8000,
          action: recoveryRetryAction(recoveryTarget),
        })
        return
      }
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

  async function forkLocalRunFromCheckpoint(runID: string, checkpointID: string) {
    if (!localHostConfig) {
      setNotice(t('app.notice.localHostDisconnected'))
      return
    }
    const key = `${runID}:${checkpointID}`
    if (checkpointForksInFlightRef.current.has(key)) return
    checkpointForksInFlightRef.current.add(key)
    setCheckpointForking(true)
    try {
      await forkLocalRunFromCheckpointOnce(runID, checkpointID, localHostConfig)
    } finally {
      checkpointForksInFlightRef.current.delete(key)
      setCheckpointForking(false)
    }
  }

  async function forkLocalRunFromCheckpointOnce(
    runID: string,
    checkpointID: string,
    config: LocalHostConfig,
  ) {
    const [pendingCommands, conversations] = await Promise.all([
      localData.listPendingRuntimeCommands(),
      localData.list(),
    ])
    const existingFork = pendingCommands.find((command) =>
      command.type === 'run.fork' &&
      !command.canceledAt &&
      command.input.sourceRunId === runID &&
      command.input.checkpointId === checkpointID,
    )
    if (existingFork) {
      navigationVersionRef.current += 1
      setPendingWorkspace(undefined)
      setPendingProject(undefined)
      setActiveConversationID(existingFork.input.threadId)
      setMainView('chat')
      setRunDiagnostics(null)
      setPendingCommandDeliveryVersion((version) => version + 1)
      await refreshConversations(existingFork.input.threadId)
      return
    }
    const sourceDiagnostics = runDiagnostics?.run.id === runID ? runDiagnostics : null
    const forkGoal = sourceDiagnostics?.run.goal || localRuns.find((run) => run.id === runID)?.goal
    const timestamp = new Date().toISOString()
    const sourceConversation = conversations.find((conversation) =>
      conversation.messages.some((message) => message.runId === runID),
    )
    const userContent = t('app.notice.checkpointForkUserMessage', {
      checkpoint: checkpointID.slice(0, 12),
      goal: forkGoal ?? '',
    })
    const conversation = createConversation(
      forkGoal || userContent,
      timestamp,
      t('chat.newConversation'),
    )
    conversation.workspace = sourceConversation?.workspace
    conversation.project = sourceConversation?.project
    const commandId = createLocalID('cmd')
    const userMessage: ChatMessage = {
      id: createLocalID('msg'),
      commandId,
      role: 'user',
      content: userContent,
      createdAt: timestamp,
      status: 'done',
    }
    const assistantMessage: ChatMessage = {
      id: createLocalID('msg'),
      role: 'assistant',
      content: '',
      createdAt: timestamp,
      status: 'pending',
      runOrigin: 'local',
      agentEvents: [],
    }
    const pendingCommand: PendingRunForkCommand = {
      type: 'run.fork',
      commandId,
      createdAt: timestamp,
      input: {
        sourceRunId: runID,
        protocolVersion: LOCAL_RUNTIME_PROTOCOL_VERSION,
        requiredCapabilities: [
          'agent.run',
          'agent.stream',
          'hitl',
          ...(sourceConversation?.workspace?.path ? ['workspace.files'] : []),
        ],
        clientMessageId: userMessage.id,
        assistantMessageId: assistantMessage.id,
        threadId: conversation.id,
        checkpointId: checkpointID,
        goal: forkGoal,
        userInput: userContent,
        threadTitle: conversation.title,
        threadMetadata: {
          archived: false,
          pinned: false,
          project: conversation.project,
          workspace: conversation.workspace,
        },
      },
    }
    conversation.messages = [userMessage, assistantMessage]
    try {
      setNotice('')
      await localData.saveWithPendingRuntimeCommand(conversation, pendingCommand)
      navigationVersionRef.current += 1
      setPendingWorkspace(undefined)
      setPendingProject(undefined)
      setActiveConversationID(conversation.id)
      setMainView('chat')
      setRunDiagnostics(null)
      await refreshConversations(conversation.id)
      const run = await forkLocalRun(commandId, pendingCommand.input, config)
      const keepConversation = await settleDeliveredLocalRunCommand(
        pendingCommand,
        run,
        config,
      )
      if (!keepConversation) return
      setLocalRuns((items) => upsertLocalRun(items, run))
      Object.assign(assistantMessage, { runId: run.id, status: 'streaming' as const })
      conversation.updatedAt = timestamp
      await localData.save(conversation)

      const renderContext = createConversationRenderContext()
      scheduleConversationRender(conversation, renderContext)
      await streamLocalMessage(
        run.id,
        config,
        conversation,
        assistantMessage,
        t,
        openOfficeDocument,
        () => scheduleConversationRender(conversation, renderContext),
      )
      finalizeLocalRunStatus(assistantMessage)
      scheduleConversationRender(conversation, renderContext)
      try {
        const snapshot = await getLocalThreadSnapshot(conversation.id, config)
        Object.assign(conversation, projectRuntimeThread(snapshot, conversation, t))
        scheduleConversationRender(conversation, renderContext)
      } catch {
        conversation.updatedAt = new Date().toISOString()
      }
      await localData.save(conversation)
      await refreshConversationsAfterStream(conversation.id, renderContext)
    } catch (error) {
      setPendingCommandDeliveryVersion((version) => version + 1)
      setNotice(error instanceof Error ? error.message : t('app.notice.checkpointForkFailed'))
      await refreshConversations(conversation.id)
    }
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
  async function selectProjectForActiveConversation(recoveryTarget?: RecoveryTarget) {
    const config = localHostConfig ?? getDesktopLocalHostConfig()
    if (!hasLocalHostAuthorization(config)) {
      setNotice(t('app.notice.localHostNotPairedAuthorize'))
      return
    }
    if (!localHostConfig) {
      setLocalHostConfig(config)
    }
    const targetConversationID = recoveryTarget?.conversationID ?? activeIDRef.current
    const picked = await chooseWorkspaceDirectory()
    if (!picked) return
    try {
      const ws = await authorizeLocalWorkspace(picked, config)
      setAuthorizedWorkspaces((items) => upsertWorkspace(items, ws))
      const name = pathBasename(ws.path) || ws.label || ws.path
      const workspace: ConversationWorkspace = {
        path: ws.path,
        label: ws.label,
        authorized: true,
        authorizationId: ws.id,
      }
      const project: ConversationProject = { name }
      if (targetConversationID) {
        await updateConversationMetadata(targetConversationID, (item) => {
          item.project = project
          item.workspace = workspace
        })
      } else {
        setPendingWorkspace(workspace)
        setPendingProject(project)
      }
      if (recoveryTarget) {
        setNotice(t('app.notice.workspaceBoundWithRetry', { label: name }), {
          duration: 8000,
          action: recoveryRetryAction(recoveryTarget),
        })
        return
      }
      setNotice(t('project.notice.bound', { name }))
    } catch (err) {
      setNotice(err instanceof Error ? err.message : t('app.notice.workspaceAuthorizeFailed'))
    }
  }

  async function authorizeWorkspace(path: string): Promise<LocalWorkspaceAuthorization> {
    if (!hasLocalHostAuthorization(localHostConfig)) {
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
    if (!hasLocalHostAuthorization(localHostConfig)) {
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
    const runtimeOwnsThread = runtimeThreadIDsRef.current.has(conversationID)
    if (runtimeOwnsThread && hasLocalHostAuthorization(localHostConfig)) {
      try {
        await updateLocalThread(
          conversationID,
          {
            title: conversation.title,
            archived: conversation.archived,
            metadata: {
              pinned: conversation.pinned ?? false,
              project: conversation.project,
              workspace: conversation.workspace,
            },
          },
          localHostConfig,
        )
      } catch (error) {
        setNotice(error instanceof Error ? error.message : t('app.notice.localRunFailed'))
        return undefined
      }
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
    const runtimeOwnsThread = runtimeThreadIDsRef.current.has(conversationID)
    if (runtimeOwnsThread && hasLocalHostAuthorization(localHostConfig)) {
      try {
        await deleteLocalThread(conversationID, localHostConfig)
        const nextRuntimeThreadIDs = new Set(runtimeThreadIDsRef.current)
        nextRuntimeThreadIDs.delete(conversationID)
        storeRuntimeThreadIDs(nextRuntimeThreadIDs)
        runtimeThreadIDsRef.current = nextRuntimeThreadIDs
      } catch (error) {
        setNotice(error instanceof Error ? error.message : t('app.notice.localRunFailed'))
        return
      }
    }
    pendingConversationRendersRef.current.delete(conversationID)
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

  async function exportLocalData() {
    const conversationExport = await localData.exportAll()
    const payload = {
      ...conversationExport,
      settings: {
        agentSettings,
        chatMode: mode,
        locale,
      },
    }
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `shejane-local-data-${new Date().toISOString().slice(0, 10)}.json`
    link.click()
    URL.revokeObjectURL(url)
    setNotice(t('app.notice.localDataExported'))
  }

  // The renderer is always hosted by Electron; Runtime is its only execution backend.
  const shellClassName = isDesktop ? 'app-window-shell electron-window-shell' : 'app-window-shell'
  const appShellStyle = { '--sidebar-width': `${sidebarWidth}px` } as CSSProperties
  const shortcutModifier = keyboardShortcutModifier()
  const shortcutRows = [
    { label: t('shortcuts.newChat'), keys: [`${shortcutModifier}N`] },
    { label: t('shortcuts.searchChats'), keys: [`${shortcutModifier}K`] },
    { label: t('shortcuts.stopRun'), keys: ['Esc'] },
    { label: t('shortcuts.help'), keys: ['?'] },
  ]

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
    if (sidebarMotionTimerRef.current) {
      window.clearTimeout(sidebarMotionTimerRef.current)
    }
    setSidebarMotion('closing')
    setSidebarCollapsed(true)
    sidebarMotionTimerRef.current = window.setTimeout(() => setSidebarMotion('idle'), sidebarMotionMs)
  }

  function expandSidebar() {
    if (sidebarMotionTimerRef.current) {
      window.clearTimeout(sidebarMotionTimerRef.current)
    }
    setSidebarMotion('opening')
    setSidebarCollapsed(false)
    sidebarMotionTimerRef.current = window.setTimeout(() => setSidebarMotion('idle'), sidebarMotionMs)
  }

  return (
    <TooltipProvider>
      <main className={shellClassName}>
        <div className="window-drag-layer" aria-hidden="true" />
        <div
          className="app-shell"
          style={appShellStyle}
          data-collapsed={sidebarCollapsed ? 'true' : undefined}
          data-sidebar-motion={sidebarMotion === 'idle' ? undefined : sidebarMotion}
        >
          <ConversationSidebar
            conversations={conversations}
            activeID={activeID}
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
            onOpenConnections={() => setMainView('connections')}
            onOpenSettings={() => setMainView('settings')}
            activeView={mainView}
            searchRequestVersion={sidebarSearchRequestVersion}
            resizeHandle={(
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
            )}
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
              onCreateSkill={async (input) => {
                if (!localHostConfig) return
                await createLocalSkill(input, localHostConfig)
              }}
              onLoadSkill={(name) => {
                if (!localHostConfig) return Promise.reject(new Error('local host unavailable'))
                return getLocalSkillFile(name, localHostConfig)
              }}
              onUpdateSkill={async (name, input) => {
                if (!localHostConfig) return
                await updateLocalSkill(name, input, localHostConfig)
              }}
              onDeleteSkill={async (name) => {
                if (!localHostConfig) return
                await deleteLocalSkill(name, localHostConfig)
              }}
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
              onCreateServer={async (input) => {
                if (!localHostConfig) return
                await createMcpServer(input, localHostConfig)
              }}
              onUpdateServer={async (name, input) => {
                if (!localHostConfig) return
                await updateMcpServer(name, input, localHostConfig)
              }}
              onDeleteServer={async (name) => {
                if (!localHostConfig) return
                await deleteMcpServer(name, localHostConfig)
              }}
              onOpenFolder={(path) => {
                const bridge = window.shejaneDesktop
                if (bridge?.openFileWithDefaultApp) {
                  void bridge.openFileWithDefaultApp(path)
                }
              }}
            />
          ) : mainView === 'connections' ? (
            <ConnectionsView />
          ) : mainView === 'settings' ? (
            <SettingsView
              isDesktop={isDesktop}
              agentSettings={agentSettings}
              localHostConfig={localHostConfig}
              onModelProvidersChange={() => setModelCatalogVersion((version) => version + 1)}
              onAgentSettingsChange={(next) => {
                setAgentSettings(next)
                writeAgentSettings(next)
              }}
              onImportLocalData={(file) => void importLocalData(file)}
              onExportLocalData={() => void exportLocalData()}
              onClearMemory={
                localHostConfig
                  ? async () => {
                      try {
                        const result = await clearLocalMemory(localHostConfig)
                        toast.success(t('app.notice.memoryCleared', { count: result.deleted_count }), {
                          id: appNoticeToastID,
                        })
                        return result.deleted_count
                      } catch (error) {
                        const message = error instanceof Error ? error.message : String(error)
                        toast.error(t('app.notice.memoryClearFailed', { message }), { id: appNoticeToastID })
                        throw error
                      }
                    }
                  : undefined
              }
            />
          ) : (
          <section className="workspace">
            <header className="topbar">
              {sidebarCollapsed ? (
                <div className="topbar-expand-hotspot">
                  <button
                    type="button"
                    className="topbar-expand-button"
                    title={t('app.expandSidebar')}
                    aria-label={t('app.expandSidebar')}
                    onClick={expandSidebar}
                  >
                    <IconLayoutSidebarLeftExpand size={16} aria-hidden="true" />
                  </button>
                </div>
              ) : null}
              <div className="chat-toolbar-title">
                <span>{activeConversation?.title ?? t('app.newChat')}</span>
              </div>
              {/* Daemon status dot is meaningless on web (no daemon ever). */}
              {isDesktop ? (
                <div className="topbar-status">
                  <span
                    className={`topbar-daemon-dot${localHost?.online ? ' is-online' : ' is-offline'}`}
                    title={localHostStatusLabel(localHost, localHostConfig, t)}
                    aria-label={localHostStatusLabel(localHost, localHostConfig, t)}
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
            ) : null}

            <ChatThread
              conversation={activeConversation}
              onOpenArtifact={(artifactID) => void openLocalArtifact(artifactID)}
              onOpenDiagnostics={(runID) => void openLocalRunDiagnostics(runID)}
              onPreviewLocalFile={openOfficeDocument}
              onPickSuggestion={setDraft}
              onRegenerateMessage={handleRegenerateMessage}
              onEditResendMessage={handleEditResendMessage}
              onDeleteMessage={setPendingDeleteMessageID}
              onFailureAction={handleAgentFailureAction}
            />

            <ArtifactPanel artifact={artifactPreview} onClose={() => setArtifactPreview(null)} />
            <DocPreviewPanel
              doc={activeDocument}
              refreshKey={docPreviewRefreshKey}
              onClose={() => setActiveDocument(null)}
            />
            <DiagnosticsPanel
              diagnostics={runDiagnostics}
              onClose={() => setRunDiagnostics(null)}
              onExport={exportCurrentRunDiagnostics}
              onForkCheckpoint={(runID, checkpointID) => void forkLocalRunFromCheckpoint(runID, checkpointID)}
              checkpointForking={checkpointForking}
            />

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

            <div className="composer-dock">
              <PendingApprovalBar
                approval={pendingApproval}
                onDecision={(messageID, requestID, decision, scope, editedAction) => void handlePermissionDecision(messageID, requestID, decision, scope, editedAction)}
                onReconcile={(messageID, requestID, decision) => void handleToolReconciliation(messageID, requestID, decision)}
              />

              <PendingPlanApprovalBar
                key={pendingPlanApproval?.requestID ?? 'no-plan-approval'}
                plan={pendingPlanApproval}
                onDecision={(messageID, requestID, decision, instructions) => void handlePlanApprovalDecision(messageID, requestID, decision, instructions)}
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
                onCancel={() => void cancelActiveRun()}
              />

              <Composer
              draft={draft}
              onDraftChange={setDraft}
              isSending={isSending}
              hasActiveRun={hasActiveRun}
              onSend={() => void sendMessage()}
              onAppendInstruction={hasActiveRun ? () => void appendInstructionToActiveRun() : undefined}
              onStop={() => void cancelActiveRun()}
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
              models={models}
              onModeChange={changeMode}
              projectName={activeConversation?.project?.name ?? pendingProject?.name}
              onSelectProject={() => void selectProjectForActiveConversation()}
              isDesktop={isDesktop}
              slashCommandsEnabled={isDesktop}
              />
              <p className="composer-disclaimer">{t('composer.disclaimer')}</p>
            </div>
          </section>
          )}
          </div>
          <Dialog open={keyboardHelpOpen} onOpenChange={setKeyboardHelpOpen}>
            <DialogContent className="keyboard-shortcuts-dialog sm:max-w-[420px]">
              <DialogHeader>
                <DialogTitle>{t('shortcuts.title')}</DialogTitle>
                <DialogDescription>{t('shortcuts.description')}</DialogDescription>
              </DialogHeader>
              <div className="keyboard-shortcuts-list">
                {shortcutRows.map((row) => (
                  <div className="keyboard-shortcut-row" key={row.label}>
                    <span>{row.label}</span>
                    <span className="keyboard-shortcut-keys">
                      {row.keys.map((key) => (
                        <kbd key={key}>{key}</kbd>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </main>
    </TooltipProvider>
  )
}

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false
  }
  const tagName = target.tagName.toLowerCase()
  return (
    target.isContentEditable ||
    tagName === 'input' ||
    tagName === 'textarea' ||
    tagName === 'select'
  )
}

function keyboardShortcutModifier(): string {
  if (typeof navigator === 'undefined') {
    return 'Ctrl+'
  }
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? '⌘' : 'Ctrl+'
}

function localHostStatusLabel(
  localHost: LocalHostProbe | null,
  config: LocalHostConfig | null,
  t: Translator,
): string {
  if (!localHost?.online) {
    return t('app.localStatus.runtimeOffline')
  }
  if (!hasLocalHostAuthorization(config)) {
    return t('app.localStatus.unpaired')
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
  // Optional concrete model label for the completed turn.
  if (event.event_type === 'model.selected') {
    const payload = event.payload ?? {}
    message.runMode = {
      resolved: String(payload.label ?? payload.resolved_model_id ?? ''),
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
    // initial delivery too, so the persisted snapshot and later cursor resume
    // both start from the real post-question answer.
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

function recordLocalEventCursor(message: ChatMessage, event: AgentRunEvent) {
  if (Number.isSafeInteger(event.seq) && Number(event.seq) >= 0) {
    message.lastEventSeq = Math.max(message.lastEventSeq ?? 0, Number(event.seq))
  }
}

async function streamLocalMessage(
  runID: string,
  config: LocalHostConfig,
  conversation: Conversation,
  message: ChatMessage,
  t: Translator,
  onOfficeFileOpened: (ref: LocalOfficeFileRef) => void,
  onUpdate: () => void,
) {
  let seenEventIDs = new Set(
    (message.agentEvents ?? []).map((event) => event.eventId).filter(Boolean) as string[],
  )
  const toolArgsByCallId: ToolArgsByCallId = new Map()
  const subscribe = () => streamLocalRun(runID, config, {
    afterSeq: message.lastEventSeq,
    onEvent: (event) => {
      recordLocalEventCursor(message, event)
      appendLocalRunEvent(message, event, seenEventIDs, toolArgsByCallId, t, onOfficeFileOpened)
      onUpdate()
    },
    onDelta: (delta, event) => {
      recordLocalEventCursor(message, event)
      appendLocalDelta(message, delta, event, seenEventIDs)
      onUpdate()
    },
  })

  try {
    return await subscribe()
  } catch (error) {
    if (!(error instanceof LocalStreamCursorResetRequiredError)) throw error
    const rebuilt = projectRuntimeThread(
      await getLocalThreadSnapshot(conversation.id, config),
      undefined,
      t,
    )
    const projectedMessage = rebuilt.messages.find((item) => item.runId === runID)
    if (!projectedMessage) throw error
    for (const key of Object.keys(message)) Reflect.deleteProperty(message, key)
    Object.assign(message, projectedMessage)
    message.lastEventSeq = Math.max(message.lastEventSeq ?? 0, error.resumeAfter)
    rebuilt.messages = rebuilt.messages.map((item) => item.id === projectedMessage.id ? message : item)
    for (const key of Object.keys(conversation)) Reflect.deleteProperty(conversation, key)
    Object.assign(conversation, rebuilt)
    seenEventIDs = new Set(
      (message.agentEvents ?? []).map((event) => event.eventId).filter(Boolean) as string[],
    )
    toolArgsByCallId.clear()
    onUpdate()
    return subscribe()
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
 *  prefers the run.failed event label, falling back to the bubble content
 *  (set to the error message on a network/HTTP drop). */
function notifyAgentFailed(message: ChatMessage, t: Translator): void {
  const bridge = window.shejaneDesktop
  if (!bridge?.notify) {
    return
  }
  const raw = (latestRunFailedLabel(message) || message.content || '').trim().replace(/\s+/g, ' ')
  const body = raw.length > 140 ? `${raw.slice(0, 140)}…` : raw
  void bridge.notify({
    title: t('notify.agentFailed.title'),
    body: body || t('notify.agentFailed.empty'),
  })
}

function notifyScheduledRun(schedule: LocalScheduledRun, t: Translator): void {
  const bridge = window.shejaneDesktop
  if (!bridge?.notify) {
    return
  }
  const fallback = schedule.goal || t('notify.scheduledRun.empty')
  const raw = (schedule.status === 'failed' ? schedule.error_message : schedule.result_text)
    || fallback
  const normalized = raw.trim().replace(/\s+/g, ' ')
  const body = normalized.length > 140 ? `${normalized.slice(0, 140)}…` : normalized
  void bridge.notify({
    title: schedule.status === 'failed'
      ? t('notify.scheduledRunFailed.title')
      : t('notify.scheduledRunCompleted.title'),
    body: body || t('notify.scheduledRun.empty'),
  })
}

function latestRunFailedLabel(message: ChatMessage): string {
  return [...(message.agentEvents ?? [])].reverse().find(
    (event) => event.type === 'run.failed' || event.type === 'run.cleanup_required',
  )?.label ?? ''
}

function finalizeLocalRunStatus(message: ChatMessage) {
  const events = message.agentEvents ?? []
  if (events.some((event) => event.type === 'run.failed' || event.type === 'run.cleanup_required')) {
    message.status = 'error'
    if (!message.content.trim()) {
      message.content = latestRunFailedLabel(message)
    }
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
  if (hasPendingPlanApproval(events)) {
    message.status = 'waiting_input'
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
    if (event.type === 'tool.reconciliation_required' && event.permissionRequestId) {
      pending.add(event.permissionRequestId)
    }
    if (event.type === 'tool.reconciliation_resolved' && event.permissionRequestId) {
      pending.delete(event.permissionRequestId)
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

function hasPendingPlanApproval(events: AgentTimelineItem[]): boolean {
  const pending = new Set<string>()
  for (const event of events) {
    if (event.type === 'plan.approval_required' && event.planApprovalRequestId) {
      pending.add(event.planApprovalRequestId)
    }
    if (event.type === 'plan.approval_resolved' && event.planApprovalRequestId) {
      pending.delete(event.planApprovalRequestId)
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

function appendUnique(items: string[], item: string): string[] {
  return items.includes(item) ? items : [...items, item]
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

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  map: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let next = 0
  async function worker() {
    while (next < values.length) {
      const index = next
      next += 1
      results[index] = await map(values[index])
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, () => worker()),
  )
  return results
}

function loadRuntimeThreadIDs(): Set<string> {
  try {
    const value = JSON.parse(localStorage.getItem(runtimeThreadIDsStorageKey) ?? '[]')
    return new Set(
      Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [],
    )
  } catch {
    return new Set()
  }
}

function storeRuntimeThreadIDs(ids: Set<string>) {
  localStorage.setItem(runtimeThreadIDsStorageKey, JSON.stringify([...ids]))
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
