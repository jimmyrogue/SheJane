import {
  Download,
  FileText,
  Loader2,
  LogOut,
  MessageSquare,
  Plus,
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
import { createChatStore } from './features/chat/chatStore'
import { LocalConversationStore } from './shared/local-data/localConversations'
import type { ChatMode, Conversation } from './shared/local-data/types'

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

  const activeConversation = conversations.find((conversation) => conversation.id === activeID)
  const attachedDocument = documents.find((document) => document.id === attachedDocumentID)

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
      const conversation = await chat.sendMessage({
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
    await api.logout()
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
                  <p>{message.content}</p>
                  {message.agentEvents?.length ? (
                    <div className="agent-timeline">
                      {message.agentEvents.map((event, index) => (
                        <small key={`${event.type}-${index}`}>{event.label}</small>
                      ))}
                    </div>
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
