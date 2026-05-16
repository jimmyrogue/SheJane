import { cleanup, render } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { ThinkingIndicator } from './ThinkingIndicator'
import { I18nProvider } from '@/shared/i18n/i18n'
import type { ChatMessage } from '@/shared/local-data/types'

afterEach(() => cleanup())

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm1',
    role: 'assistant',
    content: '',
    createdAt: new Date(Date.now() - 65_000).toISOString(),
    status: 'streaming',
    runId: 'run-1',
    runOrigin: 'local',
    agentEvents: [],
    ...overrides,
  }
}

function renderIndicator(node: ReactElement) {
  return render(<I18nProvider>{node}</I18nProvider>)
}

describe('ThinkingIndicator', () => {
  it('renders nothing for user messages', () => {
    const { container } = renderIndicator(
      <ThinkingIndicator message={message({ role: 'user', status: 'done' })} />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('shows a spinning logo and elapsed time while thinking', () => {
    const { container } = renderIndicator(<ThinkingIndicator message={message({ status: 'streaming' })} />)
    const logo = container.querySelector('.thinking-logo')
    expect(logo).toHaveAttribute('data-active', 'true')
    expect(container.querySelector('.thinking-time')?.textContent).toMatch(/1m\s\d+s/)
  })

  it('freezes and shows the paused label while waiting on the user', () => {
    const { container } = renderIndicator(
      <ThinkingIndicator message={message({ status: 'waiting_input' })} />,
    )
    const logo = container.querySelector('.thinking-logo')
    expect(logo).toHaveAttribute('data-active', 'false')
    expect(container.querySelector('.thinking-time')?.textContent).toBe('暂停')
  })

  it('sums llm.usage timeline items for a real-time running total', () => {
    const { container } = renderIndicator(
      <ThinkingIndicator
        message={message({
          status: 'streaming',
          agentEvents: [
            { type: 'llm.usage', label: '', tokens: 1200 },
            { type: 'tool.completed', label: '工具完成：读取文件', tool: 'fs.read' },
            { type: 'llm.usage', label: '', tokens: 2400 },
          ],
        })}
      />,
    )
    expect(container.querySelector('.thinking-time')?.textContent).toMatch(/· 3\.6k tokens$/)
  })

  it('shows only a static logo once finished with no usage', () => {
    const { container } = renderIndicator(<ThinkingIndicator message={message({ status: 'done' })} />)
    const logo = container.querySelector('.thinking-logo')
    expect(logo).toBeInTheDocument()
    expect(logo).toHaveAttribute('data-active', 'false')
    expect(container.querySelector('.thinking-time')).toBeNull()
  })

  it('keeps this turn token total next to the static logo after completion', () => {
    const { container } = renderIndicator(
      <ThinkingIndicator
        message={message({
          status: 'done',
          tokens: 999_999,
          agentEvents: [
            { type: 'llm.usage', label: '', tokens: 100_000 },
            { type: 'llm.usage', label: '', tokens: 77_600 },
          ],
        })}
      />,
    )
    expect(container.querySelector('.thinking-logo')).toHaveAttribute('data-active', 'false')
    // Sums only this turn's llm.usage (ignores any conversation-wide field).
    expect(container.querySelector('.thinking-time')?.textContent).toBe('177.6k tokens')
  })
})
