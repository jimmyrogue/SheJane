export const PROVIDER_KINDS = ['openai-compatible', 'deepseek-v4', 'anthropic', 'mock'] as const

export const CAPABILITY_OPTIONS = [
  { value: 'chat', label: '对话 (chat)' },
  { value: 'image', label: '生图 (image)' },
] as const

export const CAPABILITY_TIER_OPTIONS = [
  { value: 'fast', label: '快速' },
  { value: 'balanced', label: '均衡' },
  { value: 'reasoning', label: '推理' },
  { value: 'max', label: '最强' },
] as const

export const IMAGE_DEFAULT_MODEL_ID = 'image.default'
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'

export const SELECT_CLASS =
  'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
