import type { ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card'
import { TableCell, TableRow } from '@/components/ui/table'
import { formatNumber } from '../shared/format'
import { PAGE_SIZE } from '../shared/sections'

export function MetricCard({ icon, label, value, helper }: { icon: ReactNode; label: string; value: number; helper: string }) {
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
        {items.length ? items.map((item, index) => <div className="truncate text-xs text-muted-foreground" key={`${item}-${index}`}>{item}</div>) : <div className="text-xs text-muted-foreground">暂无数据</div>}
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

export function StatusBadge({ status }: { status: string }) {
  const variant = status === 'disabled' || status === 'failed' || status === 'past_due' || status === 'canceled' || status === 'unpaid' ? 'destructive' : status === 'active' || status === 'paid' || status === 'succeeded' || status === 'success' ? 'default' : 'secondary'
  return <Badge variant={variant}>{status}</Badge>
}
