import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { I18nProvider } from '@/shared/i18n/i18n'
import { ModeSelector, type ModelOption } from './ModeSelector'

const MODELS: ModelOption[] = [
  { id: 'local:openai:gpt-4o', label: 'GPT-4o', vendor: 'OpenAI', capability_tier: 'max', input_price_per_million_cny: 12, output_price_per_million_cny: 48 },
  { id: 'local:ollama:qwen3', label: 'Qwen 3', vendor: 'Ollama', capability_tier: 'reasoning' },
]

function withProviders(children: ReactNode) {
  return <I18nProvider><TooltipProvider>{children}</TooltipProvider></I18nProvider>
}

function renderSelector(mode: string, onChange = vi.fn()) {
  render(withProviders(<ModeSelector mode={mode} models={MODELS} onChange={onChange} />))
  return onChange
}

function openMenu() {
  const trigger = screen.getByRole('button')
  trigger.focus()
  fireEvent.keyDown(trigger, { key: 'Enter', code: 'Enter' })
}

describe('ModeSelector (Runtime catalog)', () => {
  afterEach(cleanup)

  it('shows the selected Runtime model', () => {
    renderSelector('local:openai:gpt-4o')
    expect(screen.getByRole('button')).toHaveTextContent('GPT-4o')
  })

  it('shows a model-selection prompt for a stale selection', () => {
    renderSelector('local:removed:model')
    expect(screen.getByRole('button')).toHaveTextContent('选择具体模型')
  })

  it('lists concrete Runtime models directly', async () => {
    renderSelector('local:openai:gpt-4o')
    openMenu()
    expect((await screen.findAllByText('GPT-4o')).length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('Qwen 3')).toBeInTheDocument()
    expect(screen.queryByText('自动')).not.toBeInTheDocument()
  })

  it('selects a concrete model', async () => {
    const onChange = renderSelector('local:openai:gpt-4o')
    openMenu()
    fireEvent.click(await screen.findByText('Qwen 3'))
    expect(onChange).toHaveBeenCalledWith('local:ollama:qwen3')
  })

  it('shows catalog price information', async () => {
    renderSelector('local:openai:gpt-4o')
    openMenu()
    expect(await screen.findByLabelText('GPT-4o 模型价格: 输入 ¥12，输出 ¥48，缓存命中 ¥12，缓存写入 ¥12')).toBeInTheDocument()
  })
})
