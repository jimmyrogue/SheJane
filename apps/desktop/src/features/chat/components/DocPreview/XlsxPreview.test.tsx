import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { XlsxPreview } from './XlsxPreview'

vi.mock('read-excel-file/browser', () => ({
  default: vi.fn().mockResolvedValue([
    { sheet: 'Summary', data: [['Name', 'Count'], ['石间', 3]] },
    { sheet: 'Dates', data: [['Created'], [new Date('2026-07-15T00:00:00Z')]] },
  ]),
}))

afterEach(() => cleanup())

describe('XlsxPreview', () => {
  it('renders parsed sheets and switches tabs', async () => {
    render(<XlsxPreview sourceKey="report.xlsx" loadBytes={() => Promise.resolve(new ArrayBuffer(0))} />)

    expect(await screen.findByText('石间')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'Dates' }))
    expect(screen.getByText('2026-07-15')).toBeInTheDocument()
  })
})
