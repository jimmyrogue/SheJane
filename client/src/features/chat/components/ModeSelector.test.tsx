import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/shared/i18n/i18n'
import { ModeSelector, type ModelOption } from './ModeSelector'

const MODELS: ModelOption[] = [
  { id: 'chat.fast', label: '快速', description: '速度快、成本低' },
  { id: 'chat.deep', label: '深度', description: '推理更强' },
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
    renderSelector('chat.deep')
    expect(screen.getByRole('button')).toHaveTextContent('深度')
  })

  it('lists Auto plus every catalog model and selects one', async () => {
    const onChange = renderSelector('auto')
    // Radix DropdownMenu opens on keyboard activation in jsdom (pointer events
    // don't fire) — mirror the ConversationSidebar account-menu test.
    const trigger = screen.getByRole('button')
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'Enter', code: 'Enter' })
    // Auto + the two models all render as options.
    expect(await screen.findByText('快速')).toBeInTheDocument()
    expect(screen.getByText('深度')).toBeInTheDocument()
    fireEvent.click(screen.getByText('深度'))
    expect(onChange).toHaveBeenCalledWith('chat.deep')
  })

  it('falls back to the Auto label when the selected id is not in the catalog', () => {
    // A persisted model id that has since been removed from the catalog —
    // the trigger degrades to Auto rather than showing a blank/stale id.
    renderSelector('chat.removed')
    expect(screen.getByRole('button')).toHaveTextContent('Auto')
  })
})
