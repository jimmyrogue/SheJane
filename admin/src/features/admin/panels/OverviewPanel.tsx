import Coins from 'lucide-react/dist/esm/icons/coins'
import MessageSquareText from 'lucide-react/dist/esm/icons/message-square-text'
import ReceiptText from 'lucide-react/dist/esm/icons/receipt-text'
import Users from 'lucide-react/dist/esm/icons/users'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import type { AdminAuditLog, AdminCreditRate, AdminModelConfig, AdminOverview } from '@/shared/api/client'
import { GlanceRow, MetricCard } from '../components/ui-helpers'
import type { AdminSection } from '../shared/sections'
import { formatDateTime } from '../shared/format'

export function OverviewPanel({
  overview,
  auditLogs,
  modelConfigs,
  creditRate,
  onSwitchSection,
}: {
  overview: AdminOverview | null
  auditLogs: AdminAuditLog[]
  modelConfigs: AdminModelConfig[]
  creditRate: AdminCreditRate | null
  onSwitchSection: (section: AdminSection) => void
}) {
  const enabledModelCount = modelConfigs.filter((cfg) => cfg.enabled).length
  const configuredKeyCount = modelConfigs.filter((cfg) => cfg.api_key_configured).length
  const hasMissingKeys = modelConfigs.some((cfg) => !cfg.api_key_configured)

  return (
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
      <div className="admin-overview-grid">
        <Card className="min-w-0">
          <CardHeader className="admin-card-head-row">
            <div>
              <CardTitle>近期动态</CardTitle>
              <CardDescription>后台操作与关键账务事件。</CardDescription>
            </div>
            <Button variant="ghost" size="sm" onClick={() => onSwitchSection('audit')}>
              全部审计
            </Button>
          </CardHeader>
          <CardContent className="admin-activity-list">
            {auditLogs.slice(0, 6).length ? auditLogs.slice(0, 6).map((log) => (
              <div className="admin-activity-row" key={log.id}>
                <span className={`admin-activity-dot${log.action.includes('delete') ? ' warn' : ''}`} />
                <div className="min-w-0">
                  <div className="admin-mono admin-activity-action">{log.action}</div>
                  <div className="admin-muted-line">{log.target_id || log.target_type || '-'}</div>
                </div>
                <span className="admin-time">{formatDateTime(log.created_at).split(' ').pop()}</span>
              </div>
            )) : (
              <div className="admin-empty-inline">暂无动态</div>
            )}
          </CardContent>
        </Card>
        <Card className="min-w-0">
          <CardHeader className="admin-card-head-row">
            <div>
              <CardTitle>模型与计费</CardTitle>
              <CardDescription>当前生效的目录与全局参数。</CardDescription>
            </div>
            <Button variant="ghost" size="sm" onClick={() => onSwitchSection('providers')}>
              管理
            </Button>
          </CardHeader>
          <CardContent className="admin-glance-list">
            <GlanceRow label="模型目录" value={`${modelConfigs.length} 个 · 启用 ${enabledModelCount}`} />
            <GlanceRow warn={hasMissingKeys} label="Key 配置" value={`${configuredKeyCount} / ${modelConfigs.length || 0}`} />
            <GlanceRow mono label="全局加价系数" value={creditRate ? String(creditRate.markup_factor || 1.15) : '1.15'} />
            <GlanceRow mono label="基准 token 成本" value={creditRate ? `${creditRate.currency_per_credit || 0} ${creditRate.currency || 'cny'}` : '-'} />
            <GlanceRow label="默认模型" value="自动" last />
          </CardContent>
        </Card>
      </div>
    </section>
  )
}
