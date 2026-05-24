import { useEffect, useState } from 'react'
import { IconExternalLink, IconNotes } from '@tabler/icons-react'

import { Button } from '@/components/ui/button'
import { useI18n } from '@/shared/i18n/i18n'
import { fetchPptxOutline } from '@/shared/local-host/client'
import type { LocalHostConfig } from '@/shared/local-host/client'
import type { PptxSlideOutline } from '@/shared/local-data/types'

interface Props {
  sourceKey: string
  /** Absolute path to the .pptx on the user's filesystem. Required —
   *  the daemon's pptx-outline endpoint refuses anything outside an
   *  authorized workspace. */
  localPath: string
  config: LocalHostConfig
  refreshKey?: number
  onStatus?: (status: 'loading' | 'ready' | 'error', error?: Error) => void
}

/**
 * Right-side preview for .pptx files. There's no mature pure-browser
 * PowerPoint renderer (docx-preview / ExcelJS have no equivalent), so
 * we render an outline view: one card per slide showing title,
 * bullets, and notes. The user clicks "Open in PowerPoint" to get the
 * real visual deck via the OS default app.
 */
export function PptxPreview({ sourceKey, localPath, config, refreshKey = 0, onStatus }: Props) {
  const { t } = useI18n()
  const [slides, setSlides] = useState<PptxSlideOutline[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setError(null)
    setSlides(null)
    onStatus?.('loading')
    fetchPptxOutline(localPath, config)
      .then((data) => {
        if (cancelled) return
        setSlides(data.slides)
        onStatus?.('ready')
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const e = err instanceof Error ? err : new Error(String(err))
        setError(e.message)
        onStatus?.('error', e)
      })
    return () => {
      cancelled = true
    }
  }, [sourceKey, refreshKey, localPath, config, onStatus])

  function openNatively() {
    const bridge = window.jiandanDesktop
    if (bridge?.openFileWithDefaultApp) {
      void bridge.openFileWithDefaultApp(localPath)
    }
  }

  if (error) {
    return (
      <div className="doc-preview-error" role="alert">
        <p>{t('pptxPreview.loadFailed', { error })}</p>
      </div>
    )
  }
  if (!slides) {
    return <div className="doc-preview-loading">…</div>
  }
  return (
    <div className="doc-preview-pptx" data-testid="pptx-preview">
      <div className="pptx-toolbar">
        <Button type="button" variant="outline" size="sm" onClick={openNatively}>
          <IconExternalLink size={14} />
          {t('pptxPreview.openNatively')}
        </Button>
      </div>
      {slides.length === 0 ? (
        <div className="doc-preview-empty">{t('pptxPreview.empty')}</div>
      ) : (
        <ul className="pptx-slide-list" role="list">
          {slides.map((slide) => (
            <li key={slide.index} className="pptx-slide-card">
              <div className="pptx-slide-header">
                <span className="pptx-slide-number">
                  {t('pptxPreview.slideNumber', { n: slide.index + 1 })}
                </span>
                {slide.layout ? <span className="pptx-slide-layout">{slide.layout}</span> : null}
              </div>
              {slide.title ? <h3 className="pptx-slide-title">{slide.title}</h3> : null}
              {slide.bullets.length > 0 ? (
                <ul className="pptx-slide-bullets">
                  {slide.bullets.map((bullet, i) => (
                    <li key={i}>{bullet}</li>
                  ))}
                </ul>
              ) : null}
              {slide.notes ? (
                <details className="pptx-slide-notes">
                  <summary>
                    <IconNotes size={12} />
                    {t('pptxPreview.notesLabel')}
                  </summary>
                  <p>{slide.notes}</p>
                </details>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
