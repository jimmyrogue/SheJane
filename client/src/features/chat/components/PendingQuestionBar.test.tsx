import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PendingQuestionBar } from './PendingQuestionBar'
import { I18nProvider } from '@/shared/i18n/i18n'
import type { PendingQuestion } from '../pendingQuestion'

afterEach(() => cleanup())

function renderBar(question: PendingQuestion | null, onAnswer = vi.fn()) {
  render(
    <I18nProvider>
      <PendingQuestionBar question={question} onAnswer={onAnswer} />
    </I18nProvider>,
  )
  return onAnswer
}

describe('PendingQuestionBar', () => {
  it('renders nothing when there is no pending question', () => {
    const { container } = render(
      <I18nProvider>
        <PendingQuestionBar question={null} onAnswer={vi.fn()} />
      </I18nProvider>,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('single-select auto-advances on click; multi-select keeps an explicit submit', () => {
    const onAnswer = renderBar({
      messageID: 'm1',
      requestID: 'q1',
      questions: [
        { question: 'Color?', header: 'Color', options: [{ label: 'Red' }, { label: 'Blue' }] },
        {
          question: 'Sizes?',
          header: 'Size',
          multiSelect: true,
          options: [{ label: 'S' }, { label: 'M' }],
        },
      ],
    })

    // Step 1 is single-select: a click on the option is the answer (no need
    // to press any Next/Submit button between steps).
    expect(screen.getByText('Color?')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Red'))

    // Auto-advanced to the multi-select step, which DOES show a submit.
    expect(screen.getByText('Sizes?')).toBeInTheDocument()
    expect(screen.queryByText('Color?')).not.toBeInTheDocument()
    const submit = screen.getByRole('button', { name: '提交' })
    expect(submit).toBeDisabled()

    fireEvent.click(screen.getByText('S'))
    fireEvent.click(screen.getByText('M'))
    expect(submit).toBeEnabled()

    fireEvent.click(submit)
    expect(onAnswer).toHaveBeenCalledWith('m1', 'q1', {
      'Color?': ['Red'],
      'Sizes?': ['S', 'M'],
    })
  })

  it('single-select submits immediately on the last question click', () => {
    const onAnswer = renderBar({
      messageID: 'm3',
      requestID: 'q3',
      questions: [{ question: 'Pick', header: 'Pick', options: [{ label: 'A' }, { label: 'B' }] }],
    })

    fireEvent.click(screen.getByText('A'))
    expect(onAnswer).toHaveBeenCalledWith('m3', 'q3', { Pick: ['A'] })
  })

  it('the always-visible "Other" free-text path has its own confirm', () => {
    const onAnswer = renderBar({
      messageID: 'm2',
      requestID: 'q2',
      questions: [{ question: 'Pick', header: 'Pick', options: [{ label: 'A' }, { label: 'B' }] }],
    })

    // No need to choose an "Other" option first — the input is always shown.
    const confirm = screen.getByRole('button', { name: '提交' })
    expect(confirm).toBeDisabled()

    fireEvent.change(screen.getByPlaceholderText('输入你的答案…'), { target: { value: 'Custom' } })
    expect(confirm).toBeEnabled()

    fireEvent.click(confirm)
    expect(onAnswer).toHaveBeenCalledWith('m2', 'q2', { Pick: ['Custom'] })
  })
})
