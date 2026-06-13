import type { CSSProperties } from 'react'
import Loader2 from 'lucide-react/dist/esm/icons/loader-2'
import Plus from 'lucide-react/dist/esm/icons/plus'
import RefreshCcw from 'lucide-react/dist/esm/icons/refresh-ccw'
import ShieldCheck from 'lucide-react/dist/esm/icons/shield-check'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from '@/components/ui/sidebar'
import { Tabs, TabsContent } from '@/components/ui/tabs'
import { type AdminAPI, type AuthPayload } from '@/shared/api/client'
import { AdminAccountBlock, BrandBlock } from '../components/brand'
import { ModelConfigCard } from '../model/ModelConfigCard'
import { AgentRunsCard, AgentTraceDialog } from '../panels/AgentRunsPanel'
import { OverviewPanel } from '../panels/OverviewPanel'
import { AuditCard, OrdersCard, ToolCallsCard } from '../panels/RecordPanels'
import { UsersPanel } from '../panels/UsersPanel'
import { NAV_ITEMS } from '../shared/sections'
import { useAdminDashboardData } from './useAdminDashboardData'

export function AdminDashboard({ api, auth, onLogout }: { api: AdminAPI; auth: AuthPayload; onLogout: () => Promise<void> }) {
  const { state, actions } = useAdminDashboardData(api)
  const activeNav = NAV_ITEMS.find((item) => item.id === state.activeSection)

  return (
    <SidebarProvider
      className="admin-shell"
      style={{ '--sidebar-width': '236px', '--sidebar-width-icon': '236px' } as CSSProperties}
    >
      <Sidebar className="admin-sidebar" collapsible="none">
        <SidebarHeader>
          <div className="admin-sidebar-brand">
            <BrandBlock compact subtitle="SheJane Admin" />
          </div>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                {NAV_ITEMS.map((item) => (
                  <SidebarMenuItem key={item.id}>
                    <SidebarMenuButton isActive={state.activeSection === item.id} tooltip={item.label} onClick={() => actions.switchSection(item.id)}>
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
          <AdminAccountBlock email={auth.user.email} onLogout={onLogout} />
        </SidebarFooter>
      </Sidebar>

      <SidebarInset className="admin-page-shell">
        <header className="admin-topbar">
          <div className="flex min-w-0 items-center gap-3">
            <div className="min-w-0">
              <h1 className="sr-only">管理后台</h1>
              <h2 className="truncate text-lg font-semibold tracking-normal">{activeNav?.label ?? '管理后台'}</h2>
              <p className="truncate text-sm text-muted-foreground">{activeNav?.description ?? '用户、额度、订单和模型状态的独立管理面板'}</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2.5">
            <Button variant="outline" onClick={() => void actions.refreshAdminData()} disabled={state.loading}>
              {state.loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCcw className="size-4" />}
              刷新数据
            </Button>
            {state.activeSection === 'providers' ? (
              <Button onClick={actions.requestModelCreate}>
                <Plus className="size-4" />
                新增模型
              </Button>
            ) : null}
          </div>
        </header>

        <main className="admin-content">
          <Tabs value={state.activeSection} onValueChange={actions.switchSection} className="flex flex-1 flex-col gap-4 md:gap-6">
            {state.notice ? (
              <div
                className="fixed left-1/2 top-4 z-[100] w-[min(92vw,520px)] -translate-x-1/2 cursor-pointer"
                role="status"
                onClick={() => actions.setNotice('')}
                title="点击关闭"
              >
                <Alert className="border-border bg-background shadow-lg">
                  <ShieldCheck className="size-4" />
                  <AlertDescription>{state.notice}</AlertDescription>
                </Alert>
              </div>
            ) : null}

            <TabsContent value="overview" className="mt-0 flex flex-col gap-4">
              <OverviewPanel
                overview={state.overview}
                auditLogs={state.auditLogs}
                modelConfigs={state.modelConfigs}
                creditRate={state.creditRate}
                onSwitchSection={actions.switchSection}
              />
            </TabsContent>

            <TabsContent value="users" className="mt-0">
              <UsersPanel
                users={state.users}
                query={state.query}
                page={state.page}
                hasMore={state.hasMoreUsers}
                selectedUser={state.selectedUser}
                delta={state.delta}
                reason={state.reason}
                onQueryChange={actions.setQuery}
                onSearch={actions.searchUsers}
                onChangePage={actions.changeUsersPage}
                onOpenUser={actions.openUser}
                onCloseUser={actions.closeUser}
                onDeltaChange={actions.setDelta}
                onReasonChange={actions.setReason}
                onAdjustCredits={actions.adjustCredits}
                onUpdateStatus={actions.updateStatus}
              />
            </TabsContent>

            <TabsContent value="tool-calls" className="mt-0">
              <ToolCallsCard calls={state.toolCalls} page={state.toolPage} hasMore={state.hasMoreTool} onChangePage={actions.changeToolCallsPage} />
            </TabsContent>

            <TabsContent value="orders" className="mt-0">
              <OrdersCard orders={state.orders} page={state.orderPage} hasMore={state.hasMoreOrders} onChangePage={actions.changeOrdersPage} />
            </TabsContent>

            <TabsContent value="providers" className="mt-0">
              <ModelConfigCard
                configs={state.modelConfigs}
                creditRate={state.creditRate}
                billingLevers={state.billingLevers}
                api={api}
                onReload={actions.reloadModelConfigs}
                onNotice={actions.setNotice}
                createRequestNonce={state.modelCreateRequest}
              />
            </TabsContent>

            <TabsContent value="agent-runs" className="mt-0">
              <AgentRunsCard runs={state.agentRuns} traceLoadingId={state.traceLoadingId} onOpenTrace={actions.openAgentTrace} />
            </TabsContent>

            <TabsContent value="audit" className="mt-0">
              <AuditCard logs={state.auditLogs} page={state.auditPage} hasMore={state.hasMoreAudit} onChangePage={actions.changeAuditPage} />
            </TabsContent>
          </Tabs>
          <AgentTraceDialog trace={state.agentTrace} onClose={() => actions.setAgentTrace(null)} />
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}
