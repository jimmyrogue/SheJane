import { useCallback, useEffect, useRef, useState } from 'react'
import {
  IconFileTypeDocx,
  IconFileTypePpt,
  IconFileTypeXls,
  IconMinus,
  IconPlus,
  IconRestore,
} from '@tabler/icons-react'

import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { useI18n } from '@/shared/i18n/i18n'
import { getDesktopLocalHostConfig } from '@/shared/local-host/client'
import type { OpenDocument } from '@/shared/local-data/types'

import { DocxPreview } from './DocPreview/DocxPreview'
import { PptxPreview } from './DocPreview/PptxPreview'
import { XlsxPreview } from './DocPreview/XlsxPreview'

interface Props {
  doc: OpenDocument | null
  refreshKey?: number
  onClose: () => void
}

const WIDTH_STORAGE_KEY = 'jiandanly.docPreview.width'
const ZOOM_STORAGE_KEY = 'jiandanly.docPreview.zoom'
const DEFAULT_WIDTH = 760
const MIN_WIDTH = 420
const MAX_WIDTH_VW = 95 // % of viewport
const DEFAULT_ZOOM = 1
const MIN_ZOOM = 0.5
const MAX_ZOOM = 1.6
const ZOOM_STEP = 0.1

function readStoredNumber(key: string, fallback: number): number {
  if (typeof window === 'undefined') return fallback
  try {
    const raw = window.localStorage.getItem(key)
    if (raw == null) return fallback
    const n = Number(raw)
    return Number.isFinite(n) && n > 0 ? n : fallback
  } catch {
    return fallback
  }
}

function writeStoredNumber(key: string, value: number) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(key, String(value))
  } catch {
    /* localStorage disabled */
  }
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value))
}

/**
 * Right-side document preview. The Sheet stays non-modal so the main
 * chat stays usable while the panel is open (same UX as ArtifactPanel
 * and DiagnosticsPanel).
 *
 * Two interactive affordances the user controls:
 *  1. Panel width — drag the left edge. Persisted across reloads.
 *  2. Page zoom — +/- buttons in the header. Persisted across reloads.
 *
 * docx-preview has no native zoom API, so we apply CSS `zoom: x` on
 * the host node. `zoom` is non-standard but well-supported in
 * Chromium/Electron and (unlike `transform: scale`) actually re-flows
 * the layout so scrollbars stay accurate.
 */
export function DocPreviewPanel({ doc, refreshKey = 0, onClose }: Props) {
  const { t } = useI18n()
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [widthPx, setWidthPxState] = useState<number>(() =>
    clamp(readStoredNumber(WIDTH_STORAGE_KEY, DEFAULT_WIDTH), MIN_WIDTH, viewportMaxWidth()),
  )
  const [zoom, setZoomState] = useState<number>(() =>
    clamp(readStoredNumber(ZOOM_STORAGE_KEY, DEFAULT_ZOOM), MIN_ZOOM, MAX_ZOOM),
  )

  function setWidthPx(next: number) {
    const clamped = clamp(next, MIN_WIDTH, viewportMaxWidth())
    setWidthPxState(clamped)
    writeStoredNumber(WIDTH_STORAGE_KEY, clamped)
  }
  function setZoom(next: number) {
    const clamped = clamp(Math.round(next * 100) / 100, MIN_ZOOM, MAX_ZOOM)
    setZoomState(clamped)
    writeStoredNumber(ZOOM_STORAGE_KEY, clamped)
  }

  // ─── Resize handle (drag the left edge) ─────────────────────────────
  // We don't use a render-on-every-mousemove pattern; pointer events
  // give us coalesced moves and capture so the drag doesn't break when
  // the cursor leaves the handle.
  const resizingRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const onResizePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault()
      const target = event.currentTarget
      target.setPointerCapture(event.pointerId)
      resizingRef.current = { startX: event.clientX, startWidth: widthPx }
    },
    [widthPx],
  )
  const onResizePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const state = resizingRef.current
    if (!state) return
    // Drag-left = widen the panel (panel is on the right; we widen by
    // pulling the left edge to the left), drag-right = narrow.
    const delta = state.startX - event.clientX
    setWidthPx(state.startWidth + delta)
  }, [])
  const onResizePointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (resizingRef.current) {
      event.currentTarget.releasePointerCapture(event.pointerId)
      resizingRef.current = null
    }
  }, [])

  // Re-clamp width on viewport resize so a stored 1200px width on a
  // 1024px viewport doesn't make the panel cover the whole screen.
  useEffect(() => {
    function onWindowResize() {
      setWidthPxState((current) => clamp(current, MIN_WIDTH, viewportMaxWidth()))
    }
    window.addEventListener('resize', onWindowResize)
    return () => window.removeEventListener('resize', onWindowResize)
  }, [])

  const KindIcon =
    doc?.kind === 'excel'
      ? IconFileTypeXls
      : doc?.kind === 'powerpoint'
        ? IconFileTypePpt
        : IconFileTypeDocx
  const zoomPercent = Math.round(zoom * 100)
  // Localhost config: pptx preview needs it to hit the outline
  // endpoint; getDesktopLocalHostConfig pulls it from the desktop
  // bridge so the panel doesn't need a config prop threaded down.
  const localHostConfig = doc?.kind === 'powerpoint' ? getDesktopLocalHostConfig() : undefined

  return (
    <Sheet modal={false} open={Boolean(doc)} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        className="doc-preview-panel overflow-hidden"
        style={{ width: `${widthPx}px`, maxWidth: '95vw' }}
        showOverlay={false}
      >
        {/* Drag handle: positioned on the left edge of the panel. */}
        <div
          className="doc-preview-resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label={t('docPreview.resize')}
          onPointerDown={onResizePointerDown}
          onPointerMove={onResizePointerMove}
          onPointerUp={onResizePointerUp}
          onPointerCancel={onResizePointerUp}
        />

        <SheetHeader>
          <div className="doc-preview-header">
            <span className={`doc-preview-icon doc-preview-icon-${doc?.kind ?? 'word'}`} aria-hidden="true">
              <KindIcon size={20} />
            </span>
            <div className="doc-preview-header-text">
              <SheetTitle className="doc-preview-title" title={doc?.tooltip}>
                {doc?.name ?? t('docPreview.defaultTitle')}
              </SheetTitle>
              <SheetDescription className="doc-preview-subtitle">
                {doc
                  ? t(
                      doc.kind === 'word'
                        ? 'docPreview.kind.word'
                        : doc.kind === 'excel'
                          ? 'docPreview.kind.excel'
                          : 'docPreview.kind.powerpoint',
                    )
                  : ''}
              </SheetDescription>
            </div>
            <div className="doc-preview-zoom" role="group" aria-label={t('docPreview.zoom')}>
              <Button
                variant="ghost"
                size="icon-sm"
                title={t('docPreview.zoomOut')}
                disabled={zoom <= MIN_ZOOM + 1e-6}
                onClick={() => setZoom(zoom - ZOOM_STEP)}
              >
                <IconMinus size={14} />
              </Button>
              <button
                type="button"
                className="doc-preview-zoom-label"
                onClick={() => setZoom(DEFAULT_ZOOM)}
                title={t('docPreview.zoomReset')}
                aria-label={t('docPreview.zoomReset')}
              >
                {zoomPercent}%
              </button>
              <Button
                variant="ghost"
                size="icon-sm"
                title={t('docPreview.zoomIn')}
                disabled={zoom >= MAX_ZOOM - 1e-6}
                onClick={() => setZoom(zoom + ZOOM_STEP)}
              >
                <IconPlus size={14} />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                title={t('docPreview.zoomReset')}
                disabled={Math.abs(zoom - DEFAULT_ZOOM) < 1e-6}
                onClick={() => setZoom(DEFAULT_ZOOM)}
              >
                <IconRestore size={14} />
              </Button>
            </div>
          </div>
        </SheetHeader>
        <div className="doc-preview-body">
          <div className="doc-preview-zoom-stage" style={{ zoom }}>
            {doc?.kind === 'word' ? (
              <DocxPreview
                sourceKey={doc.sourceKey}
                loadBytes={doc.loadBytes}
                refreshKey={refreshKey}
                onStatus={setStatus}
              />
            ) : doc?.kind === 'excel' ? (
              <XlsxPreview
                sourceKey={doc.sourceKey}
                loadBytes={doc.loadBytes}
                refreshKey={refreshKey}
                onStatus={setStatus}
              />
            ) : doc?.kind === 'powerpoint' && doc.localPath && localHostConfig ? (
              <PptxPreview
                sourceKey={doc.sourceKey}
                localPath={doc.localPath}
                config={localHostConfig}
                refreshKey={refreshKey}
                onStatus={setStatus}
              />
            ) : null}
          </div>
          {doc && status === 'loading' ? (
            <div className="doc-preview-status">{t('docPreview.loading')}</div>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function viewportMaxWidth(): number {
  if (typeof window === 'undefined') return 1600
  return Math.max(MIN_WIDTH, Math.floor((window.innerWidth * MAX_WIDTH_VW) / 100))
}
