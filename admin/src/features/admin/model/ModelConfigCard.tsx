import { type AdminAPI, type AdminBillingLevers, type AdminCreditRate, type AdminModelConfig } from '@/shared/api/client'
import { StatItem } from '../components/ui-helpers'
import { ModelBillingTab } from './ModelBillingTab'
import { ModelCatalogTab } from './ModelCatalogTab'
import { ModelConfigDialog } from './ModelConfigDialog'
import { useModelConfigManager } from './useModelConfigManager'

export function ModelConfigCard({
  configs,
  creditRate,
  billingLevers,
  api,
  onReload,
  onNotice,
  createRequestNonce,
}: {
  configs: AdminModelConfig[]
  creditRate: AdminCreditRate | null
  billingLevers: AdminBillingLevers | null
  api: AdminAPI
  onReload: () => Promise<void>
  onNotice: (message: string) => void
  createRequestNonce: number
}) {
  const manager = useModelConfigManager({
    configs,
    creditRate,
    billingLevers,
    api,
    onReload,
    onNotice,
    createRequestNonce,
  })

  return (
    <div className="flex min-w-0 flex-col">
      <div className="admin-model-strip">
        <div className="admin-stat-strip">
          <StatItem label="模型总数" value={String(configs.length)} />
          <StatItem label="已启用" value={String(manager.modelStats.enabled)} />
          <StatItem
            warn={manager.modelStats.keyConfigured < configs.length}
            label="Key 已配置"
            value={`${manager.modelStats.keyConfigured} / ${configs.length || 0}`}
          />
          <StatItem label="默认模型" value="自动" last />
        </div>
        <div className="admin-subtabs" role="tablist" aria-label="模型管理视图">
          <button type="button" className={manager.modelTab === 'catalog' ? 'active' : ''} onClick={() => manager.setModelTab('catalog')}>
            模型目录
          </button>
          <button type="button" className={manager.modelTab === 'billing' ? 'active' : ''} onClick={() => manager.setModelTab('billing')}>
            全局计费
          </button>
        </div>
      </div>

      {manager.modelTab === 'catalog' ? (
        <ModelCatalogTab
          configs={configs}
          visibleConfigs={manager.visibleConfigs}
          modelStats={manager.modelStats}
          catalogQuery={manager.catalogQuery}
          vendorFilter={manager.vendorFilter}
          onCatalogQueryChange={manager.setCatalogQuery}
          onVendorFilterChange={manager.setVendorFilter}
          onOpenEdit={manager.openEdit}
          onToggleEnabled={manager.toggleEnabled}
          onRemoveConfig={manager.removeConfig}
        />
      ) : (
        <ModelBillingTab manager={manager} />
      )}

      <ModelConfigDialog manager={manager} />
    </div>
  )
}
