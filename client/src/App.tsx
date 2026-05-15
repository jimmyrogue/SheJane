import { IconLayoutSidebarLeftExpand } from '@tabler/icons-react'
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { toast } from 'sonner'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  JiandanAPI,
  type AuthPayload,
  type UserDocument,
  type WalletBalance,
} from './shared/api/client'
import { createAuthClient } from './shared/api/authClient'
import { createChatStore, timelineItem } from './features/chat/chatStore'
import { AuthScreen } from './features/auth/AuthScreen'
import { ArtifactPanel } from './features/chat/components/ArtifactPanel'
import { ChatThread } from './features/chat/components/ChatThread'
import { Composer } from './features/chat/components/Composer'
import { ConversationSidebar } from './features/chat/components/ConversationSidebar'
import { DiagnosticsPanel } from './features/chat/components/DiagnosticsPanel'
import type { AgentRunEvent } from './shared/api/sse'
import { I18nProvider, useI18n, type Translator } from './shared/i18n/i18n'
import { createLocalID, LocalConversationStore } from './shared/local-data/localConversations'
import type { AgentTimelineItem, ChatMessage, ChatMode, Conversation, ConversationWorkspace } from './shared/local-data/types'
import {
  authorizeLocalWorkspace,
  createLocalRun,
  diagnoseLocalWorkspace,
  getLocalRunDiagnostics,
  getDesktopLocalHostConfig,
  getLocalArtifact,
  listAuthorizedWorkspaces,
  listLocalRuns,
  probeLocalHost,
  resolveLocalPermission,
  setLocalCloudSession,
  streamLocalRun,
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
const appNoticeToastID = 'jiandanly-app-notice'
const sidebarWidthStorageKey = 'jiandanly.sidebar.width.v1'
const sidebarCollapsedStorageKey = 'jiandanly.sidebar.collapsed.v1'
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
  const api = useMemo(() => new JiandanAPI(), [])
  const authClient = useMemo(() => createAuthClient(api), [api])
  const localData = useMemo(() => new LocalConversationStore(), [])
  const chat = useMemo(() => createChatStore({ localData, api, t }), [api, localData, t])
  const pendingConversationRendersRef = useRef<Map<string, PendingConversationRender>>(new Map())
  const liveRenderTimerRef = useRef<number>()
  const activeIDRef = useRef<string | undefined>()
  const navigationVersionRef = useRef(0)
  const sidebarResizeStateRef = useRef<{ startX: number, startWidth: number } | null>(null)

  const [auth, setAuth] = useState<AuthPayload | null>(null)
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeID, setActiveID] = useState<string>()
  const [draft, setDraft] = useState('')
  const [mode, setMode] = useState<ChatMode>('fast')
  const [documents, setDocuments] = useState<UserDocument[]>([])
  const [attachedDocumentID, setAttachedDocumentID] = useState<string>()
  const [balance, setBalance] = useState<WalletBalance | null>(null)
  const [isSending, setIsSending] = useState(false)
  const [isUploading, setIsUploading] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsed)
  const [isResizingSidebar, setIsResizingSidebar] = useState(false)
  const [localHost, setLocalHost] = useState<LocalHostProbe | null>(null)
  const [localHostConfig, setLocalHostConfig] = useState<LocalHostConfig | null>(null)
  const [localCloudSession, setLocalCloudSessionState] = useState<LocalCloudSession | null>(null)
  const [pendingWorkspace, setPendingWorkspace] = useState<ConversationWorkspace | undefined>()
  const [authorizedWorkspaces, setAuthorizedWorkspaces] = useState<LocalWorkspaceAuthorization[]>([])
  const [localRuns, setLocalRuns] = useState<LocalHarnessRun[]>([])
  const [artifactPreview, setArtifactPreview] = useState<LocalArtifact | null>(null)
  const [runDiagnostics, setRunDiagnostics] = useState<LocalRunDiagnostics | null>(null)

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

  useEffect(() => {
    writeSidebarWidth(sidebarWidth)
  }, [sidebarWidth])

  useEffect(() => {
    writeSidebarCollapsed(sidebarCollapsed)
  }, [sidebarCollapsed])

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
    setDraft('')
  }

  function selectConversation(id: string) {
    navigationVersionRef.current += 1
    setPendingWorkspace(undefined)
    setActiveConversationID(id)
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
    setIsSending(true)
    setNotice('')
    setDraft('')
    const renderContext = createConversationRenderContext()
    try {
      const canUseLocalHarness = !attachedDocument && Boolean(localHost?.online && localHostConfig?.token && localCloudSession?.connected)
      const conversation = canUseLocalHarness
        ? await sendLocalHarnessMessage(content, renderContext)
        : await chat.sendMessage({
            conversationId: activeID,
            content,
            mode,
            scene: 'chat',
            document: attachedDocument
              ? {
                  id: attachedDocument.id,
                  name: attachedDocument.original_name,
                }
              : undefined,
            onConversationUpdate: (nextConversation) => scheduleConversationRender(nextConversation, renderContext),
          })
      await refreshConversationsAfterStream(conversation.id, renderContext)
      setBalance(await api.balance())
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

  async function sendLocalHarnessMessage(content: string, context: ConversationRenderContext): Promise<Conversation> {
    if (!localHostConfig) {
      throw new Error(t('app.notice.localHostDisconnected'))
    }
    const text = content.trim()
    if (!text) {
      throw new Error(t('app.notice.emptyMessage'))
    }

    const timestamp = new Date().toISOString()
    const conversation = (activeID ? await localData.get(activeID) : undefined) ?? createConversation(text, timestamp, t('chat.newConversation'))
    if (!conversation.workspace && pendingWorkspace) {
      conversation.workspace = { ...pendingWorkspace }
    }
    const userMessage: ChatMessage = {
      id: createLocalID('msg'),
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
      status: 'streaming',
      runOrigin: 'local',
      agentEvents: [],
    }

    conversation.messages = [...conversation.messages, userMessage, assistantMessage]
    conversation.updatedAt = timestamp
    await localData.save(conversation)
    scheduleConversationRender(conversation, context)

    try {
      const run = await createLocalRun(
        {
          goal: text,
          workspacePath: conversation.workspace?.path.trim() || undefined,
        },
        localHostConfig,
      )
      assistantMessage.runId = run.id
      setLocalRuns((items) => upsertLocalRun(items, run))
      scheduleConversationRender(conversation, context)
      const seenEventIDs = new Set<string>()
      await streamLocalRun(run.id, localHostConfig, {
        onEvent: (event) => {
          appendLocalRunEvent(assistantMessage, event, seenEventIDs, t)
          scheduleConversationRender(conversation, context)
        },
        onDelta: (delta, event) => {
          appendLocalDelta(assistantMessage, delta, event, seenEventIDs)
          scheduleConversationRender(conversation, context)
        },
      })
      finalizeLocalRunStatus(assistantMessage)
      scheduleConversationRender(conversation, context)
    } catch (error) {
      assistantMessage.status = 'error'
      assistantMessage.content = error instanceof Error ? error.message : t('app.notice.localRunFailed')
      scheduleConversationRender(conversation, context)
      throw error
    } finally {
      conversation.updatedAt = new Date().toISOString()
      await localData.save(conversation)
    }

    return conversation
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
    const renderContext = createConversationRenderContext()
    const seenEventIDs = new Set((message.agentEvents ?? []).map((event) => event.eventId).filter(Boolean) as string[])
    try {
      await resolveLocalPermission(requestID, decision, localHostConfig, { scope })
      await streamLocalRun(message.runId, localHostConfig, {
        onEvent: (event) => {
          appendLocalRunEvent(message, event, seenEventIDs, t)
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
      await streamLocalRun(run.id, localHostConfig, {
        onEvent: (event) => {
          appendLocalRunEvent(assistantMessage, event, seenEventIDs, t)
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
    const selectedPath = await window.jiandanDesktop?.selectWorkspaceDirectory?.()
    if (!selectedPath) {
      return undefined
    }
    return selectedPath
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

  async function addConversationToProject(conversationID: string, projectName: string) {
    const nextProjectName = projectName.trim()
    if (!nextProjectName) {
      return
    }
    const conversation = await updateConversationMetadata(conversationID, (item) => {
      item.project = { name: nextProjectName }
    })
    if (conversation) {
      setNotice(t('app.notice.conversationAddedToProject', { title: conversation.title, project: nextProjectName }))
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
    link.download = `jiandan-conversation-${safeFilename(conversation.title)}-${new Date().toISOString().slice(0, 10)}.json`
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
    try {
      const upload = await api.createDocumentUpload({
        filename: file.name,
        content_type: contentType,
        size_bytes: file.size,
      })
      setDocuments((items) => upsertDocument(items, upload.document))
      setAttachedDocumentID(upload.document.id)
      const uploadResponse = await fetch(upload.upload.url, {
        method: upload.upload.method,
        headers: upload.upload.headers,
        body: file,
      })
      if (!uploadResponse.ok) {
        throw new Error(t('app.notice.s3UploadFailed', { status: uploadResponse.status }))
      }
      const completed = await api.completeDocument(upload.document.id)
      setDocuments((items) => upsertDocument(items, completed))
      setAttachedDocumentID(completed.id)
      setNotice(t('app.notice.documentReady'))
    } catch (error) {
      setNotice(error instanceof Error ? error.message : t('app.notice.documentUploadFailed'))
    } finally {
      setIsUploading(false)
    }
  }

  async function deleteDocument(document: UserDocument) {
    const deleted = await api.deleteDocument(document.id)
    setDocuments((items) => items.filter((item) => item.id !== deleted.id))
    setAttachedDocumentID((current) => (current === deleted.id ? undefined : current))
    setNotice(t('app.notice.documentDeleted'))
  }

  if (!auth) {
    return <AuthScreen onAuthed={handleAuth} authClient={authClient} />
  }

  const shellClassName = window.jiandanDesktop ? 'app-window-shell electron-window-shell' : 'app-window-shell'
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
            onAddConversationToProject={(conversationID, projectName) => void addConversationToProject(conversationID, projectName)}
            onDeleteConversation={(conversationID) => void deleteConversationData(conversationID)}
            onCollapseSidebar={collapseSidebar}
            onLogout={() => {
              void authClient.logout().finally(() => setAuth(null))
            }}
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
            </header>

            <ChatThread
              conversation={activeConversation}
              onOpenArtifact={(artifactID) => void openLocalArtifact(artifactID)}
              onOpenDiagnostics={(runID) => void openLocalRunDiagnostics(runID)}
              onPermissionDecision={(messageID, requestID, decision, scope) => void handlePermissionDecision(messageID, requestID, decision, scope)}
            />

            <ArtifactPanel artifact={artifactPreview} onClose={() => setArtifactPreview(null)} />
            <DiagnosticsPanel diagnostics={runDiagnostics} onClose={() => setRunDiagnostics(null)} onExport={exportCurrentRunDiagnostics} />

            <Composer
              mode={mode}
              onModeChange={setMode}
              draft={draft}
              onDraftChange={setDraft}
              isSending={isSending}
              documents={documents}
              attachedDocumentID={attachedDocumentID}
              attachedDocument={attachedDocument}
              isUploading={isUploading}
              localStatusLabel={localHostStatusLabel(localHost, localHostConfig, localCloudSession, t)}
              canUseLocalWorkspace={Boolean(localHost?.online && localHostConfig?.token && localCloudSession?.connected)}
              canPickWorkspace={Boolean(window.jiandanDesktop?.selectWorkspaceDirectory)}
              localProject={
                !attachedDocument && localHost?.online && localHostConfig?.token && localCloudSession?.connected
                  ? localProject
                  : undefined
              }
              onUploadDocument={(file) => void uploadDocument(file)}
              onAttachDocument={setAttachedDocumentID}
              onDeleteDocument={(document) => void deleteDocument(document)}
              onDetachDocument={() => setAttachedDocumentID(undefined)}
              onPickWorkspace={() => chooseWorkspaceDirectory()}
              onDiagnoseWorkspace={(path) => diagnoseWorkspace(path)}
              onAuthorizeWorkspace={(path) => authorizeWorkspace(path)}
              onClearLocalProject={() => void saveActiveConversationWorkspace(undefined)}
              onSend={() => void sendMessage()}
            />
          </section>
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

function appendLocalRunEvent(message: ChatMessage, event: AgentRunEvent, seenEventIDs: Set<string>, t: Translator) {
  if (event.event_type === 'llm.delta') {
    return
  }
  if (event.id && seenEventIDs.has(event.id)) {
    return
  }
  if (event.id) {
    seenEventIDs.add(event.id)
  }
  const item = timelineItem(event, t)
  if (item) {
    message.agentEvents = [...(message.agentEvents ?? []), item]
  }
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
  message.status = hasPendingPermission(events) ? 'waiting_permission' : 'done'
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

function downloadLocalRunDiagnostics(diagnostics: LocalRunDiagnostics) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(diagnostics, null, 2)], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `jiandanly-local-run-${diagnostics.run.id}-diagnostics.json`
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
  return ''
}
