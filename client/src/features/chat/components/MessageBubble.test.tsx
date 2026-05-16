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
    // Typing caret is on while streaming.
    expect(container.querySelector('.message-content.is-streaming')).toBeInTheDocument()
  })

  it('drops the streaming caret once the message is done', () => {
    const { container } = render(
      <I18nProvider>
        <MessageBubble message={message({ role: 'assistant', status: 'done', content: '完成。' })} />
      </I18nProvider>,
    )
    expect(container.querySelector('.message-content.is-streaming')).not.toBeInTheDocument()
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
