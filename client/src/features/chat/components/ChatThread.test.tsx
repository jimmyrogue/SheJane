import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/shared/i18n/i18n'
import type { Conversation } from '@/shared/local-data/types'
import { ChatThread } from './ChatThread'

describe('ChatThread streaming display cache', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('does not replay already displayed streaming text after switching conversations', () => {
    vi.useFakeTimers()
    const { rerender } = renderThread(conversationWithStreamingAnswer('第一段。'))

    act(() => {
      vi.advanceTimersByTime(90)
    })
    expect(document.body).toHaveTextContent('第一段。')

    rerender(renderThreadElement(emptyConversation('conv-empty')))
    expect(document.body).not.toHaveTextContent('第一段。')

    rerender(renderThreadElement(conversationWithStreamingAnswer('第一段。第二段。')))
    expect(document.body).toHaveTextContent('第一段。')
    expect(document.body).not.toHaveTextContent('第二段。')

    act(() => {
      vi.advanceTimersByTime(90)
    })
    expect(document.body).toHaveTextContent('第二段。')
  })

  it('uses the collapsed reasoning disclosure as the only thinking indicator', () => {
    renderThread(conversationWithReasoningAnswer())

    expect(screen.getAllByText('正在思考…')).toHaveLength(1)
    expect(document.querySelector('.message-reasoning')).not.toHaveAttribute('open')
    expect(document.querySelector('.thinking-indicator')).not.toBeInTheDocument()
  })
})

function renderThread(conversation: Conversation) {
  return render(renderThreadElement(conversation))
}

function renderThreadElement(conversation: Conversation) {
  return (
    <I18nProvider>
      <ChatThread
        conversation={conversation}
        onOpenArtifact={() => undefined}
        onOpenDiagnostics={() => undefined}
      />
    </I18nProvider>
  )
}

function emptyConversation(id: string): Conversation {
  return {
    id,
    title: '空对话',
    archived: false,
    createdAt: '2026-05-10T00:00:00Z',
    updatedAt: '2026-05-10T00:00:00Z',
    messages: [],
  }
}

function conversationWithStreamingAnswer(content: string): Conversation {
  return {
    id: 'conv-old',
    title: '旧任务',
    archived: false,
    createdAt: '2026-05-10T00:00:00Z',
    updatedAt: '2026-05-10T00:00:00Z',
    messages: [
      {
        id: 'msg-user',
        role: 'user',
        content: '旧任务',
        createdAt: '2026-05-10T00:00:00Z',
        status: 'done',
      },
      {
        id: 'msg-assistant',
        role: 'assistant',
        content,
        createdAt: '2026-05-10T00:00:01Z',
        status: 'streaming',
      },
    ],
  }
}

function conversationWithReasoningAnswer(): Conversation {
  return {
    id: 'conv-reasoning',
    title: '思考任务',
    archived: false,
    createdAt: '2026-05-10T00:00:00Z',
    updatedAt: '2026-05-10T00:00:00Z',
    messages: [
      {
        id: 'msg-user',
        role: 'user',
        content: '帮我查一下新闻',
        createdAt: '2026-05-10T00:00:00Z',
        status: 'done',
      },
      {
        id: 'msg-assistant',
        role: 'assistant',
        content: '',
        reasoning: 'Need to search first.',
        createdAt: '2026-05-10T00:00:01Z',
        status: 'streaming',
      },
    ],
  }
}
