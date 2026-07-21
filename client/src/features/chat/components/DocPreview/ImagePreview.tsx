import { useEffect, useState } from 'react'

interface Props {
  sourceKey: string
  name: string
  loadBytes: () => Promise<ArrayBuffer>
  refreshKey?: number
  onStatus?: (status: 'loading' | 'ready' | 'error', error?: Error) => void
}

export function ImagePreview({ sourceKey, name, loadBytes, refreshKey = 0, onStatus }: Props) {
  const [url, setURL] = useState<string>()
  const [error, setError] = useState<Error>()

  useEffect(() => {
    let cancelled = false
    let objectURL: string | undefined
    setURL(undefined)
    setError(undefined)
    onStatus?.('loading')
    void loadBytes().then((bytes) => {
      if (cancelled) return
      objectURL = URL.createObjectURL(new Blob([bytes]))
      setURL(objectURL)
      onStatus?.('ready')
    }).catch((reason: unknown) => {
      if (cancelled) return
      const next = reason instanceof Error ? reason : new Error(String(reason))
      setError(next)
      onStatus?.('error', next)
    })
    return () => {
      cancelled = true
      if (objectURL) URL.revokeObjectURL(objectURL)
    }
  }, [sourceKey, refreshKey, loadBytes, onStatus])

  if (error) return <div className="doc-preview-error" role="alert">{error.message}</div>
  if (!url) return <div className="doc-preview-loading">…</div>
  return <div className="doc-preview-image"><img src={url} alt={name} /></div>
}
