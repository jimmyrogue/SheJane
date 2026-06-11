import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TodayView } from './TodayView'

describe('TodayView (mock)', () => {
  afterEach(cleanup)

  it('renders the priority groups in order', () => {
    render(<TodayView />)
    expect(screen.getByText('现在回')).toBeInTheDocument()
    expect(screen.getByText('今天内')).toBeInTheDocument()
    expect(screen.getByText('可放一放')).toBeInTheDocument()
    expect(screen.getByText('只需知道')).toBeInTheDocument()
  })

  it('toggles a todo complete/incomplete', () => {
    render(<TodayView />)
    const row = screen.getByText('Q3 预算的数字今天上午要，先给个初版也行').closest('.today-row') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: '标记为完成' }))
    expect(within(row).getByRole('button', { name: '标记为未完成' })).toBeInTheDocument()
  })

  it('quotes an open todo back to chat', () => {
    const onQuoteToChat = vi.fn()
    render(<TodayView onQuoteToChat={onQuoteToChat} />)
    const row = screen.getByText('团队 6 月考勤异常 2 条，需要你确认').closest('.today-row') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: '引用到对话' }))
    expect(onQuoteToChat).toHaveBeenCalledWith('团队 6 月考勤异常 2 条，需要你确认')
  })
})
