import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/shared/i18n/i18n'
import { ModeSelector, type ModelOption } from './ModeSelector'

const MODELS: ModelOption[] = [
  { id: 'gpt-4o', label: 'GPT-4o', vendor: 'ChatGPT', capability_tier: 'max', description: '通用强模型' },
  { id: 'claude-sonnet', label: 'Claude Sonnet', vendor: 'Claude', capability_tier: 'reasoning', description: '复杂推理和长文' },
  { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', vendor: 'DeepSeek', capability_tier: 'fast', description: '速度快、成本低' },
  { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', vendor: 'DeepSeek', capability_tier: 'max', description: '复杂推理' },
]

function renderSelector(mode: string, onChange = vi.fn()) {
  render(
    <I18nProvider>
      <ModeSelector mode={mode} models={MODELS} onChange={onChange} />
    </I18nProvider>,
  )
  return onChange
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
      <I18nProvider>
        <ModeSelector mode="deep-compatible" models={longModels} onChange={vi.fn()} />
      </I18nProvider>,
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
