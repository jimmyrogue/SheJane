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
  it('renders work IM connections instead of MCP server catalog copy', () => {
    renderView()

    expect(screen.getByText('连接', { selector: '.chat-toolbar-title span' })).toBeInTheDocument()
    expect(screen.getByText('飞书 Lark')).toBeInTheDocument()
    expect(screen.getByText('企业微信')).toBeInTheDocument()
    expect(screen.queryByText('Claude Desktop')).not.toBeInTheDocument()
    expect(screen.queryByText('添加自定义 MCP 服务器…')).not.toBeInTheDocument()
  })

  it('lets disconnected IM tools move into the connected state', () => {
    renderView()

    fireEvent.click(screen.getByRole('button', { name: '连接企业微信' }))

    expect(screen.getAllByText('已连接')).toHaveLength(3)
    expect(screen.queryByRole('button', { name: '连接企业微信' })).not.toBeInTheDocument()
  })
})
