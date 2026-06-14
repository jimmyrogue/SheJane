import ChevronRight from 'lucide-react/dist/esm/icons/chevron-right'
import Coins from 'lucide-react/dist/esm/icons/coins'
import MessageSquareText from 'lucide-react/dist/esm/icons/message-square-text'
import ReceiptText from 'lucide-react/dist/esm/icons/receipt-text'
import Users from 'lucide-react/dist/esm/icons/users'
import type { AdminAuditLog, AdminCreditRate, AdminModelConfig, AdminOverview } from '@/shared/api/client'
import { GlanceRow, MetricCard } from '../components/ui-helpers'
import type { AdminSection } from '../shared/sections'
import { formatDateTime } from '../shared/format'
import { auditActionLabel, targetTypeLabel } from '../shared/labels'

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
  const recentLogs = auditLogs.slice(0, 6)
  const creditAnchorPerMillion = creditRate?.currency_per_credit
    ? Number((creditRate.currency_per_credit * 1_000_000).toFixed(6)).toString()
    : '0'

  return (
    <section id="overview" className="flex flex-col gap-[18px]">
      <div className="admin-kpi-grid">
        <MetricCard icon={<Users className="size-4" />} label="总用户" value={overview?.users_total ?? 0} helper={`活跃 ${overview?.active_users ?? 0} · 禁用 ${overview?.disabled_users ?? 0}`} />
        <MetricCard icon={<MessageSquareText className="size-4" />} label="总调用" value={overview?.llm_calls_total ?? 0} helper={`失败 ${overview?.llm_calls_failed ?? 0}`} />
        <MetricCard icon={<Coins className="size-4" />} label="额度消耗" value={overview?.credits_cost_total ?? 0} helper="累计额度消耗" />
        <MetricCard icon={<ReceiptText className="size-4" />} label="订单" value={overview?.orders_total ?? 0} helper="只读订单视图" />
      </div>
      <div className="admin-overview-grid">
        <section className="admin-card min-w-0">
          <div className="admin-card-head">
            <div>
              <h3 className="admin-card-head-title">近期动态</h3>
              <p className="admin-card-head-desc">后台操作与关键账务事件。</p>
            </div>
            <button type="button" className="admin-link-btn" onClick={() => onSwitchSection('audit')}>
              全部审计
              <ChevronRight />
            </button>
          </div>
          <div className="admin-activity-list">
            {recentLogs.length ? (
              recentLogs.map((log) => (
                <div className="admin-activity-row" key={log.id}>
                  <span className={`admin-activity-dot${log.action.includes('delete') ? ' warn' : ''}`} />
                  <div className="min-w-0">
                    <div className="admin-activity-action truncate">{auditActionLabel(log.action)}</div>
                    <div className="admin-muted-line">{log.target_id || (log.target_type ? targetTypeLabel(log.target_type) : '-')}</div>
                  </div>
                  <span className="admin-time">{formatDateTime(log.created_at).split(' ').pop()}</span>
                </div>
              ))
            ) : (
              <div className="admin-empty-inline">暂无动态</div>
            )}
          </div>
        </section>
        <section className="admin-card min-w-0">
          <div className="admin-card-head">
            <div>
              <h3 className="admin-card-head-title">模型与计费</h3>
              <p className="admin-card-head-desc">当前生效的目录与全局参数。</p>
            </div>
            <button type="button" className="admin-link-btn" onClick={() => onSwitchSection('providers')}>
              管理
              <ChevronRight />
            </button>
          </div>
          <div className="admin-glance-list">
            <GlanceRow label="模型目录" value={`${modelConfigs.length} 个 · 启用 ${enabledModelCount}`} />
            <GlanceRow warn={hasMissingKeys} label="Key 配置" value={`${configuredKeyCount} / ${modelConfigs.length || 0}`} />
            <GlanceRow mono label="全局加价系数" value={creditRate ? String(creditRate.markup_factor || 1.15) : '1.15'} />
            <GlanceRow mono label="每百万 token 金额" value={creditRate ? `${creditAnchorPerMillion} ${creditRate.currency || 'cny'}` : '-'} />
            <GlanceRow label="默认模型" value="自动" last />
          </div>
        </section>
      </div>
    </section>
  )
}
