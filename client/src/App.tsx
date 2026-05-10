import {
  BookOpenText,
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

const scenes = [
  { value: 'chat', label: '自由对话' },
  { value: 'write', label: '帮我写' },
  { value: 'read', label: '帮我读' },
  { value: 'translate', label: '帮我翻译' },
  { value: 'calculate', label: '帮我算' },
]

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
  const [scene, setScene] = useState('chat')
  const [workspaceView, setWorkspaceView] = useState<'chat' | 'documents'>('chat')
  const [documents, setDocuments] = useState<UserDocument[]>([])
  const [activeDocumentID, setActiveDocumentID] = useState<string>()
  const [documentQuestion, setDocumentQuestion] = useState('')
  const [documentAnswer, setDocumentAnswer] = useState('')
  const [balance, setBalance] = useState<WalletBalance | null>(null)
  const [isSending, setIsSending] = useState(false)
  const [isUploading, setIsUploading] = useState(false)
  const [isAskingDocument, setIsAskingDocument] = useState(false)
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
        setActiveDocumentID(items[0]?.id)
      })
      .catch(() => undefined)
  }, [api])

  const activeConversation = conversations.find((conversation) => conversation.id === activeID)
  const activeDocument = documents.find((document) => document.id === activeDocumentID)

  async function handleAuth(payload: AuthPayload) {
    api.setAccessToken(payload.access_token)
    setAuth(payload)
    const [wallet, items] = await Promise.all([api.balance(), api.listDocuments()])
    setBalance(wallet)
    setDocuments(items)
    setActiveDocumentID(items[0]?.id)
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
    setIsSending(true)
    setNotice('')
    try {
      const conversation = await chat.sendMessage({
        conversationId: activeID,
        content: draft,
        mode,
        scene,
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
    setActiveDocumentID(undefined)
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
      setActiveDocumentID(upload.document.id)
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
      setActiveDocumentID(completed.id)
      setNotice('文档已解析完成')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '文档上传失败')
    } finally {
      setIsUploading(false)
    }
  }

  async function askActiveDocument() {
    if (!activeDocument) {
      setNotice('请先选择文档')
      return
    }
    if (activeDocument.status !== 'ready') {
      setNotice('文档尚未解析完成')
      return
    }
    const question = documentQuestion.trim()
    if (!question) {
      setNotice('请先输入问题')
      return
    }
    setNotice('')
    setDocumentAnswer('')
    setIsAskingDocument(true)
    try {
      await api.askDocument(activeDocument.id, { mode, question }, {
        onDelta: (content) => setDocumentAnswer((current) => current + content),
      })
      setDocumentQuestion('')
      setBalance(await api.balance())
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '文档问答失败')
    } finally {
      setIsAskingDocument(false)
    }
  }

  async function deleteActiveDocument() {
    if (!activeDocument) {
      return
    }
    const deleted = await api.deleteDocument(activeDocument.id)
    setDocuments((items) => items.filter((item) => item.id !== deleted.id))
    setActiveDocumentID((current) => {
      if (current !== deleted.id) {
        return current
      }
      return documents.find((item) => item.id !== deleted.id)?.id
    })
    setDocumentAnswer('')
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

        <div className="workspace-switch">
          <button className={workspaceView === 'chat' ? 'selected' : ''} onClick={() => setWorkspaceView('chat')}>
            <MessageSquare size={16} />
            对话
          </button>
          <button
            className={workspaceView === 'documents' ? 'selected' : ''}
            onClick={() => setWorkspaceView('documents')}
          >
            <BookOpenText size={16} />
            文档阅读
          </button>
        </div>

        {workspaceView === 'chat' ? (
          <>
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
          </>
        ) : (
          <>
            <label className="document-upload">
              <Upload size={18} />
              <span>{isUploading ? '上传解析中' : '上传文档'}</span>
              <input
                aria-label="上传文档"
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
                <button
                  className={document.id === activeDocumentID ? 'document-list-item active' : 'document-list-item'}
                  key={document.id}
                  onClick={() => setActiveDocumentID(document.id)}
                >
                  <FileText size={16} />
                  <span>{document.original_name}</span>
                  <small>{document.status}</small>
                </button>
              ))}
            </div>
          </>
        )}
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

        {workspaceView === 'chat' ? (
          <section className="chat-surface">
            {activeConversation?.messages.length ? (
              <div className="messages">
                {activeConversation.messages.map((message) => (
                  <article className={`message ${message.role}`} key={message.id}>
                    <span>{message.role === 'user' ? '我' : '简单'}</span>
                    <p>{message.content}</p>
                  </article>
                ))}
              </div>
            ) : (
              <div className="empty-state">
                <h1>把复杂的工作，简单做完</h1>
                <p>选择模式，输入任务，聊天历史会默认保存在本机。</p>
              </div>
            )}
          </section>
        ) : (
          <section className="document-surface">
            {activeDocument ? (
              <div className="document-reader">
                <header className="document-header">
                  <div>
                    <span className="eyebrow">基于单个文档提问</span>
                    <h1>{activeDocument.original_name}</h1>
                    <p>
                      {formatBytes(activeDocument.size_bytes)} · {activeDocument.status} · 过期于{' '}
                      {formatDate(activeDocument.expires_at)}
                    </p>
                  </div>
                  <button className="icon-button light" title="删除文档" onClick={() => void deleteActiveDocument()}>
                    <Trash2 size={17} />
                  </button>
                </header>

                {activeDocument.status === 'failed' ? (
                  <div className="document-status failed">{activeDocument.error_message || '解析失败'}</div>
                ) : null}
                {activeDocument.status !== 'ready' && activeDocument.status !== 'failed' ? (
                  <div className="document-status">
                    <Loader2 size={18} />
                    文档正在准备中
                  </div>
                ) : null}

                <div className="document-answer">
                  {documentAnswer ? (
                    <p>{documentAnswer}</p>
                  ) : (
                    <p className="muted">选择已解析完成的文档后，可以在下方提问。</p>
                  )}
                </div>
              </div>
            ) : (
              <div className="empty-state">
                <h1>上传材料，直接开问</h1>
                <p>支持 PDF、Word 和 Excel，本阶段按单文件上下文回答。</p>
              </div>
            )}
          </section>
        )}

        {notice ? <div className="notice">{notice}</div> : null}

        {workspaceView === 'chat' ? (
          <footer className="composer">
            <div className="composer-controls">
              <ModeToggle mode={mode} onChange={setMode} />
              <select value={scene} onChange={(event) => setScene(event.target.value)}>
                {scenes.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="composer-input">
              <textarea
                value={draft}
                placeholder="写邮件、总结材料、翻译文本，或直接问一个工作问题"
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
        ) : (
          <footer className="composer document-composer">
            <div className="composer-controls">
              <ModeToggle mode={mode} onChange={setMode} />
              <span className="muted">上传和解析免费；提问会消耗额度。</span>
            </div>
            <div className="composer-input">
              <textarea
                value={documentQuestion}
                placeholder="询问这份文档里的结论、数字、风险或下一步"
                onChange={(event) => setDocumentQuestion(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                    void askActiveDocument()
                  }
                }}
              />
              <button
                className="send-button"
                disabled={isAskingDocument || activeDocument?.status !== 'ready'}
                onClick={() => void askActiveDocument()}
              >
                <Send size={18} />
                提问
              </button>
            </div>
          </footer>
        )}
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
