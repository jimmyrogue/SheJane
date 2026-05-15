import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PendingApprovalBar } from './PendingApprovalBar'
import { I18nProvider } from '@/shared/i18n/i18n'

afterEach(() => cleanup())

describe('PendingApprovalBar', () => {
  it('renders nothing when there is no pending approval', () => {
    const { container } = render(
      <I18nProvider>
        <PendingApprovalBar approval={null} onDecision={vi.fn()} />
      </I18nProvider>,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the prompt and forwards decisions with message id, request id and scope', () => {
    const onDecision = vi.fn()
    render(
      <I18nProvider>
        <PendingApprovalBar approval={{ messageID: 'm1', requestID: 'p1', tool: '运行命令' }} onDecision={onDecision} />
      </I18nProvider>,
    )

    expect(screen.getByText('等待批准：运行命令')).toBeInTheDocument()

    fireEvent.click(screen.getByText('本会话始终允许'))
    expect(onDecision).toHaveBeenCalledWith('m1', 'p1', 'approve', 'run')

    fireEvent.click(screen.getByText('允许一次'))
    expect(onDecision).toHaveBeenCalledWith('m1', 'p1', 'approve', 'once')

    fireEvent.click(screen.getByText('拒绝'))
    expect(onDecision).toHaveBeenCalledWith('m1', 'p1', 'deny', undefined)
  })
})
