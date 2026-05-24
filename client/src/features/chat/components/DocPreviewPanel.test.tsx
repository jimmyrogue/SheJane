import { cleanup, render, screen, fireEvent } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/shared/i18n/i18n'
import type { OpenDocument } from '@/shared/local-data/types'

import { DocPreviewPanel } from './DocPreviewPanel'

// docx-preview and exceljs both touch DOM APIs (canvas / blob) that jsdom
// only partially implements. We stub the subcomponents so this test focuses
// on the panel's shell behavior — wiring is verified by the integration
// smoke step, not unit tests.
vi.mock('./DocPreview/DocxPreview', () => ({
  DocxPreview: ({ sourceKey }: { sourceKey: string }) => (
    <div data-testid="docx-preview-stub">docx:{sourceKey}</div>
  ),
}))
vi.mock('./DocPreview/XlsxPreview', () => ({
  XlsxPreview: ({ sourceKey }: { sourceKey: string }) => (
    <div data-testid="xlsx-preview-stub">xlsx:{sourceKey}</div>
  ),
}))

function makeDoc(overrides: Partial<OpenDocument> = {}): OpenDocument {
  return {
    sourceKey: 'local:/tmp/report.docx',
    kind: 'word',
    name: 'report.docx',
    tooltip: '/tmp/report.docx',
    loadBytes: () => Promise.resolve(new ArrayBuffer(0)),
    ...overrides,
  }
}

afterEach(() => cleanup())

describe('DocPreviewPanel', () => {
  it('renders nothing visible when no document is open', () => {
    render(
      <I18nProvider>
        <DocPreviewPanel doc={null} onClose={vi.fn()} />
      </I18nProvider>,
    )
    expect(screen.queryByTestId('docx-preview-stub')).not.toBeInTheDocument()
    expect(screen.queryByTestId('xlsx-preview-stub')).not.toBeInTheDocument()
  })

  it('mounts the Word renderer when kind=word and shows the title', () => {
    const doc = makeDoc()
    render(
      <I18nProvider>
        <DocPreviewPanel doc={doc} onClose={vi.fn()} />
      </I18nProvider>,
    )
    expect(screen.getByTestId('docx-preview-stub')).toHaveTextContent(`docx:${doc.sourceKey}`)
    expect(screen.getByText('report.docx')).toBeInTheDocument()
    expect(screen.getByText('Word 文档')).toBeInTheDocument()
  })

  it('mounts the Excel renderer when kind=excel', () => {
    const doc = makeDoc({
      sourceKey: 'cloud:doc_xy',
      kind: 'excel',
      name: 'q4.xlsx',
    })
    render(
      <I18nProvider>
        <DocPreviewPanel doc={doc} onClose={vi.fn()} />
      </I18nProvider>,
    )
    expect(screen.getByTestId('xlsx-preview-stub')).toHaveTextContent('xlsx:cloud:doc_xy')
    expect(screen.queryByTestId('docx-preview-stub')).not.toBeInTheDocument()
    expect(screen.getByText('Excel 表格')).toBeInTheDocument()
  })

  it('calls onClose when the Sheet primitive close button is clicked', () => {
    const doc = makeDoc()
    const onClose = vi.fn()
    render(
      <I18nProvider>
        <DocPreviewPanel doc={doc} onClose={onClose} />
      </I18nProvider>,
    )
    // shadcn Sheet ships its own absolute-positioned close button with
    // sr-only "Close" text — we no longer add a duplicate inside the
    // header, so the test targets that built-in affordance.
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('zoom buttons update the percentage label and the inline style on the stage', () => {
    const doc = makeDoc()
    render(
      <I18nProvider>
        <DocPreviewPanel doc={doc} onClose={vi.fn()} />
      </I18nProvider>,
    )

    // Sheet renders into a portal under document.body, so we can't use
    // the render() container — query the live document instead.
    const stage = document.body.querySelector('.doc-preview-zoom-stage') as HTMLElement | null
    expect(stage).not.toBeNull()
    expect(screen.getByText('100%')).toBeInTheDocument()
    expect(stage!.style.zoom).toBe('1')

    fireEvent.click(screen.getByTitle('放大'))
    expect(screen.getByText('110%')).toBeInTheDocument()
    expect(stage!.style.zoom).toBe('1.1')

    fireEvent.click(screen.getByTitle('缩小'))
    fireEvent.click(screen.getByTitle('缩小'))
    expect(screen.getByText('90%')).toBeInTheDocument()

    // The percentage label itself is a reset trigger.
    fireEvent.click(screen.getByText('90%'))
    expect(screen.getByText('100%')).toBeInTheDocument()
  })

  it('clamps stored width to the viewport so an oversized saved value does not break layout', () => {
    // Pre-seed a width way beyond the viewport. The panel reads from
    // localStorage on mount and should clamp on first render.
    window.localStorage.setItem('jiandanly.docPreview.width', '99999')
    const doc = makeDoc()
    render(
      <I18nProvider>
        <DocPreviewPanel doc={doc} onClose={vi.fn()} />
      </I18nProvider>,
    )
    const sheet = document.body.querySelector('.doc-preview-panel') as HTMLElement | null
    expect(sheet).not.toBeNull()
    const widthPx = Number((sheet!.style.width || '0').replace('px', ''))
    expect(widthPx).toBeGreaterThan(0)
    expect(widthPx).toBeLessThanOrEqual(Math.floor(window.innerWidth * 0.95))
    window.localStorage.removeItem('jiandanly.docPreview.width')
  })
})
