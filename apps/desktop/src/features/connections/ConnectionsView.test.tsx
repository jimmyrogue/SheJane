import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { I18nProvider } from '@/shared/i18n/i18n'
import { ConnectionsView } from './ConnectionsView'

afterEach(cleanup)

function renderView() {
  render(
    <I18nProvider>
      <ConnectionsView />
    </I18nProvider>,
  )
}

describe('ConnectionsView', () => {
  it('shows the remaining work connectors', () => {
    renderView()
    expect(screen.getByText('日历')).toBeInTheDocument()
    expect(screen.getByText('邮箱 IMAP')).toBeInTheDocument()
    expect(screen.getByText('企业微信')).toBeInTheDocument()
    expect(screen.queryByText('飞书 Lark')).not.toBeInTheDocument()
  })

  it('lets a disconnected connector move into the connected state', () => {
    renderView()
    fireEvent.click(screen.getByRole('button', { name: '连接企业微信' }))
    expect(screen.queryByRole('button', { name: '连接企业微信' })).not.toBeInTheDocument()
    expect(screen.getAllByText('已连接')).toHaveLength(2)
  })
})
