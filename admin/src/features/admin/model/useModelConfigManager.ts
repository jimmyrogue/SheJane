import { useEffect, useMemo, useRef, useState } from 'react'
import {
  type AdminAPI,
  type AdminBillingLevers,
  type AdminCreditRate,
  type AdminModelConfig,
  type ModelConfigInput,
} from '@/shared/api/client'
import { IMAGE_DEFAULT_MODEL_ID } from './model-options'
import { emptyModelForm, type ModelConfigForm, type ModelPreset, type ModelTab } from './types'

export function useModelConfigManager({
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
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<ModelConfigForm>(emptyModelForm())
  const [editingHasKey, setEditingHasKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [markupInput, setMarkupInput] = useState('1.15')
  const [rateInput, setRateInput] = useState('')
  const [rateCurrency, setRateCurrency] = useState('cny')
  const [rateSaving, setRateSaving] = useState(false)
  const [tavilyInput, setTavilyInput] = useState('')
  const [e2bBaseInput, setE2bBaseInput] = useState('')
  const [e2bPerSecInput, setE2bPerSecInput] = useState('')
  const [leversSaving, setLeversSaving] = useState(false)
  const [modelTab, setModelTab] = useState<ModelTab>('catalog')
  const [catalogQuery, setCatalogQuery] = useState('')
  const [vendorFilter, setVendorFilter] = useState('all')

  // Open the create drawer only when the nonce actually changes (i.e. the user
  // clicked 新增模型) — NOT on mount. This component lives in a Tabs panel that
  // remounts every time the 模型 tab is re-entered; seeding the ref with the
  // current nonce keeps a remount from auto-opening the drawer.
  const lastCreateNonce = useRef(createRequestNonce)
  useEffect(() => {
    if (createRequestNonce !== lastCreateNonce.current) {
      lastCreateNonce.current = createRequestNonce
      if (createRequestNonce > 0) {
        openCreate()
      }
    }
  }, [createRequestNonce])

  useEffect(() => {
    if (creditRate) {
      setMarkupInput(creditRate.markup_factor ? String(creditRate.markup_factor) : '1.15')
      setRateInput(creditRate.currency_per_credit ? String(creditRate.currency_per_credit) : '')
      setRateCurrency(creditRate.currency || 'cny')
    }
  }, [creditRate])

  useEffect(() => {
    if (billingLevers) {
      setTavilyInput(billingLevers.tavily_search_credits ? String(billingLevers.tavily_search_credits) : '')
      setE2bBaseInput(billingLevers.e2b_code_exec_base_credits ? String(billingLevers.e2b_code_exec_base_credits) : '')
      setE2bPerSecInput(
        billingLevers.e2b_code_exec_per_second_credits ? String(billingLevers.e2b_code_exec_per_second_credits) : '',
      )
    }
  }, [billingLevers])

  function openCreate() {
    setEditingId(null)
    setEditingHasKey(false)
    setForm(emptyModelForm())
    setDialogOpen(true)
  }

  function openEdit(cfg: AdminModelConfig) {
    setEditingId(cfg.id)
    setEditingHasKey(cfg.api_key_configured)
    setForm({
      slot: cfg.slot,
      capability: cfg.capability,
      provider_kind: cfg.provider_kind,
      display_name: cfg.display_name,
      vendor: cfg.vendor ?? '',
      vendor_info: cfg.vendor_info ?? '',
      capability_tier: cfg.capability_tier || 'balanced',
      description: cfg.description ?? '',
      priority: String(cfg.priority ?? 0),
      base_url: cfg.base_url,
      model_name: cfg.model_name,
      credit_multiplier: String(cfg.credit_multiplier),
      input_credit_multiplier: String(cfg.input_credit_multiplier || cfg.credit_multiplier || 1),
      output_credit_multiplier: String(cfg.output_credit_multiplier || cfg.credit_multiplier || 1),
      cached_input_credit_multiplier: cfg.cached_input_credit_multiplier ? String(cfg.cached_input_credit_multiplier) : '',
      cache_write_credit_multiplier: String(cfg.cache_write_credit_multiplier || cfg.input_credit_multiplier || cfg.credit_multiplier || 1),
      price_per_call_cny: String(cfg.price_per_call_cny ?? 0),
      enabled: cfg.enabled,
      api_key: '',
    })
    setDialogOpen(true)
  }

  function applyPreset(preset: ModelPreset) {
    setForm((current) => ({
      ...current,
      ...preset.patch,
      slot: preset.patch.capability === 'image'
        ? IMAGE_DEFAULT_MODEL_ID
        : preset.patch.slot ?? current.slot,
    }))
  }

  async function submitForm() {
    const multiplier = Number(form.credit_multiplier)
    const parseTokenMultiplier = (raw: string, label: string): number | null => {
      const trimmed = raw.trim()
      if (!trimmed) return 0
      const n = Number(trimmed)
      if (!Number.isFinite(n) || n < 0) {
        onNotice(`${label}必须是非负数字；留空或 0 表示沿用基础倍率`)
        return null
      }
      return n
    }
    const modelID = form.capability === 'image' ? IMAGE_DEFAULT_MODEL_ID : form.slot.trim()
    if (!modelID || !form.provider_kind.trim()) {
      onNotice('模型 ID 与 provider_kind 必填')
      return
    }
    if (!Number.isFinite(multiplier) || multiplier <= 0) {
      onNotice('基础倍率必须是大于 0 的数字')
      return
    }
    const inputMultiplier = parseTokenMultiplier(form.input_credit_multiplier, '输入 token 倍率')
    if (inputMultiplier === null) return
    const outputMultiplier = parseTokenMultiplier(form.output_credit_multiplier, '输出 token 倍率')
    if (outputMultiplier === null) return
    const cachedInputMultiplier = parseTokenMultiplier(form.cached_input_credit_multiplier, '缓存命中 token 倍率')
    if (cachedInputMultiplier === null) return
    const cacheWriteMultiplier = parseTokenMultiplier(form.cache_write_credit_multiplier, '缓存写入 token 倍率')
    if (cacheWriteMultiplier === null) return
    const payload: ModelConfigInput = {
      slot: modelID,
      capability: form.capability.trim() || 'chat',
      provider_kind: form.provider_kind,
      display_name: form.display_name.trim(),
      vendor: form.vendor.trim(),
      vendor_info: form.vendor_info.trim(),
      capability_tier: form.capability_tier,
      description: form.description.trim(),
      priority: Math.trunc(Number(form.priority)) || 0,
      base_url: form.base_url.trim(),
      model_name: form.model_name.trim(),
      credit_multiplier: multiplier,
      input_credit_multiplier: inputMultiplier,
      output_credit_multiplier: outputMultiplier,
      cached_input_credit_multiplier: cachedInputMultiplier,
      cache_write_credit_multiplier: cacheWriteMultiplier,
      price_per_call_cny: Number(form.price_per_call_cny) || 0,
      enabled: form.enabled,
    }
    if (form.api_key.trim()) {
      payload.api_key = form.api_key.trim()
    }
    setSaving(true)
    try {
      if (editingId) {
        await api.adminUpdateModelConfig(editingId, payload)
      } else {
        await api.adminCreateModelConfig(payload)
      }
      await onReload()
      setDialogOpen(false)
      onNotice('模型配置已保存并即时生效')
    } catch (caught) {
      onNotice(caught instanceof Error ? caught.message : '保存模型配置失败')
    } finally {
      setSaving(false)
    }
  }

  async function toggleEnabled(cfg: AdminModelConfig) {
    try {
      await api.adminToggleModelConfig(cfg.id, !cfg.enabled)
      await onReload()
      onNotice(cfg.enabled ? '已停用该模型' : '已启用该模型')
    } catch (caught) {
      onNotice(caught instanceof Error ? caught.message : '更新状态失败')
    }
  }

  async function removeConfig(cfg: AdminModelConfig) {
    if (!window.confirm(`确认删除模型配置「${cfg.display_name || cfg.slot}」？`)) {
      return
    }
    try {
      await api.adminDeleteModelConfig(cfg.id)
      await onReload()
      onNotice('模型配置已删除')
    } catch (caught) {
      onNotice(caught instanceof Error ? caught.message : '删除失败')
    }
  }

  async function saveRate() {
    const markup = Number(markupInput)
    if (!Number.isFinite(markup) || markup < 1 || markup > 3) {
      onNotice('加价系数必须在 1.0–3.0 之间（1.15 = 加价 15%）')
      return
    }
    const value = Number(rateInput || 0)
    if (!Number.isFinite(value) || value < 0) {
      onNotice('基准每 token 成本不能为负')
      return
    }
    setRateSaving(true)
    try {
      await api.adminSetCreditRate({ markup_factor: markup, currency_per_credit: value, currency: rateCurrency.trim() || 'cny' })
      await onReload()
      onNotice('计费参数已更新并即时生效')
    } catch (caught) {
      onNotice(caught instanceof Error ? caught.message : '保存计费参数失败')
    } finally {
      setRateSaving(false)
    }
  }

  async function saveLevers() {
    const parseLever = (raw: string, label: string): number | null => {
      const n = Number(raw || 0)
      if (!Number.isFinite(n) || n < 0 || n > 1_000_000) {
        onNotice(`${label}必须在 0–1000000 credits 之间（0 表示沿用环境默认值）`)
        return null
      }
      return Math.floor(n)
    }
    const tavily = parseLever(tavilyInput, 'web.search 每次费用')
    if (tavily === null) return
    const e2bBase = parseLever(e2bBaseInput, 'code.execute 基础费用')
    if (e2bBase === null) return
    const e2bPerSec = parseLever(e2bPerSecInput, 'code.execute 每秒费用')
    if (e2bPerSec === null) return
    setLeversSaving(true)
    try {
      await api.adminSetBillingLevers({
        tavily_search_credits: tavily,
        e2b_code_exec_base_credits: e2bBase,
        e2b_code_exec_per_second_credits: e2bPerSec,
      })
      await onReload()
      onNotice('工具计费杠杆已更新并即时生效')
    } catch (caught) {
      onNotice(caught instanceof Error ? caught.message : '保存工具计费杠杆失败')
    } finally {
      setLeversSaving(false)
    }
  }

  const modelStats = useMemo(() => {
    let enabled = 0
    let keyConfigured = 0
    const vendors = new Set<string>()
    for (const cfg of configs) {
      if (cfg.enabled) enabled += 1
      if (cfg.api_key_configured) keyConfigured += 1
      vendors.add(cfg.vendor || '其他')
    }
    return { enabled, keyConfigured, vendors: Array.from(vendors) }
  }, [configs])

  const visibleConfigs = useMemo(() => {
    const q = catalogQuery.trim().toLowerCase()
    return configs.filter((cfg) => {
      const vendor = cfg.vendor || '其他'
      const matchesVendor = vendorFilter === 'all' || (vendorFilter === 'off' ? !cfg.enabled : vendor === vendorFilter)
      const matchesQuery = !q
        || cfg.slot.toLowerCase().includes(q)
        || (cfg.display_name || '').toLowerCase().includes(q)
        || (cfg.model_name || '').toLowerCase().includes(q)
        || vendor.toLowerCase().includes(q)
      return matchesVendor && matchesQuery
    })
  }, [catalogQuery, configs, vendorFilter])

  return {
    dialogOpen,
    editingId,
    form,
    editingHasKey,
    saving,
    markupInput,
    rateInput,
    rateCurrency,
    rateSaving,
    tavilyInput,
    e2bBaseInput,
    e2bPerSecInput,
    leversSaving,
    modelTab,
    catalogQuery,
    vendorFilter,
    modelStats,
    visibleConfigs,
    setDialogOpen,
    setForm,
    setMarkupInput,
    setRateInput,
    setRateCurrency,
    setTavilyInput,
    setE2bBaseInput,
    setE2bPerSecInput,
    setModelTab,
    setCatalogQuery,
    setVendorFilter,
    openEdit,
    applyPreset,
    submitForm,
    toggleEnabled,
    removeConfig,
    saveRate,
    saveLevers,
  }
}
