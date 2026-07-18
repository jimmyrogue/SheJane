import { describe, expect, it } from 'vitest'
import { conversationForQuestionAnswer, findConversationPendingQuestion } from './pendingQuestion'
import type { AgentQuestionItem, Conversation } from '@/shared/local-data/types'

const sampleQuestions: AgentQuestionItem[] = [
  { question: 'Pick one', header: 'Pick', options: [{ label: 'A' }, { label: 'B' }] },
]

function conversation(messages: Conversation['messages']): Conversation {
  return {
    id: 'c1',
    title: 't',
    archived: false,
    createdAt: '2026-05-16T00:00:00Z',
    updatedAt: '2026-05-16T00:00:00Z',
    messages,
  }
}

describe('findConversationPendingQuestion', () => {
  it('returns null with no conversation or no pending question', () => {
    expect(findConversationPendingQuestion(undefined)).toBeNull()
    expect(
      findConversationPendingQuestion(
        conversation([
          {
            id: 'm1',
            role: 'assistant',
            content: '',
            createdAt: '2026-05-16T00:00:00Z',
            status: 'done',
            agentEvents: [{ type: 'tool.completed', label: 'x' }],
          },
        ]),
      ),
    ).toBeNull()
  })

  it('ignores answered questions', () => {
    expect(
      findConversationPendingQuestion(
        conversation([
          {
            id: 'm1',
            role: 'assistant',
            content: '',
            createdAt: '2026-05-16T00:00:00Z',
            status: 'done',
            agentEvents: [
              { type: 'question.asked', label: 'q', questionRequestId: 'q1', questions: sampleQuestions },
              { type: 'question.answered', label: 'a', questionRequestId: 'q1' },
            ],
          },
        ]),
      ),
    ).toBeNull()
  })

  it('returns the newest unanswered question scanning messages newest-first', () => {
    const result = findConversationPendingQuestion(
      conversation([
        {
          id: 'm1',
          role: 'assistant',
          content: '',
          createdAt: '2026-05-16T00:00:00Z',
          status: 'done',
          agentEvents: [
            { type: 'question.asked', label: 'q', questionRequestId: 'old', questions: sampleQuestions },
            { type: 'question.answered', label: 'a', questionRequestId: 'old' },
          ],
        },
        {
          id: 'm2',
          role: 'assistant',
          content: '',
          createdAt: '2026-05-16T00:01:00Z',
          status: 'waiting_input',
          agentEvents: [
            { type: 'question.asked', label: 'q', questionRequestId: 'q9', questions: sampleQuestions },
          ],
        },
      ]),
    )
    expect(result).toEqual({ messageID: 'm2', requestID: 'q9', questions: sampleQuestions })
  })
})

describe('conversationForQuestionAnswer', () => {
  it('uses the visible projection when persisted state has only the placeholder message', () => {
    const persisted = conversation([{
      id: 'm1',
      role: 'assistant',
      content: '',
      createdAt: '2026-05-16T00:00:00Z',
      status: 'streaming',
    }])
    const visible = conversation([{
      id: 'm1',
      role: 'assistant',
      content: '',
      createdAt: '2026-05-16T00:00:00Z',
      status: 'waiting_input',
      runId: 'run-1',
    }])

    expect(conversationForQuestionAnswer(persisted, visible, 'm1')).toBe(visible)
  })

  it('prefers persisted state once it contains the Runtime run id', () => {
    const persisted = conversation([{
      id: 'm1',
      role: 'assistant',
      content: '',
      createdAt: '2026-05-16T00:00:00Z',
      status: 'waiting_input',
      runId: 'run-1',
    }])
    const visible = conversation([{
      id: 'm1',
      role: 'assistant',
      content: '',
      createdAt: '2026-05-16T00:00:00Z',
      status: 'waiting_input',
      runId: 'run-1',
    }])

    expect(conversationForQuestionAnswer(persisted, visible, 'm1')).toBe(persisted)
  })
})
