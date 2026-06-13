import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { AdminAuditLog, AdminOrder, AdminToolCall } from '@/shared/api/client'
import { EmptyTableRow, Pagination, StatusBadge } from '../components/ui-helpers'
import { formatCurrency, formatDateTime, formatMetadata, formatNumber } from '../shared/format'

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
