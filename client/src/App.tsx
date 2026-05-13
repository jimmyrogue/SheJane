import { LogOut, WalletCards } from 'lucide-react'
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
import type { AgentTimelineItem, ChatMessage, ChatMode, Conversation } from './shared/local-data/types'
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
  revokeLocalWorkspace,
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
  type LocalWorkspaceAuthorization,
} from './shared/local-host/client'

const documentMaxBytes = 30 * 1024 * 1024

export function App() {
  const api = useMemo(() => new JiandanAPI(), [])
  const localData = useMemo(() => new LocalConversationStore(), [])
  const chat = useMemo(() => createChatStore({ localData, api }), [api, localData])
  const liveConversationRef = useRef<Conversation | null>(null)
  const liveRenderTimerRef = useRef<number>()

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
  const [localWorkspacePath, setLocalWorkspacePath] = useState(() => localStorage.getItem('jiandanly-local-workspace') ?? '')
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
  const selectedWorkspace = findWorkspaceByPath(authorizedWorkspaces, localWorkspacePath)
  const localProjectLabel = selectedWorkspace?.label ?? workspaceLabelFromPath(localWorkspacePath)

  async function handleAuth(payload: AuthPayload) {
    api.setAccessToken(payload.access_token)
    setAuth(payload)
    const [wallet, items] = await Promise.all([api.balance(), api.listDocuments()])
    setBalance(wallet)
    setDocuments(items)
  }

  async function refreshConversations(nextActiveID?: string) {
    const items = await localData.list()
    setConversations(items)
    setActiveID(nextActiveID ?? items[0]?.id)
  }

  function scheduleConversationRender(conversation: Conversation) {
    liveConversationRef.current = cloneConversation(conversation)
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
      setActiveID(next.id)
      setConversations((items) => upsertConversation(items, next))
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
      await refreshConversations(conversation.id)
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
          workspacePath: localWorkspacePath.trim() || undefined,
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

  async function chooseWorkspaceDirectory() {
    const selectedPath = await window.jiandanDesktop?.selectWorkspaceDirectory?.()
    if (!selectedPath) {
      return
    }
    await authorizeWorkspace(selectedPath)
  }

  async function authorizeWorkspace(path = localWorkspacePath) {
    if (!localHostConfig?.token) {
      setNotice('本地 Harness 未配对，无法授权工作区')
      return
    }
    const nextPath = path.trim()
    if (!nextPath) {
      setNotice('请先填写本地工作区路径')
      return
    }
    try {
      const workspace = await authorizeLocalWorkspace(nextPath, localHostConfig)
      setLocalWorkspacePath(workspace.path)
      localStorage.setItem('jiandanly-local-workspace', workspace.path)
      setAuthorizedWorkspaces((items) => upsertWorkspace(items, workspace))
      setNotice(`工作区已授权：${workspace.label}`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '工作区授权失败')
    }
  }

  async function diagnoseWorkspace(path = localWorkspacePath) {
    if (!localHostConfig?.token) {
      setNotice('本地 Harness 未配对，无法诊断工作区')
      return
    }
    const nextPath = path.trim()
    if (!nextPath) {
      setNotice('请先填写本地工作区路径')
      return
    }
    try {
      const diagnosis = await diagnoseLocalWorkspace(nextPath, localHostConfig)
      if (diagnosis.authorized) {
        setNotice(`路径已授权：${diagnosis.workspace?.label ?? workspaceLabelFromPath(diagnosis.path)}`)
        return
      }
      if (diagnosis.reason === 'not_found') {
        setNotice('路径不存在，请重新选择工作区')
        return
      }
      if (diagnosis.reason === 'not_directory') {
        setNotice('路径不是文件夹，请选择工作区目录')
        return
      }
      setNotice('路径存在，但尚未授权')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '工作区诊断失败')
    }
  }

  async function revokeWorkspace(workspace: LocalWorkspaceAuthorization) {
    if (!localHostConfig?.token) {
      setNotice('本地 Harness 未配对，无法撤销工作区')
      return
    }
    try {
      const revoked = await revokeLocalWorkspace(workspace.id, localHostConfig)
      setAuthorizedWorkspaces((items) => items.filter((item) => item.id !== revoked.id))
      if (pathInsideWorkspace(revoked.path, localWorkspacePath)) {
        setLocalWorkspacePath('')
        localStorage.removeItem('jiandanly-local-workspace')
      }
      setNotice(`工作区授权已撤销：${revoked.label}`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '工作区撤销失败')
    }
  }

  async function exportLocalData() {
    const payload = await localData.exportAll()
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `jiandan-conversations-${new Date().toISOString().slice(0, 10)}.json`
    link.click()
    URL.revokeObjectURL(url)
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

  return (
    <main className="app-shell">
      <ConversationSidebar
        conversations={conversations}
        activeID={activeID}
        documents={documents}
        attachedDocumentID={attachedDocumentID}
        isUploading={isUploading}
        localStatusLabel={localHostStatusLabel(localHost, localHostConfig, localCloudSession)}
        localWorkspacePath={localWorkspacePath}
        canPickWorkspace={Boolean(window.jiandanDesktop?.selectWorkspaceDirectory)}
        authorizedWorkspaces={authorizedWorkspaces}
        localRuns={localRuns}
        onNewConversation={() => setActiveID(undefined)}
        onSelectConversation={setActiveID}
        onUploadDocument={(file) => void uploadDocument(file)}
        onAttachDocument={setAttachedDocumentID}
        onDeleteDocument={(document) => void deleteDocument(document)}
        onWorkspacePathChange={(path) => {
          setLocalWorkspacePath(path)
          localStorage.setItem('jiandanly-local-workspace', path)
        }}
        onPickWorkspace={() => void chooseWorkspaceDirectory()}
        onAuthorizeWorkspace={() => void authorizeWorkspace()}
        onDiagnoseWorkspace={(path) => void diagnoseWorkspace(path)}
        onRevokeWorkspace={(workspace) => void revokeWorkspace(workspace)}
        onRecoverLocalRun={(run) => void recoverLocalRun(run)}
        onExportLocalRunDiagnostics={(run) => void exportLocalRunDiagnostics(run)}
        onExportLocalData={exportLocalData}
        onImportLocalData={(file) => void importLocalData(file)}
      />

      <TooltipProvider>
      <section className="workspace">
        <header className="topbar">
          <div className="quota">
            <WalletCards size={20} />
            <span>
              本月额度 <strong>{balance?.monthly_remaining ?? 0}</strong>
            </span>
            <span>
              额外额度 <strong>{balance?.extra_credits_balance ?? 0}</strong>
            </span>
            <span className="plan">{balance?.plan_code ?? 'free_trial'}</span>
          </div>
          <div className="account">
            {localHost ? (
              <span className={localHost.online && localHostConfig?.token ? 'host-chip online' : 'host-chip offline'}>
                {localHostStatusLabel(localHost, localHostConfig, localCloudSession)}
              </span>
            ) : null}
            <span>{auth.user.email}</span>
            <button onClick={startCheckout}>升级</button>
            <button className="icon-button" title="退出登录" onClick={logout}>
              <LogOut size={17} />
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
          attachedDocument={attachedDocument}
          localProject={
            !attachedDocument && localHost?.online && localHostConfig?.token && localCloudSession?.connected && localWorkspacePath.trim()
              ? {
                  label: localProjectLabel,
                  path: localWorkspacePath.trim(),
                  authorized: Boolean(selectedWorkspace),
                }
              : undefined
          }
          onDetachDocument={() => setAttachedDocumentID(undefined)}
          onClearLocalProject={() => {
            setLocalWorkspacePath('')
            localStorage.removeItem('jiandanly-local-workspace')
          }}
          onSend={() => void sendMessage()}
        />
      </section>
      </TooltipProvider>
    </main>
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

function workspaceLabelFromPath(path: string): string {
  const trimmed = path.trim()
  if (!trimmed) {
    return ''
  }
  return trimmed.split('/').filter(Boolean).at(-1) ?? trimmed
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
