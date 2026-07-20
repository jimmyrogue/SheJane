import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/shared/i18n/i18n'
import type { AgentSettings } from '@/runtime/client'
import { SettingsView } from './SettingsView'

const settings: Required<AgentSettings> = {
  memory: 'on',
  skills: 'on',
  mcp: 'on',
  mcpDisabled: [],
  advanced: {},
}

describe('SettingsView', () => {
  afterEach(cleanup)

  it('keeps settings focused on models, agent, general, and local data', () => {
    render(
      <I18nProvider>
        <SettingsView
          isDesktop
          agentSettings={settings}
          onAgentSettingsChange={vi.fn()}
          onImportLocalData={vi.fn()}
        />
      </I18nProvider>,
    )

    expect(screen.getAllByText('模型供应商')).not.toHaveLength(0)
    expect(screen.getByRole('switch', { name: '记忆' })).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: '子代理' })).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: '浏览器无头' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: '输入防护' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Runtime' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '运行' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '推理质量' })).not.toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: 'Skill' })).not.toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: 'MCP 服务' })).not.toBeInTheDocument()
    expect(screen.queryByText('账户')).not.toBeInTheDocument()
    expect(screen.queryByText('退出登录')).not.toBeInTheDocument()
  })

  it('keeps local data controls available', () => {
    render(
      <I18nProvider>
        <SettingsView
          isDesktop
          agentSettings={settings}
          onAgentSettingsChange={vi.fn()}
          onImportLocalData={vi.fn()}
          onExportLocalData={vi.fn()}
        />
      </I18nProvider>,
    )

    expect(screen.getAllByText('数据与安全')).not.toHaveLength(0)
  })
})
