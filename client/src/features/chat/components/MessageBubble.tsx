import { useEffect, useRef } from 'react'
import { Sparkles } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { ChatMessage } from '@/shared/local-data/types'
import { useSmoothTextStream } from '@/shared/streaming/useSmoothTextStream'

export function MessageBubble({
  message,
  children,
}: {
  message: ChatMessage
  children?: React.ReactNode
}) {
  const previousMessageIDRef = useRef(message.id)
  const previousContentRef = useRef('')
  const stream = useSmoothTextStream({ locale: 'zh', segmentsPerTick: 3, tickMs: 22 })
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
      stream.start()
      previousContentRef.current = ''
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
  }, [isAssistant, message.content, message.id, message.status, stream])

  const waitingText = message.status === 'waiting_permission' ? '等待你批准本地工具调用。' : ''
  const content = message.content || waitingText

  return (
    <article className={cn('message', message.role)}>
      <div className={isAssistant ? 'avatar-bot' : 'avatar'}>
        {isAssistant ? <Sparkles size={14} /> : '我'}
      </div>
      <div className="message-bubble-inner">
        <div className="message-meta">
          <span>{message.role === 'user' ? '我' : '简单'}</span>
          {message.status === 'streaming' ? <Badge variant="secondary">running</Badge> : null}
          {message.runOrigin ? <Badge variant="outline">{message.runOrigin === 'local' ? 'Local Harness' : 'Cloud Run'}</Badge> : null}
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
