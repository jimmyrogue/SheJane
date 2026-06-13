import { CAPABILITY_TIER_OPTIONS } from '../model/model-options'

export function formatSignedNumber(value: number): string {
  return value > 0 ? `+${formatNumber(value)}` : formatNumber(value)
}

export function formatNumber(value: number) {
  return new Intl.NumberFormat('zh-CN').format(value)
}

export function formatMultiplier(value: number) {
  return Number.isFinite(value) ? Number(value.toFixed(4)).toString() : '0'
}

export function formatCapabilityTier(value?: string) {
  return CAPABILITY_TIER_OPTIONS.find((option) => option.value === value)?.label ?? '均衡'
}

export function formatCurrency(amountCents: number) {
  return `¥${(amountCents / 100).toFixed(2)}`
}

export function formatDateTime(value?: string) {
  if (!value) {
    return '-'
  }
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

export function formatMetadata(value: string) {
  if (!value) {
    return ''
  }
  try {
    return JSON.stringify(JSON.parse(value))
  } catch {
    return value
  }
}
