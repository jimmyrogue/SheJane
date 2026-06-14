import type { CSSProperties, ReactNode } from 'react'
import { TableCell, TableRow } from '@/components/ui/table'
import { formatNumber } from '../shared/format'
import { statusLabel } from '../shared/labels'
import { PAGE_SIZE } from '../shared/sections'

export function MetricCard({ icon, label, value, helper }: { icon: ReactNode; label: string; value: number; helper: string }) {
  return (
    <div className="admin-kpi-card">
      <div className="admin-kpi-head">
        <span className="admin-kpi-label">{label}</span>
        <span className="admin-kpi-icon">{icon}</span>
      </div>
      <div className="admin-kpi-value">{formatNumber(value)}</div>
      <div className="admin-kpi-sub">{helper}</div>
    </div>
  )
}

export function GlanceRow({
  label,
  value,
  mono = false,
  warn = false,
  last = false,
}: {
  label: string
  value: string
  mono?: boolean
  warn?: boolean
  last?: boolean
}) {
  return (
    <div className={`admin-glance-row${last ? ' last' : ''}`}>
      <span>{label}</span>
      <strong className={`${mono ? 'admin-mono ' : ''}${warn ? 'warn' : ''}`}>{value}</strong>
    </div>
  )
}

export function StatItem({
  label,
  value,
  warn = false,
  last = false,
}: {
  label: string
  value: string
  warn?: boolean
  last?: boolean
}) {
  return (
    <div className={`admin-stat-item${last ? ' last' : ''}`}>
      <span>{label}</span>
      <strong className={warn ? 'warn' : ''}>{value}</strong>
    </div>
  )
}

export function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button type="button" className={`admin-filter-chip${active ? ' active' : ''}`} onClick={onClick}>
      {label}
    </button>
  )
}

export function Pagination({
  page,
  hasMore,
  onChangePage,
}: {
  page: number
  hasMore: boolean
  onChangePage: (nextPage: number) => Promise<void> | void
}) {
  return (
    <div className="admin-pager">
      <button type="button" className="admin-pager-btn" disabled={page <= 0} onClick={() => void onChangePage(page - 1)}>
        上一页
      </button>
      <span className="admin-pager-label">第 {page + 1} 页 · 每页 {PAGE_SIZE} 条</span>
      <button type="button" className="admin-pager-btn" disabled={!hasMore} onClick={() => void onChangePage(page + 1)}>
        下一页
      </button>
    </div>
  )
}

export function DetailItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-background p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 truncate text-sm font-medium">{value}</div>
    </div>
  )
}

export function ActivityList({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="rounded-lg border bg-background p-3">
      <div className="mb-3 text-sm font-medium">{title}</div>
      <div className="grid gap-2">
        {items.length ? items.map((item, index) => (
          <div className="truncate text-xs text-muted-foreground" title={item} key={`${item}-${index}`}>
            {item}
          </div>
        )) : <div className="text-xs text-muted-foreground">暂无数据</div>}
      </div>
    </div>
  )
}

export function EmptyTableRow({ columns, label }: { columns: number; label: string }) {
  return (
    <TableRow>
      <TableCell colSpan={columns} className="h-24 text-center text-muted-foreground">
        {label}
      </TableCell>
    </TableRow>
  )
}

const MOSS_STATUS = new Set(['active', 'online', 'done', 'completed', 'succeeded', 'success', 'paid', 'settled'])
const WARN_STATUS = new Set(['failed', 'error', 'past_due', 'canceled', 'cancelled', 'unpaid', 'refunded', 'expired'])
const INK_STATUS = new Set(['processing', 'running', 'queued', 'reserved'])

export function StatusBadge({ status }: { status: string }) {
  const tone = MOSS_STATUS.has(status) ? 'moss' : WARN_STATUS.has(status) ? 'warn' : INK_STATUS.has(status) ? 'ink' : 'neutral'
  return (
    <span className={`admin-chip admin-chip-${tone}`}>
      <span className="admin-chip-dot" />
      {statusLabel(status)}
    </span>
  )
}

export type DataGridColumn<T> = {
  label: string
  width: string
  align?: 'right'
  render: (row: T) => ReactNode
}

export function DataGrid<T>({
  columns,
  rows,
  getRowKey,
  onRowClick,
  rowLabel,
  empty,
}: {
  columns: Array<DataGridColumn<T>>
  rows: T[]
  getRowKey: (row: T) => string
  onRowClick?: (row: T) => void
  rowLabel?: (row: T) => string
  empty: string
}) {
  const template = columns.map((column) => column.width).join(' ')
  const clickable = Boolean(onRowClick)
  const gridStyle = { '--admin-dt-columns': template } as CSSProperties
  return (
    <div data-slot="data-grid-scroll" className="admin-dt-scroll">
      <div data-slot="data-grid-content" className="admin-dt-content" style={gridStyle}>
        <div className="admin-dt-head">
          {columns.map((column, index) => (
            <span key={index} className={column.align === 'right' ? 'admin-dt-cell-right' : undefined}>
              {column.label}
            </span>
          ))}
        </div>
        {rows.length ? (
          rows.map((row) => (
            <div
              key={getRowKey(row)}
              className={`admin-dt-row${clickable ? ' admin-dt-row-click' : ''}`}
              role={clickable ? 'button' : undefined}
              tabIndex={clickable ? 0 : undefined}
              aria-label={rowLabel?.(row)}
              onClick={clickable ? () => onRowClick?.(row) : undefined}
              onKeyDown={
                clickable
                  ? (event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        onRowClick?.(row)
                      }
                    }
                  : undefined
              }
            >
              {columns.map((column, index) => (
                <div key={index} className={`admin-dt-cell${column.align === 'right' ? ' admin-dt-cell-right' : ''}`}>
                  {column.render(row)}
                </div>
              ))}
            </div>
          ))
        ) : (
          <div className="admin-empty-inline">{empty}</div>
        )}
      </div>
    </div>
  )
}

export function Toggle({ on, onClick, label }: { on: boolean; onClick: () => void; label?: string }) {
  return (
    <button type="button" className="admin-toggle" data-on={on} aria-pressed={on} aria-label={label} onClick={onClick}>
      <span className="admin-toggle-knob" />
    </button>
  )
}
