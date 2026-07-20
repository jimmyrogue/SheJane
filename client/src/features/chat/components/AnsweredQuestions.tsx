import { useI18n } from '@/shared/i18n/i18n'
import type { ChatMessage } from '@/shared/local-data/types'

/**
 * Replays a resolved `user.ask` as ordinary transcript turns: the question we
 * asked rendered like an assistant message, the user's choice rendered like a
 * user message — reusing the existing bubble styles, no special treatment.
 * One question/answer pair per asked question.
 */
export function AnsweredQuestions({ message }: { message: ChatMessage }) {
  const { t } = useI18n()
  const events = message.agentEvents ?? []
  const answered = events.filter((event) => event.type === 'question.answered' && event.questionAnswers)
  if (answered.length === 0) {
    return null
  }

  return (
    <>
      {answered.flatMap((event, index) =>
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
      )}
    </>
  )
}
