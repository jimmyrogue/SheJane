import { cloneElement, Fragment, isValidElement, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import remarkNormalizeHeadings from 'remark-normalize-headings'
import { IconCheck, IconCopy, IconPencil, IconRefresh, IconSparkles, IconTrash } from '@tabler/icons-react'
import { ChatImage } from './ChatImage'
import { CodeBlock } from './CodeBlock'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { formatMessageTime, useI18n, type Translator } from '@/shared/i18n/i18n'
import type { AgentTimelineItem, ChatMessage, LocalOfficeFileRef } from '@/shared/local-data/types'
import { useSmoothTextStream } from '@/shared/streaming/useSmoothTextStream'
import { completePartialMarkdown } from '@/shared/streaming/completePartialMarkdown'

export function MessageBubble({
  message,
  children,
  initialStreamText = '',
  onStreamTextCommit,
  workspaceRoot,
  onPreviewLocalFile,
  onRegenerate,
  onEditResend,
  onDelete,
  runActive = false,
}: {
  message: ChatMessage
  children?: React.ReactNode
  initialStreamText?: string
  onStreamTextCommit?: (messageID: string, displayedText: string) => void
  /** Re-run an assistant turn: drops it (and everything after) and
   *  re-issues the originating user message. Assistant messages only. */
  onRegenerate?: (messageID: string) => void
  /** Edit a user message and resend: drops it (and everything after) and
   *  starts a fresh run with the edited text. User messages only. */
  onEditResend?: (messageID: string, newText: string) => void
  /** Delete a message. Deleting a user message also drops its paired
   *  assistant reply; deleting an assistant message drops just it. */
  onDelete?: (messageID: string) => void
  /** True while a run is streaming for this conversation — disables the
   *  retry/edit/delete actions so the user can't mutate mid-run. */
  runActive?: boolean
  /** Absolute path of the active conversation's workspace, used to
   *  resolve relative office-file refs in agent text. Undefined for
   *  chats without a project. */
  workspaceRoot?: string
  /** Callback fired when the user clicks a recognized office filename
   *  rendered inside agent markdown. Undefined disables the click. */
  onPreviewLocalFile?: (ref: LocalOfficeFileRef) => void
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

  const [editing, setEditing] = useState(false)
  const [editText, setEditText] = useState('')
  const startEdit = () => {
    setEditText(message.content)
    setEditing(true)
  }
  const cancelEdit = () => setEditing(false)
  const commitEdit = () => {
    const next = editText.trim()
    if (!next) {
      return
    }
    setEditing(false)
    onEditResend?.(message.id, next)
  }

  const waitingText = message.status === 'waiting_permission'
    ? t('message.waitingPermission')
    : message.status === 'waiting_input'
      ? t('message.waitingInput')
      : ''
  const content = message.content || waitingText
  const hideDuplicateFailureContent = isAssistant && isDuplicateFailureContent(message)
  // Action affordances appear on settled turns only (not mid-stream).
  const settled = message.status === 'done' || message.status === 'error'
  const latestCleanupState = [...(message.agentEvents ?? [])].reverse().find(
    (event) => event.type === 'run.cleanup_required' || event.type === 'run.failed',
  )
  const cleanupUnconfirmed = latestCleanupState?.type === 'run.cleanup_required'
  const canRegenerate = isAssistant && settled && !cleanupUnconfirmed && Boolean(onRegenerate)
  const canEdit = !isAssistant && Boolean(onEditResend)
  const canDelete = settled && Boolean(onDelete)

  // Per-turn Runtime usage comes from model token counts and completed tools.
  const toolCalls = (message.agentEvents ?? []).filter((event) => event.type === 'tool.completed' || event.type === 'tool.failed').length
  const usageParts = buildUsageParts(message, toolCalls, locale, t)
  const showUsage = isAssistant && settled && usageParts.length > 0
  const showStream = isAssistant && (message.status === 'streaming' || stream.isStreaming)
  const messageTime = formatMessageTime(message.createdAt, locale, t)

  return (
    <article className={cn('message', message.role)}>
      <div className="message-bubble-inner">
        <div className="message-content">
          {editing ? (
            <div className="message-edit">
              <textarea
                className="message-edit-input"
                value={editText}
                autoFocus
                rows={Math.min(10, Math.max(2, editText.split('\n').length))}
                aria-label={t('message.edit')}
                onChange={(event) => setEditText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault()
                    commitEdit()
                  } else if (event.key === 'Escape') {
                    event.preventDefault()
                    cancelEdit()
                  }
                }}
              />
              <div className="message-edit-actions">
                <button type="button" className="message-edit-cancel" onClick={cancelEdit}>
                  {t('message.editCancel')}
                </button>
                <button type="button" className="message-edit-save" onClick={commitEdit} disabled={!editText.trim()}>
                  {t('message.editSave')}
                </button>
              </div>
            </div>
          ) : showStream ? (
            stream.text ? (
              <MarkdownContent
                content={completePartialMarkdown(stream.text)}
                workspaceRoot={workspaceRoot}
                onPreviewLocalFile={onPreviewLocalFile}
              />
            ) : waitingText ? (
              <p className="whitespace-pre-wrap break-words">{waitingText}</p>
            ) : null
          ) : hideDuplicateFailureContent ? null : (
            <MarkdownContent
              content={content}
              normalizeHeadings
              workspaceRoot={workspaceRoot}
              onPreviewLocalFile={onPreviewLocalFile}
            />
          )}
        </div>
        {/* Rich rendering for matplotlib/PIL figures from code.execute.
         *  We pull image/png base64 payloads out of every tool.completed
         *  event for code.execute and inline them — that way users see
         *  the actual chart instead of just LLM prose describing it (or,
         *  worse, the model's hallucinated `![](imgbb.com/…)` URL). */}
        {isAssistant ? <CodeExecutionImages events={message.agentEvents} /> : null}
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
              {copied ? <IconCheck size={13} aria-hidden="true" /> : <IconCopy size={13} aria-hidden="true" />}
            </button>
          ) : null}
          {!editing && canRegenerate ? (
            <button
              type="button"
              className="message-meta-action"
              onClick={() => onRegenerate?.(message.id)}
              disabled={runActive}
              title={t('message.regenerate')}
              aria-label={t('message.regenerate')}
            >
              <IconRefresh size={13} aria-hidden="true" />
            </button>
          ) : null}
          {!editing && canEdit ? (
            <button
              type="button"
              className="message-meta-action"
              onClick={startEdit}
              disabled={runActive}
              title={t('message.edit')}
              aria-label={t('message.edit')}
            >
              <IconPencil size={13} aria-hidden="true" />
            </button>
          ) : null}
          {!editing && canDelete ? (
            <button
              type="button"
              className="message-meta-action message-meta-action-danger"
              onClick={() => onDelete?.(message.id)}
              disabled={runActive}
              title={t('message.delete')}
              aria-label={t('message.delete')}
            >
              <IconTrash size={13} aria-hidden="true" />
            </button>
          ) : null}
          {isAssistant ? <ModelModeBadge runMode={message.runMode} /> : null}
          {showUsage ? (
            <span className="message-meta-usage" title={t('agent.usageTooltip')}>
              {usageParts.join(' · ')}
            </span>
          ) : null}
          {showUsage && messageTime ? <span className="message-meta-dot" aria-hidden="true">·</span> : null}
          {messageTime ? <span className="message-meta-time">{messageTime}</span> : null}
        </div>
      </div>
    </article>
  )
}

function ModelModeBadge({ runMode }: { runMode?: ChatMessage['runMode'] }) {
  if (!runMode?.resolved?.trim()) {
    return null
  }
  const reason = runMode.reason?.trim()
  const label = runMode.resolved
  const badge = (
    <span className="message-meta-mode">
      <IconSparkles className="message-meta-mode-icon" size={11} aria-hidden="true" />
      <span className="message-meta-mode-label">{label}</span>
    </span>
  )
  if (!reason) {
    return badge
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>{badge}</TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {reason}
      </TooltipContent>
    </Tooltip>
  )
}

function isDuplicateFailureContent(message: ChatMessage): boolean {
  if (message.role !== 'assistant' || message.status !== 'error') {
    return false
  }
  const content = normalizeFailureText(message.content)
  if (!content) {
    return false
  }
  return (message.agentEvents ?? []).some((event) => {
    if (event.type !== 'run.failed' && event.type !== 'run.cleanup_required' && event.type !== 'tool.failed' && event.verificationStatus !== 'failed') {
      return false
    }
    return sameFailureText(content, normalizeFailureText(event.label))
  })
}

function sameFailureText(content: string, label: string): boolean {
  if (!content || !label) {
    return false
  }
  return content === label || label.startsWith(`${content} · `) || content.startsWith(`${label} · `)
}

function normalizeFailureText(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim()
}

function buildUsageParts(
  message: ChatMessage,
  toolCalls: number,
  locale: string,
  t: Translator,
): string[] {
  const parts: string[] = []
  if (typeof message.tokens === 'number' && message.tokens > 0) {
    parts.push(t('agent.usageTokens', { count: formatUsageNumber(message.tokens, locale) }))
  }
  if (toolCalls > 0) {
    parts.push(t('agent.usageTools', { count: formatUsageNumber(toolCalls, locale) }))
  }
  return parts
}

function formatUsageNumber(value: number, locale: string): string {
  return new Intl.NumberFormat(locale === 'zh' ? 'zh-CN' : 'en-US', {
    maximumFractionDigits: 2,
  }).format(value)
}

function MarkdownContent({
  content,
  normalizeHeadings = false,
  workspaceRoot,
  onPreviewLocalFile,
}: {
  content: string
  normalizeHeadings?: boolean
  workspaceRoot?: string
  onPreviewLocalFile?: (ref: LocalOfficeFileRef) => void
}) {
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
  // Click-to-preview is only enabled when (a) the parent gave us a
  // callback AND (b) we know which workspace to resolve relative paths
  // against. Without `workspaceRoot` we'd be guessing — the absolute
  // path case still works because the regex captures it whole.
  const previewEnabled = Boolean(onPreviewLocalFile)
  const previewClick = onPreviewLocalFile
  // react-markdown doesn't expose a `text`-node component override (the
  // `components` map only takes HTML element names), so we walk the
  // rendered children of common text containers and replace recognized
  // office filenames inside any string descendant. This catches refs in
  // paragraphs, list items, table cells, headings, blockquotes — without
  // needing a custom remark/rehype plugin.
  const renderChildren = (children: React.ReactNode): React.ReactNode => {
    if (!previewEnabled || !previewClick) return children
    return processChildren(children, workspaceRoot, previewClick)
  }
  return (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      components={{
        a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
        img: ({ node: _node, src, alt }) => <ChatImage src={typeof src === 'string' ? src : undefined} alt={alt} />,
        p: ({ children }) => <p>{renderChildren(children)}</p>,
        li: ({ children }) => <li>{renderChildren(children)}</li>,
        td: ({ children }) => <td>{renderChildren(children)}</td>,
        th: ({ children }) => <th>{renderChildren(children)}</th>,
        h1: ({ children }) => <h1>{renderChildren(children)}</h1>,
        h2: ({ children }) => <h2>{renderChildren(children)}</h2>,
        h3: ({ children }) => <h3>{renderChildren(children)}</h3>,
        h4: ({ children }) => <h4>{renderChildren(children)}</h4>,
        h5: ({ children }) => <h5>{renderChildren(children)}</h5>,
        h6: ({ children }) => <h6>{renderChildren(children)}</h6>,
        blockquote: ({ children }) => <blockquote>{renderChildren(children)}</blockquote>,
        // Fenced code blocks get syntax highlighting + a per-block copy
        // button (CodeBlock). Inline code keeps the plain chip styling.
        // react-markdown v9 dropped the `inline` prop, so detect a block by
        // a `language-*` class or a multi-line body.
        code: ({ node: _node, className, children, ...rest }) => {
          const text = childrenToText(children)
          const match = /language-(\w+)/.exec(className || '')
          if (match || text.includes('\n')) {
            return <CodeBlock language={match?.[1]} code={text.replace(/\n$/, '')} />
          }
          return (
            <code className={className} {...rest}>
              {children}
            </code>
          )
        },
        // CodeBlock supplies its own <pre>; unwrap react-markdown's so we
        // don't nest <pre><div><pre>.
        pre: ({ children }) => <>{children}</>,
      }}
    >
      {content}
    </ReactMarkdown>
  )
}

/** Flatten a react-markdown children tree to its raw text — used to recover
 *  the verbatim source of a fenced code block for highlighting + copy. */
function childrenToText(node: React.ReactNode): string {
  if (node == null || node === false || node === true) {
    return ''
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node)
  }
  if (Array.isArray(node)) {
    return node.map(childrenToText).join('')
  }
  if (typeof node === 'object' && 'props' in node) {
    return childrenToText((node as { props?: { children?: React.ReactNode } }).props?.children)
  }
  return ''
}

/** Element types we deliberately don't crack open. `a` and `button`
 *  would produce invalid nested-interactive markup if we put an
 *  OfficeFileLink (button) inside them; OfficeFileLink itself never
 *  contains office refs to find. */
const NON_RECURSIVE_INLINE_TYPES = new Set<unknown>(['a', 'button'])

/** Walk a ReactNode tree, replacing any string descendants with a
 *  fragment that has recognized office filenames wrapped in clickable
 *  buttons. Non-string nodes recurse into their `children` prop so
 *  refs nested inside `<code>` / `<strong>` / `<em>` / etc. get
 *  picked up too (LLMs commonly format filenames as bold inline code,
 *  which we'd otherwise miss). */
function processChildren(
  children: React.ReactNode,
  workspaceRoot: string | undefined,
  onPreviewLocalFile: (ref: LocalOfficeFileRef) => void,
): React.ReactNode {
  if (typeof children === 'string') {
    return renderTextWithOfficeLinks(children, workspaceRoot, onPreviewLocalFile)
  }
  if (Array.isArray(children)) {
    return children.map((child, i) => (
      // Fragments are transparent to layout AND to testing-library
      // text matching (whereas a wrapping `<span>` introduces an
      // extra element with the same textContent and confuses
      // `findByText`).
      <Fragment key={i}>{processChildren(child, workspaceRoot, onPreviewLocalFile)}</Fragment>
    ))
  }
  if (isValidElement(children)) {
    if (
      NON_RECURSIVE_INLINE_TYPES.has(children.type) ||
      children.type === OfficeFileLink
    ) {
      return children
    }
    const props = (children.props ?? {}) as { children?: React.ReactNode }
    if (props.children === undefined) {
      return children
    }
    return cloneElement(
      children,
      undefined,
      processChildren(props.children, workspaceRoot, onPreviewLocalFile),
    )
  }
  // null / boolean / number — leave alone.
  return children
}

/** Office-file extension → kind mapping. Lowercase keys; the regex
 *  also uses lowercase so case-insensitive matches work in one pass.
 */
const OFFICE_EXTENSION_KIND: Record<string, 'word' | 'excel'> = {
  docx: 'word',
  xlsx: 'excel',
}

/** Regex that captures a chunk of "looks like a path" text ending in
 *  `.docx` / `.xlsx`. Matches:
 *    foo.docx
 *    sub/foo.docx
 *    /Users/me/project/foo.docx
 *    ~/Documents/foo.xlsx
 *  Doesn't try to be exhaustive — we stop at whitespace, quotes, or
 *  common markdown delimiters (backticks, parens) so we don't swallow
 *  surrounding punctuation. Case-insensitive on the extension only.
 */
const OFFICE_FILE_RE = /([^\s"'`(){}\[\]<>]+\.(?:docx|xlsx))/gi

/** Cross-platform basename. Mirror of the helper in App.tsx. */
function pathBasename(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, '')
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed
}

/** Returns true if `path` looks absolute (POSIX or Windows). Used to
 *  decide whether we need to prepend `workspaceRoot`. */
function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || path.startsWith('~') || /^[A-Za-z]:[\\/]/.test(path)
}

/** Join two path segments with the system's preferred separator. We
 *  default to "/" since the daemon runs on the user's machine and
 *  Windows tolerates forward slashes everywhere. */
function joinPath(root: string, rel: string): string {
  const cleanedRoot = root.replace(/[/\\]+$/, '')
  const cleanedRel = rel.replace(/^[/\\]+/, '')
  return `${cleanedRoot}/${cleanedRel}`
}

/** Scan a text node for office file references, returning a React
 *  fragment with the recognized refs replaced by clickable buttons.
 *  Non-match characters pass through verbatim, so this is safe to use
 *  on arbitrary agent prose.
 */
function renderTextWithOfficeLinks(
  text: string,
  workspaceRoot: string | undefined,
  onPreviewLocalFile: (ref: LocalOfficeFileRef) => void,
): React.ReactNode {
  const parts: React.ReactNode[] = []
  let lastIndex = 0
  // The regex has `g` flag; we reset `lastIndex` to 0 on entry by using
  // `matchAll` (which constructs a fresh internal cursor each call).
  const matches = Array.from(text.matchAll(OFFICE_FILE_RE))
  if (matches.length === 0) {
    // Return the bare string — fragment-wrapping is invisible to React
    // but causes Testing Library's `findByText` to occasionally fail
    // when comparing normalized text content.
    return text
  }
  for (const match of matches) {
    const matchedText = match[0]
    const start = match.index ?? 0
    if (start > lastIndex) {
      parts.push(text.slice(lastIndex, start))
    }
    const ext = matchedText.slice(matchedText.lastIndexOf('.') + 1).toLowerCase()
    const kind = OFFICE_EXTENSION_KIND[ext]
    const absolutePath = isAbsolutePath(matchedText)
      ? matchedText.replace(/^~/, () => {
          // Best-effort: we don't know HOME on the renderer side, so
          // leave the tilde — the daemon doesn't expand it either,
          // and clicking such a path will just 404. Reasonable
          // degradation for an edge case.
          return '~'
        })
      : workspaceRoot
        ? joinPath(workspaceRoot, matchedText)
        : null
    if (!kind || !absolutePath) {
      // Either the extension isn't one we preview, or we have no
      // workspace root to resolve against — render as plain text.
      parts.push(matchedText)
    } else {
      parts.push(
        <OfficeFileLink
          key={`${start}-${matchedText}`}
          path={absolutePath}
          kind={kind}
          name={pathBasename(matchedText) || matchedText}
          display={matchedText}
          onClick={onPreviewLocalFile}
        />,
      )
    }
    lastIndex = start + matchedText.length
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex))
  }
  return <>{parts}</>
}

function OfficeFileLink({
  path,
  kind,
  name,
  display,
  onClick,
}: {
  path: string
  kind: 'word' | 'excel'
  name: string
  display: string
  onClick: (ref: LocalOfficeFileRef) => void
}) {
  return (
    <button
      type="button"
      className="message-office-link"
      title={path}
      onClick={(event) => {
        event.preventDefault()
        onClick({ path, kind, name })
      }}
    >
      {display}
    </button>
  )
}

/**
 * Pulls all base64-encoded image/png payloads out of an assistant
 * message's `tool.completed` events for `code.execute` and renders
 * them as inline `<img>` elements. Used to surface matplotlib/PIL
 * figures so the user actually sees what the agent generated, rather
 * than relying on the LLM's text description (which often hallucinates
 * markdown image links pointing at fake URLs).
 *
 * Returns `null` when there are no images — the surrounding bubble
 * keeps its layout clean for text-only replies.
 */
function CodeExecutionImages({ events }: { events?: AgentTimelineItem[] }) {
  if (!events || events.length === 0) return null
  const images: string[] = []
  const seen = new Set<string>()
  for (const item of events) {
    if (item.type !== 'tool.completed' || item.tool !== 'code.execute') continue
    for (const img of item.codeExecImages ?? []) {
      if (!img || seen.has(img)) continue
      seen.add(img)
      images.push(img)
    }
  }
  if (images.length === 0) return null
  return (
    <div className="message-code-images">
      {images.map((b64, idx) => (
        <img
          key={`${b64.slice(0, 24)}-${idx}`}
          src={`data:image/png;base64,${b64}`}
          alt=""
          className="message-code-image"
          loading="lazy"
        />
      ))}
    </div>
  )
}
