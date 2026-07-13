import { useEffect, useRef, useState } from 'react'
import { renderAsync } from 'docx-preview'

interface Props {
  /** Stable identifier that changes when the source changes. Drives the
   *  useEffect refetch — same key + same refreshKey = no reload. */
  sourceKey: string
  /** Returns the .docx bytes. Closure over whichever authenticated
   *  fetch backs this source through the local Runtime workspace endpoint. */
  loadBytes: () => Promise<ArrayBuffer>
  /** Bumped by the parent on edit / re-open to force a refetch. */
  refreshKey?: number
  onStatus?: (status: 'loading' | 'ready' | 'error', error?: Error) => void
}

/**
 * Renders a .docx inline using docx-preview. The component is source-
 * agnostic — it just takes a `loadBytes` async function. App.tsx wraps
 * `fetchWorkspaceFile` (for workspace files) or `api.fetchDocumentBytes`
 * into that signature.
 */
export function DocxPreview({ sourceKey, loadBytes, refreshKey = 0, onStatus }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    const node = containerRef.current
    if (!node) {
      return
    }
    let cancelled = false
    setError(null)
    onStatus?.('loading')
    node.innerHTML = ''
    loadBytes()
      .then(async (buf) => {
        if (cancelled) return
        await renderAsync(buf, node, undefined, {
          className: 'docx-render',
          inWrapper: true,
          ignoreWidth: false,
          ignoreHeight: false,
          ignoreFonts: false,
          breakPages: true,
          experimental: false,
          trimXmlDeclaration: true,
        })
        if (cancelled) return
        onStatus?.('ready')
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const e = err instanceof Error ? err : new Error(String(err))
        setError(e)
        onStatus?.('error', e)
      })
    return () => {
      cancelled = true
    }
  }, [sourceKey, refreshKey, loadBytes, onStatus])

  if (error) {
    return (
      <div className="doc-preview-error" role="alert">
        <p>{error.message}</p>
      </div>
    )
  }
  return <div ref={containerRef} className="doc-preview-docx" data-testid="docx-preview" />
}
