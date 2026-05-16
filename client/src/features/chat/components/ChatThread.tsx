import { Fragment, useCallback, useEffect, useRef } from 'react'
import { AgentProgress } from './AgentProgress'
import { AnsweredQuestions } from './AnsweredQuestions'
import { MessageBubble } from './MessageBubble'
import { ThinkingIndicator } from './ThinkingIndicator'
import { IconCodeDots, IconPalette, IconSearch, IconWriting } from '@tabler/icons-react'
import type { Conversation } from '@/shared/local-data/types'
import { appLogoURL } from '@/shared/assets/logo'
import { useI18n } from '@/shared/i18n/i18n'
import { useSmartAutoScroll } from '@/shared/streaming/useSmartAutoScroll'

export function ChatThread({
  conversation,
  onOpenArtifact,
  onOpenDiagnostics,
}: {
  conversation?: Conversation
  onOpenArtifact: (artifactID: string) => void
  onOpenDiagnostics: (runID: string) => void
}) {
  const { t } = useI18n()
  const streamDisplayCacheRef = useRef<Map<string, string>>(new Map())
  const messageCount = conversation?.messages.length ?? 0
  const lastMessageContent = conversation?.messages.at(-1)?.content ?? ''
  const scrollRef = useSmartAutoScroll<HTMLDivElement>([messageCount, lastMessageContent.length], { bottomThreshold: 120 })
  const handleStreamTextCommit = useCallback((messageID: string, displayedText: string) => {
    streamDisplayCacheRef.current.set(messageID, displayedText)
  }, [])

  useEffect(() => {
    for (const message of conversation?.messages ?? []) {
      if (message.status !== 'streaming') {
        streamDisplayCacheRef.current.delete(message.id)
      }
    }
  }, [conversation])

  return (
    <section className="chat-surface">
      {conversation?.messages.length ? (
        <div className="messages" ref={scrollRef}>
          {conversation.messages.map((message) => (
            <Fragment key={message.id}>
              <AnsweredQuestions message={message} />
              <MessageBubble
                message={message}
                initialStreamText={message.status === 'streaming' ? streamDisplayCacheRef.current.get(message.id) : undefined}
                onStreamTextCommit={handleStreamTextCommit}
              >
                <AgentProgress
                  message={message}
                  onOpenArtifact={onOpenArtifact}
                  onOpenDiagnostics={onOpenDiagnostics}
                />
              </MessageBubble>
            </Fragment>
          ))}
          {conversation.messages.at(-1) ? (
            <ThinkingIndicator message={conversation.messages[conversation.messages.length - 1]} />
          ) : null}
        </div>
      ) : (
        <div className="empty-state welcome-body">
          <div className="logo" aria-hidden="true">
            <img src={appLogoURL} alt="" />
          </div>
          <h1>{t('welcome.title')}</h1>
          <p>{t('welcome.subtitle')}</p>
          <div className="suggest-grid" aria-label={t('welcome.suggestions')}>
            <button className="suggest-tile" type="button">
              <span className="tag tag-code"><IconCodeDots size={14} /> Code</span>
              <span className="text">{t('welcome.code')}</span>
            </button>
            <button className="suggest-tile" type="button">
              <span className="tag tag-write"><IconWriting size={14} /> Write</span>
              <span className="text">{t('welcome.write')}</span>
            </button>
            <button className="suggest-tile" type="button">
              <span className="tag tag-research"><IconSearch size={14} /> Research</span>
              <span className="text">{t('welcome.research')}</span>
            </button>
            <button className="suggest-tile" type="button">
              <span className="tag tag-create"><IconPalette size={14} /> Create</span>
              <span className="text">{t('welcome.create')}</span>
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
