import readExcelFile, { type CellValue } from 'read-excel-file/web-worker'

interface WorkerScope {
  onmessage: ((event: MessageEvent<ArrayBuffer>) => void) | null
  postMessage(value: unknown): void
}

const worker = globalThis as unknown as WorkerScope

worker.onmessage = (event) => {
  void readExcelFile(event.data).then((workbook) => {
    worker.postMessage({
      sheets: workbook.map(({ sheet, data }) => ({
        name: sheet,
        rows: data.slice(0, 1000).map((row) => row.slice(0, 50).map(cellToString)),
      })),
    })
  }).catch((reason: unknown) => {
    worker.postMessage({ error: reason instanceof Error ? reason.message : String(reason) })
  })
}

function cellToString(value: CellValue | null): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  return String(value)
}
