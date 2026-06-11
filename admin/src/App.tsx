import {
  BarChart3,
  Ban,
  Bot,
  ClipboardList,
  Coins,
  KeyRound,
  Loader2,
  LogOut,
  MessageSquareText,
  Pencil,
  Plus,
  Power,
  ReceiptText,
  RefreshCcw,
  Search,
  Settings,
  Trash2,
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
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
import { Tabs, TabsContent } from '@/components/ui/tabs'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  AdminAPI,
  type AdminAgentRun,
  type AdminAgentRunTrace,
  type AdminAuditLog,
  type AdminBillingLevers,
  type AdminCreditRate,
  type AdminModelConfig,
  type AdminOrder,
  type AdminOverview,
  type AdminToolCall,
  type AdminUserDetail,
  type AdminUserSummary,
  type AuthPayload,
  type ModelConfigInput,
} from './shared/api/client'

type AdminSection = 'overview' | 'users' | 'tool-calls' | 'orders' | 'providers' | 'agent-runs' | 'audit'

const PAGE_SIZE = 20

const navItems: Array<{ id: AdminSection; label: string; icon: typeof BarChart3 }> = [
  { id: 'overview', label: '概览', icon: BarChart3 },
  { id: 'users', label: '用户', icon: Users },
  { id: 'tool-calls', label: '工具', icon: Search },
  { id: 'orders', label: '订单', icon: ReceiptText },
  { id: 'providers', label: '模型', icon: Settings },
  { id: 'agent-runs', label: 'Agent', icon: Bot },
  { id: 'audit', label: '审计', icon: ClipboardList },
]

export function App() {
  const api = useMemo(() => new AdminAPI(), [])
  const [auth, setAuth] = useState<AuthPayload | null>(null)
  const [authChecked, setAuthChecked] = useState(false)

  // Silently renew an expired access token mid-session (15-min TTL) using
  // the refresh cookie, instead of bouncing to "登录已过期". A dead refresh
  // token drops to login.
  useEffect(() => {
    api.setTokenRefresher(async () => {
      try {
        const payload = await api.refresh()
        api.setAccessToken(payload.access_token)
        return payload.access_token
      } catch {
        setAuth(null)
        return null
      }
    })
  }, [api])

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
  const [page, setPage] = useState(0)
  const [hasMoreUsers, setHasMoreUsers] = useState(false)
  const [toolCalls, setToolCalls] = useState<AdminToolCall[]>([])
  const [toolPage, setToolPage] = useState(0)
  const [hasMoreTool, setHasMoreTool] = useState(false)
  const [orders, setOrders] = useState<AdminOrder[]>([])
  const [orderPage, setOrderPage] = useState(0)
  const [hasMoreOrders, setHasMoreOrders] = useState(false)
  const [modelConfigs, setModelConfigs] = useState<AdminModelConfig[]>([])
  const [creditRate, setCreditRate] = useState<AdminCreditRate | null>(null)
  const [billingLevers, setBillingLevers] = useState<AdminBillingLevers | null>(null)
  const [agentRuns, setAgentRuns] = useState<AdminAgentRun[]>([])
  const [auditLogs, setAuditLogs] = useState<AdminAuditLog[]>([])
  const [auditPage, setAuditPage] = useState(0)
  const [hasMoreAudit, setHasMoreAudit] = useState(false)
  const [selectedUser, setSelectedUser] = useState<AdminUserDetail | null>(null)
  const [agentTrace, setAgentTrace] = useState<AdminAgentRunTrace | null>(null)
  const [traceLoadingId, setTraceLoadingId] = useState('')
  const [query, setQuery] = useState('')
  const [delta, setDelta] = useState('')
  const [reason, setReason] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(false)
  const [activeSection, setActiveSection] = useState<AdminSection>('overview')

  useEffect(() => {
    void loadAdminData()
  }, [])

  // List loading is independent of the open detail dialog so refreshing the
  // list (search / page / post-write) never closes the dialog.
  async function loadUsersPage(nextQuery: string, nextPage: number) {
    const userData = await api.adminUsers(nextQuery, PAGE_SIZE, nextPage * PAGE_SIZE)
    setUsers(userData)
    setPage(nextPage)
    setHasMoreUsers(userData.length === PAGE_SIZE)
  }

  async function loadToolCallsPage(nextPage: number) {
    const data = await api.adminToolCalls(PAGE_SIZE, nextPage * PAGE_SIZE)
    setToolCalls(data)
    setToolPage(nextPage)
    setHasMoreTool(data.length === PAGE_SIZE)
  }

  async function loadOrdersPage(nextPage: number) {
    const data = await api.adminOrders(PAGE_SIZE, nextPage * PAGE_SIZE)
    setOrders(data)
    setOrderPage(nextPage)
    setHasMoreOrders(data.length === PAGE_SIZE)
  }

  async function loadAuditPage(nextPage: number) {
    const data = await api.adminAuditLogs(PAGE_SIZE, nextPage * PAGE_SIZE)
    setAuditLogs(data)
    setAuditPage(nextPage)
    setHasMoreAudit(data.length === PAGE_SIZE)
  }

  async function reloadModelConfigs() {
    const [configs, rate, levers] = await Promise.all([
      api.adminModelConfigs(),
      api.adminCreditRate(),
      api.adminBillingLevers(),
    ])
    setModelConfigs(configs)
    setCreditRate(rate)
    setBillingLevers(levers)
  }

  async function loadAdminData(nextQuery = query, announce = false) {
    setLoading(true)
    try {
      const [overviewData, modelConfigData, creditRateData, billingLeversData, agentRunData] = await Promise.all([
        api.adminOverview(),
        api.adminModelConfigs(),
        api.adminCreditRate(),
        api.adminBillingLevers(),
        api.adminAgentRuns(),
      ])
      setOverview(overviewData)
      setModelConfigs(modelConfigData)
      setCreditRate(creditRateData)
      setBillingLevers(billingLeversData)
      setAgentRuns(agentRunData)
      await Promise.all([
        loadUsersPage(nextQuery, 0),
        loadToolCallsPage(0),
        loadOrdersPage(0),
        loadAuditPage(0),
      ])
      if (announce) {
        setNotice('数据已刷新')
      }
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : '加载后台数据失败')
    } finally {
      setLoading(false)
    }
  }

  async function changeToolCallsPage(nextPage: number) {
    if (nextPage < 0) {
      return
    }
    setNotice('')
    try {
      await loadToolCallsPage(nextPage)
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : '加载工具调用失败')
    }
  }

  async function changeOrdersPage(nextPage: number) {
    if (nextPage < 0) {
      return
    }
    setNotice('')
    try {
      await loadOrdersPage(nextPage)
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : '加载订单失败')
    }
  }

  async function changeAuditPage(nextPage: number) {
    if (nextPage < 0) {
      return
    }
    setNotice('')
    try {
      await loadAuditPage(nextPage)
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : '加载审计日志失败')
    }
  }

  async function searchUsers() {
    setNotice('')
    try {
      await loadUsersPage(query, 0)
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : '加载用户失败')
    }
  }

  async function changeUsersPage(nextPage: number) {
    if (nextPage < 0) {
      return
    }
    setNotice('')
    try {
      await loadUsersPage(query, nextPage)
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : '加载用户失败')
    }
  }

  async function refreshAdminData() {
    setNotice('')
    await loadAdminData(query, true)
  }

  // Click a user row to open its detail dialog.
  async function openUser(userId: string) {
    setNotice('')
    try {
      setSelectedUser(await api.adminUserDetail(userId))
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : '加载用户详情失败')
    }
  }

  function closeUser() {
    setSelectedUser(null)
  }

  async function openAgentTrace(runId: string) {
    setNotice('')
    setTraceLoadingId(runId)
    try {
      setAgentTrace(await api.adminAgentRunTrace(runId))
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : '加载 Run Trace 失败')
    } finally {
      setTraceLoadingId('')
    }
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
          <div className="flex items-center justify-between gap-2">
            <BrandBlock compact subtitle={auth.user.email} />
            <SidebarTrigger className="size-7 shrink-0 text-muted-foreground" />
          </div>
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
            {notice ? (
              <div
                className="fixed left-1/2 top-4 z-[100] w-[min(92vw,520px)] -translate-x-1/2 cursor-pointer"
                role="status"
                onClick={() => setNotice('')}
                title="点击关闭"
              >
                <Alert className="border-border bg-background shadow-lg">
                  <ShieldCheck className="size-4" />
                  <AlertDescription>{notice}</AlertDescription>
                </Alert>
              </div>
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
              <UsersPanel
                users={users}
                query={query}
                page={page}
                hasMore={hasMoreUsers}
                selectedUser={selectedUser}
                delta={delta}
                reason={reason}
                onQueryChange={setQuery}
                onSearch={searchUsers}
                onChangePage={changeUsersPage}
                onOpenUser={openUser}
                onCloseUser={closeUser}
                onDeltaChange={setDelta}
                onReasonChange={setReason}
                onAdjustCredits={adjustCredits}
                onUpdateStatus={updateStatus}
              />
            </TabsContent>

            <TabsContent value="tool-calls" className="mt-0">
              <ToolCallsCard calls={toolCalls} page={toolPage} hasMore={hasMoreTool} onChangePage={changeToolCallsPage} />
            </TabsContent>

            <TabsContent value="orders" className="mt-0">
              <OrdersCard orders={orders} page={orderPage} hasMore={hasMoreOrders} onChangePage={changeOrdersPage} />
            </TabsContent>

            <TabsContent value="providers" className="mt-0">
              <ModelConfigCard
                configs={modelConfigs}
                creditRate={creditRate}
                billingLevers={billingLevers}
                api={api}
                onReload={reloadModelConfigs}
                onNotice={setNotice}
              />
            </TabsContent>

            <TabsContent value="agent-runs" className="mt-0">
              <AgentRunsCard runs={agentRuns} traceLoadingId={traceLoadingId} onOpenTrace={openAgentTrace} />
            </TabsContent>

            <TabsContent value="audit" className="mt-0">
              <AuditCard logs={auditLogs} page={auditPage} hasMore={hasMoreAudit} onChangePage={changeAuditPage} />
            </TabsContent>
          </Tabs>
          <AgentTraceDialog trace={agentTrace} onClose={() => setAgentTrace(null)} />
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
        <div className="truncate text-sm font-semibold">SheJane Admin</div>
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

function UsersPanel({
  users,
  query,
  page,
  hasMore,
  selectedUser,
  delta,
  reason,
  onQueryChange,
  onSearch,
  onChangePage,
  onOpenUser,
  onCloseUser,
  onDeltaChange,
  onReasonChange,
  onAdjustCredits,
  onUpdateStatus,
}: {
  users: AdminUserSummary[]
  query: string
  page: number
  hasMore: boolean
  selectedUser: AdminUserDetail | null
  delta: string
  reason: string
  onQueryChange: (value: string) => void
  onSearch: () => Promise<void>
  onChangePage: (nextPage: number) => Promise<void>
  onOpenUser: (userId: string) => Promise<void>
  onCloseUser: () => void
  onDeltaChange: (value: string) => void
  onReasonChange: (value: string) => void
  onAdjustCredits: () => Promise<void>
  onUpdateStatus: (status: 'active' | 'disabled') => Promise<void>
}) {
  return (
    <Card id="users" className="min-w-0">
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle>用户</CardTitle>
            <CardDescription>搜索用户，点击任一行查看信息、钱包与用量。</CardDescription>
          </div>
          <Badge variant="secondary">第 {page + 1} 页</Badge>
        </div>
      </CardHeader>
      <CardContent className="grid gap-4">
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            void onSearch()
          }}
        >
          <Input value={query} placeholder="搜索邮箱或名称" onChange={(event) => onQueryChange(event.target.value)} />
          <Button type="submit" variant="outline" size="icon" aria-label="搜索用户">
            <Search className="size-4" />
          </Button>
        </form>

        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>邮箱</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="text-right">调用</TableHead>
                <TableHead className="text-right">额度消耗</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.length ? (
                users.map((item) => (
                  <TableRow
                    key={item.user.id}
                    role="button"
                    tabIndex={0}
                    aria-label={item.user.email}
                    className="cursor-pointer"
                    onClick={() => void onOpenUser(item.user.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        void onOpenUser(item.user.id)
                      }
                    }}
                  >
                    <TableCell className="max-w-60 truncate font-medium">{item.user.email}</TableCell>
                    <TableCell><StatusBadge status={item.user.status} /></TableCell>
                    <TableCell className="text-right tabular-nums">{item.calls_count}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(item.credits_cost)}</TableCell>
                  </TableRow>
                ))
              ) : (
                <EmptyTableRow columns={4} label="暂无用户" />
              )}
            </TableBody>
          </Table>
        </div>

        <Pagination page={page} hasMore={hasMore} onChangePage={onChangePage} />
      </CardContent>

      <Dialog open={Boolean(selectedUser)} onOpenChange={(open) => { if (!open) onCloseUser() }}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
          {selectedUser ? (
            <>
              <DialogHeader>
                <DialogTitle className="truncate">{selectedUser.user.email}</DialogTitle>
                <DialogDescription>用户信息、钱包、用量与管理操作（写操作需填原因并入审计）。</DialogDescription>
              </DialogHeader>
              <UserDetailBody
                selectedUser={selectedUser}
                delta={delta}
                reason={reason}
                onDeltaChange={onDeltaChange}
                onReasonChange={onReasonChange}
                onAdjustCredits={onAdjustCredits}
                onUpdateStatus={onUpdateStatus}
              />
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </Card>
  )
}

function UserDetailBody({
  selectedUser,
  delta,
  reason,
  onDeltaChange,
  onReasonChange,
  onAdjustCredits,
  onUpdateStatus,
}: {
  selectedUser: AdminUserDetail
  delta: string
  reason: string
  onDeltaChange: (value: string) => void
  onReasonChange: (value: string) => void
  onAdjustCredits: () => Promise<void>
  onUpdateStatus: (status: 'active' | 'disabled') => Promise<void>
}) {
  const nextStatus = selectedUser.user.status === 'disabled' ? 'active' : 'disabled'
  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">用户详情</span>
        <StatusBadge status={selectedUser.user.status ?? 'none'} />
      </div>
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
      <div className="grid gap-2">
        <span className="text-sm font-medium">用量（最近调用）</span>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>模型</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>Run</TableHead>
              <TableHead>时间</TableHead>
              <TableHead className="text-right">额度</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {selectedUser.calls.length ? (
              selectedUser.calls.slice(0, 20).map((call) => (
                <TableRow key={call.request_id}>
                  <TableCell className="max-w-40 truncate">{call.provider}/{call.model}</TableCell>
                  <TableCell><StatusBadge status={call.status} /></TableCell>
                  <TableCell className="max-w-36 truncate text-muted-foreground">{call.run_id || '-'}</TableCell>
                  <TableCell className="max-w-40 truncate text-muted-foreground">{call.started_at ?? '-'}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(call.credits_cost)}</TableCell>
                </TableRow>
              ))
            ) : (
              <EmptyTableRow columns={5} label="暂无调用记录" />
            )}
          </TableBody>
        </Table>
      </div>
      <div className="grid gap-2">
        <span className="text-sm font-medium">工具 / 生图调用（最近）</span>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>工具</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>时间</TableHead>
              <TableHead className="text-right">次数</TableHead>
              <TableHead className="text-right">额度</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {selectedUser.tool_calls?.length ? (
              selectedUser.tool_calls.slice(0, 20).map((call) => (
                <TableRow key={call.request_id}>
                  <TableCell className="max-w-40 truncate">{call.tool}{call.provider ? ` · ${call.provider}` : ''}</TableCell>
                  <TableCell><StatusBadge status={call.status} /></TableCell>
                  <TableCell className="max-w-40 truncate text-muted-foreground">{call.started_at ?? '-'}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(call.units)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(call.credits_cost)}</TableCell>
                </TableRow>
              ))
            ) : (
              <EmptyTableRow columns={5} label="暂无工具/生图调用" />
            )}
          </TableBody>
        </Table>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <ActivityList title="最近账本" items={selectedUser.transactions.slice(0, 4).map((tx) => `${tx.type} ${tx.amount} · 余额 ${tx.extra_balance_after}`)} />
        <ActivityList title="最近订单" items={selectedUser.orders.slice(0, 4).map((order) => `${order.id} · ${formatCurrency(order.amount_cny)} · ${order.status}`)} />
      </div>
    </div>
  )
}


function Pagination({
  page,
  hasMore,
  onChangePage,
}: {
  page: number
  hasMore: boolean
  onChangePage: (nextPage: number) => Promise<void> | void
}) {
  return (
    <div className="flex items-center justify-between">
      <Button variant="outline" size="sm" disabled={page <= 0} onClick={() => void onChangePage(page - 1)}>
        上一页
      </Button>
      <span className="text-xs text-muted-foreground">第 {page + 1} 页 · 每页 {PAGE_SIZE} 条</span>
      <Button variant="outline" size="sm" disabled={!hasMore} onClick={() => void onChangePage(page + 1)}>
        下一页
      </Button>
    </div>
  )
}

function ToolCallsCard({
  calls,
  page,
  hasMore,
  onChangePage,
}: {
  calls: AdminToolCall[]
  page: number
  hasMore: boolean
  onChangePage: (nextPage: number) => Promise<void>
}) {
  return (
    <Card id="tool-calls" className="min-w-0">
      <CardHeader>
        <CardTitle>工具调用</CardTitle>
        <CardDescription>非 LLM 第三方服务调用记录，只读展示扣费、provider 和失败原因。</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>工具</TableHead>
              <TableHead>用户</TableHead>
              <TableHead>状态</TableHead>
              <TableHead className="text-right">额度</TableHead>
              <TableHead>Run</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {calls.length ? (
              calls.map((call) => (
                <TableRow key={call.request_id}>
                  <TableCell>
                    <div className="font-medium">{call.tool}</div>
                    <div className="text-xs text-muted-foreground">{call.provider} · {call.units || 0} unit</div>
                  </TableCell>
                  <TableCell className="max-w-36 truncate">{call.user_email ?? call.user_id}</TableCell>
                  <TableCell>
                    <StatusBadge status={call.status} />
                    {call.error_code ? <div className="mt-1 max-w-44 truncate text-xs text-muted-foreground">{call.error_code}</div> : null}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(call.credits_cost)}</TableCell>
                  <TableCell className="max-w-44 truncate">
                    <div>{call.run_id || '-'}</div>
                    <div className="text-xs text-muted-foreground">{formatDateTime(call.started_at)}</div>
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <EmptyTableRow columns={5} label="暂无工具调用记录" />
            )}
          </TableBody>
        </Table>
        <Pagination page={page} hasMore={hasMore} onChangePage={onChangePage} />
      </CardContent>
    </Card>
  )
}

function OrdersCard({
  orders,
  page,
  hasMore,
  onChangePage,
}: {
  orders: AdminOrder[]
  page: number
  hasMore: boolean
  onChangePage: (nextPage: number) => Promise<void>
}) {
  return (
    <Card id="orders" className="min-w-0">
      <CardHeader>
        <CardTitle>订单</CardTitle>
        <CardDescription>订单只读展示，不提供手工改状态入口。</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
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
              orders.map((order) => (
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
        {orders[0] ? <p className="truncate text-xs text-muted-foreground">Stripe session: {orders[0].stripe_checkout_session_id || 'mock'} · 钱包 {orders[0].wallet_status || '-'} · {formatDateTime(orders[0].created_at)}</p> : null}
        <Pagination page={page} hasMore={hasMore} onChangePage={onChangePage} />
      </CardContent>
    </Card>
  )
}

function AuditCard({
  logs,
  page,
  hasMore,
  onChangePage,
}: {
  logs: AdminAuditLog[]
  page: number
  hasMore: boolean
  onChangePage: (nextPage: number) => Promise<void>
}) {
  return (
    <Card id="audit" className="min-w-0">
      <CardHeader>
        <CardTitle>审计</CardTitle>
        <CardDescription>只读展示后台操作和关键账务事件。</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
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
              logs.map((log) => (
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
        <Pagination page={page} hasMore={hasMore} onChangePage={onChangePage} />
      </CardContent>
    </Card>
  )
}

const PROVIDER_KINDS = ['openai-compatible', 'deepseek-v4', 'anthropic', 'mock'] as const

const CAPABILITY_OPTIONS = [
  { value: 'chat', label: '对话 (chat)' },
  { value: 'image', label: '生图 (image)' },
] as const

const IMAGE_DEFAULT_MODEL_ID = 'image.default'

type ModelPreset = {
  id: string
  label: string
  helper: string
  patch: Partial<ModelConfigForm>
}

const MODEL_PRESETS: ModelPreset[] = [
  {
    id: 'deepseek-pro',
    label: 'DeepSeek Pro',
    helper: '基准 1x',
    patch: {
      capability: 'chat',
      slot: 'deepseek-pro',
      provider_kind: 'deepseek-v4',
      display_name: 'DeepSeek Pro',
      description: '基准模型,适合复杂分析和多步任务',
      base_url: 'https://api.deepseek.com',
      model_name: 'deepseek-v4-pro',
      credit_multiplier: '1',
      input_credit_multiplier: '1',
      output_credit_multiplier: '1',
      cache_write_credit_multiplier: '1',
    },
  },
  {
    id: 'deepseek-flash',
    label: 'DeepSeek Flash',
    helper: '轻量 0.1x',
    patch: {
      capability: 'chat',
      slot: 'deepseek-flash',
      provider_kind: 'deepseek-v4',
      display_name: 'DeepSeek Flash',
      description: '速度快、成本低,适合日常对话和简单任务',
      base_url: 'https://api.deepseek.com',
      model_name: 'deepseek-v4-flash',
      credit_multiplier: '0.1',
      input_credit_multiplier: '0.1',
      output_credit_multiplier: '0.1',
      cache_write_credit_multiplier: '0.1',
      priority: '100',
    },
  },
  {
    id: 'openai-compatible',
    label: 'OpenAI 兼容',
    helper: '通用网关',
    patch: {
      capability: 'chat',
      provider_kind: 'openai-compatible',
      base_url: 'https://api.openai.com/v1',
      model_name: '',
    },
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    helper: 'Claude 路由',
    patch: {
      capability: 'chat',
      provider_kind: 'anthropic',
      base_url: '',
      model_name: 'claude-sonnet-4-5',
    },
  },
]

const SELECT_CLASS =
  'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'

interface ModelConfigForm {
  slot: string
  capability: string
  provider_kind: string
  display_name: string
  description: string
  priority: string
  base_url: string
  model_name: string
  credit_multiplier: string
  input_credit_multiplier: string
  output_credit_multiplier: string
  cached_input_credit_multiplier: string
  cache_write_credit_multiplier: string
  price_per_call_cny: string
  enabled: boolean
  api_key: string
}

function emptyModelForm(): ModelConfigForm {
  return {
    slot: '',
    capability: 'chat',
    provider_kind: 'openai-compatible',
    display_name: '',
    description: '',
    priority: '0',
    base_url: '',
    model_name: '',
    credit_multiplier: '1',
    input_credit_multiplier: '1',
    output_credit_multiplier: '1',
    cached_input_credit_multiplier: '',
    cache_write_credit_multiplier: '1',
    price_per_call_cny: '0',
    enabled: true,
    api_key: '',
  }
}

function ModelConfigCard({
  configs,
  creditRate,
  billingLevers,
  api,
  onReload,
  onNotice,
}: {
  configs: AdminModelConfig[]
  creditRate: AdminCreditRate | null
  billingLevers: AdminBillingLevers | null
  api: AdminAPI
  onReload: () => Promise<void>
  onNotice: (message: string) => void
}) {
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<ModelConfigForm>(emptyModelForm())
  const [editingHasKey, setEditingHasKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [markupInput, setMarkupInput] = useState('1.15')
  const [rateInput, setRateInput] = useState('')
  const [rateCurrency, setRateCurrency] = useState('cny')
  const [rateSaving, setRateSaving] = useState(false)
  const [tavilyInput, setTavilyInput] = useState('')
  const [e2bBaseInput, setE2bBaseInput] = useState('')
  const [e2bPerSecInput, setE2bPerSecInput] = useState('')
  const [leversSaving, setLeversSaving] = useState(false)

  useEffect(() => {
    if (creditRate) {
      setMarkupInput(creditRate.markup_factor ? String(creditRate.markup_factor) : '1.15')
      setRateInput(creditRate.currency_per_credit ? String(creditRate.currency_per_credit) : '')
      setRateCurrency(creditRate.currency || 'cny')
    }
  }, [creditRate])

  useEffect(() => {
    if (billingLevers) {
      setTavilyInput(billingLevers.tavily_search_credits ? String(billingLevers.tavily_search_credits) : '')
      setE2bBaseInput(billingLevers.e2b_code_exec_base_credits ? String(billingLevers.e2b_code_exec_base_credits) : '')
      setE2bPerSecInput(
        billingLevers.e2b_code_exec_per_second_credits ? String(billingLevers.e2b_code_exec_per_second_credits) : '',
      )
    }
  }, [billingLevers])

  function openCreate() {
    setEditingId(null)
    setEditingHasKey(false)
    setForm(emptyModelForm())
    setDialogOpen(true)
  }

  function openEdit(cfg: AdminModelConfig) {
    setEditingId(cfg.id)
    setEditingHasKey(cfg.api_key_configured)
    setForm({
      slot: cfg.slot,
      capability: cfg.capability,
      provider_kind: cfg.provider_kind,
      display_name: cfg.display_name,
      description: cfg.description ?? '',
      priority: String(cfg.priority ?? 0),
      base_url: cfg.base_url,
      model_name: cfg.model_name,
      credit_multiplier: String(cfg.credit_multiplier),
      input_credit_multiplier: String(cfg.input_credit_multiplier || cfg.credit_multiplier || 1),
      output_credit_multiplier: String(cfg.output_credit_multiplier || cfg.credit_multiplier || 1),
      cached_input_credit_multiplier: cfg.cached_input_credit_multiplier ? String(cfg.cached_input_credit_multiplier) : '',
      cache_write_credit_multiplier: String(cfg.cache_write_credit_multiplier || cfg.input_credit_multiplier || cfg.credit_multiplier || 1),
      price_per_call_cny: String(cfg.price_per_call_cny ?? 0),
      enabled: cfg.enabled,
      api_key: '',
    })
    setDialogOpen(true)
  }

  function applyPreset(preset: ModelPreset) {
    setForm((current) => ({
      ...current,
      ...preset.patch,
      slot: preset.patch.capability === 'image'
        ? IMAGE_DEFAULT_MODEL_ID
        : preset.patch.slot ?? current.slot,
    }))
  }

  async function submitForm() {
    const multiplier = Number(form.credit_multiplier)
    const parseTokenMultiplier = (raw: string, label: string): number | null => {
      const trimmed = raw.trim()
      if (!trimmed) return 0
      const n = Number(trimmed)
      if (!Number.isFinite(n) || n < 0) {
        onNotice(`${label}必须是非负数字；留空或 0 表示沿用基础倍率`)
        return null
      }
      return n
    }
    const modelID = form.capability === 'image' ? IMAGE_DEFAULT_MODEL_ID : form.slot.trim()
    if (!modelID || !form.provider_kind.trim()) {
      onNotice('模型 ID 与 provider_kind 必填')
      return
    }
    if (!Number.isFinite(multiplier) || multiplier <= 0) {
      onNotice('基础倍率必须是大于 0 的数字')
      return
    }
    const inputMultiplier = parseTokenMultiplier(form.input_credit_multiplier, '输入 token 倍率')
    if (inputMultiplier === null) return
    const outputMultiplier = parseTokenMultiplier(form.output_credit_multiplier, '输出 token 倍率')
    if (outputMultiplier === null) return
    const cachedInputMultiplier = parseTokenMultiplier(form.cached_input_credit_multiplier, '缓存命中 token 倍率')
    if (cachedInputMultiplier === null) return
    const cacheWriteMultiplier = parseTokenMultiplier(form.cache_write_credit_multiplier, '缓存写入 token 倍率')
    if (cacheWriteMultiplier === null) return
    const payload: ModelConfigInput = {
      slot: modelID,
      capability: form.capability.trim() || 'chat',
      provider_kind: form.provider_kind,
      display_name: form.display_name.trim(),
      description: form.description.trim(),
      priority: Math.trunc(Number(form.priority)) || 0,
      base_url: form.base_url.trim(),
      model_name: form.model_name.trim(),
      credit_multiplier: multiplier,
      input_credit_multiplier: inputMultiplier,
      output_credit_multiplier: outputMultiplier,
      cached_input_credit_multiplier: cachedInputMultiplier,
      cache_write_credit_multiplier: cacheWriteMultiplier,
      price_per_call_cny: Number(form.price_per_call_cny) || 0,
      enabled: form.enabled,
    }
    if (form.api_key.trim()) {
      payload.api_key = form.api_key.trim()
    }
    setSaving(true)
    try {
      if (editingId) {
        await api.adminUpdateModelConfig(editingId, payload)
      } else {
        await api.adminCreateModelConfig(payload)
      }
      await onReload()
      setDialogOpen(false)
      onNotice('模型配置已保存并即时生效')
    } catch (caught) {
      onNotice(caught instanceof Error ? caught.message : '保存模型配置失败')
    } finally {
      setSaving(false)
    }
  }

  async function toggleEnabled(cfg: AdminModelConfig) {
    try {
      await api.adminToggleModelConfig(cfg.id, !cfg.enabled)
      await onReload()
      onNotice(cfg.enabled ? '已停用该模型' : '已启用该模型')
    } catch (caught) {
      onNotice(caught instanceof Error ? caught.message : '更新状态失败')
    }
  }

  async function removeConfig(cfg: AdminModelConfig) {
    if (!window.confirm(`确认删除模型配置「${cfg.display_name || cfg.slot}」？`)) {
      return
    }
    try {
      await api.adminDeleteModelConfig(cfg.id)
      await onReload()
      onNotice('模型配置已删除')
    } catch (caught) {
      onNotice(caught instanceof Error ? caught.message : '删除失败')
    }
  }

  async function saveRate() {
    const markup = Number(markupInput)
    if (!Number.isFinite(markup) || markup < 1 || markup > 3) {
      onNotice('加价系数必须在 1.0–3.0 之间（1.15 = 加价 15%）')
      return
    }
    const value = Number(rateInput || 0)
    if (!Number.isFinite(value) || value < 0) {
      onNotice('基准每 token 成本不能为负')
      return
    }
    setRateSaving(true)
    try {
      await api.adminSetCreditRate({ markup_factor: markup, currency_per_credit: value, currency: rateCurrency.trim() || 'cny' })
      await onReload()
      onNotice('计费参数已更新并即时生效')
    } catch (caught) {
      onNotice(caught instanceof Error ? caught.message : '保存计费参数失败')
    } finally {
      setRateSaving(false)
    }
  }

  async function saveLevers() {
    const parseLever = (raw: string, label: string): number | null => {
      const n = Number(raw || 0)
      if (!Number.isFinite(n) || n < 0 || n > 1_000_000) {
        onNotice(`${label}必须在 0–1000000 credits 之间（0 表示沿用环境默认值）`)
        return null
      }
      return Math.floor(n)
    }
    const tavily = parseLever(tavilyInput, 'web.search 每次费用')
    if (tavily === null) return
    const e2bBase = parseLever(e2bBaseInput, 'code.execute 基础费用')
    if (e2bBase === null) return
    const e2bPerSec = parseLever(e2bPerSecInput, 'code.execute 每秒费用')
    if (e2bPerSec === null) return
    setLeversSaving(true)
    try {
      await api.adminSetBillingLevers({
        tavily_search_credits: tavily,
        e2b_code_exec_base_credits: e2bBase,
        e2b_code_exec_per_second_credits: e2bPerSec,
      })
      await onReload()
      onNotice('工具计费杠杆已更新并即时生效')
    } catch (caught) {
      onNotice(caught instanceof Error ? caught.message : '保存工具计费杠杆失败')
    } finally {
      setLeversSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card id="providers" className="min-w-0">
        <CardHeader className="flex flex-row items-start justify-between gap-2">
          <div>
            <CardTitle>模型配置</CardTitle>
            <CardDescription>动态管理用户端模型目录、provider / 上游模型 / token 费率，保存后即时生效，不再依赖 .env。API key 加密存储且不回显。</CardDescription>
          </div>
          <Button size="sm" onClick={openCreate}>
            <Plus className="size-4" />
            新增模型
          </Button>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>模型 ID / 能力</TableHead>
                <TableHead>Provider / Model</TableHead>
                <TableHead>Token 费率</TableHead>
                <TableHead>每次金额</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {configs.length ? (
                configs.map((cfg) => (
                  <TableRow key={cfg.id}>
                    <TableCell>
                      <div className="font-medium">{cfg.slot}</div>
                      <div className="text-xs text-muted-foreground">{cfg.capability}</div>
                    </TableCell>
                    <TableCell className="max-w-52">
                      <div className="truncate font-medium">{cfg.display_name || cfg.provider_kind}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {cfg.provider_kind} · {cfg.model_name || '-'} · {cfg.base_url || 'default'}
                      </div>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      <div className="text-xs">in {formatMultiplier(cfg.input_credit_multiplier || cfg.credit_multiplier)}x · out {formatMultiplier(cfg.output_credit_multiplier || cfg.credit_multiplier)}x</div>
                      <div className="text-xs text-muted-foreground">base {formatMultiplier(cfg.credit_multiplier)}x</div>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {cfg.price_per_call_cny ? `¥${cfg.price_per_call_cny}/次` : '-'}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        <Badge variant={cfg.enabled ? 'default' : 'outline'}>{cfg.enabled ? '启用' : '停用'}</Badge>
                        <Badge variant={cfg.api_key_configured ? 'secondary' : 'outline'}>
                          <KeyRound className="size-3" />
                          {cfg.api_key_configured ? 'key 已配置' : 'key 未配置'}
                        </Badge>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="icon" title="编辑" onClick={() => openEdit(cfg)}>
                          <Pencil className="size-4" />
                        </Button>
                        <Button variant="ghost" size="icon" title={cfg.enabled ? '停用' : '启用'} onClick={() => toggleEnabled(cfg)}>
                          <Power className="size-4" />
                        </Button>
                        <Button variant="ghost" size="icon" title="删除" onClick={() => removeConfig(cfg)}>
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <EmptyTableRow columns={6} label="暂无模型配置（首次启动会从 env 自动播种）" />
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>计费参数</CardTitle>
          <CardDescription>
            全局加价系数 = 产品固定利润（1.15 = 全线加价 15%，建议 1.10–1.20）。最终扣费 = 输入 tokens × 输入费率 + 输出 tokens × 输出费率，再乘加价系数。
            基准每 token 成本仅用于把生图等「按次金额」模型换算成 credits（每次金额 ÷ 基准成本 × 加价系数）。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="markup-value">全局加价系数（利润）</Label>
              <Input
                id="markup-value"
                value={markupInput}
                onChange={(event) => setMarkupInput(event.target.value)}
                placeholder="1.15 = 加价 15%"
                className="w-40"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="rate-value">基准每 token 成本（{rateCurrency || 'cny'}）</Label>
              <Input
                id="rate-value"
                value={rateInput}
                onChange={(event) => setRateInput(event.target.value)}
                placeholder="DeepSeek-Pro 每 token 成本，仅生图换算用；留空=不启用生图"
                className="w-72"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="rate-currency">货币</Label>
              <Input
                id="rate-currency"
                value={rateCurrency}
                onChange={(event) => setRateCurrency(event.target.value)}
                className="w-24"
              />
            </div>
            <Button onClick={saveRate} disabled={rateSaving}>
              {rateSaving ? <Loader2 className="size-4 animate-spin" /> : null}
              保存
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>工具计费杠杆</CardTitle>
          <CardDescription>
            每次调用工具收取的 credits，保存后即时生效（本实例立即，其它实例 ≤30s 收敛）。留空或 0 表示沿用环境默认值。
            这些是 Reserve→Settle 的成本输入，不涉及钱包发放。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="lever-tavily">web.search 每次</Label>
              <Input
                id="lever-tavily"
                value={tavilyInput}
                onChange={(event) => setTavilyInput(event.target.value)}
                placeholder="默认 20"
                className="w-32"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="lever-e2b-base">code.execute 基础</Label>
              <Input
                id="lever-e2b-base"
                value={e2bBaseInput}
                onChange={(event) => setE2bBaseInput(event.target.value)}
                placeholder="默认 5"
                className="w-32"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="lever-e2b-persec">code.execute 每秒</Label>
              <Input
                id="lever-e2b-persec"
                value={e2bPerSecInput}
                onChange={(event) => setE2bPerSecInput(event.target.value)}
                placeholder="默认 1"
                className="w-32"
              />
            </div>
            <Button onClick={saveLevers} disabled={leversSaving}>
              {leversSaving ? <Loader2 className="size-4 animate-spin" /> : null}
              保存
            </Button>
          </div>
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editingId ? '编辑模型配置' : '新增模型配置'}</DialogTitle>
            <DialogDescription>先选模板，再补上游连接和费率。保存后立即生效；API key 留空会保持原值。</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            {!editingId ? (
              <div className="grid gap-2">
                <div className="text-xs font-medium text-muted-foreground">常用模板</div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {MODEL_PRESETS.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      className="rounded-lg border bg-background px-3 py-2 text-left transition hover:bg-muted active:scale-[0.99]"
                      onClick={() => applyPreset(preset)}
                    >
                      <div className="text-sm font-medium">{preset.label}</div>
                      <div className="text-xs text-muted-foreground">{preset.helper}</div>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="grid gap-3 rounded-lg border bg-muted/20 p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="text-sm font-medium">模型身份</div>
                <label className="flex items-center gap-2 text-sm text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={form.enabled}
                    onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
                  />
                  启用
                </label>
              </div>
              <div className="grid gap-3 sm:grid-cols-[160px_1fr_1fr]">
                <div className="grid gap-1.5">
                  <Label htmlFor="mc-cap">能力</Label>
                  <select
                    id="mc-cap"
                    className={SELECT_CLASS}
                    value={form.capability}
                    onChange={(e) => {
                      const capability = e.target.value
                      const slot = capability === 'image'
                        ? IMAGE_DEFAULT_MODEL_ID
                        : form.capability === 'image' && form.slot === IMAGE_DEFAULT_MODEL_ID
                          ? ''
                          : form.slot
                      setForm({ ...form, capability, slot })
                    }}
                  >
                    {CAPABILITY_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="mc-slot">模型 ID</Label>
                  {form.capability === 'image' ? (
                    <Input id="mc-slot" value={IMAGE_DEFAULT_MODEL_ID} disabled />
                  ) : (
                    <Input
                      id="mc-slot"
                      value={form.slot}
                      onChange={(e) => setForm({ ...form, slot: e.target.value })}
                      placeholder="gpt-4o / claude-sonnet / deepseek-v4"
                      maxLength={40}
                    />
                  )}
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="mc-name">显示名</Label>
                  <Input id="mc-name" value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} placeholder="DeepSeek Pro" />
                </div>
              </div>
            </div>

            <div className="grid gap-3 rounded-lg border bg-muted/20 p-3">
              <div className="text-sm font-medium">上游连接</div>
              <div className="grid gap-3 sm:grid-cols-[180px_1fr]">
                <div className="grid gap-1.5">
                  <Label htmlFor="mc-kind">Provider</Label>
                  <select
                    id="mc-kind"
                    className={SELECT_CLASS}
                    value={form.provider_kind}
                    onChange={(e) => setForm({ ...form, provider_kind: e.target.value })}
                  >
                    {PROVIDER_KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {kind}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="mc-base">Base URL</Label>
                  <Input id="mc-base" value={form.base_url} onChange={(e) => setForm({ ...form, base_url: e.target.value })} placeholder="https://api.deepseek.com" />
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="mc-model">上游模型名</Label>
                  <Input id="mc-model" value={form.model_name} onChange={(e) => setForm({ ...form, model_name: e.target.value })} placeholder="deepseek-v4-pro" />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="mc-key">API Key</Label>
                  <Input
                    id="mc-key"
                    type="password"
                    value={form.api_key}
                    onChange={(e) => setForm({ ...form, api_key: e.target.value })}
                    placeholder={editingHasKey ? '已配置，留空保持不变' : '输入 API key'}
                  />
                </div>
              </div>
            </div>

            <div className="grid gap-3 rounded-lg border bg-muted/20 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-medium">计费</div>
                  <div className="text-xs text-muted-foreground">DeepSeek Pro = 1，利润由全局加价系数统一处理。</div>
                </div>
                <div className="flex flex-wrap gap-1">
                  <Badge variant="outline">in {formatMultiplier(Number(form.input_credit_multiplier || form.credit_multiplier || 0))}x</Badge>
                  <Badge variant="outline">out {formatMultiplier(Number(form.output_credit_multiplier || form.credit_multiplier || 0))}x</Badge>
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="mc-input-mult">输入费率</Label>
                  <Input
                    id="mc-input-mult"
                    value={form.input_credit_multiplier}
                    onChange={(e) => setForm({ ...form, input_credit_multiplier: e.target.value })}
                    placeholder="DeepSeek Pro = 1"
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="mc-output-mult">输出费率</Label>
                  <Input
                    id="mc-output-mult"
                    value={form.output_credit_multiplier}
                    onChange={(e) => setForm({ ...form, output_credit_multiplier: e.target.value })}
                    placeholder="通常高于输入费率"
                  />
                </div>
              </div>
              {form.capability === 'image' ? (
                <div className="grid gap-1.5">
                  <Label htmlFor="mc-price">每次金额（¥）</Label>
                  <Input
                    id="mc-price"
                    value={form.price_per_call_cny}
                    onChange={(e) => setForm({ ...form, price_per_call_cny: e.target.value })}
                    placeholder="生图按每张图片金额换算 credits"
                  />
                </div>
              ) : null}
              <details className="group rounded-lg border bg-background px-3 py-2">
                <summary className="cursor-pointer list-none text-sm font-medium">
                  高级参数
                  <span className="ml-2 text-xs text-muted-foreground">缓存、排序、兼容兜底</span>
                </summary>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <div className="grid gap-1.5">
                    <Label htmlFor="mc-mult">基础倍率</Label>
                    <Input
                      id="mc-mult"
                      value={form.credit_multiplier}
                      onChange={(e) => setForm({ ...form, credit_multiplier: e.target.value })}
                      placeholder="新费率留空时的兜底"
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="mc-priority">优先级</Label>
                    <Input id="mc-priority" type="number" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })} placeholder="100" />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="mc-cache-read-mult">缓存命中费率</Label>
                    <Input
                      id="mc-cache-read-mult"
                      value={form.cached_input_credit_multiplier}
                      onChange={(e) => setForm({ ...form, cached_input_credit_multiplier: e.target.value })}
                      placeholder="留空=沿用输入费率"
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="mc-cache-write-mult">缓存写入费率</Label>
                    <Input
                      id="mc-cache-write-mult"
                      value={form.cache_write_credit_multiplier}
                      onChange={(e) => setForm({ ...form, cache_write_credit_multiplier: e.target.value })}
                      placeholder="留空=沿用输入费率"
                    />
                  </div>
                  <div className="grid gap-1.5 sm:col-span-2">
                    <Label htmlFor="mc-desc">Auto 路由描述</Label>
                    <Input id="mc-desc" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="速度快、成本低,适合日常任务" />
                  </div>
                  {form.capability !== 'image' ? (
                    <div className="grid gap-1.5 sm:col-span-2">
                      <Label htmlFor="mc-price">每次金额（¥）</Label>
                      <Input
                        id="mc-price"
                        value={form.price_per_call_cny}
                        onChange={(e) => setForm({ ...form, price_per_call_cny: e.target.value })}
                        placeholder="文本模型通常保持 0"
                      />
                    </div>
                  ) : null}
                </div>
              </details>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>
              取消
            </Button>
            <Button onClick={submitForm} disabled={saving}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              保存
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function AgentRunsCard({
  runs,
  traceLoadingId,
  onOpenTrace,
}: {
  runs: AdminAgentRun[]
  traceLoadingId: string
  onOpenTrace: (runId: string) => Promise<void>
}) {
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
              <TableHead className="text-right">追踪</TableHead>
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
                  <TableCell className="text-right">
                    <Button variant="ghost" size="sm" disabled={traceLoadingId === run.id} onClick={() => void onOpenTrace(run.id)}>
                      {traceLoadingId === run.id ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
                      追踪
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <EmptyTableRow columns={6} label="暂无 Agent Runs" />
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

function AgentTraceDialog({ trace, onClose }: { trace: AdminAgentRunTrace | null; onClose: () => void }) {
  const eventItems = trace?.events.slice(-8).map((event) => `#${event.seq} ${event.event_type} · ${formatDateTime(event.created_at)}`) ?? []
  const llmItems = trace?.llm_calls.slice(0, 8).map((call) => `${call.provider}/${call.model} · ${call.status} · ${formatNumber(call.credits_cost)} credits`) ?? []
  const toolItems = trace?.tool_calls.slice(0, 8).map((call) => `${call.tool} · ${call.status} · ${formatNumber(call.credits_cost)} credits`) ?? []
  const walletItems = trace?.wallet_transactions.slice(0, 8).map((tx) => `${tx.type} · ${formatSignedNumber(tx.amount)} credits · ${formatDateTime(tx.created_at)}`) ?? []

  return (
    <Dialog open={Boolean(trace)} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-4xl">
        {trace ? (
          <div className="grid gap-5">
            <DialogHeader>
              <DialogTitle className="truncate">Run Trace</DialogTitle>
              <DialogDescription className="truncate">{trace.run.id}</DialogDescription>
            </DialogHeader>
            <div className="grid gap-3 md:grid-cols-4">
              <DetailItem label="用户" value={trace.run.user_email || trace.run.user_id} />
              <DetailItem label="状态" value={trace.run.status} />
              <DetailItem label="模型" value={trace.run.mode} />
              <DetailItem label="更新时间" value={formatDateTime(trace.run.updated_at)} />
            </div>
            <div className="grid gap-3 md:grid-cols-4">
              <ActivityList title={`事件 ${trace.events.length}`} items={eventItems} />
              <ActivityList title={`LLM ${trace.llm_calls.length}`} items={llmItems} />
              <ActivityList title={`工具 ${trace.tool_calls.length}`} items={toolItems} />
              <ActivityList title={`账务 ${trace.wallet_transactions.length}`} items={walletItems} />
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
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

function formatSignedNumber(value: number): string {
  return value > 0 ? `+${formatNumber(value)}` : formatNumber(value)
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

function formatMultiplier(value: number) {
  return Number.isFinite(value) ? Number(value.toFixed(4)).toString() : '0'
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
