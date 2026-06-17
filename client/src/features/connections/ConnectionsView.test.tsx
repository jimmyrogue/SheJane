import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/shared/i18n/i18n'
import type { LocalHostConfig, LocalLarkSource, LocalLarkStatus } from '@/shared/local-host/client'
import { ConnectionsView } from './ConnectionsView'

afterEach(() => {
  cleanup()
  delete window.shejaneDesktop
})

const localHostConfig: LocalHostConfig = { baseURL: 'http://127.0.0.1:17371', token: 'local-token' }

function larkStatus(
  status: LocalLarkStatus['connection']['status'],
  overrides: Partial<LocalLarkStatus['connection']> = {},
): LocalLarkStatus {
  return {
    connection: {
      id: 'conn-lark',
      provider: 'lark',
      auth_mode: 'lark_cli',
      status,
      account_label: 'Jane',
      tenant_label: 'ColdFlame',
      cloud_extraction_enabled: true,
      data_retention_days: 7,
      auto_sync_enabled: false,
      auto_sync_interval_minutes: 5,
      last_error_code: '',
      last_checked_at: '2026-06-15T00:00:00Z',
      last_auto_synced_at: null,
      created_at: '2026-06-15T00:00:00Z',
      updated_at: '2026-06-15T00:00:00Z',
      ...overrides,
    },
    connector: {
      available: true,
      source: 'bundled',
      executable_path: 'C:\\Program Files\\SheJane\\resources\\connectors\\lark\\win32-x64\\lark-cli.exe',
    },
  }
}

function larkSource(overrides: Partial<LocalLarkSource> = {}): LocalLarkSource {
  return {
    id: 'lark_src_1',
    connection_id: 'conn-lark',
    provider_source_id_hash: 'hash_1',
    source_type: 'group',
    display_label: '项目群',
    sync_enabled: true,
    last_synced_at: null,
    last_message_time: null,
    created_at: '2026-06-15T00:00:00Z',
    updated_at: '2026-06-15T00:00:00Z',
    ...overrides,
  }
}

function p2pLarkSource(overrides: Partial<LocalLarkSource> = {}): LocalLarkSource {
  return larkSource({
    id: 'lark_src_2',
    provider_source_id_hash: 'hash_2',
    source_type: 'p2p',
    display_label: 'ChatGPT',
    sync_enabled: false,
    ...overrides,
  })
}

function renderView(props?: React.ComponentProps<typeof ConnectionsView>) {
  render(
    <I18nProvider>
      <ConnectionsView {...props} />
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

  it('shows a compact Lark connection row and triggers a local sync', async () => {
    const getLarkStatus = vi.fn().mockResolvedValue(larkStatus('connected'))
    const listLarkSources = vi.fn().mockResolvedValue([larkSource()])
    const previewLark = vi.fn().mockResolvedValue({
      provider: 'lark',
      processed_messages: 1,
      candidate_count: 1,
      skipped_messages: 0,
      candidates: [],
    })
    const syncLark = vi.fn().mockResolvedValue({
      provider: 'lark',
      extraction_provider: 'cloud_redacted',
      processed_messages: 7,
      created_todos: 2,
      skipped_messages: 5,
    })

    renderView({
      localHostConfig,
      api: {
        getLarkStatus,
        listLarkSources,
        previewLark,
        syncLark,
      },
    })

    const larkRow = (await screen.findByText('飞书 Lark')).closest('.connection-row') as HTMLElement
    expect(within(larkRow).getByText('已连接')).toBeInTheDocument()
    expect(within(larkRow).getByText('内置 lark-cli')).toBeInTheDocument()
    expect(within(larkRow).getByText('Jane · ColdFlame')).toBeInTheDocument()
    expect(within(larkRow).getByText('已选 1 个对话')).toBeInTheDocument()
    expect(within(larkRow).queryByText('项目群')).not.toBeInTheDocument()
    expect(within(larkRow).queryByRole('combobox', { name: '飞书消息保留天数' })).not.toBeInTheDocument()
    expect(within(larkRow).queryByRole('switch', { name: '自动轮询同步飞书待办' })).not.toBeInTheDocument()

    fireEvent.click(within(larkRow).getByRole('button', { name: '同步飞书 Lark' }))

    await waitFor(() => {
      expect(previewLark).toHaveBeenCalledWith({ limit: 100 }, localHostConfig)
    })
    expect(syncLark).not.toHaveBeenCalled()

    fireEvent.click(within(larkRow).getByRole('button', { name: '同步飞书 Lark' }))

    await waitFor(() => {
      expect(syncLark).toHaveBeenCalledWith({ limit: 100, extraction_provider: 'cloud_redacted' }, localHostConfig)
    })
    expect(await within(larkRow).findByText('已处理 7 条 · 新增 2 件')).toBeInTheDocument()
  })

  it('keeps source selection inside a searchable setup dialog', async () => {
    const getLarkStatus = vi.fn().mockResolvedValue(larkStatus('connected'))
    const listLarkSources = vi.fn().mockResolvedValue([
      larkSource({ sync_enabled: false }),
      p2pLarkSource(),
    ])
    const updateLarkSource = vi.fn().mockResolvedValue(larkSource({ sync_enabled: true }))

    renderView({
      localHostConfig,
      api: {
        getLarkStatus,
        listLarkSources,
        updateLarkSource,
      },
    })

    const larkRow = (await screen.findByText('飞书 Lark')).closest('.connection-row') as HTMLElement
    fireEvent.click(within(larkRow).getByRole('button', { name: '设置飞书 Lark' }))
    const settingsDialog = await screen.findByRole('dialog', { name: '设置飞书 Lark' })
    fireEvent.click(within(settingsDialog).getByRole('button', { name: '选择对话' }))

    const sourceDialog = await screen.findByRole('dialog', { name: '选择飞书对话' })
    const search = within(sourceDialog).getByRole('searchbox', { name: '搜索飞书对话' })
    fireEvent.change(search, { target: { value: '项目' } })
    expect(within(sourceDialog).getByText('项目群')).toBeInTheDocument()
    expect(within(sourceDialog).queryByText('ChatGPT')).not.toBeInTheDocument()

    fireEvent.click(within(sourceDialog).getByRole('switch', { name: '同步 项目群' }))
    await waitFor(() => {
      expect(updateLarkSource).toHaveBeenCalledWith('lark_src_1', { sync_enabled: true }, localHostConfig)
    })
    expect(await within(sourceDialog).findByText('已选择 1 个对话')).toBeInTheDocument()
  })

  it('returns Lark to the authorization flow when sync reports missing scopes', async () => {
    const getLarkStatus = vi.fn()
      .mockResolvedValueOnce(larkStatus('connected'))
      .mockResolvedValueOnce(larkStatus('needs_auth', {
        account_label: '',
        tenant_label: '',
        last_error_code: 'lark_auth_scope_required',
      }))
    const previewLark = vi.fn().mockRejectedValue(new Error('lark_auth_scope_required'))

    renderView({
      localHostConfig,
      api: {
        getLarkStatus,
        listLarkSources: vi.fn().mockResolvedValue([]),
        previewLark,
      },
    })

    const larkRow = (await screen.findByText('飞书 Lark')).closest('.connection-row') as HTMLElement
    fireEvent.click(within(larkRow).getByRole('button', { name: '同步飞书 Lark' }))

    await waitFor(() => {
      expect(getLarkStatus).toHaveBeenCalledTimes(2)
    })
    expect(await within(larkRow).findByText('需要重新授权飞书权限')).toBeInTheDocument()
    expect(within(larkRow).getByText('需要授权')).toBeInTheDocument()
    expect(within(larkRow).getByRole('button', { name: '连接飞书 Lark' })).toBeInTheDocument()
    expect(within(larkRow).queryByRole('button', { name: '同步飞书 Lark' })).not.toBeInTheDocument()
  })

  it('opens the returned Lark authorization URL and shows a fallback link', async () => {
    const openExternal = vi.fn(async () => 'ok')
    window.shejaneDesktop = {
      platform: 'darwin',
      openExternal,
    }
    const getLarkStatus = vi.fn().mockResolvedValue(larkStatus('needs_auth'))
    const connectLark = vi.fn().mockResolvedValue({
      connection: larkStatus('needs_auth', { last_error_code: 'lark_config_required' }).connection,
      connector: larkStatus('needs_auth').connector,
      authorization_url: 'https://open.feishu.cn/cli/setup?code=abc',
      device_code: null,
    })

    renderView({
      localHostConfig,
      api: {
        getLarkStatus,
        listLarkSources: vi.fn().mockResolvedValue([]),
        connectLark,
      },
    })

    const larkRow = (await screen.findByText('飞书 Lark')).closest('.connection-row') as HTMLElement
    fireEvent.click(within(larkRow).getByRole('button', { name: '连接飞书 Lark' }))

    await waitFor(() => {
      expect(openExternal).toHaveBeenCalledWith('https://open.feishu.cn/cli/setup?code=abc')
    })
    expect(await within(larkRow).findByRole('link', { name: 'https://open.feishu.cn/cli/setup?code=abc' })).toHaveAttribute(
      'href',
      'https://open.feishu.cn/cli/setup?code=abc',
    )
  })

  it('refreshes Lark status after device authorization completes locally', async () => {
    const openExternal = vi.fn(async () => 'ok')
    window.shejaneDesktop = {
      platform: 'darwin',
      openExternal,
    }
    const getLarkStatus = vi.fn()
      .mockResolvedValueOnce(larkStatus('needs_auth', {
        account_label: '',
        tenant_label: '',
      }))
      .mockResolvedValueOnce(larkStatus('connected'))
    const connectLark = vi.fn().mockResolvedValue({
      connection: larkStatus('needs_auth', {
        account_label: '',
        tenant_label: '',
      }).connection,
      connector: larkStatus('needs_auth').connector,
      authorization_url: 'https://accounts.example.test/auth',
      device_code: 'dev-1',
    })

    renderView({
      localHostConfig,
      api: {
        getLarkStatus,
        listLarkSources: vi.fn().mockResolvedValue([]),
        connectLark,
      },
    })

    const larkRow = (await screen.findByText('飞书 Lark')).closest('.connection-row') as HTMLElement
    fireEvent.click(within(larkRow).getByRole('button', { name: '连接飞书 Lark' }))

    await waitFor(() => {
      expect(getLarkStatus).toHaveBeenCalledTimes(2)
    })
    expect(await within(larkRow).findByText('授权完成')).toBeInTheDocument()
    expect(within(larkRow).getByText('已连接')).toBeInTheDocument()
    expect(within(larkRow).getByText('Jane · ColdFlame')).toBeInTheDocument()
    expect(await screen.findByRole('dialog', { name: '选择飞书对话' })).toBeInTheDocument()
  })

  it('requires a redacted preview before the default cloud-enhanced Lark sync', async () => {
    const getLarkStatus = vi.fn().mockResolvedValue(larkStatus('connected'))
    const previewLark = vi.fn().mockResolvedValue({
      provider: 'lark',
      processed_messages: 1,
      candidate_count: 1,
      skipped_messages: 0,
      candidates: [
        {
          message_id: 'msg_1',
          source_id: 'lark_src_1',
          source_label: '项目群',
          source_type: 'group',
          redacted_text: '请今天联系 [email] 确认合同',
          priority: 'today',
          suggested_action: 'reply',
          confidence: 0.82,
        },
      ],
    })
    const syncLark = vi.fn().mockResolvedValue({
      provider: 'lark',
      extraction_provider: 'cloud_redacted',
      processed_messages: 3,
      created_todos: 1,
      skipped_messages: 2,
    })

    renderView({
      localHostConfig,
      api: {
        getLarkStatus,
        listLarkSources: vi.fn().mockResolvedValue([]),
        previewLark,
        syncLark,
      },
    })

    const larkRow = (await screen.findByText('飞书 Lark')).closest('.connection-row') as HTMLElement
    fireEvent.click(within(larkRow).getByRole('button', { name: '设置飞书 Lark' }))
    const settingsDialog = await screen.findByRole('dialog', { name: '设置飞书 Lark' })
    expect(within(settingsDialog).queryByRole('switch', { name: '使用云端脱敏增强提取飞书待办' })).not.toBeInTheDocument()
    fireEvent.click(within(larkRow).getByRole('button', { name: '同步飞书 Lark' }))

    await waitFor(() => {
      expect(previewLark).toHaveBeenCalledWith({ limit: 100 }, localHostConfig)
    })
    expect(syncLark).not.toHaveBeenCalled()
    expect(await within(larkRow).findByText('可提取 1 条脱敏候选')).toBeInTheDocument()

    fireEvent.click(within(larkRow).getByRole('button', { name: '同步飞书 Lark' }))

    await waitFor(() => {
      expect(syncLark).toHaveBeenCalledWith({ limit: 100, extraction_provider: 'cloud_redacted' }, localHostConfig)
    })
  })

  it('hides the cloud extraction toggle while cloud enhancement is the default', async () => {
    renderView({
      localHostConfig,
      api: {
        getLarkStatus: vi.fn().mockResolvedValue(larkStatus('connected', {
          cloud_extraction_enabled: false,
        })),
        listLarkSources: vi.fn().mockResolvedValue([]),
      },
    })

    const larkRow = (await screen.findByText('飞书 Lark')).closest('.connection-row') as HTMLElement
    fireEvent.click(within(larkRow).getByRole('button', { name: '设置飞书 Lark' }))
    const settingsDialog = await screen.findByRole('dialog', { name: '设置飞书 Lark' })
    expect(within(settingsDialog).queryByRole('switch', { name: '使用云端脱敏增强提取飞书待办' })).not.toBeInTheDocument()
  })

  it('persists Lark retention and auto polling preferences', async () => {
    let connection = larkStatus('connected').connection
    const updateLarkConnection = vi.fn().mockImplementation((input) => {
      connection = { ...connection, ...input }
      return Promise.resolve(connection)
    })

    renderView({
      localHostConfig,
      api: {
        getLarkStatus: vi.fn().mockResolvedValue({ ...larkStatus('connected'), connection }),
        listLarkSources: vi.fn().mockResolvedValue([]),
        updateLarkConnection,
      },
    })

    const larkRow = (await screen.findByText('飞书 Lark')).closest('.connection-row') as HTMLElement
    fireEvent.click(within(larkRow).getByRole('button', { name: '设置飞书 Lark' }))
    const settingsDialog = await screen.findByRole('dialog', { name: '设置飞书 Lark' })
    const retentionSelect = within(settingsDialog).getByRole('combobox', { name: '飞书消息保留天数' })
    expect(retentionSelect).toHaveValue('7')

    fireEvent.change(retentionSelect, { target: { value: '3' } })
    await waitFor(() => {
      expect(updateLarkConnection).toHaveBeenCalledWith({ data_retention_days: 3 }, localHostConfig)
    })

    fireEvent.click(within(settingsDialog).getByRole('switch', { name: '自动轮询同步飞书待办' }))
    await waitFor(() => {
      expect(updateLarkConnection).toHaveBeenCalledWith({ auto_sync_enabled: true }, localHostConfig)
    })

    const intervalSelect = within(settingsDialog).getByRole('combobox', { name: '飞书自动同步间隔' })
    expect(intervalSelect).toHaveValue('5')
    fireEvent.change(intervalSelect, { target: { value: '2' } })

    await waitFor(() => {
      expect(updateLarkConnection).toHaveBeenCalledWith({ auto_sync_interval_minutes: 2 }, localHostConfig)
    })
  })

  it('keeps destructive Lark actions inside settings', async () => {
    const getLarkStatus = vi.fn().mockResolvedValue(larkStatus('connected'))
    const listLarkSources = vi.fn().mockResolvedValue([larkSource()])
    const clearLarkCache = vi.fn().mockResolvedValue({
      cleared: true,
      deleted_sources: 1,
      deleted_messages: 2,
      deleted_todos: 1,
    })

    renderView({
      localHostConfig,
      api: {
        getLarkStatus,
        listLarkSources,
        clearLarkCache,
      },
    })

    const larkRow = (await screen.findByText('飞书 Lark')).closest('.connection-row') as HTMLElement
    expect(within(larkRow).queryByRole('button', { name: '清理飞书 Lark 本地缓存' })).not.toBeInTheDocument()
    fireEvent.click(within(larkRow).getByRole('button', { name: '设置飞书 Lark' }))
    const settingsDialog = await screen.findByRole('dialog', { name: '设置飞书 Lark' })
    fireEvent.click(within(settingsDialog).getByRole('button', { name: '清理飞书 Lark 本地缓存' }))

    await waitFor(() => {
      expect(clearLarkCache).toHaveBeenCalledWith(localHostConfig)
    })
    expect(await within(larkRow).findByText('已清理 2 条消息 · 1 件待办')).toBeInTheDocument()
  })

  it('keeps Lark actions visible in a Windows-sized desktop viewport', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1366 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 768 })
    window.dispatchEvent(new Event('resize'))

    renderView({
      localHostConfig,
      api: {
        getLarkStatus: vi.fn().mockResolvedValue(larkStatus('connected')),
        listLarkSources: vi.fn().mockResolvedValue([larkSource()]),
      },
    })

    const larkRow = (await screen.findByText('飞书 Lark')).closest('.connection-row') as HTMLElement
    expect(within(larkRow).getByText('内置 lark-cli')).toBeInTheDocument()
    expect(within(larkRow).getByText('已选 1 个对话')).toBeInTheDocument()
    expect(within(larkRow).queryByText('项目群')).not.toBeInTheDocument()
    expect(within(larkRow).getByRole('button', { name: '同步飞书 Lark' })).toBeInTheDocument()
    expect(within(larkRow).getByRole('button', { name: '设置飞书 Lark' })).toBeInTheDocument()
    expect(within(larkRow).queryByRole('button', { name: '预览飞书 Lark' })).not.toBeInTheDocument()
    expect(within(larkRow).queryByRole('button', { name: '清理飞书 Lark 本地缓存' })).not.toBeInTheDocument()
  })
})
