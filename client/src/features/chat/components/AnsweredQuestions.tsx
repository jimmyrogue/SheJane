import { useI18n } from '@/shared/i18n/i18n'
import type { ChatMessage } from '@/shared/local-data/types'

export function AnsweredQuestions({ message }: { message: ChatMessage }) {
  const { t } = useI18n()
  const answered = (message.agentEvents ?? []).filter(
    (event) => event.type === 'question.answered' && event.questionAnswers,
  )
  if (answered.length === 0) {
    return null
  }

  return answered.flatMap((event, index) =>
    Object.entries(event.questionAnswers ?? {}).flatMap(([question, picks]) => [
      <article className="message assistant" key={`${event.eventId ?? index}-${question}-q`}>
        <div className="message-bubble-inner">
          <div className="message-content">
            <p className="whitespace-pre-wrap break-words">{question}</p>
          </div>
        </div>
      </article>,
      <article className="message user" key={`${event.eventId ?? index}-${question}-a`}>
        <div className="message-bubble-inner">
          <div className="message-content">
            <p className="whitespace-pre-wrap break-words">
              {picks.join(t('agent.question.answerJoiner'))}
            </p>
          </div>
        </div>
      </article>,
    ]),
  )
}
