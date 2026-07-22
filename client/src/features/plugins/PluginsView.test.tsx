import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/shared/i18n/i18n'
import { PluginsView } from './PluginsView'
import {
  RuntimeHTTPError,
  type PluginDetail,
  type PluginSummary,
} from '@/runtime/client'

afterEach(cleanup)

const plugin: PluginSummary = {
  id: 'dev.shejane.fixture.archive',
  name: 'Archive fixture',
  version: '0.1.0',
  digest: `sha256:${'a'.repeat(64)}`,
  publisher: { id: 'dev.shejane', name: 'SheJane' },
  execution_kind: 'wasi',
  signature_status: 'unsigned',
  compatibility: 'compatible',
  enabled: true,
  retired: false,
}

const detail: PluginDetail = {
  ...plugin,
  description: 'Create deterministic archives.',
  license: 'AGPL-3.0-only',
  actions: [
    {
      id: 'archive.extract',
      title: 'Extract archive',
      description: 'Extract an authorized ZIP.',
      consumes: ['application/zip'],
      produces: ['application/octet-stream'],
      effects: ['read', 'artifact'],
      determinism: 'input_stable',
      capabilities: ['input.read', 'artifact.write'],
      limits: { timeout_ms: 10000, memory_mb: 128, output_mb: 8 },
    },
  ],
  skills: [],
  mcp_servers: [],
  commands: [
    {
      id: 'archive',
      title: 'Archive files',
      description: 'Create an archive.',
      required_actions: ['archive.extract'],
    },
  ],
  versions: [
    {
      version: '0.2.0',
      digest: `sha256:${'b'.repeat(64)}`,
      signature_status: 'unsigned',
      compatibility: 'compatible',
      state: 'installed',
      active: false,
      created_at: '2026-07-16T00:00:00Z',
    },
    {
      version: '0.1.0',
      digest: plugin.digest,
      signature_status: 'unsigned',
      compatibility: 'compatible',
      state: 'installed',
      active: true,
      created_at: '2026-07-15T00:00:00Z',
    },
  ],
}

const visionDetail: PluginDetail = {
  ...detail,
  id: 'org.shejane.vision.cloud',
  name: 'Vision Cloud',
  execution_kind: 'managed_worker',
  model_binding: null,
  actions: [
    {
      ...detail.actions[0],
      id: 'vision.analyze_images',
      title: 'Analyze images',
      capabilities: ['input.read', 'artifact.write', 'model.vision.invoke'],
      determinism: 'nondeterministic',
    },
  ],
}

describe('PluginsView', () => {
  it('does not expose the removed plugin source management UI', async () => {
    const listSources = vi.fn().mockResolvedValue([])
    const legacySourceProps = { listSources }
    render(
      <I18nProvider>
        <PluginsView
          listPlugins={vi.fn().mockResolvedValue([])}
          {...legacySourceProps}
        />
      </I18nProvider>,
    )

    await screen.findByText('还没有安装插件。')
    expect(listSources).not.toHaveBeenCalled()
    expect(screen.queryByText('插件来源')).not.toBeInTheDocument()
  })

  it('loads Runtime-owned plugins and refreshes the list', async () => {
    const listPlugins = vi.fn().mockResolvedValue([plugin])
    render(
      <I18nProvider>
        <PluginsView listPlugins={listPlugins} />
      </I18nProvider>,
    )

    expect(await screen.findByText('Archive fixture')).toBeInTheDocument()
    expect(screen.queryByText('dev.shejane.fixture.archive')).not.toBeInTheDocument()
    expect(screen.queryByText('unsigned')).not.toBeInTheDocument()
    expect(screen.queryByText('WASI')).not.toBeInTheDocument()
    expect(screen.queryByText('SheJane')).not.toBeInTheDocument()
    expect(screen.queryByText('已启用')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '刷新插件' }))
    await waitFor(() => expect(listPlugins).toHaveBeenCalledTimes(2))
  })

  it('keeps the current catalog visible while refreshing', async () => {
    let finishRefresh: (plugins: PluginSummary[]) => void = () => undefined
    const listPlugins = vi
      .fn()
      .mockResolvedValueOnce([plugin])
      .mockImplementationOnce(() => new Promise<PluginSummary[]>((resolve) => {
        finishRefresh = resolve
      }))
    render(
      <I18nProvider>
        <PluginsView listPlugins={listPlugins} />
      </I18nProvider>,
    )

    expect(await screen.findByText('Archive fixture')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '刷新插件' }))
    await waitFor(() => expect(listPlugins).toHaveBeenCalledTimes(2))
    expect(screen.getByText('Archive fixture')).toBeInTheDocument()

    finishRefresh([plugin])
    await waitFor(() => expect(screen.getByText('Archive fixture')).toBeInTheDocument())
  })

  it('filters plugins without exposing hidden technical metadata', async () => {
    render(
      <I18nProvider>
        <PluginsView
          listPlugins={vi.fn().mockResolvedValue([
            plugin,
            { ...plugin, id: 'org.shejane.computer-use', name: 'Computer Use' },
          ])}
        />
      </I18nProvider>,
    )

    await screen.findByText('Archive fixture')
    fireEvent.change(screen.getByLabelText('搜索插件'), { target: { value: 'computer' } })
    expect(screen.queryByText('Archive fixture')).not.toBeInTheDocument()
    expect(screen.getByText('Computer Use')).toBeInTheDocument()
  })

  it('labels the Computer Use host adapter as built-in', async () => {
    const computerUse = {
      ...detail,
      id: 'org.shejane.computer-use',
      name: 'Computer Use',
      execution_kind: 'builtin' as const,
    }
    render(
      <I18nProvider>
        <PluginsView
          listPlugins={vi.fn().mockResolvedValue([computerUse])}
          getPlugin={vi.fn().mockResolvedValue(computerUse)}
        />
      </I18nProvider>,
    )

    fireEvent.click(await screen.findByRole('button', { name: '查看 Computer Use 的详情' }))
    expect(await screen.findByText('Built-in')).toBeInTheDocument()
  })

  it('opens details from the plugin name and runs toggle, rollback, and remove commands', async () => {
    const listPlugins = vi.fn().mockResolvedValue([plugin])
    const getPlugin = vi.fn().mockResolvedValue(detail)
    const setEnabled = vi.fn().mockResolvedValue(undefined)
    const rollbackPlugin = vi.fn().mockResolvedValue(undefined)
    const removePlugin = vi.fn().mockResolvedValue(undefined)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(
      <I18nProvider>
        <PluginsView
          listPlugins={listPlugins}
          getPlugin={getPlugin}
          setEnabled={setEnabled}
          rollbackPlugin={rollbackPlugin}
          removePlugin={removePlugin}
        />
      </I18nProvider>,
    )

    const openDetails = await screen.findByRole('button', { name: '查看 Archive fixture 的详情' })
    expect(openDetails).toHaveTextContent('Archive fixture')
    expect(screen.queryByRole('button', { name: '更新' })).not.toBeInTheDocument()
    fireEvent.click(openDetails)
    expect(await screen.findByText('Create deterministic archives.')).toBeInTheDocument()
    expect(screen.getByText('application/zip')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('switch', { name: '切换插件：Archive fixture' }))
    await waitFor(() => expect(setEnabled).toHaveBeenCalledWith(plugin, false))

    fireEvent.click(screen.getByRole('button', { name: '回滚到 0.2.0' }))
    await waitFor(() => expect(rollbackPlugin).toHaveBeenCalledWith(detail, detail.versions[0].digest))

    const remove = screen.getByRole('button', { name: '移除插件：Archive fixture' })
    expect(remove).not.toHaveTextContent('移除')
    fireEvent.click(remove)
    await waitFor(() => expect(removePlugin).toHaveBeenCalledWith(plugin))
  })

  it('hides retired plugins from the installed catalog', async () => {
    render(
      <I18nProvider>
        <PluginsView
          listPlugins={vi.fn().mockResolvedValue([{ ...plugin, retired: true, enabled: false }])}
        />
      </I18nProvider>,
    )

    expect(await screen.findByText('还没有安装插件。')).toBeInTheDocument()
    expect(screen.queryByText('Archive fixture')).not.toBeInTheDocument()
  })

  it('retries an unsigned local install only after explicit confirmation', async () => {
    const installPlugin = vi
      .fn()
      .mockRejectedValueOnce(
        new RuntimeHTTPError(
          'installing this unsigned plugin requires explicit confirmation',
          409,
          'unsigned_plugin_confirmation_required',
        ),
      )
      .mockResolvedValue(undefined)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(
      <I18nProvider>
        <PluginsView
          listPlugins={vi.fn().mockResolvedValue([])}
          selectPackage={vi.fn().mockResolvedValue('/tmp/archive.shejane-plugin')}
          installPlugin={installPlugin}
        />
      </I18nProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: '导入插件' }))
    await waitFor(() => expect(installPlugin).toHaveBeenNthCalledWith(1, '/tmp/archive.shejane-plugin', false))
    await waitFor(() => expect(installPlugin).toHaveBeenNthCalledWith(2, '/tmp/archive.shejane-plugin', true))
  })

  it('binds an explicit image-capable model for a Vision plugin', async () => {
    const bindVisionModel = vi.fn().mockResolvedValue(undefined)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(
      <I18nProvider>
        <PluginsView
          listPlugins={vi.fn().mockResolvedValue([visionDetail])}
          getPlugin={vi.fn().mockResolvedValue(visionDetail)}
          visionModels={[
            {
              id: 'local:vision:vision-a',
              label: 'Vision A',
              vendor: 'Vision Provider',
            },
          ]}
          bindVisionModel={bindVisionModel}
        />
      </I18nProvider>,
    )

    fireEvent.click(await screen.findByRole('button', { name: '查看 Vision Cloud 的详情' }))
    fireEvent.change(await screen.findByRole('combobox', { name: '选择视觉模型' }), {
      target: { value: 'local:vision:vision-a' },
    })
    fireEvent.click(screen.getByRole('button', { name: '绑定模型' }))

    await waitFor(() =>
      expect(bindVisionModel).toHaveBeenCalledWith(
        visionDetail,
        'local:vision:vision-a',
      ),
    )
    expect(window.confirm).toHaveBeenCalledWith(
      expect.stringContaining('local:vision:vision-a'),
    )
  })

  it('projects a pending command and surfaces its rejection', async () => {
    let rejectCommand: (cause: Error) => void = () => undefined
    const setEnabled = vi.fn().mockImplementation(
      () => new Promise((_resolve, reject) => {
        rejectCommand = reject
      }),
    )
    render(
      <I18nProvider>
        <PluginsView
          listPlugins={vi.fn().mockResolvedValue([plugin])}
          setEnabled={setEnabled}
        />
      </I18nProvider>,
    )

    const toggle = await screen.findByRole('switch', { name: '切换插件：Archive fixture' })
    fireEvent.click(toggle)
    await waitFor(() => expect(toggle).toBeDisabled())
    rejectCommand(new Error('Runtime rejected plugin command'))

    expect(await screen.findByRole('alert')).toHaveTextContent('Runtime rejected plugin command')
    expect(toggle).not.toBeDisabled()
  })
})
