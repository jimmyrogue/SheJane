import { useEffect, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { appLogoURL } from '@/shared/assets/logo'
import { useI18n } from '@/shared/i18n/i18n'
import type { ChatMessage } from '@/shared/local-data/types'
import { useSmoothTextStream } from '@/shared/streaming/useSmoothTextStream'

export function MessageBubble({
  message,
  children,
  initialStreamText = '',
  onStreamTextCommit,
}: {
  message: ChatMessage
  children?: React.ReactNode
  initialStreamText?: string
  onStreamTextCommit?: (messageID: string, displayedText: string) => void
}) {
  const { locale, t } = useI18n()
  const previousMessageIDRef = useRef(message.id)
  const previousContentRef = useRef('')
  const stream = useSmoothTextStream({ locale, segmentsPerTick: 3, tickMs: 22 })
  const isAssistant = message.role === 'assistant'

  useEffect(() => {
    if (previousMessageIDRef.current !== message.id) {
      previousMessageIDRef.current = message.id
      previousContentRef.current = ''
      stream.cancel()
    }
    if (!isAssistant || message.status !== 'streaming') {
      previousContentRef.current = message.content
      if (stream.isStreaming) {
        stream.finish()
      }
      return
    }
    if (!stream.isStreaming) {
      const seedText = message.content.startsWith(initialStreamText) ? initialStreamText : ''
      stream.start(seedText)
      previousContentRef.current = seedText
    }
    if (message.content.startsWith(previousContentRef.current)) {
      const delta = message.content.slice(previousContentRef.current.length)
      if (delta) {
        stream.pushChunk(delta)
        previousContentRef.current = message.content
      }
    } else {
      stream.start()
      stream.pushChunk(message.content)
      previousContentRef.current = message.content
    }
  }, [initialStreamText, isAssistant, message.content, message.id, message.status, stream])

  useEffect(() => {
    if (isAssistant && message.status === 'streaming' && stream.text) {
      onStreamTextCommit?.(message.id, stream.text)
    }
  }, [isAssistant, message.id, message.status, onStreamTextCommit, stream.text])

  const waitingText = message.status === 'waiting_permission' ? t('message.waitingPermission') : ''
  const content = message.content || waitingText

  return (
    <article className={cn('message', message.role)}>
      <div className={isAssistant ? 'avatar-bot' : 'avatar'}>
        {isAssistant ? <img src={appLogoURL} alt="" aria-hidden="true" /> : t('message.me')}
      </div>
      <div className="message-bubble-inner">
        <div className="message-meta">
          <span>{message.role === 'user' ? t('message.me') : t('message.assistant')}</span>
          {message.status === 'streaming' ? <Badge variant="secondary">{t('message.processing')}</Badge> : null}
        </div>
        <div className="message-content">
          {isAssistant && message.status === 'streaming' ? (
            <p className="streaming-text whitespace-pre-wrap break-words">
              {stream.segments.map((segment) => (
                <span className="stream-segment" key={segment.id}>
                  {segment.text}
                </span>
              ))}
              {!stream.text && waitingText ? waitingText : null}
            </p>
          ) : (
            <MarkdownContent content={content} />
          )}
        </div>
        {children}
      </div>
    </article>
  )
}

function MarkdownContent({ content }: { content: string }) {
  if (!content) {
    return null
  }
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
      }}
    >
      {content}
    </ReactMarkdown>
  )
}
