import type { AdminModelConfig } from '@/shared/api/client'

export type ModelTab = 'catalog' | 'billing'

export type ModelPreset = {
  id: string
  label: string
  helper: string
  patch: Partial<ModelConfigForm>
}

export interface ModelConfigForm {
  slot: string
  capability: string
  provider_kind: string
  display_name: string
  vendor: string
  vendor_info: string
  capability_tier: string
  description: string
  priority: string
  base_url: string
  model_name: string
  credit_multiplier: string
  input_credit_multiplier: string
  output_credit_multiplier: string
  cached_input_credit_multiplier: string
  cache_write_credit_multiplier: string
  price_per_call_cny: string
  enabled: boolean
  api_key: string
}

export type ModelStats = {
  enabled: number
  keyConfigured: number
  vendors: string[]
}

export type ModelConfigManager = {
  dialogOpen: boolean
  editingId: string | null
  form: ModelConfigForm
  editingHasKey: boolean
  saving: boolean
  markupInput: string
  rateInput: string
  rateCurrency: string
  rateSaving: boolean
  tavilyInput: string
  e2bBaseInput: string
  e2bPerSecInput: string
  leversSaving: boolean
  modelTab: ModelTab
  catalogQuery: string
  vendorFilter: string
  modelStats: ModelStats
  visibleConfigs: AdminModelConfig[]
  setDialogOpen: (open: boolean) => void
  setForm: (form: ModelConfigForm | ((current: ModelConfigForm) => ModelConfigForm)) => void
  setMarkupInput: (value: string) => void
  setRateInput: (value: string) => void
  setRateCurrency: (value: string) => void
  setTavilyInput: (value: string) => void
  setE2bBaseInput: (value: string) => void
  setE2bPerSecInput: (value: string) => void
  setModelTab: (tab: ModelTab) => void
  setCatalogQuery: (value: string) => void
  setVendorFilter: (value: string) => void
  openEdit: (cfg: AdminModelConfig) => void
  applyPreset: (preset: ModelPreset) => void
  submitForm: () => Promise<void>
  toggleEnabled: (cfg: AdminModelConfig) => Promise<void>
  removeConfig: (cfg: AdminModelConfig) => Promise<void>
  saveRate: () => Promise<void>
  saveLevers: () => Promise<void>
}

export function emptyModelForm(): ModelConfigForm {
  return {
    slot: '',
    capability: 'chat',
    provider_kind: 'openai-compatible',
    display_name: '',
    vendor: '',
    vendor_info: '',
    capability_tier: 'balanced',
    description: '',
    priority: '0',
    base_url: '',
    model_name: '',
    credit_multiplier: '1',
    input_credit_multiplier: '1',
    output_credit_multiplier: '1',
    cached_input_credit_multiplier: '',
    cache_write_credit_multiplier: '1',
    price_per_call_cny: '0',
    enabled: true,
    api_key: '',
  }
}
