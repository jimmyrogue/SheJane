import Loader2 from 'lucide-react/dist/esm/icons/loader-2'
import Search from 'lucide-react/dist/esm/icons/search'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { AdminAgentRun, AdminAgentRunTrace } from '@/shared/api/client'
import { ActivityList, DetailItem, EmptyTableRow, StatusBadge } from '../components/ui-helpers'
import { formatDateTime, formatNumber, formatSignedNumber } from '../shared/format'

export function AgentRunsCard({
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

export function AgentTraceDialog({ trace, onClose }: { trace: AdminAgentRunTrace | null; onClose: () => void }) {
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
