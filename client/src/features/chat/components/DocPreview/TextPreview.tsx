import { useEffect, useState } from 'react'

import { codeLanguageForFile } from '@/shared/files/filePreview'
import { CodeBlock } from '../CodeBlock'

interface Props {
  sourceKey: string
  name: string
  kind: 'code' | 'text'
  loadBytes: () => Promise<ArrayBuffer>
  refreshKey?: number
  onStatus?: (status: 'loading' | 'ready' | 'error', error?: Error) => void
}

// ponytail: cap rendered text so syntax highlighting cannot freeze the chat UI;
// raise this only together with a virtualized text renderer.
const MAX_RENDERED_TEXT_BYTES = 512 * 1024

export function TextPreview({ sourceKey, name, kind, loadBytes, refreshKey = 0, onStatus }: Props) {
  const [text, setText] = useState<string>()
  const [error, setError] = useState<Error>()

  useEffect(() => {
    let cancelled = false
    setText(undefined)
    setError(undefined)
    onStatus?.('loading')
    void loadBytes().then((bytes) => {
      if (cancelled) return
      const visible = bytes.slice(0, MAX_RENDERED_TEXT_BYTES)
      const decoded = new TextDecoder('utf-8', { fatal: false }).decode(visible)
      setText(bytes.byteLength > visible.byteLength
        ? `${decoded}\n\n… (preview truncated)`
        : decoded)
      onStatus?.('ready')
    }).catch((reason: unknown) => {
      if (cancelled) return
      const next = reason instanceof Error ? reason : new Error(String(reason))
      setError(next)
      onStatus?.('error', next)
    })
    return () => {
      cancelled = true
    }
  }, [sourceKey, refreshKey, loadBytes, onStatus])

  if (error) return <div className="doc-preview-error" role="alert">{error.message}</div>
  if (text === undefined) return <div className="doc-preview-loading">…</div>
  return kind === 'code'
    ? <div className="doc-preview-code"><CodeBlock language={codeLanguageForFile(name)} code={text} /></div>
    : <pre className="doc-preview-text">{text}</pre>
}
