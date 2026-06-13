import Ban from 'lucide-react/dist/esm/icons/ban'
import ChevronRight from 'lucide-react/dist/esm/icons/chevron-right'
import Coins from 'lucide-react/dist/esm/icons/coins'
import Search from 'lucide-react/dist/esm/icons/search'
import UserCheck from 'lucide-react/dist/esm/icons/user-check'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { AdminUserDetail, AdminUserSummary } from '@/shared/api/client'
import { ActivityList, DataGrid, type DataGridColumn, DetailItem, EmptyTableRow, Pagination, StatusBadge } from '../components/ui-helpers'
import { formatCurrency, formatNumber } from '../shared/format'
import { roleLabel, statusLabel, txTypeLabel } from '../shared/labels'

const USER_COLUMNS: Array<DataGridColumn<AdminUserSummary>> = [
  {
    label: '邮箱',
    width: 'minmax(240px, 2fr)',
    render: (item) => (
      <div className="flex min-w-0 items-center gap-[11px]">
        <span className="admin-user-avatar">{item.user.email.charAt(0)}</span>
        <span className="min-w-0 truncate" style={{ fontSize: '13.5px', fontWeight: 500 }}>{item.user.email}</span>
      </div>
    ),
  },
  { label: '状态', width: '120px', render: (item) => <StatusBadge status={item.user.status} /> },
  {
    label: '调用',
    width: '110px',
    align: 'right',
    render: (item) => <span className={`admin-num${item.calls_count ? '' : ' admin-num-faint'}`}>{item.calls_count.toLocaleString()}</span>,
  },
  {
    label: '额度消耗',
    width: '140px',
    align: 'right',
    render: (item) => <span className={`admin-num${item.credits_cost ? ' admin-num-strong' : ' admin-num-faint'}`}>{formatNumber(item.credits_cost)}</span>,
  },
  { label: '', width: '40px', align: 'right', render: () => <ChevronRight className="admin-dt-chevron size-3.5" /> },
]

export function UsersPanel({
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
    <section id="users" className="admin-card min-w-0">
      <form
        className="admin-search-card"
        onSubmit={(event) => {
          event.preventDefault()
          void onSearch()
        }}
      >
        <div className="admin-search-box">
          <Search className="size-4" />
          <input value={query} placeholder="搜索邮箱或名称…" aria-label="搜索邮箱或名称" onChange={(event) => onQueryChange(event.target.value)} />
        </div>
      </form>
      <DataGrid
        columns={USER_COLUMNS}
        rows={users}
        getRowKey={(item) => item.user.id}
        rowLabel={(item) => item.user.email}
        onRowClick={(item) => void onOpenUser(item.user.id)}
        empty="暂无用户"
      />
      <Pagination page={page} hasMore={hasMore} onChangePage={onChangePage} />

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
    </section>
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
        <DetailItem label="角色" value={roleLabel(selectedUser.user.role)} />
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
        <ActivityList title="最近账本" items={selectedUser.transactions.slice(0, 4).map((tx) => `${txTypeLabel(tx.type)} ${tx.amount} · 余额 ${tx.extra_balance_after}`)} />
        <ActivityList title="最近订单" items={selectedUser.orders.slice(0, 4).map((order) => `${order.id} · ${formatCurrency(order.amount_cny)} · ${statusLabel(order.status)}`)} />
      </div>
    </div>
  )
}
