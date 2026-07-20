import { useEffect, useMemo, useState } from 'react'
import type { CellValue } from 'read-excel-file/browser'

interface Props {
  sourceKey: string
  loadBytes: () => Promise<ArrayBuffer>
  refreshKey?: number
  onStatus?: (status: 'loading' | 'ready' | 'error', error?: Error) => void
}

interface SheetView {
  name: string
  /** rows × cols of stringified cell values. Empty cells become "". */
  rows: string[][]
}

/**
 * Renders a .xlsx inline as a list of tabbed sheets.
 *
 * Source-agnostic (like DocxPreview): just consumes `loadBytes()`.
 * Sheet formatting (bold, colors) is not surfaced for v1; cell values
 * + structure cover ~90% of "let me see what's in here" cases.
 *
 * Row/column caps (1000 × 50) bound DOM size for huge sheets; if users
 * need more we'll swap in a virtual grid library.
 */
export function XlsxPreview({ sourceKey, loadBytes, refreshKey = 0, onStatus }: Props) {
  const [sheets, setSheets] = useState<SheetView[] | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)

  useEffect(() => {
    let cancelled = false
    setError(null)
    setSheets(null)
    onStatus?.('loading')
    Promise.all([loadBytes(), import('read-excel-file/browser')])
      .then(async ([buf, { default: readExcelFile }]) => {
        if (cancelled) return
        const workbook = await readExcelFile(buf)
        const out = workbook.map(({ sheet, data }) => ({
          name: sheet,
          rows: data.slice(0, 1000).map((row) => row.slice(0, 50).map(cellToString)),
        }))
        if (cancelled) return
        setSheets(out)
        setActiveIndex(0)
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

  const activeSheet = useMemo(() => sheets?.[activeIndex] ?? null, [sheets, activeIndex])

  if (error) {
    return (
      <div className="doc-preview-error" role="alert">
        <p>{error.message}</p>
      </div>
    )
  }
  if (!sheets) {
    return <div className="doc-preview-loading">…</div>
  }
  if (sheets.length === 0) {
    return <div className="doc-preview-empty">(empty workbook)</div>
  }
  return (
    <div className="doc-preview-xlsx" data-testid="xlsx-preview">
      {sheets.length > 1 ? (
        <div className="xlsx-sheet-tabs" role="tablist">
          {sheets.map((sheet, i) => (
            <button
              key={sheet.name}
              role="tab"
              type="button"
              aria-selected={i === activeIndex}
              className={i === activeIndex ? 'xlsx-sheet-tab active' : 'xlsx-sheet-tab'}
              onClick={() => setActiveIndex(i)}
            >
              {sheet.name}
            </button>
          ))}
        </div>
      ) : null}
      {activeSheet ? <SheetTable rows={activeSheet.rows} /> : null}
    </div>
  )
}

function SheetTable({ rows }: { rows: string[][] }) {
  if (rows.length === 0) {
    return <div className="doc-preview-empty">(empty sheet)</div>
  }
  return (
    <div className="xlsx-sheet-scroll">
      <table className="xlsx-sheet-table">
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function cellToString(value: CellValue | null): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  return String(value)
}
