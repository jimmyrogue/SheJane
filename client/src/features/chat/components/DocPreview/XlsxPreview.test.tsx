import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { XlsxPreview } from './XlsxPreview'

const terminate = vi.fn()

class FakeWorker {
  onmessage?: (event: MessageEvent) => void
  onerror?: (event: ErrorEvent) => void
  postMessage() {
    queueMicrotask(() => this.onmessage?.({ data: {
      sheets: [
        { name: 'Summary', rows: [['Name', 'Count'], ['石间', '3']] },
        { name: 'Dates', rows: [['Created'], ['2026-07-15']] },
      ],
    } } as MessageEvent))
  }
  terminate = terminate
}

beforeEach(() => {
  terminate.mockClear()
  vi.stubGlobal('Worker', FakeWorker)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('XlsxPreview', () => {
  it('renders parsed sheets and switches tabs', async () => {
    const view = render(<XlsxPreview sourceKey="report.xlsx" loadBytes={() => Promise.resolve(new ArrayBuffer(0))} />)

    expect(await screen.findByText('石间')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'Dates' }))
    expect(screen.getByText('2026-07-15')).toBeInTheDocument()
    view.unmount()
    expect(terminate).toHaveBeenCalled()
  })
})
