import { Download, LogOut, MessageSquare, Plus, Send, Upload, WalletCards } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { JiandanAPI, type AuthPayload, type WalletBalance } from './shared/api/client'
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
  const [balance, setBalance] = useState<WalletBalance | null>(null)
  const [isSending, setIsSending] = useState(false)
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
        return api.balance()
      })
      .then(setBalance)
      .catch(() => undefined)
  }, [api])

  const activeConversation = conversations.find((conversation) => conversation.id === activeID)

  async function handleAuth(payload: AuthPayload) {
    api.setAccessToken(payload.access_token)
    setAuth(payload)
    setBalance(await api.balance())
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

        {notice ? <div className="notice">{notice}</div> : null}

        <footer className="composer">
          <div className="composer-controls">
            <div className="segmented">
              <button className={mode === 'fast' ? 'selected' : ''} onClick={() => setMode('fast')}>
                快速
              </button>
              <button className={mode === 'deep' ? 'selected' : ''} onClick={() => setMode('deep')}>
                深度
              </button>
            </div>
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
      </section>
    </main>
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
