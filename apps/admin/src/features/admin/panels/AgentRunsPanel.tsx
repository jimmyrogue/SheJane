import Loader2 from 'lucide-react/dist/esm/icons/loader-2'
import Search from 'lucide-react/dist/esm/icons/search'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { AdminAgentRun, AdminAgentRunTrace } from '@/shared/api/client'
import { ActivityList, DataGrid, type DataGridColumn, DetailItem, StatusBadge } from '../components/ui-helpers'
import { formatDateTime, formatNumber, formatSignedNumber } from '../shared/format'
import { originLabel, runModeLabel, statusLabel, txTypeLabel } from '../shared/labels'

export function AgentRunsCard({
  runs,
  traceLoadingId,
  onOpenTrace,
}: {
  runs: AdminAgentRun[]
  traceLoadingId: string
  onOpenTrace: (runId: string) => Promise<void>
}) {
  const columns: Array<DataGridColumn<AdminAgentRun>> = [
    {
      label: 'Run',
      width: 'minmax(160px, 1.1fr)',
      render: (run) => (
        <div className="min-w-0">
          <div className="admin-mono truncate" style={{ fontSize: '12.5px', color: 'var(--sj-ink)' }}>{run.id}</div>
          <div className="truncate" style={{ marginTop: 2, fontSize: '11px', color: 'var(--sj-ink-faint)' }}>{originLabel(run.origin)} · {runModeLabel(run.mode)}</div>
        </div>
      ),
    },
    { label: '用户', width: 'minmax(150px, 1fr)', render: (run) => <div className="truncate" style={{ fontSize: '13px' }}>{run.user_email || run.user_id}</div> },
    {
      label: '摘要',
      width: 'minmax(200px, 1.6fr)',
      render: (run) => (
        <div className="min-w-0">
          <div className="truncate" style={{ fontSize: '13px', color: 'var(--sj-ink)' }}>{run.goal_summary || '用户任务'}</div>
          <div className="truncate" style={{ marginTop: 2, fontSize: '11px', color: 'var(--sj-ink-faint)' }}>附件 {run.attachments?.length ?? 0} · 过期 {formatDateTime(run.expires_at)}</div>
        </div>
      ),
    },
    { label: '状态', width: '120px', render: (run) => <StatusBadge status={run.status} /> },
    { label: '更新时间', width: '150px', render: (run) => <span style={{ fontSize: '12.5px', color: 'var(--sj-ink-soft)', whiteSpace: 'nowrap' }}>{formatDateTime(run.updated_at)}</span> },
    {
      label: '',
      width: '70px',
      align: 'right',
      render: (run) => (
        <button
          type="button"
          className="admin-link-btn"
          style={{ width: '100%', justifyContent: 'flex-end', gap: 5 }}
          disabled={traceLoadingId === run.id}
          onClick={() => void onOpenTrace(run.id)}
        >
          {traceLoadingId === run.id ? <Loader2 className="size-3 animate-spin" /> : <Search className="size-3" />}
          追踪
        </button>
      ),
    },
  ]

  return (
    <section id="agent-runs" className="admin-card min-w-0">
      <DataGrid columns={columns} rows={runs.slice(0, 10)} getRowKey={(run) => run.id} empty="暂无 Agent Runs" />
    </section>
  )
}

export function AgentTraceDialog({ trace, onClose }: { trace: AdminAgentRunTrace | null; onClose: () => void }) {
  const eventItems = trace?.events.slice(-8).map((event) => `#${event.seq} ${event.event_type} · ${formatDateTime(event.created_at)}`) ?? []
  const llmItems = trace?.llm_calls.slice(0, 8).map(llmTraceItem) ?? []
  const toolItems = trace?.tool_calls.slice(0, 8).map((call) => `${call.tool} · ${statusLabel(call.status)} · ${formatNumber(call.credits_cost)} 额度`) ?? []
  const walletItems = trace?.wallet_transactions.slice(0, 8).map((tx) => `${txTypeLabel(tx.type)} · ${formatSignedNumber(tx.amount)} 额度 · ${formatDateTime(tx.created_at)}`) ?? []

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
              <DetailItem label="状态" value={statusLabel(trace.run.status)} />
              <DetailItem label="模式" value={runModeLabel(trace.run.mode)} />
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

function llmTraceItem(call: AdminAgentRunTrace['llm_calls'][number]) {
  const error = call.error_message || call.error_code
  return [
    `${call.provider}/${call.model}`,
    statusLabel(call.status),
    `${formatNumber(call.credits_cost)} 额度`,
    error,
  ].filter(Boolean).join(' · ')
}
