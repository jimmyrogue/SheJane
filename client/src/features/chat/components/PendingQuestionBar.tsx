import { useMemo, useState } from 'react'
import { IconArrowLeft, IconArrowRight, IconCheck } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/shared/i18n/i18n'
import type { PendingQuestion } from '../pendingQuestion'

const OTHER = '__other__'

export function PendingQuestionBar({
  question,
  onAnswer,
}: {
  question: PendingQuestion | null
  onAnswer: (messageID: string, requestID: string, answers: Record<string, string[]>) => void
}) {
  const { t } = useI18n()
  const [selected, setSelected] = useState<Record<number, string[]>>({})
  const [otherText, setOtherText] = useState<Record<number, string>>({})
  const [step, setStep] = useState(0)

  const answers = useMemo(() => {
    if (!question) {
      return null
    }
    const result: Record<string, string[]> = {}
    for (let qi = 0; qi < question.questions.length; qi += 1) {
      const item = question.questions[qi]
      const picks = selected[qi] ?? []
      const labels = picks.filter((value) => value !== OTHER)
      if (picks.includes(OTHER)) {
        const free = (otherText[qi] ?? '').trim()
        if (!free) {
          return null
        }
        labels.push(free)
      }
      if (labels.length === 0) {
        return null
      }
      result[item.question] = labels
    }
    return result
  }, [question, selected, otherText])

  if (!question) {
    return null
  }

  const total = question.questions.length
  const activeStep = Math.min(step, total - 1)
  const item = question.questions[activeStep]
  const multi = item.multiSelect === true
  const picks = selected[activeStep] ?? []

  const isAnswered = (qi: number): boolean => {
    const q = question.questions[qi]
    if (!q) {
      return false
    }
    const chosen = selected[qi] ?? []
    const labels = chosen.filter((value) => value !== OTHER)
    if (chosen.includes(OTHER)) {
      if (!(otherText[qi] ?? '').trim()) {
        return false
      }
      return true
    }
    return labels.length > 0
  }

  const currentAnswered = isAnswered(activeStep)
  const isLast = activeStep >= total - 1

  const toggle = (qi: number, value: string) => {
    setSelected((current) => {
      const existing = current[qi] ?? []
      if (multi) {
        const next = existing.includes(value)
          ? existing.filter((entry) => entry !== value)
          : [...existing, value]
        return { ...current, [qi]: next }
      }
      return { ...current, [qi]: [value] }
    })
  }

  const submit = () => {
    if (!answers) {
      return
    }
    onAnswer(question.messageID, question.requestID, answers)
  }

  return (
    <div className="question-bar" role="region" aria-label={t('agent.question.title')}>
      <div className="question-bar-head">
        <span className="question-bar-title">{t('agent.question.title')}</span>
        <span className="question-bar-detail">
          {total > 1 ? t('agent.question.progress', { current: activeStep + 1, total }) : t('agent.question.detail')}
        </span>
      </div>
      <div className="question-bar-list">
        <div className="question-block" key={`${item.question}-${activeStep}`}>
          <div className="question-block-head">
            <span className="question-chip">{item.header}</span>
            <span className="question-text">{item.question}</span>
            {multi ? <span className="question-multi-hint">{t('agent.question.multiHint')}</span> : null}
          </div>
          {item.body ? <pre className="question-body">{item.body}</pre> : null}
          <div className="question-options" role={multi ? 'group' : 'radiogroup'}>
            {[
              ...item.options.map((option) => ({
                value: option.label,
                label: option.label,
                description: option.description,
              })),
              { value: OTHER, label: t('agent.question.other'), description: undefined },
            ].map((option) => {
              const active = picks.includes(option.value)
              return (
                <button
                  type="button"
                  key={option.value}
                  className="question-option"
                  data-active={active}
                  role={multi ? 'checkbox' : 'radio'}
                  aria-checked={active}
                  onClick={() => toggle(activeStep, option.value)}
                >
                  <span className="question-option-main">
                    <span className="question-option-label">{option.label}</span>
                    {option.description ? (
                      <span className="question-option-desc">{option.description}</span>
                    ) : null}
                  </span>
                  {active ? (
                    <IconCheck className="question-option-check" size={15} aria-hidden="true" />
                  ) : null}
                </button>
              )
            })}
          </div>
          {picks.includes(OTHER) ? (
            <input
              className="question-other-input"
              type="text"
              value={otherText[activeStep] ?? ''}
              placeholder={t('agent.question.otherPlaceholder')}
              onChange={(event) => setOtherText((current) => ({ ...current, [activeStep]: event.target.value }))}
            />
          ) : null}
        </div>
      </div>
      <div className="question-bar-actions">
        {activeStep > 0 ? (
          <Button size="sm" variant="outline" onClick={() => setStep(activeStep - 1)}>
            <IconArrowLeft size={14} />
            {t('agent.question.back')}
          </Button>
        ) : null}
        {isLast ? (
          <Button size="sm" disabled={!answers} onClick={submit}>
            <IconCheck size={14} />
            {t('agent.question.submit')}
          </Button>
        ) : (
          <Button size="sm" disabled={!currentAnswered} onClick={() => setStep(activeStep + 1)}>
            {t('agent.question.next')}
            <IconArrowRight size={14} />
          </Button>
        )}
      </div>
    </div>
  )
}
