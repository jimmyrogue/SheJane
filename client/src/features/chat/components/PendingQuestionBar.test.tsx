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

  it('asks multiple questions one at a time and forwards the combined answers', () => {
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

    // Step 1: only the first question is shown, "Next" gates progress.
    expect(screen.getByText('Color?')).toBeInTheDocument()
    expect(screen.queryByText('Sizes?')).not.toBeInTheDocument()
    const next = screen.getByRole('button', { name: '下一步' })
    expect(next).toBeDisabled()
    expect(screen.queryByRole('button', { name: '提交' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('Red'))
    expect(next).toBeEnabled()
    fireEvent.click(next)

    // Step 2: the second question appears, now with a "Submit".
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

  it('requires free text when the "Other" option is chosen', () => {
    const onAnswer = renderBar({
      messageID: 'm2',
      requestID: 'q2',
      questions: [{ question: 'Pick', header: 'Pick', options: [{ label: 'A' }, { label: 'B' }] }],
    })

    fireEvent.click(screen.getByText('其他'))
    const submit = screen.getByRole('button', { name: '提交' })
    expect(submit).toBeDisabled()

    fireEvent.change(screen.getByPlaceholderText('输入你的答案…'), { target: { value: 'Custom' } })
    expect(submit).toBeEnabled()

    fireEvent.click(submit)
    expect(onAnswer).toHaveBeenCalledWith('m2', 'q2', { Pick: ['Custom'] })
  })

  it('renders the optional body (e.g. a plan) above the options', () => {
    renderBar({
      messageID: 'm3',
      requestID: 'q3',
      questions: [
        {
          question: '是否按此计划执行？',
          header: '计划确认',
          body: '1. 确定日期\n2. 预订住宿\n成功标准：\n· 预算可控',
          options: [{ label: '按此计划执行' }, { label: '取消' }],
        },
      ],
    })

    expect(screen.getByText(/1\. 确定日期/)).toBeInTheDocument()
    expect(screen.getByText(/成功标准/)).toBeInTheDocument()
  })
})
