import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageBubble } from './MessageBubble'
import { I18nProvider } from '@/shared/i18n/i18n'
import type { ChatMessage } from '@/shared/local-data/types'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm1',
    role: 'assistant',
    content: '今天杭州多云。',
    createdAt: new Date().toISOString(),
    status: 'done',
    ...overrides,
  }
}

describe('MessageBubble meta', () => {
  it('renders Markdown live while streaming (no raw ** flash)', () => {
    vi.useFakeTimers()
    const { container } = render(
      <I18nProvider>
        <MessageBubble message={message({ role: 'assistant', status: 'streaming', content: '**你好**' })} />
      </I18nProvider>,
    )

    act(() => {
      vi.advanceTimersByTime(5000)
    })

    expect(container.querySelector('strong')?.textContent).toBe('你好')
    expect(screen.queryByText('**你好**')).not.toBeInTheDocument()
  })

  it('treats a single newline as a line break (remark-breaks)', () => {
    const { container } = render(
      <I18nProvider>
        <MessageBubble message={message({ role: 'assistant', status: 'done', content: '第一行\n第二行' })} />
      </I18nProvider>,
    )
    expect(container.querySelector('br')).toBeInTheDocument()
    const paragraphText = container.querySelector('p')?.textContent ?? ''
    expect(paragraphText).toContain('第一行')
    expect(paragraphText).toContain('第二行')
  })

  it('normalizes ad-hoc heading levels on the finished message', () => {
    const { container } = render(
      <I18nProvider>
        <MessageBubble message={message({ role: 'assistant', status: 'done', content: '### 标题\n正文' })} />
      </I18nProvider>,
    )
    // remark-normalize-headings (finished path) rebalances a lone `###` to h1.
    expect(container.querySelector('h1')?.textContent).toBe('标题')
    expect(container.querySelector('h3')).not.toBeInTheDocument()
  })

  it('shows the relative time and copies the message content', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })

    render(
      <I18nProvider>
        <MessageBubble message={message()} />
      </I18nProvider>,
    )

    expect(screen.getByText('刚刚')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '复制' }))
    expect(writeText).toHaveBeenCalledWith('今天杭州多云。')
    await waitFor(() => expect(screen.getByRole('button', { name: '已复制' })).toBeInTheDocument())
  })

  it('also lets the user message be copied', () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })

    render(
      <I18nProvider>
        <MessageBubble message={message({ role: 'user', content: '杭州天气怎么样' })} />
      </I18nProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: '复制' }))
    expect(writeText).toHaveBeenCalledWith('杭州天气怎么样')
  })

  it('omits the copy action when there is no content', () => {
    render(
      <I18nProvider>
        <MessageBubble message={message({ content: '' })} />
      </I18nProvider>,
    )
    expect(screen.queryByRole('button', { name: '复制' })).not.toBeInTheDocument()
    expect(screen.getByText('刚刚')).toBeInTheDocument()
  })
})
