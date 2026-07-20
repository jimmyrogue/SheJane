import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AnsweredQuestions } from './AnsweredQuestions'
import { I18nProvider } from '@/shared/i18n/i18n'
import type { ChatMessage } from '@/shared/local-data/types'

afterEach(() => cleanup())

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm1',
    role: 'assistant',
    content: '',
    createdAt: '2026-05-16T00:00:00Z',
    status: 'done',
    runId: 'run-1',
    agentEvents: [],
    ...overrides,
  }
}

describe('AnsweredQuestions', () => {
  it('renders nothing when there is no answered question', () => {
    const { container } = render(
      <I18nProvider>
        <AnsweredQuestions message={message()} />
      </I18nProvider>,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the chosen labels paired with the question header', () => {
    render(
      <I18nProvider>
        <AnsweredQuestions
          message={message({
            agentEvents: [
              {
                type: 'question.asked',
                label: 'q',
                questionRequestId: 'q1',
                questions: [
                  { question: '请问您想查询哪个城市的天气?', header: '城市', options: [{ label: '北京' }, { label: '上海' }] },
                ],
              },
              {
                type: 'question.answered',
                label: 'a',
                questionRequestId: 'q1',
                questionAnswers: { '请问您想查询哪个城市的天气?': ['杭州'] },
              },
            ],
          })}
        />
      </I18nProvider>,
    )

    const question = screen.getByText('请问您想查询哪个城市的天气?')
    const answer = screen.getByText('杭州')
    expect(question).toBeInTheDocument()
    expect(answer).toBeInTheDocument()
    expect(question.closest('article')).toHaveClass('message', 'assistant')
    expect(answer.closest('article')).toHaveClass('message', 'user')
  })
})
