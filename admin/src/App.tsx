import {
  BarChart3,
  Ban,
  Bot,
  ClipboardList,
  Coins,
  Database,
  KeyRound,
  Loader2,
  LogOut,
  MessageSquareText,
  ReceiptText,
  RefreshCcw,
  Search,
  Settings,
  ShieldAlert,
  ShieldCheck,
  UserCheck,
  Users,
} from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
} from '@/components/ui/sidebar'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  AdminAPI,
  type AdminAgentRun,
  type AdminAuditLog,
  type AdminLLMCall,
  type AdminOrder,
  type AdminOverview,
  type AdminProviderStatus,
  type AdminUserDetail,
  type AdminUserSummary,
  type AuthPayload,
} from './shared/api/client'

type AdminSection = 'overview' | 'users' | 'usage' | 'orders' | 'providers' | 'agent-runs' | 'audit'

const navItems: Array<{ id: AdminSection; label: string; icon: typeof BarChart3 }> = [
  { id: 'overview', label: '概览', icon: BarChart3 },
  { id: 'users', label: '用户', icon: Users },
  { id: 'usage', label: '用量', icon: MessageSquareText },
  { id: 'orders', label: '订单', icon: ReceiptText },
  { id: 'providers', label: '模型', icon: Settings },
  { id: 'agent-runs', label: 'Agent', icon: Bot },
  { id: 'audit', label: '审计', icon: ClipboardList },
]

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

  return (
    <TooltipProvider>
      {!authChecked ? (
        <LoadingScreen />
      ) : !auth ? (
        <AuthScreen api={api} onAuthed={handleLogin} />
      ) : auth.user.role !== 'admin' ? (
        <AccessDeniedScreen auth={auth} onLogout={logout} />
      ) : (
        <AdminDashboard api={api} auth={auth} onLogout={logout} />
      )}
    </TooltipProvider>
  )
}

function LoadingScreen() {
  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/40 p-6">
      <Card className="w-full max-w-sm">
        <CardContent className="flex items-center gap-3 pt-6 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          正在检查登录状态...
        </CardContent>
      </Card>
    </main>
  )
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
    <main className="flex min-h-svh items-center justify-center bg-muted/40 p-6">
      <Card className="w-full max-w-md shadow-sm">
        <CardHeader className="space-y-4">
          <BrandBlock subtitle="运营、用户、额度和模型状态" />
          <div>
            <CardTitle>管理员登录</CardTitle>
            <CardDescription>使用配置在 ADMIN_EMAILS 中的账号进入独立后台。</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault()
              void login()
            }}
          >
            <div className="grid gap-2">
              <Label htmlFor="admin-name">名称</Label>
              <Input id="admin-name" value={name} autoComplete="name" onChange={(event) => setName(event.target.value)} placeholder="首次创建管理员时填写" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="admin-email">邮箱</Label>
              <Input id="admin-email" value={email} type="email" autoComplete="email" onChange={(event) => setEmail(event.target.value)} placeholder="admin@example.com" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="admin-password">密码</Label>
              <Input id="admin-password" value={password} type="password" autoComplete="current-password" onChange={(event) => setPassword(event.target.value)} placeholder="至少 8 位" />
            </div>
            {error ? (
              <Alert variant="destructive">
                <ShieldAlert className="size-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button className="flex-1" type="submit">
                登录
              </Button>
              <Button className="flex-1" type="button" variant="outline" onClick={() => void register()}>
                创建账号
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </main>
  )
}

function AccessDeniedScreen({ auth, onLogout }: { auth: AuthPayload; onLogout: () => Promise<void> }) {
  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/40 p-6">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-4">
          <BrandBlock subtitle={auth.user.email} />
          <div>
            <CardTitle>无管理员权限</CardTitle>
            <CardDescription>当前账号不是管理员。请使用配置在 ADMIN_EMAILS 中的账号登录。</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <Button variant="outline" onClick={() => void onLogout()}>
            <LogOut className="size-4" />
            退出登录
          </Button>
        </CardContent>
      </Card>
    </main>
  )
}

function AdminDashboard({ api, auth, onLogout }: { api: AdminAPI; auth: AuthPayload; onLogout: () => Promise<void> }) {
  const [overview, setOverview] = useState<AdminOverview | null>(null)
  const [users, setUsers] = useState<AdminUserSummary[]>([])
  const [calls, setCalls] = useState<AdminLLMCall[]>([])
  const [orders, setOrders] = useState<AdminOrder[]>([])
  const [providers, setProviders] = useState<AdminProviderStatus[]>([])
  const [agentRuns, setAgentRuns] = useState<AdminAgentRun[]>([])
  const [auditLogs, setAuditLogs] = useState<AdminAuditLog[]>([])
  const [selectedUser, setSelectedUser] = useState<AdminUserDetail | null>(null)
  const [query, setQuery] = useState('')
  const [delta, setDelta] = useState('')
  const [reason, setReason] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(false)
  const [activeSection, setActiveSection] = useState<AdminSection>('overview')

  useEffect(() => {
    void loadAdminData()
  }, [])

  async function loadAdminData(nextQuery = query, announce = false) {
    setLoading(true)
    try {
      const [overviewData, userData, callData, orderData, providerData, agentRunData, auditData] = await Promise.all([
        api.adminOverview(),
        api.adminUsers(nextQuery),
        api.adminLLMCalls(),
        api.adminOrders(),
        api.adminProviders(),
        api.adminAgentRuns(),
        api.adminAuditLogs(),
      ])
      setOverview(overviewData)
      setUsers(userData)
      setCalls(callData)
      setOrders(orderData)
      setProviders(providerData)
      setAgentRuns(agentRunData)
      setAuditLogs(auditData)

      const currentUserId = selectedUser?.user.id
      const detailUserId = currentUserId && userData.some((item) => item.user.id === currentUserId) ? currentUserId : userData[0]?.user.id
      setSelectedUser(detailUserId ? await api.adminUserDetail(detailUserId) : null)
      if (announce) {
        setNotice('数据已刷新')
      }
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : '加载后台数据失败')
    } finally {
      setLoading(false)
    }
  }

  async function searchUsers() {
    setNotice('')
    await loadAdminData(query)
  }

  async function refreshAdminData() {
    setNotice('')
    await loadAdminData(query, true)
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
    try {
      await api.adminUpdateUserStatus(selectedUser.user.id, status, reason.trim())
      setReason('')
      setSelectedUser(await api.adminUserDetail(selectedUser.user.id))
      await loadAdminData()
      setNotice('用户状态已更新')
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : '用户状态更新失败')
    }
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
    try {
      await api.adminAdjustCredits(selectedUser.user.id, parsedDelta, reason.trim())
      setDelta('')
      setReason('')
      setSelectedUser(await api.adminUserDetail(selectedUser.user.id))
      await loadAdminData()
      setNotice('额外额度已调整')
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : '额度调整失败')
    }
  }

  function switchSection(value: string) {
    if (isAdminSection(value)) {
      setActiveSection(value)
      setNotice('')
    }
  }

  return (
    <SidebarProvider>
      <Sidebar variant="inset" collapsible="icon">
        <SidebarHeader>
          <BrandBlock compact subtitle={auth.user.email} />
        </SidebarHeader>
        <SidebarSeparator />
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>管理后台</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {navItems.map((item) => (
                  <SidebarMenuItem key={item.id}>
                    <SidebarMenuButton isActive={activeSection === item.id} tooltip={item.label} onClick={() => switchSection(item.id)}>
                      <item.icon />
                      <span>{item.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <Button variant="ghost" className="justify-start" onClick={() => void onLogout()}>
            <LogOut className="size-4" />
            退出登录
          </Button>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>

      <SidebarInset>
        <header className="sticky top-0 z-10 flex min-h-16 items-center justify-between gap-3 border-b bg-background/95 px-4 backdrop-blur md:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <SidebarTrigger />
            <Separator orientation="vertical" className="h-5" />
            <div className="min-w-0">
              <h1 className="truncate text-lg font-semibold tracking-normal">管理后台</h1>
              <p className="truncate text-sm text-muted-foreground">用户、额度、订单和模型状态的独立管理面板</p>
            </div>
          </div>
          <Button variant="outline" onClick={() => void refreshAdminData()} disabled={loading}>
            {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCcw className="size-4" />}
            刷新数据
          </Button>
        </header>

        <main className="flex flex-1 flex-col p-4 md:p-6">
          <Tabs value={activeSection} onValueChange={switchSection} className="flex flex-1 flex-col gap-4 md:gap-6">
            <div className="overflow-x-auto">
              <TabsList variant="line" className="min-w-max justify-start">
                {navItems.map((item) => (
                  <TabsTrigger key={item.id} value={item.id}>
                    <item.icon />
                    {item.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </div>

            {notice ? (
              <Alert>
                <ShieldCheck className="size-4" />
                <AlertDescription>{notice}</AlertDescription>
              </Alert>
            ) : null}

            <TabsContent value="overview" className="mt-0 flex flex-col gap-4">
              <section id="overview" className="grid gap-3">
                <div>
                  <h2 className="text-base font-semibold tracking-normal">运营概览</h2>
                  <p className="text-sm text-muted-foreground">关键指标来自后端 admin 聚合接口。</p>
                </div>
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                  <MetricCard icon={<Users className="size-4" />} label="总用户" value={overview?.users_total ?? 0} helper={`活跃 ${overview?.active_users ?? 0} / 禁用 ${overview?.disabled_users ?? 0}`} />
                  <MetricCard icon={<MessageSquareText className="size-4" />} label="总调用" value={overview?.llm_calls_total ?? 0} helper={`失败 ${overview?.llm_calls_failed ?? 0}`} />
                  <MetricCard icon={<Coins className="size-4" />} label="额度消耗" value={overview?.credits_cost_total ?? 0} helper="credits cost total" />
                  <MetricCard icon={<ReceiptText className="size-4" />} label="订单" value={overview?.orders_total ?? 0} helper="只读订单视图" />
                </div>
              </section>
            </TabsContent>

            <TabsContent value="users" className="mt-0">
              <section className="grid gap-4 xl:grid-cols-[minmax(300px,0.9fr)_minmax(0,1.4fr)]">
                <UsersCard users={users} query={query} selectedUserId={selectedUser?.user.id} onQueryChange={setQuery} onSearch={searchUsers} onOpenUser={openUser} />
                <UserDetailCard selectedUser={selectedUser} delta={delta} reason={reason} onDeltaChange={setDelta} onReasonChange={setReason} onAdjustCredits={adjustCredits} onUpdateStatus={updateStatus} />
              </section>
            </TabsContent>

            <TabsContent value="usage" className="mt-0">
              <UsageCard calls={calls} />
            </TabsContent>

            <TabsContent value="orders" className="mt-0">
              <OrdersCard orders={orders} />
            </TabsContent>

            <TabsContent value="providers" className="mt-0">
              <ProvidersCard providers={providers} />
            </TabsContent>

            <TabsContent value="agent-runs" className="mt-0">
              <AgentRunsCard runs={agentRuns} />
            </TabsContent>

            <TabsContent value="audit" className="mt-0">
              <AuditCard logs={auditLogs} />
            </TabsContent>
          </Tabs>
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}

function isAdminSection(value: string): value is AdminSection {
  return navItems.some((item) => item.id === value)
}

function BrandBlock({ subtitle, compact = false }: { subtitle: string; compact?: boolean }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <Avatar className={compact ? 'size-9 rounded-lg' : 'size-10 rounded-lg'}>
        <AvatarFallback className="rounded-lg bg-primary text-primary-foreground">简</AvatarFallback>
      </Avatar>
      <div className="min-w-0 group-data-[collapsible=icon]:hidden">
        <div className="truncate text-sm font-semibold">Jiandanly Admin</div>
        <div className="truncate text-xs text-muted-foreground">{subtitle}</div>
      </div>
    </div>
  )
}

function MetricCard({ icon, label, value, helper }: { icon: ReactNode; label: string; value: number; helper: string }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardDescription>{label}</CardDescription>
        <div className="text-muted-foreground">{icon}</div>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold tabular-nums">{formatNumber(value)}</div>
        <p className="mt-1 text-xs text-muted-foreground">{helper}</p>
      </CardContent>
    </Card>
  )
}

function UsersCard({
  users,
  query,
  selectedUserId,
  onQueryChange,
  onSearch,
  onOpenUser,
}: {
  users: AdminUserSummary[]
  query: string
  selectedUserId?: string
  onQueryChange: (value: string) => void
  onSearch: () => Promise<void>
  onOpenUser: (userId: string) => Promise<void>
}) {
  return (
    <Card id="users" className="min-w-0">
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle>用户</CardTitle>
            <CardDescription>搜索并查看用户、钱包和最近活动。</CardDescription>
          </div>
          <Badge variant="secondary">{users.length}</Badge>
        </div>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="flex gap-2">
          <Input value={query} placeholder="搜索邮箱或名称" onChange={(event) => onQueryChange(event.target.value)} />
          <Button variant="outline" size="icon" onClick={() => void onSearch()} aria-label="搜索用户">
            <Search className="size-4" />
          </Button>
        </div>
        <div className="grid gap-2">
          {users.length ? (
            users.map((item) => (
              <Button
                key={item.user.id}
                variant={item.user.id === selectedUserId ? 'secondary' : 'outline'}
                className="h-auto justify-start px-3 py-3 text-left"
                onClick={() => void onOpenUser(item.user.id)}
              >
                <div className="grid min-w-0 gap-1">
                  <span className="truncate font-medium">{item.user.email}</span>
                  <span className="text-xs text-muted-foreground">
                    {item.user.status} · 调用 {item.calls_count} · 额度 {formatNumber(item.credits_cost)}
                  </span>
                </div>
              </Button>
            ))
          ) : (
            <EmptyState icon={<Users className="size-4" />} label="暂无用户" />
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function UserDetailCard({
  selectedUser,
  delta,
  reason,
  onDeltaChange,
  onReasonChange,
  onAdjustCredits,
  onUpdateStatus,
}: {
  selectedUser: AdminUserDetail | null
  delta: string
  reason: string
  onDeltaChange: (value: string) => void
  onReasonChange: (value: string) => void
  onAdjustCredits: () => Promise<void>
  onUpdateStatus: (status: 'active' | 'disabled') => Promise<void>
}) {
  const nextStatus = selectedUser?.user.status === 'disabled' ? 'active' : 'disabled'

  return (
    <Card className="min-w-0">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>用户详情</CardTitle>
            <CardDescription>安全写操作必须填写原因，并由后端写入审计日志。</CardDescription>
          </div>
          <StatusBadge status={selectedUser?.user.status ?? 'none'} />
        </div>
      </CardHeader>
      <CardContent className="grid gap-5">
        {selectedUser ? (
          <>
            <div className="grid gap-3 md:grid-cols-4">
              <DetailItem label="邮箱" value={selectedUser.user.email} />
              <DetailItem label="角色" value={selectedUser.user.role} />
              <DetailItem label="本月剩余" value={formatNumber(selectedUser.wallet?.monthly_remaining ?? 0)} />
              <DetailItem label="额外额度" value={formatNumber(selectedUser.wallet?.extra_credits_balance ?? 0)} />
            </div>
            <div className="grid gap-3 rounded-lg border bg-muted/30 p-3 lg:grid-cols-[minmax(180px,1fr)_minmax(200px,1fr)_auto_auto]">
              <div className="grid gap-2">
                <Label htmlFor="admin-reason">操作原因</Label>
                <Input id="admin-reason" value={reason} placeholder="操作原因" onChange={(event) => onReasonChange(event.target.value)} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="admin-credit-delta">额外额度调整</Label>
                <Input id="admin-credit-delta" value={delta} placeholder="额外额度调整，例如 1000 或 -500" onChange={(event) => onDeltaChange(event.target.value)} />
              </div>
              <div className="flex items-end">
                <Button className="w-full lg:w-auto" onClick={() => void onAdjustCredits()}>
                  <Coins className="size-4" />
                  调整额度
                </Button>
              </div>
              <div className="flex items-end">
                <Button className="w-full lg:w-auto" variant={nextStatus === 'disabled' ? 'destructive' : 'secondary'} onClick={() => void onUpdateStatus(nextStatus)}>
                  {nextStatus === 'disabled' ? <Ban className="size-4" /> : <UserCheck className="size-4" />}
                  {nextStatus === 'disabled' ? '禁用用户' : '启用用户'}
                </Button>
              </div>
            </div>
            <div className="grid gap-4 lg:grid-cols-3">
              <ActivityList title="最近账本" items={selectedUser.transactions.slice(0, 4).map((tx) => `${tx.type} ${tx.amount} · 余额 ${tx.extra_balance_after}`)} />
              <ActivityList title="最近调用" items={selectedUser.calls.slice(0, 4).map((call) => `${call.provider}/${call.model} · ${call.status} · ${call.credits_cost}`)} />
              <ActivityList title="最近订单" items={selectedUser.orders.slice(0, 4).map((order) => `${order.id} · ${formatCurrency(order.amount_cny)} · ${order.status}`)} />
            </div>
          </>
        ) : (
          <EmptyState icon={<Database className="size-4" />} label="选择一个用户查看详情" />
        )}
      </CardContent>
    </Card>
  )
}

function UsageCard({ calls }: { calls: AdminLLMCall[] }) {
  return (
    <Card id="usage" className="min-w-0">
      <CardHeader>
        <CardTitle>调用记录</CardTitle>
        <CardDescription>全局 LLM 调用、状态和额度消耗。</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>用户</TableHead>
              <TableHead>模型</TableHead>
              <TableHead>状态</TableHead>
              <TableHead className="text-right">额度</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {calls.length ? (
              calls.slice(0, 8).map((call) => (
                <TableRow key={call.request_id}>
                  <TableCell className="max-w-36 truncate">{call.user_email ?? call.user_id}</TableCell>
                  <TableCell className="max-w-40 truncate">{call.provider}/{call.model}</TableCell>
                  <TableCell><StatusBadge status={call.status} /></TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(call.credits_cost)}</TableCell>
                </TableRow>
              ))
            ) : (
              <EmptyTableRow columns={4} label="暂无调用记录" />
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

function OrdersCard({ orders }: { orders: AdminOrder[] }) {
  return (
    <Card id="orders" className="min-w-0">
      <CardHeader>
        <CardTitle>订单</CardTitle>
        <CardDescription>订单只读展示，不提供手工改状态入口。</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>订单</TableHead>
              <TableHead>用户</TableHead>
              <TableHead>金额</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>订阅</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {orders.length ? (
              orders.slice(0, 8).map((order) => (
                <TableRow key={order.id}>
                  <TableCell className="max-w-32 truncate">{order.id}</TableCell>
                  <TableCell className="max-w-36 truncate">{order.user_email ?? order.user_id ?? 'unknown'}</TableCell>
                  <TableCell>{formatCurrency(order.amount_cny)}</TableCell>
                  <TableCell><StatusBadge status={order.status} /></TableCell>
                  <TableCell className="max-w-40 truncate">{order.stripe_subscription_id || '-'}</TableCell>
                </TableRow>
              ))
            ) : (
              <EmptyTableRow columns={5} label="暂无订单" />
            )}
          </TableBody>
        </Table>
        {orders[0] ? <p className="mt-3 truncate text-xs text-muted-foreground">Stripe session: {orders[0].stripe_checkout_session_id || 'mock'} · 钱包 {orders[0].wallet_status || '-'} · {formatDateTime(orders[0].created_at)}</p> : null}
      </CardContent>
    </Card>
  )
}

function AuditCard({ logs }: { logs: AdminAuditLog[] }) {
  return (
    <Card id="audit" className="min-w-0">
      <CardHeader>
        <CardTitle>审计</CardTitle>
        <CardDescription>只读展示后台操作和关键账务事件。</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>动作</TableHead>
              <TableHead>对象</TableHead>
              <TableHead>操作者</TableHead>
              <TableHead>时间</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {logs.length ? (
              logs.slice(0, 10).map((log) => (
                <TableRow key={log.id}>
                  <TableCell>
                    <div className="font-medium">{log.action}</div>
                    <div className="max-w-72 truncate text-xs text-muted-foreground">{formatMetadata(log.metadata)}</div>
                  </TableCell>
                  <TableCell className="max-w-40 truncate">{log.target_type || '-'} · {log.target_id || '-'}</TableCell>
                  <TableCell className="max-w-32 truncate">{log.actor_user_id || 'system'}</TableCell>
                  <TableCell className="whitespace-nowrap">{formatDateTime(log.created_at)}</TableCell>
                </TableRow>
              ))
            ) : (
              <EmptyTableRow columns={4} label="暂无审计记录" />
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

function ProvidersCard({ providers }: { providers: AdminProviderStatus[] }) {
  return (
    <Card id="providers" className="min-w-0">
      <CardHeader>
        <CardTitle>模型</CardTitle>
        <CardDescription>只读展示 provider 状态，不暴露 API key 原文。</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>模式</TableHead>
              <TableHead>Provider / Model</TableHead>
              <TableHead>状态</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {providers.length ? (
              providers.map((provider) => (
                <TableRow key={`${provider.mode}-${provider.provider}`}>
                  <TableCell>{provider.mode}</TableCell>
                  <TableCell className="max-w-44">
                    <div className="truncate font-medium">{provider.provider}</div>
                    <div className="truncate text-xs text-muted-foreground">{provider.kind || 'unknown'} · {provider.model} · {provider.base_url || 'default'}</div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      <Badge variant={provider.mock ? 'secondary' : 'default'}>{provider.mock ? 'mock' : 'real'}</Badge>
                      <Badge variant={provider.api_key_configured ? 'secondary' : 'outline'}>
                        <KeyRound className="size-3" />
                        {provider.api_key_configured ? 'key 已配置' : 'key 未配置'}
                      </Badge>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <EmptyTableRow columns={3} label="暂无模型配置" />
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

function AgentRunsCard({ runs }: { runs: AdminAgentRun[] }) {
  return (
    <Card id="agent-runs" className="min-w-0">
      <CardHeader>
        <CardTitle>Agent Runs</CardTitle>
        <CardDescription>只读观察云端兼容 run 的状态、用户、模式和摘要，不展示完整用户输入。</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Run</TableHead>
              <TableHead>用户</TableHead>
              <TableHead>摘要</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>更新时间</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.length ? (
              runs.slice(0, 10).map((run) => (
                <TableRow key={run.id}>
                  <TableCell>
                    <div className="max-w-32 truncate font-medium">{run.id}</div>
                    <div className="text-xs text-muted-foreground">{run.origin} · {run.mode}</div>
                  </TableCell>
                  <TableCell className="max-w-36 truncate">{run.user_email || run.user_id}</TableCell>
                  <TableCell className="max-w-72 truncate">
                    <div>{run.goal_summary || '用户任务'}</div>
                    <div className="text-xs text-muted-foreground">附件 {run.attachments?.length ?? 0} · 过期 {formatDateTime(run.expires_at)}</div>
                  </TableCell>
                  <TableCell><StatusBadge status={run.status} /></TableCell>
                  <TableCell className="whitespace-nowrap">{formatDateTime(run.updated_at)}</TableCell>
                </TableRow>
              ))
            ) : (
              <EmptyTableRow columns={5} label="暂无 Agent Runs" />
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

function DetailItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-background p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 truncate text-sm font-medium">{value}</div>
    </div>
  )
}

function ActivityList({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="rounded-lg border bg-background p-3">
      <div className="mb-3 text-sm font-medium">{title}</div>
      <div className="grid gap-2">
        {items.length ? items.map((item, index) => <div className="truncate text-xs text-muted-foreground" key={`${item}-${index}`}>{item}</div>) : <div className="text-xs text-muted-foreground">暂无数据</div>}
      </div>
    </div>
  )
}

function EmptyState({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <div className="flex min-h-24 items-center justify-center gap-2 rounded-lg border border-dashed text-sm text-muted-foreground">
      {icon}
      {label}
    </div>
  )
}

function EmptyTableRow({ columns, label }: { columns: number; label: string }) {
  return (
    <TableRow>
      <TableCell colSpan={columns} className="h-24 text-center text-muted-foreground">
        {label}
      </TableCell>
    </TableRow>
  )
}

function StatusBadge({ status }: { status: string }) {
  const variant = status === 'disabled' || status === 'failed' || status === 'past_due' || status === 'canceled' || status === 'unpaid' ? 'destructive' : status === 'active' || status === 'paid' || status === 'succeeded' || status === 'success' ? 'default' : 'secondary'
  return <Badge variant={variant}>{status}</Badge>
}

function formatNumber(value: number) {
  return new Intl.NumberFormat('zh-CN').format(value)
}

function formatCurrency(amountCents: number) {
  return `¥${(amountCents / 100).toFixed(2)}`
}

function formatDateTime(value?: string) {
  if (!value) {
    return '-'
  }
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

function formatMetadata(value: string) {
  if (!value) {
    return ''
  }
  try {
    return JSON.stringify(JSON.parse(value))
  } catch {
    return value
  }
}
