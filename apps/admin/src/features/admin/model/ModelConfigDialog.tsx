import { useState } from 'react'
import type { ReactNode } from 'react'
import Check from 'lucide-react/dist/esm/icons/check'
import ChevronDown from 'lucide-react/dist/esm/icons/chevron-down'
import ChevronRight from 'lucide-react/dist/esm/icons/chevron-right'
import Loader2 from 'lucide-react/dist/esm/icons/loader-2'
import Sliders from 'lucide-react/dist/esm/icons/sliders-horizontal'
import X from 'lucide-react/dist/esm/icons/x'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Toggle } from '../components/ui-helpers'
import { CAPABILITY_OPTIONS, CAPABILITY_TIER_OPTIONS, IMAGE_DEFAULT_MODEL_ID, PROVIDER_KINDS } from './model-options'
import { MODEL_PRESETS } from './presets'
import type { ModelConfigManager } from './types'

function formatPrice(value: number) {
  return Number.isFinite(value) ? Number(value.toFixed(4)).toString() : '0'
}

function DField({ id, label, hint, grow, width, children }: { id?: string; label: string; hint?: string; grow?: boolean; width?: number; children: ReactNode }) {
  return (
    <div className={`admin-dfield${grow ? ' admin-dfield-grow' : ''}`} style={!grow && width ? { width, flexShrink: 0 } : undefined}>
      <label htmlFor={id} className="admin-dfield-label">{label}</label>
      {children}
      {hint ? <div className="admin-dfield-hint">{hint}</div> : null}
    </div>
  )
}

function DInput({ id, value, onChange, placeholder, mono, type = 'text', disabled, maxLength }: {
  id?: string
  value: string
  onChange?: (value: string) => void
  placeholder?: string
  mono?: boolean
  type?: string
  disabled?: boolean
  maxLength?: number
}) {
  return (
    <input
      id={id}
      type={type}
      value={value}
      disabled={disabled}
      maxLength={maxLength}
      placeholder={placeholder}
      className={mono ? 'admin-dinput mono' : 'admin-dinput'}
      onChange={onChange ? (event) => onChange(event.target.value) : undefined}
    />
  )
}

function DSelect({ id, value, onChange, options }: { id?: string; value: string; onChange: (value: string) => void; options: ReadonlyArray<{ value: string; label: string }> }) {
  return (
    <div className="admin-dselect-wrap">
      <select id={id} value={value} className="admin-dselect" onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
      <ChevronDown />
    </div>
  )
}

export function ModelConfigDialog({ manager }: { manager: ModelConfigManager }) {
  const { form } = manager
  const isEdit = Boolean(manager.editingId)
  const isImage = form.capability === 'image'
  const [advanced, setAdvanced] = useState(false)

  const set = (key: string, value: string | boolean) => manager.setForm({ ...form, [key]: value } as typeof form)
  const close = () => manager.setDialogOpen(false)

  const inputPrice = Number(form.input_price_per_million_cny || 0)
  const outputPrice = Number(form.output_price_per_million_cny || 0)
  const priceConfigured = inputPrice > 0 && outputPrice > 0
  const averagePrice = priceConfigured ? (inputPrice + outputPrice) / 2 : 0

  const onCapabilityChange = (capability: string) => {
    const slot = capability === 'image'
      ? IMAGE_DEFAULT_MODEL_ID
      : form.capability === 'image' && form.slot === IMAGE_DEFAULT_MODEL_ID
        ? ''
        : form.slot
    manager.setForm({ ...form, capability, slot })
  }

  return (
    <Dialog open={manager.dialogOpen} onOpenChange={manager.setDialogOpen}>
      <DialogContent showCloseButton={false} className="admin-model-drawer">
        <div className="admin-drawer-head">
          <div className="min-w-0">
            <DialogTitle className="admin-drawer-title">{isEdit ? '编辑模型' : '新增模型'}</DialogTitle>
            <DialogDescription className="admin-drawer-desc">
              {isEdit ? '改动保存后即时生效；API key 留空保持原值。' : '先选模板，再补连接与价格。三步即可上线。'}
            </DialogDescription>
          </div>
          <button type="button" className="admin-icon-action" aria-label="关闭" onClick={close}>
            <X />
          </button>
        </div>

        <div className="admin-drawer-body">
          {!isEdit ? (
            <div className="admin-tpl">
              <div className="admin-tpl-label">① 从模板开始</div>
              <div className="admin-tpl-grid">
                {MODEL_PRESETS.map((preset) => (
                  <button key={preset.id} type="button" className="admin-tpl-btn" onClick={() => manager.applyPreset(preset)}>
                    <div className="admin-tpl-btn-title">{preset.label}</div>
                    <div className="admin-tpl-btn-sub">{preset.helper}</div>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <section className="admin-drawer-section">
            <div className="admin-drawer-section-head">
              <h3 className="admin-drawer-section-title">{isEdit ? '模型身份' : '② 模型身份'}</h3>
              <div className="admin-drawer-section-toggle">
                启用
                <Toggle on={form.enabled} label="启用" onClick={() => set('enabled', !form.enabled)} />
              </div>
            </div>
            <div className="admin-drawer-row">
              <DField id="mc-cap" label="能力" width={150}>
                <DSelect id="mc-cap" value={form.capability} onChange={onCapabilityChange} options={CAPABILITY_OPTIONS} />
              </DField>
              <DField id="mc-slot" label="模型 ID" grow hint="用户端可见的唯一标识">
                {isImage ? (
                  <DInput id="mc-slot" value={IMAGE_DEFAULT_MODEL_ID} mono disabled />
                ) : (
                  <DInput id="mc-slot" value={form.slot} onChange={(value) => set('slot', value)} placeholder="gpt-4o / claude-sonnet / deepseek-v4" mono maxLength={40} />
                )}
              </DField>
            </div>
            <div className="admin-drawer-row">
              <DField id="mc-name" label="显示名" grow>
                <DInput id="mc-name" value={form.display_name} onChange={(value) => set('display_name', value)} placeholder="DeepSeek Pro" />
              </DField>
              <DField id="mc-tier" label="能力档位" width={140}>
                <DSelect id="mc-tier" value={form.capability_tier} onChange={(value) => set('capability_tier', value)} options={CAPABILITY_TIER_OPTIONS} />
              </DField>
            </div>
            <div className="admin-drawer-row">
              <DField id="mc-vendor" label="厂商" grow>
                <DInput id="mc-vendor" value={form.vendor} onChange={(value) => set('vendor', value)} placeholder="DeepSeek / ChatGPT / Claude" />
              </DField>
            </div>
            <DField id="mc-vendor-info" label="厂商简介" hint="鼠标悬浮厂商 info 时展示，例如：OpenAI 出品，通用能力全面。">
              <DInput id="mc-vendor-info" value={form.vendor_info} onChange={(value) => set('vendor_info', value)} placeholder="一句话介绍这个厂商 / 模型" />
            </DField>
          </section>

          <section className="admin-drawer-section">
            <div className="admin-drawer-section-head">
              <h3 className="admin-drawer-section-title">{isEdit ? '上游连接' : '③ 上游连接'}</h3>
            </div>
            <div className="admin-drawer-row">
              <DField id="mc-kind" label="Provider" width={180}>
                <DSelect id="mc-kind" value={form.provider_kind} onChange={(value) => set('provider_kind', value)} options={PROVIDER_KINDS.map((kind) => ({ value: kind, label: kind }))} />
              </DField>
              <DField id="mc-base" label="Base URL" grow>
                <DInput id="mc-base" value={form.base_url} onChange={(value) => set('base_url', value)} placeholder="https://api.deepseek.com" mono />
              </DField>
            </div>
            <div className="admin-drawer-row">
              <DField id="mc-model" label="上游模型名" grow>
                <DInput id="mc-model" value={form.model_name} onChange={(value) => set('model_name', value)} placeholder="deepseek-v4-pro" mono />
              </DField>
            </div>
            <DField id="mc-key" label="API Key" hint={isEdit ? '留空则保持原 key 不变 · 加密存储且不回显' : '加密存储且不回显'}>
              <DInput id="mc-key" type="password" value={form.api_key} onChange={(value) => set('api_key', value)} placeholder={manager.editingHasKey ? '•••••••• 留空不修改' : '输入 API key'} mono />
            </DField>
          </section>

          <section className="admin-drawer-section">
            <div className="admin-drawer-section-head">
              <h3 className="admin-drawer-section-title">{isEdit ? '计费' : '④ 计费'}</h3>
            </div>
            {!isImage ? (
              <>
                <div className="admin-drawer-row">
                  <DField id="mc-input-price" label="输入单价" grow hint="供应商成本价，¥ / 1M tokens">
                    <DInput id="mc-input-price" value={form.input_price_per_million_cny} onChange={(value) => set('input_price_per_million_cny', value)} placeholder="20" mono />
                  </DField>
                  <DField id="mc-output-price" label="输出单价" grow hint="供应商成本价，¥ / 1M tokens">
                    <DInput id="mc-output-price" value={form.output_price_per_million_cny} onChange={(value) => set('output_price_per_million_cny', value)} placeholder="80" mono />
                  </DField>
                </div>
                <div className="admin-drawer-row">
                  <DField id="mc-cache-read-price" label="缓存命中输入" grow hint="可选，留空沿用输入单价">
                    <DInput id="mc-cache-read-price" value={form.cached_input_price_per_million_cny} onChange={(value) => set('cached_input_price_per_million_cny', value)} placeholder="2" mono />
                  </DField>
                  <DField id="mc-cache-write-price" label="缓存写入输入" grow hint="可选，留空沿用输入单价">
                    <DInput id="mc-cache-write-price" value={form.cache_write_price_per_million_cny} onChange={(value) => set('cache_write_price_per_million_cny', value)} placeholder="20" mono />
                  </DField>
                </div>
                <div className="admin-est-box">
                  <span className="mono">{priceConfigured ? `avg ¥${formatPrice(averagePrice)} / 1M` : 'legacy multiplier fallback'}</span>
                  <span className="sep">·</span>
                  <span>最终扣费再乘以全局加价系数并换算 credits</span>
                </div>
              </>
            ) : (
              <div style={{ marginTop: 14 }}>
                <DField id="mc-price" label="每次金额（¥）">
                  <DInput id="mc-price" value={form.price_per_call_cny} onChange={(value) => set('price_per_call_cny', value)} placeholder="生图按每张图片金额换算 credits" mono />
                </DField>
              </div>
            )}

            <button type="button" className="admin-adv-toggle" onClick={() => setAdvanced((open) => !open)}>
              <Sliders />
              <span className="admin-adv-toggle-label">高级参数 · 旧倍率、排序、兼容兜底</span>
              {advanced ? <ChevronDown /> : <ChevronRight />}
            </button>
            {advanced ? (
              <div className="admin-adv-body">
                <div className="admin-drawer-row">
                  <DField id="mc-mult" label="基础倍率" grow hint="新费率留空时的兜底">
                    <DInput id="mc-mult" value={form.credit_multiplier} onChange={(value) => set('credit_multiplier', value)} mono />
                  </DField>
                  <DField id="mc-priority" label="优先级" grow hint="数字越小越靠前">
                    <DInput id="mc-priority" type="number" value={form.priority} onChange={(value) => set('priority', value)} placeholder="100" mono />
                  </DField>
                </div>
                <div className="admin-drawer-row">
                  <DField id="mc-input-mult" label="输入倍率" grow>
                    <DInput id="mc-input-mult" value={form.input_credit_multiplier} onChange={(value) => set('input_credit_multiplier', value)} placeholder="legacy = 1" mono />
                  </DField>
                  <DField id="mc-output-mult" label="输出倍率" grow>
                    <DInput id="mc-output-mult" value={form.output_credit_multiplier} onChange={(value) => set('output_credit_multiplier', value)} placeholder="通常高于输入倍率" mono />
                  </DField>
                </div>
                <div className="admin-drawer-row">
                  <DField id="mc-cache-read" label="缓存命中倍率" grow>
                    <DInput id="mc-cache-read" value={form.cached_input_credit_multiplier} onChange={(value) => set('cached_input_credit_multiplier', value)} placeholder="留空=沿用输入倍率" mono />
                  </DField>
                  <DField id="mc-cache-write" label="缓存写入倍率" grow>
                    <DInput id="mc-cache-write" value={form.cache_write_credit_multiplier} onChange={(value) => set('cache_write_credit_multiplier', value)} placeholder="留空=沿用输入倍率" mono />
                  </DField>
                </div>
                <DField id="mc-desc" label="Auto 路由描述">
                  <DInput id="mc-desc" value={form.description} onChange={(value) => set('description', value)} placeholder="速度快、成本低，适合日常任务" />
                </DField>
                {!isImage ? (
                  <DField id="mc-price" label="每次金额（¥）" hint="仅按次计费模型（如生图）填写">
                    <DInput id="mc-price" value={form.price_per_call_cny} onChange={(value) => set('price_per_call_cny', value)} placeholder="文本模型通常保持 0" mono />
                  </DField>
                ) : null}
              </div>
            ) : null}
          </section>
        </div>

        <div className="admin-drawer-foot">
          <span className="admin-drawer-foot-note">保存后即时生效</span>
          <div className="admin-drawer-foot-actions">
            <button type="button" className="admin-drawer-btn admin-drawer-btn-ghost" disabled={manager.saving} onClick={close}>
              取消
            </button>
            <button type="button" className="admin-drawer-btn admin-drawer-btn-primary" disabled={manager.saving} onClick={() => void manager.submitForm()}>
              {manager.saving ? <Loader2 className="size-4 animate-spin" /> : <Check />}
              保存
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
