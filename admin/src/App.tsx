import { BarChart3, Ban, Coins, LogOut, ReceiptText, Search, Settings, ShieldCheck, Users } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import {
  AdminAPI,
  type AdminLLMCall,
  type AdminOrder,
  type AdminOverview,
  type AdminProviderStatus,
  type AdminUserDetail,
  type AdminUserSummary,
  type AuthPayload,
} from './shared/api/client'

export function App() {
  const api = useMemo(() => new AdminAPI(), [])
  const [auth, setAuth] = useState<AuthPayload | null>(null)
  const [authChecked, setAuthChecked] = useState(false)

  useEffect(() => {
    api
      .refresh()
      .then((payload) => {
        api.setAccessToken(payload.access_token)
        setAuth(payload)
      })
      .catch(() => undefined)
      .finally(() => setAuthChecked(true))
  }, [api])

  async function handleLogin(payload: AuthPayload) {
    api.setAccessToken(payload.access_token)
    setAuth(payload)
  }

  async function logout() {
    await api.logout()
    setAuth(null)
  }

  if (!authChecked) {
    return <main className="auth-page">正在检查登录状态...</main>
  }

  if (!auth) {
    return <AuthScreen api={api} onAuthed={handleLogin} />
  }

  if (auth.user.role !== 'admin') {
    return (
      <main className="auth-page">
        <section className="auth-panel">
          <div className="brand">
            <span className="brand-mark">简</span>
            <div>
              <strong>Jiandanly Admin</strong>
              <small>{auth.user.email}</small>
            </div>
          </div>
          <h1>无管理员权限</h1>
          <p>当前账号不是管理员。请使用配置在 ADMIN_EMAILS 中的账号登录。</p>
          <button className="auth-submit" onClick={() => void logout()}>
            退出登录
          </button>
        </section>
      </main>
    )
  }

  return <AdminDashboard api={api} auth={auth} onLogout={logout} />
}

function AuthScreen({ api, onAuthed }: { api: AdminAPI; onAuthed: (payload: AuthPayload) => Promise<void> }) {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')

  async function login() {
    setError('')
    try {
      await onAuthed(await api.login({ email, password }))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '登录失败')
    }
  }

  async function register() {
    setError('')
    try {
      await onAuthed(await api.register({ email, password, name: name || email.split('@')[0] }))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '创建账号失败')
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-panel">
        <div className="brand">
          <span className="brand-mark">简</span>
          <div>
            <strong>Jiandanly Admin</strong>
            <small>运营、用户、额度和模型状态</small>
          </div>
        </div>
        <label>
          名称
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="首次创建管理员时填写" />
        </label>
        <label>
          邮箱
          <input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="admin@example.com" />
        </label>
        <label>
          密码
          <input value={password} type="password" onChange={(event) => setPassword(event.target.value)} placeholder="至少 8 位" />
        </label>
        {error ? <p className="auth-error">{error}</p> : null}
        <div className="auth-actions">
          <button className="auth-submit" onClick={() => void login()}>
            登录
          </button>
          <button onClick={() => void register()}>创建账号</button>
        </div>
      </section>
    </main>
  )
}

function AdminDashboard({ api, auth, onLogout }: { api: AdminAPI; auth: AuthPayload; onLogout: () => Promise<void> }) {
  const [overview, setOverview] = useState<AdminOverview | null>(null)
  const [users, setUsers] = useState<AdminUserSummary[]>([])
  const [calls, setCalls] = useState<AdminLLMCall[]>([])
  const [orders, setOrders] = useState<AdminOrder[]>([])
  const [providers, setProviders] = useState<AdminProviderStatus[]>([])
  const [selectedUser, setSelectedUser] = useState<AdminUserDetail | null>(null)
  const [query, setQuery] = useState('')
  const [delta, setDelta] = useState('')
  const [reason, setReason] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    void loadAdminData()
  }, [])

  async function loadAdminData(nextQuery = query) {
    const [overviewData, userData, callData, orderData, providerData] = await Promise.all([
      api.adminOverview(),
      api.adminUsers(nextQuery),
      api.adminLLMCalls(),
      api.adminOrders(),
      api.adminProviders(),
    ])
    setOverview(overviewData)
    setUsers(userData)
    setCalls(callData)
    setOrders(orderData)
    setProviders(providerData)
    if (!userData.length) {
      setSelectedUser(null)
    } else if (!selectedUser || !userData.some((item) => item.user.id === selectedUser.user.id)) {
      setSelectedUser(await api.adminUserDetail(userData[0].user.id))
    }
  }

  async function searchUsers() {
    setNotice('')
    await loadAdminData(query)
  }

  async function openUser(userId: string) {
    setNotice('')
    setSelectedUser(await api.adminUserDetail(userId))
  }

  async function updateStatus(status: 'active' | 'disabled') {
    if (!selectedUser) {
      return
    }
    if (!reason.trim()) {
      setNotice('请填写操作原因')
      return
    }
    await api.adminUpdateUserStatus(selectedUser.user.id, status, reason.trim())
    setReason('')
    setSelectedUser(await api.adminUserDetail(selectedUser.user.id))
    await loadAdminData()
    setNotice('用户状态已更新')
  }

  async function adjustCredits() {
    if (!selectedUser) {
      return
    }
    const parsedDelta = Number(delta)
    if (!Number.isFinite(parsedDelta) || parsedDelta === 0) {
      setNotice('额度调整不能为 0')
      return
    }
    if (!reason.trim()) {
      setNotice('请填写操作原因')
      return
    }
    await api.adminAdjustCredits(selectedUser.user.id, parsedDelta, reason.trim())
    setDelta('')
    setReason('')
    setSelectedUser(await api.adminUserDetail(selectedUser.user.id))
    await loadAdminData()
    setNotice('额外额度已调整')
  }

  return (
    <main className="admin-shell">
      <aside className="admin-sidebar">
        <div className="brand">
          <span className="brand-mark">简</span>
          <div>
            <strong>Jiandanly Admin</strong>
            <small>{auth.user.email}</small>
          </div>
        </div>
        <nav>
          <a href="#overview">概览</a>
          <a href="#users">用户</a>
          <a href="#usage">用量</a>
          <a href="#orders">订单</a>
          <a href="#providers">模型</a>
        </nav>
        <button className="logout-button" onClick={() => void onLogout()}>
          <LogOut size={16} />
          退出登录
        </button>
      </aside>

      <section className="admin-workspace">
        <div className="admin-header" id="overview">
          <div>
            <h1>运营概览</h1>
            <p>用户、额度、订单和模型状态的独立管理后台。</p>
          </div>
          <ShieldCheck size={28} />
        </div>

        <div className="admin-metrics">
          <AdminMetric icon={<Users size={18} />} label="用户" value={overview?.users_total ?? 0} />
          <AdminMetric icon={<BarChart3 size={18} />} label="调用" value={overview?.llm_calls_total ?? 0} />
          <AdminMetric icon={<Coins size={18} />} label="额度消耗" value={overview?.credits_cost_total ?? 0} />
          <AdminMetric icon={<ReceiptText size={18} />} label="订单" value={overview?.orders_total ?? 0} />
        </div>

        {notice ? <div className="notice">{notice}</div> : null}

        <div className="admin-grid">
          <section className="admin-panel" id="users">
            <div className="panel-title">
              <h2>用户</h2>
              <div className="admin-search">
                <input value={query} placeholder="搜索邮箱或名称" onChange={(event) => setQuery(event.target.value)} />
                <button onClick={() => void searchUsers()} aria-label="搜索用户">
                  <Search size={15} />
                </button>
              </div>
            </div>
            <div className="admin-list">
              {users.map((item) => (
                <button className="admin-user-row" key={item.user.id} onClick={() => void openUser(item.user.id)}>
                  <span>{item.user.email}</span>
                  <small>
                    {item.user.status} · 调用 {item.calls_count} · 额度 {item.credits_cost}
                  </small>
                </button>
              ))}
            </div>
          </section>

          <section className="admin-panel">
            <div className="panel-title">
              <h2>用户详情</h2>
              <span className="plan">{selectedUser?.user.role ?? 'none'}</span>
            </div>
            {selectedUser ? (
              <>
                <div className="detail-lines">
                  <span>{selectedUser.user.email}</span>
                  <span>状态 {selectedUser.user.status}</span>
                  <span>本月剩余 {selectedUser.wallet?.monthly_remaining ?? 0}</span>
                  <span>额外额度 {selectedUser.wallet?.extra_credits_balance ?? 0}</span>
                </div>
                <div className="admin-form">
                  <input value={reason} placeholder="操作原因" onChange={(event) => setReason(event.target.value)} />
                  <input value={delta} placeholder="额外额度调整，例如 1000 或 -500" onChange={(event) => setDelta(event.target.value)} />
                  <button onClick={() => void adjustCredits()}>
                    <Coins size={15} />
                    调整额度
                  </button>
                  <button onClick={() => void updateStatus(selectedUser.user.status === 'disabled' ? 'active' : 'disabled')}>
                    <Ban size={15} />
                    {selectedUser.user.status === 'disabled' ? '启用用户' : '禁用用户'}
                  </button>
                </div>
                <AdminMiniTable title="最近账本" items={selectedUser.transactions.slice(0, 4).map((tx) => `${tx.type} ${tx.amount} · 余额 ${tx.extra_balance_after}`)} />
                <AdminMiniTable title="最近调用" items={selectedUser.calls.slice(0, 4).map((call) => `${call.provider}/${call.model} · ${call.status} · ${call.credits_cost}`)} />
                <AdminMiniTable title="最近订单" items={selectedUser.orders.slice(0, 4).map((order) => `${order.id} · ¥${order.amount_cny / 100} · ${order.status}`)} />
              </>
            ) : (
              <p>选择一个用户查看详情。</p>
            )}
          </section>
        </div>

        <div className="admin-grid lower">
          <section className="admin-panel" id="usage">
            <div className="panel-title">
              <h2>调用记录</h2>
              <BarChart3 size={18} />
            </div>
            <AdminMiniTable items={calls.slice(0, 8).map((call) => `${call.user_email ?? call.user_id} · ${call.provider}/${call.model} · ${call.status} · ${call.credits_cost}`)} />
          </section>

          <section className="admin-panel" id="orders">
            <div className="panel-title">
              <h2>订单</h2>
              <ReceiptText size={18} />
            </div>
            <AdminMiniTable
              items={orders.slice(0, 8).map((order) => `${order.id} · ${order.user_email ?? order.user_id ?? 'unknown'} · ¥${order.amount_cny / 100} · ${order.status} · Stripe ${order.stripe_checkout_session_id || 'mock'} · ${formatDateTime(order.created_at)}`)}
            />
          </section>

          <section className="admin-panel" id="providers">
            <div className="panel-title">
              <h2>模型</h2>
              <Settings size={18} />
            </div>
            <AdminMiniTable
              items={providers.map((provider) => `${provider.mode} · ${provider.provider} · ${provider.model} · ${provider.base_url || 'default'} · ${provider.mock ? 'mock' : 'real'} · ${provider.api_key_configured ? 'key 已配置' : 'key 未配置'}`)}
            />
          </section>
        </div>
      </section>
    </main>
  )
}

function AdminMetric({ icon, label, value }: { icon: ReactNode; label: string; value: number }) {
  return (
    <div className="admin-metric">
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function AdminMiniTable({ title, items }: { title?: string; items: string[] }) {
  return (
    <div className="admin-mini-table">
      {title ? <strong>{title}</strong> : null}
      {items.length ? items.map((item, index) => <span key={`${item}-${index}`}>{item}</span>) : <span>暂无数据</span>}
    </div>
  )
}

function formatDateTime(value?: string) {
  if (!value) {
    return '-'
  }
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}
