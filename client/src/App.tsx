import { ChevronDown, LogOut, MoreHorizontal, PanelLeft, Search, Share2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  JiandanAPI,
  type AuthPayload,
  type UserDocument,
  type WalletBalance,
} from './shared/api/client'
import { createChatStore, timelineItem } from './features/chat/chatStore'
import { AuthScreen } from './features/auth/AuthScreen'
import { ArtifactPanel } from './features/chat/components/ArtifactPanel'
import { ChatThread } from './features/chat/components/ChatThread'
import { Composer } from './features/chat/components/Composer'
import { ConversationSidebar } from './features/chat/components/ConversationSidebar'
import { DiagnosticsPanel } from './features/chat/components/DiagnosticsPanel'
import type { AgentRunEvent } from './shared/api/sse'
import { createLocalID, LocalConversationStore } from './shared/local-data/localConversations'
import type { AgentTimelineItem, ChatMessage, ChatMode, Conversation, ConversationWorkspace } from './shared/local-data/types'
import {
  authorizeLocalWorkspace,
  clearLocalCloudSession,
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

export function App() {
  const api = useMemo(() => new JiandanAPI(), [])
  const localData = useMemo(() => new LocalConversationStore(), [])
  const chat = useMemo(() => createChatStore({ localData, api }), [api, localData])
  const liveConversationRef = useRef<{ conversation: Conversation; navigationVersion: number } | null>(null)
  const liveRenderTimerRef = useRef<number>()
  const activeIDRef = useRef<string | undefined>()
  const navigationVersionRef = useRef(0)

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
  const [notice, setNotice] = useState('')
  const [localHost, setLocalHost] = useState<LocalHostProbe | null>(null)
  const [localHostConfig, setLocalHostConfig] = useState<LocalHostConfig | null>(null)
  const [localCloudSession, setLocalCloudSessionState] = useState<LocalCloudSession | null>(null)
  const [pendingWorkspace, setPendingWorkspace] = useState<ConversationWorkspace | undefined>()
  const [authorizedWorkspaces, setAuthorizedWorkspaces] = useState<LocalWorkspaceAuthorization[]>([])
  const [localRuns, setLocalRuns] = useState<LocalHarnessRun[]>([])
  const [artifactPreview, setArtifactPreview] = useState<LocalArtifact | null>(null)
  const [runDiagnostics, setRunDiagnostics] = useState<LocalRunDiagnostics | null>(null)

  useEffect(() => {
    return () => {
      if (liveRenderTimerRef.current !== undefined) {
        window.clearTimeout(liveRenderTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    activeIDRef.current = activeID
  }, [activeID])

  useEffect(() => {
    void localData.list().then((items) => {
      setConversations(items)
      setActiveID(items[0]?.id)
    })
  }, [localData])

  useEffect(() => {
    api
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
  }, [api])

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
    setActiveID(nextActiveID ?? (options.preserveEmptyActive ? undefined : items[0]?.id))
  }

  function startNewConversation() {
    navigationVersionRef.current += 1
    setActiveID(undefined)
    setPendingWorkspace(undefined)
    setDraft('')
  }

  function selectConversation(id: string) {
    navigationVersionRef.current += 1
    setPendingWorkspace(undefined)
    setActiveID(id)
  }

  function scheduleConversationRender(conversation: Conversation) {
    liveConversationRef.current = {
      conversation: cloneConversation(conversation),
      navigationVersion: navigationVersionRef.current,
    }
    if (liveRenderTimerRef.current !== undefined) {
      return
    }
    liveRenderTimerRef.current = window.setTimeout(() => {
      liveRenderTimerRef.current = undefined
      const next = liveConversationRef.current
      liveConversationRef.current = null
      if (!next) {
        return
      }
      if (navigationVersionRef.current === next.navigationVersion || activeIDRef.current === next.conversation.id) {
        setActiveID(next.conversation.id)
      }
      setConversations((items) => upsertConversation(items, next.conversation))
    }, 33)
  }

  async function sendMessage() {
    if (!auth) {
      setNotice('请先登录后再发送消息')
      return
    }
    if (attachedDocument && attachedDocument.status !== 'ready') {
      setNotice('文档尚未解析完成')
      return
    }
    setIsSending(true)
    setNotice('')
    const navigationVersionAtSend = navigationVersionRef.current
    try {
      const canUseLocalHarness = !attachedDocument && Boolean(localHost?.online && localHostConfig?.token && localCloudSession?.connected)
      const conversation = canUseLocalHarness
        ? await sendLocalHarnessMessage(draft)
        : await chat.sendMessage({
            conversationId: activeID,
            content: draft,
            mode,
            scene: 'chat',
            document: attachedDocument
              ? {
                  id: attachedDocument.id,
                  name: attachedDocument.original_name,
                }
              : undefined,
            onConversationUpdate: scheduleConversationRender,
          })
      setDraft('')
      const userNavigatedWhileSending = navigationVersionRef.current !== navigationVersionAtSend
      await refreshConversations(userNavigatedWhileSending ? activeIDRef.current : conversation.id, {
        preserveEmptyActive: userNavigatedWhileSending && !activeIDRef.current,
      })
      setBalance(await api.balance())
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '发送失败')
      await refreshConversations(activeID)
    } finally {
      setIsSending(false)
    }
  }

  async function sendLocalHarnessMessage(content: string): Promise<Conversation> {
    if (!localHostConfig) {
      throw new Error('本地 Harness 未连接')
    }
    const text = content.trim()
    if (!text) {
      throw new Error('消息不能为空')
    }

    const timestamp = new Date().toISOString()
    const conversation = (activeID ? await localData.get(activeID) : undefined) ?? createConversation(text, timestamp)
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
    scheduleConversationRender(conversation)

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
      scheduleConversationRender(conversation)
      const seenEventIDs = new Set<string>()
      await streamLocalRun(run.id, localHostConfig, {
        onEvent: (event) => {
          appendLocalRunEvent(assistantMessage, event, seenEventIDs)
          scheduleConversationRender(conversation)
        },
        onDelta: (delta, event) => {
          appendLocalDelta(assistantMessage, delta, event, seenEventIDs)
          scheduleConversationRender(conversation)
        },
      })
      finalizeLocalRunStatus(assistantMessage)
      scheduleConversationRender(conversation)
    } catch (error) {
      assistantMessage.status = 'error'
      assistantMessage.content = error instanceof Error ? error.message : '本地 Harness 执行失败'
      scheduleConversationRender(conversation)
      throw error
    } finally {
      conversation.updatedAt = new Date().toISOString()
      await localData.save(conversation)
    }

    return conversation
  }

  async function handlePermissionDecision(messageID: string, requestID: string, decision: 'approve' | 'deny', scope: LocalPermissionScope = 'once') {
    if (!activeID || !localHostConfig) {
      setNotice('本地 Harness 未连接')
      return
    }
    const conversation = await localData.get(activeID)
    const message = conversation?.messages.find((item) => item.id === messageID)
    if (!conversation || !message?.runId) {
      setNotice('找不到需要继续的本地任务')
      return
    }

    setNotice('')
    message.status = 'streaming'
    const seenEventIDs = new Set((message.agentEvents ?? []).map((event) => event.eventId).filter(Boolean) as string[])
    try {
      await resolveLocalPermission(requestID, decision, localHostConfig, { scope })
      await streamLocalRun(message.runId, localHostConfig, {
        onEvent: (event) => {
          appendLocalRunEvent(message, event, seenEventIDs)
          scheduleConversationRender(conversation)
        },
        onDelta: (delta, event) => {
          appendLocalDelta(message, delta, event, seenEventIDs)
          scheduleConversationRender(conversation)
        },
      })
      finalizeLocalRunStatus(message)
      scheduleConversationRender(conversation)
    } catch (error) {
      message.status = 'error'
      message.content = error instanceof Error ? error.message : '本地权限处理失败'
      setNotice(message.content)
      scheduleConversationRender(conversation)
    } finally {
      conversation.updatedAt = new Date().toISOString()
      await localData.save(conversation)
      await refreshConversations(conversation.id)
    }
  }

  async function openLocalArtifact(artifactID: string) {
    if (!localHostConfig) {
      setNotice('本地 Harness 未连接')
      return
    }
    setNotice('')
    try {
      setArtifactPreview(await getLocalArtifact(artifactID, localHostConfig))
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Artifact 读取失败')
    }
  }

  async function recoverLocalRun(run: LocalHarnessRun) {
    if (!localHostConfig) {
      setNotice('本地 Harness 未连接')
      return
    }
    const timestamp = new Date().toISOString()
    const conversation = createConversation(run.goal, timestamp)
    const userMessage: ChatMessage = {
      id: createLocalID('msg'),
      role: 'user',
      content: `恢复本地任务：${run.goal}`,
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
    scheduleConversationRender(conversation)
    setNotice('')
    try {
      const seenEventIDs = new Set<string>()
      await streamLocalRun(run.id, localHostConfig, {
        onEvent: (event) => {
          appendLocalRunEvent(assistantMessage, event, seenEventIDs)
          scheduleConversationRender(conversation)
        },
        onDelta: (delta, event) => {
          appendLocalDelta(assistantMessage, delta, event, seenEventIDs)
          scheduleConversationRender(conversation)
        },
      })
      finalizeLocalRunStatus(assistantMessage)
      scheduleConversationRender(conversation)
      const freshRuns = await listLocalRuns(localHostConfig)
      setLocalRuns(freshRuns)
    } catch (error) {
      assistantMessage.status = 'error'
      assistantMessage.content = error instanceof Error ? error.message : '本地任务恢复失败'
      setNotice(assistantMessage.content)
      scheduleConversationRender(conversation)
    } finally {
      conversation.updatedAt = new Date().toISOString()
      await localData.save(conversation)
      await refreshConversations(conversation.id)
    }
  }

  async function exportLocalRunDiagnostics(run: LocalHarnessRun) {
    if (!localHostConfig) {
      setNotice('本地 Harness 未连接')
      return
    }
    try {
      const diagnostics = await getLocalRunDiagnostics(run.id, localHostConfig)
      downloadLocalRunDiagnostics(diagnostics)
      setNotice(`诊断已导出：${diagnostics.run.id}`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '本地任务诊断导出失败')
    }
  }

  async function openLocalRunDiagnostics(runID: string) {
    if (!localHostConfig) {
      setNotice('本地 Harness 未连接')
      return
    }
    try {
      setRunDiagnostics(await getLocalRunDiagnostics(runID, localHostConfig))
      setNotice('')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '本地任务诊断读取失败')
    }
  }

  function exportCurrentRunDiagnostics() {
    if (!runDiagnostics) {
      return
    }
    downloadLocalRunDiagnostics(runDiagnostics)
    setNotice(`诊断已导出：${runDiagnostics.run.id}`)
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
      throw new Error('本地 Harness 未配对，无法授权工作区')
    }
    const nextPath = path.trim()
    if (!nextPath) {
      throw new Error('请先填写本地工作区路径')
    }
    const workspace = await authorizeLocalWorkspace(nextPath, localHostConfig)
    setAuthorizedWorkspaces((items) => upsertWorkspace(items, workspace))
    await saveActiveConversationWorkspace({
      path: workspace.path,
      label: workspace.label,
      authorized: true,
      authorizationId: workspace.id,
    })
    setNotice(`当前对话已绑定工作区：${workspace.label}`)
    return workspace
  }

  async function diagnoseWorkspace(path: string): Promise<LocalWorkspaceDiagnosis> {
    if (!localHostConfig?.token) {
      throw new Error('本地 Harness 未配对，无法诊断工作区')
    }
    const nextPath = path.trim()
    if (!nextPath) {
      throw new Error('请先填写本地工作区路径')
    }
    return diagnoseLocalWorkspace(nextPath, localHostConfig)
  }

  async function saveActiveConversationWorkspace(workspace: ConversationWorkspace | undefined) {
    if (!activeID) {
      setPendingWorkspace(workspace)
      return
    }
    const timestamp = new Date().toISOString()
    const conversation = (await localData.get(activeID)) ?? createConversation('新对话', timestamp)
    if (workspace) {
      conversation.workspace = workspace
    } else {
      delete conversation.workspace
    }
    conversation.updatedAt = timestamp
    await localData.save(conversation)
    setActiveID(conversation.id)
    setConversations((items) => upsertConversation(items, cloneConversation(conversation)))
  }

  async function exportConversationData(conversationID: string) {
    const conversation = await localData.get(conversationID)
    if (!conversation) {
      setNotice('找不到要导出的对话')
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
    setNotice(`已导出对话：${conversation.title}`)
  }

  async function importLocalData(file: File | undefined) {
    if (!file) {
      return
    }
    await localData.importAll(await file.text())
    await refreshConversations()
    setNotice('本地聊天数据已导入')
  }

  async function startCheckout() {
    if (!auth) {
      setNotice('请先登录后再升级')
      return
    }
    const checkout = await api.createSubscriptionCheckout()
    window.location.href = checkout.checkout_url
  }

  async function logout() {
    await Promise.allSettled([
      api.logout(),
      localHostConfig?.token ? clearLocalCloudSession(localHostConfig) : Promise.resolve(),
    ])
    setLocalCloudSessionState(null)
    setAuth(null)
    setBalance(null)
    setDocuments([])
    setAttachedDocumentID(undefined)
  }

  async function uploadDocument(file: File | undefined) {
    if (!file) {
      return
    }
    if (!auth) {
      setNotice('请先登录后再上传文档')
      return
    }
    const contentType = normalizeDocumentContentType(file)
    if (!contentType) {
      setNotice('仅支持 PDF、DOCX、XLSX 文件')
      return
    }
    if (file.size <= 0 || file.size > documentMaxBytes) {
      setNotice('文件大小不能超过 30MB')
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
        throw new Error(`S3 上传失败：HTTP ${uploadResponse.status}`)
      }
      const completed = await api.completeDocument(upload.document.id)
      setDocuments((items) => upsertDocument(items, completed))
      setAttachedDocumentID(completed.id)
      setNotice('文档已解析完成，已附加到当前对话')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '文档上传失败')
    } finally {
      setIsUploading(false)
    }
  }

  async function deleteDocument(document: UserDocument) {
    const deleted = await api.deleteDocument(document.id)
    setDocuments((items) => items.filter((item) => item.id !== deleted.id))
    setAttachedDocumentID((current) => (current === deleted.id ? undefined : current))
    setNotice('文档已删除')
  }

  if (!auth) {
    return <AuthScreen onAuthed={handleAuth} api={api} />
  }

  const shellClassName = window.jiandanDesktop ? 'app-window-shell electron-window-shell' : 'app-window-shell'

  return (
    <TooltipProvider>
      <main className={shellClassName}>
        <div className="window-titlebar">
          <div className="traffic-lights" aria-hidden="true">
            <span className="tl-red" />
            <span className="tl-amber" />
            <span className="tl-green" />
          </div>
          <div className="titlebar-title">{activeConversation?.title ?? 'Jiandanly · AI Agent'}</div>
          <div className="titlebar-actions" aria-label="窗口操作">
            <PanelLeft size={14} />
            <Search size={14} />
          </div>
        </div>

        <div className="app-shell">
          <ConversationSidebar
            conversations={conversations}
            activeID={activeID}
            balance={balance}
            userEmail={auth.user.email}
            onNewConversation={startNewConversation}
            onSelectConversation={selectConversation}
            onExportConversation={(conversationID) => void exportConversationData(conversationID)}
            onImportLocalData={(file) => void importLocalData(file)}
          />

          <section className="workspace">
            <header className="topbar">
              <div className="chat-toolbar-title">
                <span>{activeConversation?.title ?? '新对话'}</span>
                <ChevronDown size={14} aria-hidden="true" />
                <small>{activeConversation ? formatRelativeTime(activeConversation.updatedAt) : '本地优先对话'}</small>
              </div>
              <div className="account">
                {localHost ? (
                  <span className={localHost.online && localHostConfig?.token ? 'host-chip online' : 'host-chip offline'}>
                    <span className={localHost.online && localHostConfig?.token ? 'status-dot success' : 'status-dot warning'} />
                    {localHostStatusLabel(localHost, localHostConfig, localCloudSession)}
                  </span>
                ) : null}
                <span className="model-pill">
                  <span className="status-dot success" />
                  {mode === 'deep' ? 'Deep agent' : 'Fast agent'}
                </span>
                <button className="toolbar-icon-button" title="分享" aria-label="分享">
                  <Share2 size={15} />
                </button>
                <button className="toolbar-icon-button" title="更多" aria-label="更多">
                  <MoreHorizontal size={15} />
                </button>
                <span className="account-email">{auth.user.email}</span>
                <button className="btn-ghost atlas-upgrade" onClick={startCheckout}>升级</button>
                <button className="toolbar-icon-button" title="退出登录" onClick={logout}>
                  <LogOut size={15} />
                </button>
              </div>
            </header>

            <ChatThread
              conversation={activeConversation}
              onOpenArtifact={(artifactID) => void openLocalArtifact(artifactID)}
              onOpenDiagnostics={(runID) => void openLocalRunDiagnostics(runID)}
              onPermissionDecision={(messageID, requestID, decision, scope) => void handlePermissionDecision(messageID, requestID, decision, scope)}
            />

            {notice ? <div className="notice">{notice}</div> : null}

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
              localStatusLabel={localHostStatusLabel(localHost, localHostConfig, localCloudSession)}
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
): string {
  if (!localHost?.online) {
    return '云端受限'
  }
  if (!config?.token) {
    return '本地未配对'
  }
  if (!session?.connected) {
    return '本地待登录'
  }
  return '本地 Harness'
}

function formatRelativeTime(value: string): string {
  const time = new Date(value).getTime()
  if (!Number.isFinite(time)) {
    return '最近更新'
  }
  const minutes = Math.max(0, Math.round((Date.now() - time) / 60000))
  if (minutes < 1) {
    return '刚刚更新'
  }
  if (minutes < 60) {
    return `${minutes} 分钟前`
  }
  const hours = Math.round(minutes / 60)
  if (hours < 24) {
    return `${hours} 小时前`
  }
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit' }).format(new Date(value))
}

function appendLocalRunEvent(message: ChatMessage, event: AgentRunEvent, seenEventIDs: Set<string>) {
  if (event.event_type === 'llm.delta') {
    return
  }
  if (event.id && seenEventIDs.has(event.id)) {
    return
  }
  if (event.id) {
    seenEventIDs.add(event.id)
  }
  const item = timelineItem(event)
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
  return [conversation, ...items.filter((item) => item.id !== conversation.id)]
}

function cloneConversation(conversation: Conversation): Conversation {
  return {
    ...conversation,
    workspace: conversation.workspace ? { ...conversation.workspace } : undefined,
    messages: conversation.messages.map((message) => ({
      ...message,
      agentEvents: message.agentEvents ? [...message.agentEvents] : undefined,
    })),
  }
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

function createConversation(firstMessage: string, timestamp: string): Conversation {
  return {
    id: createLocalID('conv'),
    title: firstMessage.slice(0, 24) || '新对话',
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
