import type { AdminAuditLog, AdminOrder, AdminToolCall } from '@/shared/api/client'
import { DataGrid, type DataGridColumn, Pagination, StatusBadge } from '../components/ui-helpers'
import { formatCurrency, formatDateTime, formatMetadata, formatNumber } from '../shared/format'
import { actorLabel, auditActionLabel, targetTypeLabel } from '../shared/labels'

const TOOL_COLUMNS: Array<DataGridColumn<AdminToolCall>> = [
  {
    label: '工具',
    width: 'minmax(180px, 1.4fr)',
    render: (call) => (
      <div className="min-w-0">
        <div className="admin-mono truncate" style={{ fontSize: '13.5px', fontWeight: 600, color: 'var(--sj-ink)' }}>{call.tool}</div>
        <div className="truncate" style={{ marginTop: 2, fontSize: '11.5px', color: 'var(--sj-ink-faint)' }}>
          {call.provider} · {call.units || 0} unit{call.error_code ? ` · ${call.error_code}` : ''}
        </div>
      </div>
    ),
  },
  { label: '用户', width: 'minmax(160px, 1fr)', render: (call) => <div className="truncate" style={{ fontSize: '13px' }}>{call.user_email ?? call.user_id}</div> },
  { label: '状态', width: '120px', render: (call) => <StatusBadge status={call.status} /> },
  { label: '额度', width: '80px', align: 'right', render: (call) => <span className="admin-num">{formatNumber(call.credits_cost)}</span> },
  {
    label: 'Run',
    width: 'minmax(220px, 1.4fr)',
    render: (call) => (
      <div className="min-w-0">
        <div className="admin-mono truncate" style={{ fontSize: '12.5px', color: 'var(--sj-ink-soft)' }}>{call.run_id || '-'}</div>
        <div className="truncate" style={{ marginTop: 2, fontSize: '11px', color: 'var(--sj-ink-faint)' }}>{formatDateTime(call.started_at)}</div>
      </div>
    ),
  },
]

const ORDER_COLUMNS: Array<DataGridColumn<AdminOrder>> = [
  { label: '订单', width: 'minmax(260px, 2fr)', render: (order) => <div className="admin-mono truncate" style={{ fontSize: '12.5px', color: 'var(--sj-ink)' }}>{order.id}</div> },
  { label: '用户', width: 'minmax(160px, 1fr)', render: (order) => <div className="truncate" style={{ fontSize: '13px' }}>{order.user_email ?? order.user_id ?? 'unknown'}</div> },
  { label: '金额', width: '110px', align: 'right', render: (order) => <span className="admin-num admin-num-strong">{formatCurrency(order.amount_cny)}</span> },
  { label: '状态', width: '130px', render: (order) => <StatusBadge status={order.status} /> },
  { label: '订阅', width: '120px', align: 'right', render: (order) => <div className="truncate" style={{ fontSize: '13px', color: 'var(--sj-ink-faint)' }}>{order.stripe_subscription_id || '-'}</div> },
]

const AUDIT_COLUMNS: Array<DataGridColumn<AdminAuditLog>> = [
  {
    label: '动作',
    width: 'minmax(220px, 1.5fr)',
    render: (log) => (
      <div className="min-w-0">
        <div className="truncate" style={{ fontSize: '13px', fontWeight: 500, color: 'var(--sj-ink)' }}>{auditActionLabel(log.action)}</div>
        <div className="admin-mono truncate" style={{ marginTop: 2, fontSize: '11px', color: 'var(--sj-ink-faint)' }}>{formatMetadata(log.metadata)}</div>
      </div>
    ),
  },
  {
    label: '对象',
    width: 'minmax(200px, 1.4fr)',
    render: (log) => (
      <div className="flex min-w-0 items-center gap-[7px]">
        <span className="admin-pill admin-pill-faint shrink-0">{log.target_type ? targetTypeLabel(log.target_type) : '-'}</span>
        <span className="admin-mono truncate" style={{ fontSize: '11.5px', color: 'var(--sj-ink-soft)' }}>{log.target_id || '-'}</span>
      </div>
    ),
  },
  {
    label: '操作者',
    width: 'minmax(150px, 1fr)',
    render: (log) => {
      const isSystem = !log.actor_user_id || log.actor_user_id === 'system'
      return isSystem ? (
        <span className="admin-pill">{actorLabel(log.actor_user_id)}</span>
      ) : (
        <div className="admin-mono truncate" style={{ fontSize: '11.5px', color: 'var(--sj-ink-faint)' }}>{log.actor_user_id}</div>
      )
    },
  },
  { label: '时间', width: '160px', render: (log) => <span style={{ fontSize: '12.5px', color: 'var(--sj-ink-soft)', whiteSpace: 'nowrap' }}>{formatDateTime(log.created_at)}</span> },
]

export function ToolCallsCard({
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
    <section id="tool-calls" className="admin-card min-w-0">
      <DataGrid columns={TOOL_COLUMNS} rows={calls} getRowKey={(call) => call.request_id} empty="暂无工具调用记录" />
      <Pagination page={page} hasMore={hasMore} onChangePage={onChangePage} />
    </section>
  )
}

export function OrdersCard({
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
    <section id="orders" className="admin-card min-w-0">
      <DataGrid columns={ORDER_COLUMNS} rows={orders} getRowKey={(order) => order.id} empty="暂无订单" />
      {orders[0] ? (
        <div className="admin-card-foot">Stripe session: {orders[0].stripe_checkout_session_id || 'mock'} · 钱包 {orders[0].wallet_status || '-'} · {formatDateTime(orders[0].created_at)}</div>
      ) : null}
      <Pagination page={page} hasMore={hasMore} onChangePage={onChangePage} />
    </section>
  )
}

export function AuditCard({
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
    <section id="audit" className="admin-card min-w-0">
      <DataGrid columns={AUDIT_COLUMNS} rows={logs} getRowKey={(log) => log.id} empty="暂无审计记录" />
      <Pagination page={page} hasMore={hasMore} onChangePage={onChangePage} />
    </section>
  )
}
