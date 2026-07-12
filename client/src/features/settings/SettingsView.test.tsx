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

function mockRect(top: number): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    bottom: top + 40,
    left: 0,
    right: 100,
    width: 100,
    height: 40,
    toJSON: () => ({}),
  } as DOMRect
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
  afterEach(() => {
    cleanup()
    window.shejaneDesktop = undefined
  })

  it('shows the page title and the account email', () => {
    renderSettings()
    expect(screen.getByText('设置')).toBeInTheDocument()
    expect(screen.getByText('test@example.com')).toBeInTheDocument()
  })

  it('saves an authenticated external local Runtime and restarts', async () => {
    const set = vi.fn(async () => undefined)
    const restartApp = vi.fn(async () => undefined)
    window.shejaneDesktop = {
      platform: 'darwin',
      runtimeConnection: {
        get: vi.fn(async () => ({
          mode: 'external-local' as const,
          source: 'saved' as const,
          state: 'offline' as const,
          baseURL: 'http://127.0.0.1:17371',
          tokenConfigured: true,
        })),
        set,
        restartApp,
      },
    }
    renderSettings()

    const url = await screen.findByRole('textbox', { name: 'Runtime 地址' })
    fireEvent.change(url, { target: { value: 'http://127.0.0.1:17372' } })
    fireEvent.change(screen.getByLabelText('配对 Token'), { target: { value: 'new-token' } })
    fireEvent.click(screen.getByRole('button', { name: '保存并重启' }))

    await waitFor(() => expect(set).toHaveBeenCalledWith({
      mode: 'external-local',
      baseURL: 'http://127.0.0.1:17372',
      token: 'new-token',
    }))
    expect(restartApp).toHaveBeenCalledOnce()
  })

  it('shows the total available credits in the account card', () => {
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
    expect(screen.getByText('余额 · 剩余积分')).toBeInTheDocument()
    expect(screen.getByText('850')).toBeInTheDocument()
    expect(screen.queryByText(/本月余额/)).not.toBeInTheDocument()
    expect(screen.queryByText(/本月额度不限量/)).not.toBeInTheDocument()
  })

  it('keeps the balance row visible when there are no credits', () => {
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
    expect(screen.getByText('余额 · 剩余积分')).toBeInTheDocument()
    expect(screen.getByText('0')).toBeInTheDocument()
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

  it('renders general and data rows with trailing controls', () => {
    const onExportLocalData = vi.fn()
    renderSettings({ onExportLocalData })

    expect(screen.getByRole('combobox', { name: '语言' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '导入…' })).toBeInTheDocument()
    expect(screen.getByText('导出全部数据')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '导出…' }))
    expect(onExportLocalData).toHaveBeenCalledTimes(1)
  })

  it('updates the active navigation item while the settings content scrolls', () => {
    renderSettings()

    const scrollRoot = document.querySelector('.settings-scroll') as HTMLDivElement
    expect(scrollRoot).not.toBeNull()
    Object.defineProperties(scrollRoot, {
      clientHeight: { configurable: true, value: 500 },
      scrollHeight: { configurable: true, value: 1300 },
      scrollTop: { configurable: true, writable: true, value: 640 },
    })
    scrollRoot.getBoundingClientRect = vi.fn(() => mockRect(0))

    const sectionTops: Record<string, number> = {
      account: -600,
      agent: -420,
      run: -250,
      quality: -90,
      capability: 40,
      general: 220,
      data: 410,
    }
    Object.entries(sectionTops).forEach(([id, top]) => {
      const section = document.getElementById(`settings-${id}`)
      expect(section).not.toBeNull()
      section!.getBoundingClientRect = vi.fn(() => mockRect(top))
    })

    fireEvent.scroll(scrollRoot)
    expect(screen.getByRole('button', { name: '能力与安全' })).toHaveAttribute('aria-current', 'page')

    Object.defineProperty(scrollRoot, 'scrollTop', { configurable: true, writable: true, value: 800 })
    fireEvent.scroll(scrollRoot)
    expect(screen.getByRole('button', { name: '数据与安全' })).toHaveAttribute('aria-current', 'page')
  })

  it('calls onClearMemory only after confirming', async () => {
    const onClearMemory = vi.fn(async () => 7)
    renderSettings({ onClearMemory })

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

  it('keeps account security actions at the bottom and requires logout confirmation', async () => {
    const onClearMemory = vi.fn(async () => 0)
    const onLogout = vi.fn()
    const onExportLocalData = vi.fn()
    renderSettings({ onClearMemory, onLogout, onExportLocalData })

    const importRow = screen.getByText('导入本地数据').closest('.settings-row')
    const exportRow = screen.getByText('导出全部数据').closest('.settings-row')
    const clearMemoryRow = screen.getByText('清空记忆').closest('.settings-row')
    const logoutRow = screen.getByText('退出登录').closest('.settings-row')
    expect(importRow).not.toBeNull()
    expect(exportRow).not.toBeNull()
    expect(clearMemoryRow).not.toBeNull()
    expect(logoutRow).not.toBeNull()
    expect(screen.getAllByText('数据与安全').length).toBeGreaterThan(0)
    expect(Boolean(importRow!.compareDocumentPosition(exportRow!) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true)
    expect(Boolean(exportRow!.compareDocumentPosition(clearMemoryRow!) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true)
    expect(Boolean(clearMemoryRow!.compareDocumentPosition(logoutRow!) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true)
    expect(screen.queryByText('退出前需要确认，避免误触。')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '退出' }))
    expect(onLogout).not.toHaveBeenCalled()

    const confirm = await screen.findByRole('alertdialog')
    expect(within(confirm).getByText('退出当前账号？')).toBeInTheDocument()
    fireEvent.click(within(confirm).getByRole('button', { name: '取消' }))
    expect(onLogout).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '退出' }))
    const secondConfirm = await screen.findByRole('alertdialog')
    fireEvent.click(within(secondConfirm).getByRole('button', { name: '确认退出' }))
    expect(onLogout).toHaveBeenCalledTimes(1)
  })
})
