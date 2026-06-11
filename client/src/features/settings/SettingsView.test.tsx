import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/shared/i18n/i18n'
import { SettingsView } from './SettingsView'
import type { AgentSettings } from '@/shared/local-host/client'

const baseSettings: Required<AgentSettings> = {
  memory: 'on',
  skills: 'on',
  mcp: 'on',
  mcpDisabled: [],
  advanced: {},
}

function renderSettings(props: Partial<React.ComponentProps<typeof SettingsView>> = {}) {
  return render(
    <I18nProvider>
      <SettingsView
        isDesktop
        userEmail="test@example.com"
        agentSettings={baseSettings}
        onAgentSettingsChange={vi.fn()}
        onImportLocalData={vi.fn()}
        {...props}
      />
    </I18nProvider>,
  )
}

describe('SettingsView', () => {
  afterEach(cleanup)

  it('shows the page title and the account email', () => {
    renderSettings()
    expect(screen.getByText('设置')).toBeInTheDocument()
    expect(screen.getByText('test@example.com')).toBeInTheDocument()
  })

  it('shows only the extra-credits line (monthly quota is hidden)', () => {
    renderSettings({
      balance: {
        id: 'w1',
        plan_code: 'free',
        monthly_credit_limit: 1000,
        monthly_credits_used: 200,
        monthly_remaining: 800,
        extra_credits_balance: 50,
        period_end: '',
        status: 'active',
      },
    })
    expect(screen.getByText('剩余Token数 50')).toBeInTheDocument()
    expect(screen.queryByText(/本月余额/)).not.toBeInTheDocument()
    expect(screen.queryByText(/本月额度不限量/)).not.toBeInTheDocument()
  })

  it('renders no balance line when there are no extra credits', () => {
    renderSettings({
      balance: {
        id: 'w1',
        plan_code: 'free',
        monthly_credit_limit: 0,
        monthly_credits_used: 0,
        monthly_remaining: 0,
        extra_credits_balance: 0,
        period_end: '',
        status: 'active',
      },
    })
    expect(screen.queryByText(/剩余Token数/)).not.toBeInTheDocument()
  })

  it('toggles the memory agent setting', () => {
    const onAgentSettingsChange = vi.fn()
    renderSettings({ agentSettings: { ...baseSettings, memory: 'off', skills: 'off', mcp: 'off' }, onAgentSettingsChange })
    const memorySwitch = screen.getByRole('switch', { name: '记忆' })
    expect(memorySwitch).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(memorySwitch)
    expect(onAgentSettingsChange).toHaveBeenCalledWith(
      expect.objectContaining({ memory: 'on', skills: 'off', mcp: 'off' }),
    )
  })

  it('toggles the skills agent setting', () => {
    const onAgentSettingsChange = vi.fn()
    renderSettings({ agentSettings: { ...baseSettings, memory: 'off', skills: 'off', mcp: 'off' }, onAgentSettingsChange })
    fireEvent.click(screen.getByRole('switch', { name: '技能' }))
    expect(onAgentSettingsChange).toHaveBeenCalledWith(
      expect.objectContaining({ memory: 'off', skills: 'on', mcp: 'off' }),
    )
  })

  it('hides skills/MCP/advanced on the web build', () => {
    renderSettings({ isDesktop: false })
    expect(screen.getByRole('switch', { name: '记忆' })).toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: '技能' })).not.toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: 'MCP 服务' })).not.toBeInTheDocument()
    expect(screen.queryByText('高级')).not.toBeInTheDocument()
  })

  it('hides the 清空记忆 row when onClearMemory is not provided', () => {
    renderSettings()
    expect(screen.queryByText('清空记忆')).not.toBeInTheDocument()
  })

  it('calls onClearMemory only after confirming', async () => {
    const onClearMemory = vi.fn(async () => 7)
    renderSettings({ onClearMemory })

    // The bare 清空 button opens the confirm dialog, does NOT clear directly.
    fireEvent.click(screen.getByRole('button', { name: '清空' }))
    expect(onClearMemory).not.toHaveBeenCalled()

    const confirm = await screen.findByRole('alertdialog')
    expect(within(confirm).getByText('清空所有记忆？')).toBeInTheDocument()
    fireEvent.click(within(confirm).getByRole('button', { name: '确认清空' }))
    await waitFor(() => expect(onClearMemory).toHaveBeenCalledTimes(1))
  })

  it('does not call onClearMemory when the confirmation is cancelled', async () => {
    const onClearMemory = vi.fn(async () => 0)
    renderSettings({ onClearMemory })
    fireEvent.click(screen.getByRole('button', { name: '清空' }))
    const confirm = await screen.findByRole('alertdialog')
    fireEvent.click(within(confirm).getByRole('button', { name: '取消' }))
    expect(onClearMemory).not.toHaveBeenCalled()
  })
})
