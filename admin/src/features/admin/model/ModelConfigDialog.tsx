import Loader2 from 'lucide-react/dist/esm/icons/loader-2'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { formatMultiplier } from '../shared/format'
import {
  CAPABILITY_OPTIONS,
  CAPABILITY_TIER_OPTIONS,
  IMAGE_DEFAULT_MODEL_ID,
  PROVIDER_KINDS,
  SELECT_CLASS,
} from './model-options'
import { MODEL_PRESETS } from './presets'
import type { ModelConfigManager } from './types'

export function ModelConfigDialog({ manager }: { manager: ModelConfigManager }) {
  const { form } = manager

  return (
    <Dialog open={manager.dialogOpen} onOpenChange={manager.setDialogOpen}>
      <DialogContent className="admin-model-drawer max-h-[88vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{manager.editingId ? '编辑模型配置' : '新增模型配置'}</DialogTitle>
          <DialogDescription>先选模板，再补上游连接和费率。保存后立即生效；API key 留空会保持原值。</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          {!manager.editingId ? (
            <div className="grid gap-2">
              <div className="text-xs font-medium text-muted-foreground">常用模板</div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {MODEL_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    className="rounded-lg border bg-background px-3 py-2 text-left transition hover:bg-muted active:scale-[0.99]"
                    onClick={() => manager.applyPreset(preset)}
                  >
                    <div className="text-sm font-medium">{preset.label}</div>
                    <div className="text-xs text-muted-foreground">{preset.helper}</div>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <div className="grid gap-3 rounded-lg border bg-muted/20 p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm font-medium">模型身份</div>
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(e) => manager.setForm({ ...form, enabled: e.target.checked })}
                />
                启用
              </label>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="grid gap-1.5">
                <Label htmlFor="mc-cap">能力</Label>
                <select
                  id="mc-cap"
                  className={SELECT_CLASS}
                  value={form.capability}
                  onChange={(e) => {
                    const capability = e.target.value
                    const slot = capability === 'image'
                      ? IMAGE_DEFAULT_MODEL_ID
                      : form.capability === 'image' && form.slot === IMAGE_DEFAULT_MODEL_ID
                        ? ''
                        : form.slot
                    manager.setForm({ ...form, capability, slot })
                  }}
                >
                  {CAPABILITY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="mc-slot">模型 ID</Label>
                {form.capability === 'image' ? (
                  <Input id="mc-slot" value={IMAGE_DEFAULT_MODEL_ID} disabled />
                ) : (
                  <Input
                    id="mc-slot"
                    value={form.slot}
                    onChange={(e) => manager.setForm({ ...form, slot: e.target.value })}
                    placeholder="gpt-4o / claude-sonnet / deepseek-v4"
                    maxLength={40}
                  />
                )}
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="mc-name">显示名</Label>
                <Input id="mc-name" value={form.display_name} onChange={(e) => manager.setForm({ ...form, display_name: e.target.value })} placeholder="DeepSeek Pro" />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="mc-vendor">厂商</Label>
                <Input id="mc-vendor" value={form.vendor} onChange={(e) => manager.setForm({ ...form, vendor: e.target.value })} placeholder="DeepSeek / ChatGPT / Claude" />
              </div>
              <div className="grid gap-1.5 sm:col-span-2">
                <Label htmlFor="mc-vendor-info">厂商简介</Label>
                <Input
                  id="mc-vendor-info"
                  value={form.vendor_info}
                  onChange={(e) => manager.setForm({ ...form, vendor_info: e.target.value })}
                  placeholder="鼠标悬浮厂商 info 时展示，例如：OpenAI 出品，通用能力全面。"
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="mc-tier">能力档位</Label>
                <select
                  id="mc-tier"
                  className={SELECT_CLASS}
                  value={form.capability_tier}
                  onChange={(e) => manager.setForm({ ...form, capability_tier: e.target.value })}
                >
                  {CAPABILITY_TIER_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          <div className="grid gap-3 rounded-lg border bg-muted/20 p-3">
            <div className="text-sm font-medium">上游连接</div>
            <div className="grid gap-3 sm:grid-cols-[180px_1fr]">
              <div className="grid gap-1.5">
                <Label htmlFor="mc-kind">Provider</Label>
                <select
                  id="mc-kind"
                  className={SELECT_CLASS}
                  value={form.provider_kind}
                  onChange={(e) => manager.setForm({ ...form, provider_kind: e.target.value })}
                >
                  {PROVIDER_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {kind}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="mc-base">Base URL</Label>
                <Input id="mc-base" value={form.base_url} onChange={(e) => manager.setForm({ ...form, base_url: e.target.value })} placeholder="https://api.deepseek.com" />
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="mc-model">上游模型名</Label>
                <Input id="mc-model" value={form.model_name} onChange={(e) => manager.setForm({ ...form, model_name: e.target.value })} placeholder="deepseek-v4-pro" />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="mc-key">API Key</Label>
                <Input
                  id="mc-key"
                  type="password"
                  value={form.api_key}
                  onChange={(e) => manager.setForm({ ...form, api_key: e.target.value })}
                  placeholder={manager.editingHasKey ? '已配置，留空保持不变' : '输入 API key'}
                />
              </div>
            </div>
          </div>

          <div className="grid gap-3 rounded-lg border bg-muted/20 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-sm font-medium">计费</div>
                <div className="text-xs text-muted-foreground">DeepSeek Pro = 1，利润由全局加价系数统一处理。</div>
              </div>
              <div className="flex flex-wrap gap-1">
                <Badge variant="outline">in {formatMultiplier(Number(form.input_credit_multiplier || form.credit_multiplier || 0))}x</Badge>
                <Badge variant="outline">out {formatMultiplier(Number(form.output_credit_multiplier || form.credit_multiplier || 0))}x</Badge>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="mc-input-mult">输入费率</Label>
                <Input
                  id="mc-input-mult"
                  value={form.input_credit_multiplier}
                  onChange={(e) => manager.setForm({ ...form, input_credit_multiplier: e.target.value })}
                  placeholder="DeepSeek Pro = 1"
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="mc-output-mult">输出费率</Label>
                <Input
                  id="mc-output-mult"
                  value={form.output_credit_multiplier}
                  onChange={(e) => manager.setForm({ ...form, output_credit_multiplier: e.target.value })}
                  placeholder="通常高于输入费率"
                />
              </div>
            </div>
            {form.capability === 'image' ? (
              <div className="grid gap-1.5">
                <Label htmlFor="mc-price">每次金额（¥）</Label>
                <Input
                  id="mc-price"
                  value={form.price_per_call_cny}
                  onChange={(e) => manager.setForm({ ...form, price_per_call_cny: e.target.value })}
                  placeholder="生图按每张图片金额换算 credits"
                />
              </div>
            ) : null}
            <details className="group rounded-lg border bg-background px-3 py-2">
              <summary className="cursor-pointer list-none text-sm font-medium">
                高级参数
                <span className="ml-2 text-xs text-muted-foreground">缓存、排序、兼容兜底</span>
              </summary>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="mc-mult">基础倍率</Label>
                  <Input
                    id="mc-mult"
                    value={form.credit_multiplier}
                    onChange={(e) => manager.setForm({ ...form, credit_multiplier: e.target.value })}
                    placeholder="新费率留空时的兜底"
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="mc-priority">优先级</Label>
                  <Input id="mc-priority" type="number" value={form.priority} onChange={(e) => manager.setForm({ ...form, priority: e.target.value })} placeholder="100" />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="mc-cache-read-mult">缓存命中费率</Label>
                  <Input
                    id="mc-cache-read-mult"
                    value={form.cached_input_credit_multiplier}
                    onChange={(e) => manager.setForm({ ...form, cached_input_credit_multiplier: e.target.value })}
                    placeholder="留空=沿用输入费率"
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="mc-cache-write-mult">缓存写入费率</Label>
                  <Input
                    id="mc-cache-write-mult"
                    value={form.cache_write_credit_multiplier}
                    onChange={(e) => manager.setForm({ ...form, cache_write_credit_multiplier: e.target.value })}
                    placeholder="留空=沿用输入费率"
                  />
                </div>
                <div className="grid gap-1.5 sm:col-span-2">
                  <Label htmlFor="mc-desc">Auto 路由描述</Label>
                  <Input id="mc-desc" value={form.description} onChange={(e) => manager.setForm({ ...form, description: e.target.value })} placeholder="速度快、成本低,适合日常任务" />
                </div>
                {form.capability !== 'image' ? (
                  <div className="grid gap-1.5 sm:col-span-2">
                    <Label htmlFor="mc-price">每次金额（¥）</Label>
                    <Input
                      id="mc-price"
                      value={form.price_per_call_cny}
                      onChange={(e) => manager.setForm({ ...form, price_per_call_cny: e.target.value })}
                      placeholder="文本模型通常保持 0"
                    />
                  </div>
                ) : null}
              </div>
            </details>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => manager.setDialogOpen(false)} disabled={manager.saving}>
            取消
          </Button>
          <Button onClick={() => void manager.submitForm()} disabled={manager.saving}>
            {manager.saving ? <Loader2 className="size-4 animate-spin" /> : null}
            保存
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
