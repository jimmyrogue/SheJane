import KeyRound from 'lucide-react/dist/esm/icons/key-round'
import Pencil from 'lucide-react/dist/esm/icons/pencil'
import Power from 'lucide-react/dist/esm/icons/power'
import Search from 'lucide-react/dist/esm/icons/search'
import Trash2 from 'lucide-react/dist/esm/icons/trash-2'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { AdminModelConfig } from '@/shared/api/client'
import { EmptyTableRow, FilterChip } from '../components/ui-helpers'
import { formatCapabilityTier, formatMultiplier } from '../shared/format'
import type { ModelStats } from './types'

export function ModelCatalogTab({
  configs,
  visibleConfigs,
  modelStats,
  catalogQuery,
  vendorFilter,
  onCatalogQueryChange,
  onVendorFilterChange,
  onOpenEdit,
  onToggleEnabled,
  onRemoveConfig,
}: {
  configs: AdminModelConfig[]
  visibleConfigs: AdminModelConfig[]
  modelStats: ModelStats
  catalogQuery: string
  vendorFilter: string
  onCatalogQueryChange: (value: string) => void
  onVendorFilterChange: (value: string) => void
  onOpenEdit: (cfg: AdminModelConfig) => void
  onToggleEnabled: (cfg: AdminModelConfig) => Promise<void>
  onRemoveConfig: (cfg: AdminModelConfig) => Promise<void>
}) {
  return (
    <section id="providers" className="admin-model-table-card">
      <div className="admin-catalog-tools">
        <div className="admin-search-field">
          <Search className="size-4" />
          <input
            value={catalogQuery}
            onChange={(event) => onCatalogQueryChange(event.target.value)}
            placeholder="搜索模型 ID / 名称 / 上游..."
          />
        </div>
        <div className="admin-filter-chips">
          <FilterChip label="全部" active={vendorFilter === 'all'} onClick={() => onVendorFilterChange('all')} />
          {modelStats.vendors.map((vendor) => (
            <FilterChip key={vendor} label={vendor} active={vendorFilter === vendor} onClick={() => onVendorFilterChange(vendor)} />
          ))}
          <FilterChip label="已停用" active={vendorFilter === 'off'} onClick={() => onVendorFilterChange('off')} />
        </div>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>模型 ID / 能力</TableHead>
            <TableHead>Provider / Model</TableHead>
            <TableHead>Token 费率</TableHead>
            <TableHead>每次金额</TableHead>
            <TableHead>状态</TableHead>
            <TableHead className="text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {visibleConfigs.length ? (
            visibleConfigs.map((cfg) => (
              <TableRow key={cfg.id}>
                <TableCell>
                  <div className="font-medium">{cfg.slot}</div>
                  <div className="flex flex-wrap gap-1 pt-1">
                    <Badge variant="outline">{cfg.vendor || '其他'}</Badge>
                    <Badge variant="secondary">{formatCapabilityTier(cfg.capability_tier)}</Badge>
                    <Badge variant="outline">{cfg.capability}</Badge>
                  </div>
                </TableCell>
                <TableCell className="max-w-52">
                  <div className="truncate font-medium">{cfg.display_name || cfg.provider_kind}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {cfg.provider_kind} · {cfg.model_name || '-'} · {cfg.base_url || 'default'}
                  </div>
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  <div className="text-xs">in {formatMultiplier(cfg.input_credit_multiplier || cfg.credit_multiplier)}x · out {formatMultiplier(cfg.output_credit_multiplier || cfg.credit_multiplier)}x</div>
                  <div className="text-xs text-muted-foreground">base {formatMultiplier(cfg.credit_multiplier)}x</div>
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {cfg.price_per_call_cny ? `¥${cfg.price_per_call_cny}/次` : '-'}
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    <Badge variant={cfg.enabled ? 'default' : 'outline'}>{cfg.enabled ? '启用' : '停用'}</Badge>
                    <Badge variant={cfg.api_key_configured ? 'secondary' : 'outline'}>
                      <KeyRound className="size-3" />
                      {cfg.api_key_configured ? 'key 已配置' : 'key 未配置'}
                    </Badge>
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    <Button variant="ghost" size="icon" title="编辑" onClick={() => onOpenEdit(cfg)}>
                      <Pencil className="size-4" />
                    </Button>
                    <Button variant="ghost" size="icon" title={cfg.enabled ? '停用' : '启用'} onClick={() => void onToggleEnabled(cfg)}>
                      <Power className="size-4" />
                    </Button>
                    <Button variant="ghost" size="icon" title="删除" onClick={() => void onRemoveConfig(cfg)}>
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))
          ) : (
            <EmptyTableRow columns={6} label={configs.length ? '没有匹配的模型' : '暂无模型配置（首次启动会从 env 自动播种）'} />
          )}
        </TableBody>
      </Table>
    </section>
  )
}
