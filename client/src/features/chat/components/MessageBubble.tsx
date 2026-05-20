import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import remarkNormalizeHeadings from 'remark-normalize-headings'
import { IconCheck, IconCopy, IconPaperclip } from '@tabler/icons-react'
import { ChatImage } from './ChatImage'
import { cn } from '@/lib/utils'
import { formatMessageTime, useI18n } from '@/shared/i18n/i18n'
import type { ChatMessage } from '@/shared/local-data/types'
import { useSmoothTextStream } from '@/shared/streaming/useSmoothTextStream'
import { completePartialMarkdown } from '@/shared/streaming/completePartialMarkdown'

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
      if (stream.isStreaming) {
        // Run finished, but the typewriter may still have buffered text.
        // Push whatever tail just arrived, then let it drain at animation
        // speed (stream.end) instead of snapping the full reply in at once.
        if (message.content.startsWith(previousContentRef.current)) {
          const delta = message.content.slice(previousContentRef.current.length)
          if (delta) {
            stream.pushChunk(delta)
          }
        } else {
          stream.pushChunk(message.content)
        }
        previousContentRef.current = message.content
        stream.end()
      } else {
        previousContentRef.current = message.content
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

  const [copied, setCopied] = useState(false)
  const copyResetRef = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(copyResetRef.current), [])

  const handleCopy = () => {
    const text = message.content.trim()
    if (!text) {
      return
    }
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true)
      window.clearTimeout(copyResetRef.current)
      copyResetRef.current = window.setTimeout(() => setCopied(false), 1500)
    })
  }

  const waitingText = message.status === 'waiting_permission' ? t('message.waitingPermission') : ''
  const content = message.content || waitingText
  const showStream = isAssistant && (message.status === 'streaming' || stream.isStreaming)
  const messageTime = formatMessageTime(message.createdAt, locale, t)

  return (
    <article className={cn('message', message.role)}>
      <div className="message-bubble-inner">
        <div className={cn('message-content', showStream && stream.text && 'is-streaming')}>
          {showStream ? (
            stream.text ? (
              <MarkdownContent content={completePartialMarkdown(stream.text)} />
            ) : waitingText ? (
              <p className="whitespace-pre-wrap break-words">{waitingText}</p>
            ) : null
          ) : (
            <MarkdownContent content={content} normalizeHeadings />
          )}
        </div>
        {message.attachments && message.attachments.length > 0 ? (
          <div className="message-attachments">
            {message.attachments.map((attachment) =>
              attachment.previewDataUrl ? (
                <ChatImage key={attachment.documentId} src={attachment.previewDataUrl} alt={attachment.name} />
              ) : (
                <span key={attachment.documentId} className="message-attachment-chip" title={attachment.name}>
                  <IconPaperclip size={13} aria-hidden="true" />
                  {attachment.name}
                </span>
              ),
            )}
          </div>
        ) : null}
        {children}
        <div className="message-meta">
          {message.content.trim() ? (
            <button
              type="button"
              className="message-meta-action"
              onClick={handleCopy}
              title={copied ? t('message.copied') : t('message.copy')}
              aria-label={copied ? t('message.copied') : t('message.copy')}
            >
              {copied ? <IconCheck size={14} aria-hidden="true" /> : <IconCopy size={14} aria-hidden="true" />}
            </button>
          ) : null}
          {messageTime ? <span className="message-meta-time">{messageTime}</span> : null}
        </div>
      </div>
    </article>
  )
}

function MarkdownContent({ content, normalizeHeadings = false }: { content: string; normalizeHeadings?: boolean }) {
  if (!content) {
    return null
  }
  // remark-breaks: a single newline becomes a line break (LLMs emit single
  // newlines as paragraph separators; CommonMark would otherwise merge them).
  // remark-normalize-headings: rebalance ad-hoc heading levels — finished
  // content only, so streaming headings don't jump as more arrive.
  const remarkPlugins = normalizeHeadings
    ? [remarkGfm, remarkBreaks, remarkNormalizeHeadings]
    : [remarkGfm, remarkBreaks]
  return (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      components={{
        a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
        img: ({ node: _node, src, alt }) => <ChatImage src={typeof src === 'string' ? src : undefined} alt={alt} />,
      }}
    >
      {content}
    </ReactMarkdown>
  )
}
