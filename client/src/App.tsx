import {
  CheckCircle2,
  Download,
  Eye,
  FileText,
  FolderOpen,
  Loader2,
  LogOut,
  MessageSquare,
  Plus,
  RotateCcw,
  Send,
  Trash2,
  Upload,
  WalletCards,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  JiandanAPI,
  type AuthPayload,
  type UserDocument,
  type WalletBalance,
} from './shared/api/client'
import { createChatStore, timelineItem } from './features/chat/chatStore'
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
  type LocalWorkspaceAuthorization,
} from './shared/local-host/client'

const documentAccept =
  'application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.pdf,.docx,.xlsx'
const documentMaxBytes = 30 * 1024 * 1024

export function App() {
  const api = useMemo(() => new JiandanAPI(), [])
  const localData = useMemo(() => new LocalConversationStore(), [])
  const chat = useMemo(() => createChatStore({ localData, api }), [api, localData])
  const importInputRef = useRef<HTMLInputElement>(null)

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
      agentEvents: [],
    }

    conversation.messages = [...conversation.messages, userMessage, assistantMessage]
    conversation.updatedAt = timestamp
    await localData.save(conversation)

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
      const seenEventIDs = new Set<string>()
      await streamLocalRun(run.id, localHostConfig, {
        onEvent: (event) => appendLocalRunEvent(assistantMessage, event, seenEventIDs),
        onDelta: (delta, event) => appendLocalDelta(assistantMessage, delta, event, seenEventIDs),
      })
      finalizeLocalRunStatus(assistantMessage)
    } catch (error) {
      assistantMessage.status = 'error'
      assistantMessage.content = error instanceof Error ? error.message : '本地 Harness 执行失败'
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
        onEvent: (event) => appendLocalRunEvent(message, event, seenEventIDs),
        onDelta: (delta, event) => appendLocalDelta(message, delta, event, seenEventIDs),
      })
      finalizeLocalRunStatus(message)
    } catch (error) {
      message.status = 'error'
      message.content = error instanceof Error ? error.message : '本地权限处理失败'
      setNotice(message.content)
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
      agentEvents: [],
    }
    conversation.messages = [userMessage, assistantMessage]
    await localData.save(conversation)
    setNotice('')
    try {
      const seenEventIDs = new Set<string>()
      await streamLocalRun(run.id, localHostConfig, {
        onEvent: (event) => appendLocalRunEvent(assistantMessage, event, seenEventIDs),
        onDelta: (delta, event) => appendLocalDelta(assistantMessage, delta, event, seenEventIDs),
      })
      finalizeLocalRunStatus(assistantMessage)
      const freshRuns = await listLocalRuns(localHostConfig)
      setLocalRuns(freshRuns)
    } catch (error) {
      assistantMessage.status = 'error'
      assistantMessage.content = error instanceof Error ? error.message : '本地任务恢复失败'
      setNotice(assistantMessage.content)
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
      const url = URL.createObjectURL(new Blob([JSON.stringify(diagnostics, null, 2)], { type: 'application/json' }))
      const link = document.createElement('a')
      link.href = url
      link.download = `jiandanly-local-run-${run.id}-diagnostics.json`
      link.click()
      URL.revokeObjectURL(url)
      setNotice(`诊断已导出：${run.id}`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '本地任务诊断导出失败')
    }
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
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">简</span>
          <div>
            <strong>简单 Jiandan</strong>
            <small>AI, simplified.</small>
          </div>
        </div>

        <button className="primary-action" onClick={() => setActiveID(undefined)}>
          <Plus size={18} />
          新对话
        </button>

        <div className="conversation-list">
          {conversations.map((conversation) => (
            <button
              className={conversation.id === activeID ? 'conversation active' : 'conversation'}
              key={conversation.id}
              onClick={() => setActiveID(conversation.id)}
            >
              <MessageSquare size={16} />
              <span>{conversation.title}</span>
            </button>
          ))}
        </div>

        <section className="sidebar-section">
          <div className="section-heading">
            <span>附件资料</span>
            <small>{documents.length} 个</small>
          </div>
          <label className="document-upload">
            <Upload size={18} />
            <span>{isUploading ? '上传解析中' : '上传附件'}</span>
            <input
              aria-label="上传附件"
              type="file"
              accept={documentAccept}
              disabled={isUploading}
              onChange={(event) => {
                void uploadDocument(event.currentTarget.files?.[0])
                event.currentTarget.value = ''
              }}
            />
          </label>

          <div className="document-list">
            {documents.map((document) => (
              <div
                className={document.id === attachedDocumentID ? 'document-list-item active' : 'document-list-item'}
                key={document.id}
              >
                <button className="document-select" onClick={() => setAttachedDocumentID(document.id)}>
                  <FileText size={16} />
                  <span>{document.original_name}</span>
                  <small>{document.status}</small>
                </button>
                <button
                  className="document-delete"
                  title={`删除 ${document.original_name}`}
                  onClick={() => void deleteDocument(document)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        </section>

        <section className="sidebar-section">
          <div className="section-heading">
            <span>本地工作区</span>
            <small>{localHostStatusLabel(localHost, localHostConfig, localCloudSession)}</small>
          </div>
          <label className="workspace-path-field">
            <span>
              <FolderOpen size={15} />
              本地工作区路径
            </span>
            <div className="workspace-path-row">
              <input
                aria-label="本地工作区路径"
                value={localWorkspacePath}
                placeholder="/Users/you/project"
                onChange={(event) => {
                  setLocalWorkspacePath(event.target.value)
                  localStorage.setItem('jiandanly-local-workspace', event.target.value)
                }}
              />
              {window.jiandanDesktop?.selectWorkspaceDirectory ? (
                <button type="button" onClick={() => void chooseWorkspaceDirectory()}>
                  选择
                </button>
              ) : null}
            </div>
          </label>
          <button className="workspace-authorize-button" type="button" onClick={() => void authorizeWorkspace()}>
            授权当前路径
          </button>
          <button className="workspace-authorize-button subtle" type="button" onClick={() => void diagnoseWorkspace()}>
            诊断当前路径
          </button>
          {authorizedWorkspaces.length ? (
            <div className="workspace-authorized-list">
              {authorizedWorkspaces.slice(0, 3).map((workspace) => (
                <div className={workspace.path === localWorkspacePath.trim() ? 'workspace-authorized-item active' : 'workspace-authorized-item'} key={workspace.id}>
                  <button type="button" onClick={() => {
                    setLocalWorkspacePath(workspace.path)
                    localStorage.setItem('jiandanly-local-workspace', workspace.path)
                  }}>
                    已授权：{workspace.label}
                  </button>
                  <button title={`诊断 ${workspace.label}`} type="button" onClick={() => void diagnoseWorkspace(workspace.path)}>
                    诊断
                  </button>
                  <button title={`撤销 ${workspace.label}`} type="button" onClick={() => void revokeWorkspace(workspace)}>
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
        </section>

        {localRuns.length ? (
          <section className="sidebar-section">
            <div className="section-heading">
              <span>最近本地任务</span>
              <small>{localRuns.length} 个</small>
            </div>
            <div className="local-run-list">
              {localRuns.slice(0, 4).map((run) => (
                <div className="local-run-item" key={run.id}>
                  <button type="button" onClick={() => void recoverLocalRun(run)} title={`恢复 ${run.goal}`}>
                    <RotateCcw size={13} />
                    <span>{run.goal}</span>
                    <small>{run.status}</small>
                  </button>
                  <button type="button" title={`导出诊断 ${run.goal}`} onClick={() => void exportLocalRunDiagnostics(run)}>
                    <Download size={13} />
                  </button>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <div className="local-actions">
          <button onClick={exportLocalData}>
            <Download size={16} />
            导出
          </button>
          <button onClick={() => importInputRef.current?.click()}>
            <Upload size={16} />
            导入
          </button>
          <input
            ref={importInputRef}
            type="file"
            accept="application/json"
            hidden
            onChange={(event) => void importLocalData(event.currentTarget.files?.[0])}
          />
        </div>
      </aside>

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

        <section className="chat-surface">
          {activeConversation?.messages.length ? (
            <div className="messages">
              {activeConversation.messages.map((message) => (
                <article className={`message ${message.role}`} key={message.id}>
                  <span>{message.role === 'user' ? '我' : '简单'}</span>
                  <p>{message.content || (message.status === 'waiting_permission' ? '等待你批准本地工具调用。' : '')}</p>
                  {message.agentEvents?.length ? (
                    <AgentTimeline
                      message={message}
                      onOpenArtifact={(artifactID) => void openLocalArtifact(artifactID)}
                      onPermissionDecision={(requestID, decision, scope) => void handlePermissionDecision(message.id, requestID, decision, scope)}
                    />
                  ) : null}
                </article>
              ))}
            </div>
          ) : (
            <div className="empty-state">
              <h1>把复杂的工作，简单做完</h1>
              <p>直接提问，或上传附件后让简单阅读。本地聊天历史会默认保存在本机。</p>
            </div>
          )}
        </section>

        {notice ? <div className="notice">{notice}</div> : null}

        {artifactPreview ? (
          <section className="artifact-preview">
            <header>
              <div>
                <strong>Artifact: {artifactPreview.title}</strong>
                <small>{artifactPreview.tool_name ?? 'local artifact'}</small>
              </div>
              <button className="icon-button light" title="关闭 artifact" onClick={() => setArtifactPreview(null)}>
                <X size={15} />
              </button>
            </header>
            <pre>{artifactPreview.content}</pre>
          </section>
        ) : null}

        <footer className="composer">
          <div className="composer-controls">
            <ModeToggle mode={mode} onChange={setMode} />
            <span className="muted">上传和解析免费；发送问题会消耗额度。</span>
          </div>
          {attachedDocument ? (
            <div className={`attachment-chip ${attachedDocument.status !== 'ready' ? 'pending' : ''}`}>
              {attachedDocument.status !== 'ready' && attachedDocument.status !== 'failed' ? <Loader2 size={15} /> : <FileText size={15} />}
              <span>已附加 {attachedDocument.original_name}</span>
              <small>
                {formatBytes(attachedDocument.size_bytes)} · {attachedDocument.status} · {formatDate(attachedDocument.expires_at)}
              </small>
              <button title="移除附件" onClick={() => setAttachedDocumentID(undefined)}>
                <X size={14} />
              </button>
            </div>
          ) : null}
          {attachedDocument?.status === 'failed' ? (
            <div className="document-status failed">{attachedDocument.error_message || '解析失败'}</div>
          ) : null}
          {!attachedDocument && localHost?.online && localHostConfig?.token && localCloudSession?.connected && localWorkspacePath.trim() ? (
            <div className={`local-project-chip ${selectedWorkspace ? '' : 'pending'}`}>
              <FolderOpen size={15} />
              <span>本地项目：{localProjectLabel}</span>
              <small>{selectedWorkspace ? '已授权' : '待授权'} · {localWorkspacePath.trim()}</small>
              <button title="移除本地项目引用" onClick={() => {
                setLocalWorkspacePath('')
                localStorage.removeItem('jiandanly-local-workspace')
              }}>
                <X size={14} />
              </button>
            </div>
          ) : null}
          <div className="composer-input">
            <textarea
              value={draft}
              placeholder="描述你的问题、任务，或让简单阅读附件"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  void sendMessage()
                }
              }}
            />
            <button className="send-button" disabled={isSending || !draft.trim()} onClick={() => void sendMessage()}>
              <Send size={18} />
              发送
            </button>
          </div>
        </footer>
      </section>
    </main>
  )
}

function ModeToggle({ mode, onChange }: { mode: ChatMode; onChange: (mode: ChatMode) => void }) {
  return (
    <div className="segmented">
      <button className={mode === 'fast' ? 'selected' : ''} onClick={() => onChange('fast')}>
        快速
      </button>
      <button className={mode === 'deep' ? 'selected' : ''} onClick={() => onChange('deep')}>
        深度
      </button>
    </div>
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

function AgentTimeline({
  message,
  onOpenArtifact,
  onPermissionDecision,
}: {
  message: ChatMessage
  onOpenArtifact: (artifactID: string) => void
  onPermissionDecision: (requestID: string, decision: 'approve' | 'deny', scope?: LocalPermissionScope) => void
}) {
  return (
    <div className="agent-timeline">
      {message.agentEvents?.map((event, index) => (
        <div className={`timeline-item ${timelineItemClass(event)}`} key={`${event.eventId ?? event.type}-${index}`}>
          <small>{event.label}</small>
          {event.sourceUrl ? (
            <a className="timeline-source-link" href={event.sourceUrl} target="_blank" rel="noreferrer">
              {event.sourceUrl}
            </a>
          ) : null}
          {event.permissionRequestId && event.type === 'permission.required' && !isPermissionResolved(message, event.permissionRequestId) ? (
            <span className="timeline-actions">
              <button onClick={() => onPermissionDecision(event.permissionRequestId!, 'approve', 'once')}>
                <CheckCircle2 size={13} />
                允许一次
              </button>
              <button onClick={() => onPermissionDecision(event.permissionRequestId!, 'approve', 'run')}>
                <CheckCircle2 size={13} />
                本会话始终允许
              </button>
              <button onClick={() => onPermissionDecision(event.permissionRequestId!, 'deny')}>
                <X size={13} />
                拒绝
              </button>
            </span>
          ) : null}
          {event.artifactId ? (
            <button className="timeline-artifact-button" onClick={() => onOpenArtifact(event.artifactId!)}>
              <Eye size={13} />
              查看 artifact
            </button>
          ) : null}
        </div>
      ))}
    </div>
  )
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

function isPermissionResolved(message: ChatMessage, requestID: string): boolean {
  return (message.agentEvents ?? []).some((event) => event.type === 'permission.resolved' && event.permissionRequestId === requestID)
}

function timelineItemClass(event: AgentTimelineItem): string {
  if (event.type.startsWith('permission.')) {
    return 'permission'
  }
  if (event.artifactId) {
    return 'artifact'
  }
  if (event.verificationStatus) {
    return event.verificationStatus === 'passed' ? 'verification passed' : 'verification failed'
  }
  return ''
}

function AuthScreen({ api, onAuthed }: { api: JiandanAPI; onAuthed: (payload: AuthPayload) => Promise<void> }) {
  const [mode, setMode] = useState<'login' | 'register'>('register')
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')

  async function submit() {
    setError('')
    try {
      const payload =
        mode === 'register'
          ? await api.register({ email, password, name: name || email.split('@')[0] })
          : await api.login({ email, password })
      await onAuthed(payload)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '登录失败')
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-panel">
        <div className="brand auth-brand">
          <span className="brand-mark">简</span>
          <div>
            <strong>简单 Jiandan</strong>
            <small>把复杂的工作，简单做完</small>
          </div>
        </div>

        <div className="auth-tabs">
          <button className={mode === 'register' ? 'selected' : ''} onClick={() => setMode('register')}>
            注册
          </button>
          <button className={mode === 'login' ? 'selected' : ''} onClick={() => setMode('login')}>
            登录
          </button>
        </div>

        {mode === 'register' ? (
          <label>
            名称
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="你的名字" />
          </label>
        ) : null}
        <label>
          邮箱
          <input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" />
        </label>
        <label>
          密码
          <input
            value={password}
            type="password"
            onChange={(event) => setPassword(event.target.value)}
            placeholder="至少 8 位"
          />
        </label>
        {error ? <p className="auth-error">{error}</p> : null}
        <button className="auth-submit" onClick={() => void submit()}>
          {mode === 'register' ? '创建账号' : '登录'}
        </button>
      </section>
    </main>
  )
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

function formatBytes(size: number): string {
  if (size < 1024) {
    return `${size} B`
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`
  }
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

function formatDate(value: string): string {
  if (!value) {
    return '-'
  }
  return new Date(value).toLocaleDateString()
}
