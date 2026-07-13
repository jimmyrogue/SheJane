import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table'
import { DataGrid, type DataGridColumn } from './ui-helpers'

describe('admin table surfaces', () => {
  it('wraps DataGrid rows in a horizontal scroll container', () => {
    const columns: Array<DataGridColumn<{ id: string; email: string }>> = [
      { label: '邮箱', width: 'minmax(240px, 2fr)', render: (row) => row.email },
      { label: '状态', width: '120px', render: () => 'active' },
      { label: '额度消耗', width: '140px', align: 'right', render: () => '100' },
    ]

    const { container } = render(
      <DataGrid
        columns={columns}
        rows={[{ id: 'user-1', email: 'admin@example.com' }]}
        getRowKey={(row) => row.id}
        empty="暂无用户"
      />,
    )

    expect(container.querySelector('[data-slot="data-grid-scroll"]')).toHaveClass('admin-dt-scroll')
    expect(container.querySelector('[data-slot="data-grid-content"]')).toHaveClass('admin-dt-content')
  })

  it('keeps shadcn tables scrollable when their content is wider than the viewport', () => {
    const { container } = render(
      <Table>
        <TableBody>
          <TableRow>
            <TableCell>very-long-cell-content</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    )

    expect(container.querySelector('[data-slot="table-container"]')).toHaveClass('min-w-0', 'overflow-x-auto')
    expect(screen.getByRole('table')).toHaveClass('min-w-max')
  })
})
