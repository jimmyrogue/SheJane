import ReactMarkdown from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { IconCheck, IconCopy, IconDownload, IconX } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { useI18n } from '@/shared/i18n/i18n'
import type { LocalArtifact } from '@/shared/local-host/client'
import { CodeBlock } from './CodeBlock'

type ArtifactKind = 'html' | 'svg' | 'code' | 'markdown'

export function ArtifactPanel({
  artifact,
  onClose,
}: {
  artifact: LocalArtifact | null
  onClose: () => void
}) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  const resetRef = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(resetRef.current), [])

  const format = useMemo(() => inferArtifactFormat(artifact), [artifact])

  const copyArtifact = () => {
    if (!artifact) {
      return
    }
    void navigator.clipboard?.writeText(artifact.content).then(() => {
      setCopied(true)
      window.clearTimeout(resetRef.current)
      resetRef.current = window.setTimeout(() => setCopied(false), 1500)
    })
  }

  const downloadArtifact = () => {
    if (!artifact) {
      return
    }
    const blob = new Blob([artifact.content], { type: blobType(format.kind) })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = safeDownloadName(artifact.title, format.kind)
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
  }

  return (
    <Sheet modal={false} open={Boolean(artifact)} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="artifact-preview w-[min(720px,92vw)] overflow-hidden sm:max-w-[720px]" showOverlay={false} showCloseButton={false}>
        <SheetHeader>
          <div className="artifact-preview-head">
            <div className="artifact-preview-title-block">
              <SheetTitle>{t('artifact.title', { title: artifact?.title })}</SheetTitle>
              <SheetDescription>{artifact?.tool_name ?? t('artifact.defaultTool')}</SheetDescription>
            </div>
            <div className="artifact-preview-actions">
              <Button className="icon-button light" size="icon-sm" variant="ghost" title={copied ? t('artifact.copied') : t('artifact.copy')} aria-label={copied ? t('artifact.copied') : t('artifact.copy')} onClick={copyArtifact} disabled={!artifact}>
                {copied ? <IconCheck size={15} aria-hidden="true" /> : <IconCopy size={15} aria-hidden="true" />}
              </Button>
              <Button className="icon-button light" size="icon-sm" variant="ghost" title={t('artifact.download')} aria-label={t('artifact.download')} onClick={downloadArtifact} disabled={!artifact}>
                <IconDownload size={15} aria-hidden="true" />
              </Button>
              <Button className="icon-button light" size="icon-sm" variant="ghost" title={t('artifact.close')} aria-label={t('artifact.close')} onClick={onClose}>
                <IconX size={15} aria-hidden="true" />
              </Button>
            </div>
          </div>
        </SheetHeader>
        <div className="artifact-body">
          {artifact ? <ArtifactBody artifact={artifact} kind={format.kind} language={format.language} /> : null}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function ArtifactBody({
  artifact,
  kind,
  language,
}: {
  artifact: LocalArtifact
  kind: ArtifactKind
  language?: string
}) {
  if (kind === 'html' || kind === 'svg') {
    return (
      <iframe
        className="artifact-frame"
        title={artifact.title}
        sandbox=""
        srcDoc={artifact.content}
      />
    )
  }
  if (kind === 'code') {
    return <CodeBlock language={language} code={artifact.content} />
  }
  return (
    <div className="artifact-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={{
          a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
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
          pre: ({ children }) => <>{children}</>,
        }}
      >
        {artifact.content}
      </ReactMarkdown>
    </div>
  )
}

function inferArtifactFormat(artifact: LocalArtifact | null): { kind: ArtifactKind; language?: string } {
  if (!artifact) {
    return { kind: 'markdown' }
  }
  const title = artifact.title.toLowerCase()
  const content = artifact.content.trimStart()
  if (/\.(html?|xhtml)$/.test(title) || /^<!doctype html/i.test(content) || /^<html[\s>]/i.test(content)) {
    return { kind: 'html' }
  }
  if (/\.svg$/.test(title) || /^<svg[\s>]/i.test(content)) {
    return { kind: 'svg' }
  }
  const language = languageFromTitle(title)
  if (language) {
    return { kind: 'code', language }
  }
  if (looksLikeJson(content)) {
    return { kind: 'code', language: 'json' }
  }
  return { kind: 'markdown' }
}

function languageFromTitle(title: string): string | undefined {
  const extension = title.match(/\.([a-z0-9]+)$/)?.[1]
  const languages: Record<string, string> = {
    bash: 'bash',
    css: 'css',
    go: 'go',
    html: 'xml',
    java: 'java',
    js: 'javascript',
    json: 'json',
    jsx: 'javascript',
    py: 'python',
    rs: 'rust',
    sh: 'bash',
    sql: 'sql',
    ts: 'typescript',
    tsx: 'typescript',
    xml: 'xml',
    yaml: 'yaml',
    yml: 'yaml',
  }
  return extension ? languages[extension] : undefined
}

function looksLikeJson(value: string): boolean {
  if (!value.startsWith('{') && !value.startsWith('[')) {
    return false
  }
  try {
    JSON.parse(value)
    return true
  } catch {
    return false
  }
}

function blobType(kind: ArtifactKind): string {
  switch (kind) {
    case 'html':
      return 'text/html;charset=utf-8'
    case 'svg':
      return 'image/svg+xml;charset=utf-8'
    default:
      return 'text/plain;charset=utf-8'
  }
}

function safeDownloadName(title: string, kind: ArtifactKind): string {
  const fallback = kind === 'html' ? 'artifact.html' : kind === 'svg' ? 'artifact.svg' : 'artifact.txt'
  const clean = title.trim().replace(/[\\/:*?"<>|]+/g, '-')
  return clean || fallback
}

function childrenToText(node: ReactNode): string {
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
    return childrenToText((node as { props?: { children?: ReactNode } }).props?.children)
  }
  return ''
}
