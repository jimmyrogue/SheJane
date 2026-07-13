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
        <PendingApprovalBar
          approval={{ kind: 'approval', messageID: 'm1', requestID: 'p1', tool: '运行命令', toolName: 'execute', arguments: { command: 'make test' } }}
          onDecision={onDecision}
        />
      </I18nProvider>,
    )

    expect(screen.getByText('等待批准：运行命令')).toBeInTheDocument()

    fireEvent.click(screen.getByText('本次运行允许相同参数'))
    expect(onDecision).toHaveBeenCalledWith('m1', 'p1', 'approve', 'run', undefined)

    fireEvent.click(screen.getByText('允许一次'))
    expect(onDecision).toHaveBeenCalledWith('m1', 'p1', 'approve', 'once', undefined)

    fireEvent.click(screen.getByText('拒绝'))
    expect(onDecision).toHaveBeenCalledWith('m1', 'p1', 'deny', undefined, undefined)

    fireEvent.click(screen.getByText('修改参数'))
    fireEvent.change(screen.getByLabelText('修改参数'), {
      target: { value: '{"command":"make lint"}' },
    })
    fireEvent.click(screen.getByText('按修改后参数执行'))
    expect(onDecision).toHaveBeenCalledWith(
      'm1',
      'p1',
      'edit',
      'once',
      { name: 'execute', args: { command: 'make lint' } },
    )
  })

  it('requires an explicit reconciliation outcome', () => {
    const onReconcile = vi.fn()
    render(
      <I18nProvider>
        <PendingApprovalBar
          approval={{ kind: 'reconciliation', messageID: 'm1', requestID: 'toolop-1', tool: '运行命令', toolName: 'execute', arguments: {} }}
          onDecision={vi.fn()}
          onReconcile={onReconcile}
        />
      </I18nProvider>,
    )
    fireEvent.click(screen.getByText('确认未执行，重新尝试'))
    expect(onReconcile).toHaveBeenCalledWith('m1', 'toolop-1', 'retry_not_executed')
  })
})
