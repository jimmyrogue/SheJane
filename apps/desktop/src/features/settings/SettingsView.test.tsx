import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/shared/i18n/i18n'
import type { AgentSettings } from '@/shared/local-host/client'
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

  it('shows Runtime and BYOK model settings without an account section', () => {
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

    expect(screen.getAllByText('运行时')).not.toHaveLength(0)
    expect(screen.getAllByText('模型供应商')).not.toHaveLength(0)
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
