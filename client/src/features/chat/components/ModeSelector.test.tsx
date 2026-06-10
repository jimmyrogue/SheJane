import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/shared/i18n/i18n'
import { ModeSelector, type ModelOption } from './ModeSelector'

const MODELS: ModelOption[] = [
  { id: 'gpt-4o', label: 'GPT-4o', description: '通用强模型' },
  { id: 'claude-sonnet', label: 'Claude Sonnet', description: '复杂推理和长文' },
  { id: 'deepseek-v4', label: 'DeepSeek', description: '速度快、成本低' },
]

function renderSelector(mode: string, onChange = vi.fn()) {
  render(
    <I18nProvider>
      <ModeSelector mode={mode} models={MODELS} onChange={onChange} />
    </I18nProvider>,
  )
  return onChange
}

describe('ModeSelector (catalog-driven)', () => {
  afterEach(cleanup)

  it('shows the Auto label on the trigger when mode is auto', () => {
    renderSelector('auto')
    expect(screen.getByRole('button')).toHaveTextContent('Auto')
  })

  it('shows the selected model label on the trigger', () => {
    renderSelector('claude-sonnet')
    expect(screen.getByRole('button')).toHaveTextContent('Claude Sonnet')
  })

  it('lists Auto plus every catalog model and selects one', async () => {
    const onChange = renderSelector('auto')
    // Radix DropdownMenu opens on keyboard activation in jsdom (pointer events
    // don't fire) — mirror the ConversationSidebar account-menu test.
    const trigger = screen.getByRole('button')
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'Enter', code: 'Enter' })
    // Auto + all backend-provided catalog models render as options.
    expect(await screen.findByText('GPT-4o')).toBeInTheDocument()
    expect(screen.getByText('Claude Sonnet')).toBeInTheDocument()
    expect(screen.getByText('DeepSeek')).toBeInTheDocument()
    fireEvent.click(screen.getByText('GPT-4o'))
    expect(onChange).toHaveBeenCalledWith('gpt-4o')
  })

  it('falls back to the Auto label when the selected id is not in the catalog', () => {
    // A persisted model id that has since been removed from the catalog —
    // the trigger degrades to Auto rather than showing a blank/stale id.
    renderSelector('legacy-chat-model')
    expect(screen.getByRole('button')).toHaveTextContent('Auto')
  })
})
