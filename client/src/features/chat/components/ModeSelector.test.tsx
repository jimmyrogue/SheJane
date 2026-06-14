import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { I18nProvider } from '@/shared/i18n/i18n'
import { ModeSelector, type ModelOption } from './ModeSelector'

const MODELS: ModelOption[] = [
  { id: 'gpt-4o', label: 'GPT-4o', vendor: 'ChatGPT', capability_tier: 'max', description: '通用强模型', input_price_per_million_cny: 12, output_price_per_million_cny: 48, cached_input_price_per_million_cny: 1.5, cache_write_price_per_million_cny: 12 },
  { id: 'claude-sonnet', label: 'Claude Sonnet', vendor: 'Claude', capability_tier: 'reasoning', description: '复杂推理和长文', input_price_per_million_cny: 24, output_price_per_million_cny: 120 },
  { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', vendor: 'DeepSeek', capability_tier: 'fast', description: '速度快、成本低', input_price_per_million_cny: 1, output_price_per_million_cny: 2 },
  { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', vendor: 'DeepSeek', capability_tier: 'max', description: '复杂推理', input_price_per_million_cny: 4, output_price_per_million_cny: 16 },
]

function renderSelector(mode: string, onChange = vi.fn()) {
  render(
    withProviders(<ModeSelector mode={mode} models={MODELS} onChange={onChange} />),
  )
  return onChange
}

function withProviders(children: ReactNode) {
  return (
    <I18nProvider>
      <TooltipProvider>{children}</TooltipProvider>
    </I18nProvider>
  )
}

function openMenu() {
  const trigger = screen.getByRole('button')
  trigger.focus()
  fireEvent.keyDown(trigger, { key: 'Enter', code: 'Enter' })
}

describe('ModeSelector (catalog-driven)', () => {
  afterEach(cleanup)

  it('shows the Auto label on the trigger when mode is auto', () => {
    renderSelector('auto')
    expect(screen.getByRole('button')).toHaveTextContent('自动')
  })

  it('shows the selected model label on the trigger', () => {
    renderSelector('claude-sonnet')
    expect(screen.getByRole('button')).toHaveTextContent('Claude Sonnet')
  })

  it('keeps the full selected model label available for long names', () => {
    const longModels: ModelOption[] = [{ id: 'deep-compatible', label: 'deep-compatible', vendor: 'DeepSeek', description: '兼容模式' }]
    render(
      withProviders(
        <ModeSelector mode="deep-compatible" models={longModels} onChange={vi.fn()} />
      ),
    )

    const trigger = screen.getByRole('button', { name: '选择模型' })
    expect(trigger).toHaveTextContent('deep-compatible')
    expect(trigger).toHaveAttribute('title', 'deep-compatible')
    expect(screen.getByText('deep-compatible')).toHaveClass('composer-mode-trigger-label')
  })

  it('lists Auto plus intent shortcuts first and keeps concrete models behind the model list view', async () => {
    renderSelector('auto')
    openMenu()

    expect(await screen.findAllByText('自动')).toHaveLength(2)
    expect(screen.getByText('为每个任务挑选最合适的模型')).toBeInTheDocument()
    expect(screen.getByText('更快')).toBeInTheDocument()
    expect(screen.getByText('更强')).toBeInTheDocument()
    expect(screen.getByText('选择具体模型')).toBeInTheDocument()
    expect(screen.queryByText('ChatGPT')).not.toBeInTheDocument()
    expect(screen.queryByText('GPT-4o')).not.toBeInTheDocument()
    expect(screen.queryByText('DeepSeek V4 Flash')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('选择具体模型'))

    expect(await screen.findByText('具体模型')).toBeInTheDocument()
    expect(screen.getByText('ChatGPT')).toBeInTheDocument()
    expect(screen.getByText('Claude')).toBeInTheDocument()
    expect(screen.getByText('DeepSeek')).toBeInTheDocument()
    expect(screen.getByText('GPT-4o')).toBeInTheDocument()
    expect(screen.getByText('DeepSeek V4 Flash')).toBeInTheDocument()
  })

  it('normalizes known vendor casing in the concrete model list', async () => {
    render(
      withProviders(
        <ModeSelector
          mode="auto"
          models={[
            { id: 'mimo-v2-5', label: 'Mimo V2.5', vendor: 'xiaomi', capability_tier: 'balanced' },
            { id: 'kimi-k2', label: 'Kimi K2', vendor: 'kimi', capability_tier: 'reasoning' },
            { id: 'minimax-m3', label: 'MiniMax M3', vendor: 'Minimax', capability_tier: 'reasoning' },
          ]}
          onChange={vi.fn()}
        />
      ),
    )
    openMenu()
    fireEvent.click(screen.getByText('选择具体模型'))

    expect(await screen.findByText('Xiaomi')).toBeInTheDocument()
    expect(screen.getByText('Kimi')).toBeInTheDocument()
    expect(screen.getByText('MiniMax')).toBeInTheDocument()
  })

  it('uses catalog vendor_info for the vendor info tooltip', async () => {
    render(
      withProviders(
        <ModeSelector
          mode="auto"
          models={[
            {
              id: 'deepseek-v4-pro',
              label: 'DeepSeek V4 Pro',
              vendor: 'DeepSeek',
              vendor_info: '数据库里的 DeepSeek 厂商简介',
              capability_tier: 'reasoning',
            },
          ]}
          onChange={vi.fn()}
        />
      ),
    )
    openMenu()
    fireEvent.click(screen.getByText('选择具体模型'))

    const info = await screen.findByLabelText('数据库里的 DeepSeek 厂商简介')
    expect(info).toHaveAttribute('title', '数据库里的 DeepSeek 厂商简介')
  })

  it('shows model token prices from the catalog in an icon tooltip trigger', async () => {
    renderSelector('auto')
    openMenu()
    fireEvent.click(await screen.findByText('选择具体模型'))

    const gptPrice = await screen.findByLabelText('GPT-4o 模型价格: 输入 ¥12，输出 ¥48，缓存命中 ¥1.5，缓存写入 ¥12')
    expect(gptPrice).toHaveClass('composer-mode-price-info-trigger')

    // Cache prices fall back to input price when the catalog leaves them empty.
    expect(screen.getByLabelText('Claude Sonnet 模型价格: 输入 ¥24，输出 ¥120，缓存命中 ¥24，缓存写入 ¥24')).toBeInTheDocument()
  })

  it('maps intent shortcuts to Auto intent sentinel modes', async () => {
    const onChange = renderSelector('auto')
    openMenu()

    fireEvent.click(await screen.findByText('更快'))
    expect(onChange).toHaveBeenCalledWith('auto.fast')

    cleanup()
    const onStrongChange = renderSelector('auto')
    openMenu()

    fireEvent.click(await screen.findByText('更强'))
    expect(onStrongChange).toHaveBeenCalledWith('auto.smart')
  })

  it('shows Auto intent labels when a sentinel mode is selected', () => {
    renderSelector('auto.fast')
    expect(screen.getByRole('button')).toHaveTextContent('更快')

    cleanup()
    renderSelector('auto.smart')
    expect(screen.getByRole('button')).toHaveTextContent('更强')
  })

  it('falls back to the Auto label when the selected id is not in the catalog', () => {
    // A persisted model id that has since been removed from the catalog —
    // the trigger degrades to Auto rather than showing a blank/stale id.
    renderSelector('legacy-chat-model')
    expect(screen.getByRole('button')).toHaveTextContent('自动')
  })
})
