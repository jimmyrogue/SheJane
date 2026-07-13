import { useEffect, useMemo, useState } from 'react'
import ExcelJS from 'exceljs'

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
 * Renders a .xlsx inline as a list of tabbed sheets via exceljs.
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
    loadBytes()
      .then(async (buf) => {
        if (cancelled) return
        const wb = new ExcelJS.Workbook()
        await wb.xlsx.load(buf)
        const out: SheetView[] = []
        wb.eachSheet((sheet) => {
          const rows: string[][] = []
          const maxRow = Math.min(sheet.actualRowCount || sheet.rowCount, 1000)
          const maxCol = Math.min(sheet.actualColumnCount || sheet.columnCount, 50)
          for (let r = 1; r <= maxRow; r++) {
            const row: string[] = []
            const xlRow = sheet.getRow(r)
            for (let c = 1; c <= maxCol; c++) {
              const cell = xlRow.getCell(c)
              row.push(cellToString(cell.value))
            }
            rows.push(row)
          }
          out.push({ name: sheet.name, rows })
        })
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

function cellToString(value: ExcelJS.CellValue): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  if (typeof value === 'object' && 'result' in value && value.result != null) {
    return cellToString(value.result as ExcelJS.CellValue)
  }
  if (typeof value === 'object' && 'richText' in value && Array.isArray(value.richText)) {
    return value.richText.map((rt) => rt.text ?? '').join('')
  }
  if (typeof value === 'object' && 'text' in value && typeof value.text === 'string') {
    return value.text
  }
  return String(value)
}
