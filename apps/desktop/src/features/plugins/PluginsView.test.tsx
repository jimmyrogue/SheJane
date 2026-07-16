import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/shared/i18n/i18n'
import { PluginsView } from './PluginsView'
import {
  RuntimeHTTPError,
  type PluginDetail,
  type PluginSourceDetail,
  type PluginSourceSummary,
  type PluginSummary,
} from '@/shared/local-host/client'

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

const source: PluginSourceSummary = {
  source_id: 'dev.shejane.source',
  name: 'SheJane source',
  index_url: 'https://example.test/index.json',
  key_id: `ed25519:sha256:${'a'.repeat(64)}`,
  index_sha256: 'b'.repeat(64),
  package_count: 1,
  revision: 1,
  updated_at: '2026-07-16T00:00:00Z',
}

const sourceDetail: PluginSourceDetail = {
  ...source,
  packages: [
    {
      plugin_id: 'dev.shejane.fixture.archive',
      version: '0.1.0',
      name: 'Archive fixture',
      publisher_id: 'dev.shejane',
      runtime_min_version: '0.1.0',
      execution_kind: 'wasi',
      platform: 'any',
      package_url: 'https://example.test/archive.shejane-plugin',
      package_size_bytes: 1024,
      package_digest: `sha256:${'c'.repeat(64)}`,
      signer_key_id: `ed25519:sha256:${'d'.repeat(64)}`,
      capabilities: ['input.read', 'artifact.write'],
      consumes: ['application/zip'],
      produces: ['application/octet-stream'],
      release_notes: 'Initial release.',
    },
  ],
}

describe('PluginsView', () => {
  it('adds, refreshes, and removes a signed source', async () => {
    const addSource = vi.fn().mockResolvedValue(undefined)
    const refreshSource = vi.fn().mockResolvedValue(undefined)
    const removeSource = vi.fn().mockResolvedValue(undefined)
    const installSource = vi.fn().mockResolvedValue(undefined)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(
      <I18nProvider>
        <PluginsView
          listPlugins={vi.fn().mockResolvedValue([])}
          listSources={vi.fn().mockResolvedValue([source])}
          getSource={vi.fn().mockResolvedValue(sourceDetail)}
          addSource={addSource}
          refreshSource={refreshSource}
          removeSource={removeSource}
          installSource={installSource}
        />
      </I18nProvider>,
    )

    expect(await screen.findByText('SheJane source')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '查看来源 SheJane source' }))
    expect(await screen.findByText('Archive fixture')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '安装 Archive fixture 0.1.0' }))
    await waitFor(() =>
      expect(installSource).toHaveBeenCalledWith(source, sourceDetail.packages[0], undefined),
    )
    fireEvent.change(screen.getByLabelText('索引 URL'), {
      target: { value: 'https://new.example/index.json' },
    })
    fireEvent.change(screen.getByLabelText('签名 URL'), {
      target: { value: 'https://new.example/index.sig.json' },
    })
    fireEvent.change(screen.getByLabelText('来源公钥'), {
      target: { value: 'a'.repeat(44) },
    })
    fireEvent.click(screen.getByRole('button', { name: '添加来源' }))
    await waitFor(() =>
      expect(addSource).toHaveBeenCalledWith(
        'https://new.example/index.json',
        'https://new.example/index.sig.json',
        'a'.repeat(44),
      ),
    )

    fireEvent.click(screen.getByRole('button', { name: '刷新来源 SheJane source' }))
    await waitFor(() => expect(refreshSource).toHaveBeenCalledWith(source))
    fireEvent.click(screen.getByRole('button', { name: '移除来源 SheJane source' }))
    await waitFor(() => expect(removeSource).toHaveBeenCalledWith(source))
  })

  it('loads Runtime-owned plugins and refreshes the list', async () => {
    const listPlugins = vi.fn().mockResolvedValue([plugin])
    render(
      <I18nProvider>
        <PluginsView listPlugins={listPlugins} />
      </I18nProvider>,
    )

    expect(await screen.findByText('Archive fixture')).toBeInTheDocument()
    expect(screen.getByText('dev.shejane.fixture.archive')).toBeInTheDocument()
    expect(screen.getByText('已启用')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '刷新插件' }))
    await waitFor(() => expect(listPlugins).toHaveBeenCalledTimes(2))
  })

  it('shows details and runs enable, update, rollback, and remove commands', async () => {
    const listPlugins = vi.fn().mockResolvedValue([plugin])
    const getPlugin = vi.fn().mockResolvedValue(detail)
    const selectPackage = vi.fn().mockResolvedValue('/tmp/archive.shejane-plugin')
    const setEnabled = vi.fn().mockResolvedValue(undefined)
    const updatePlugin = vi.fn().mockResolvedValue(undefined)
    const rollbackPlugin = vi.fn().mockResolvedValue(undefined)
    const removePlugin = vi.fn().mockResolvedValue(undefined)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(
      <I18nProvider>
        <PluginsView
          listPlugins={listPlugins}
          getPlugin={getPlugin}
          selectPackage={selectPackage}
          setEnabled={setEnabled}
          updatePlugin={updatePlugin}
          rollbackPlugin={rollbackPlugin}
          removePlugin={removePlugin}
        />
      </I18nProvider>,
    )

    fireEvent.click(await screen.findByRole('button', { name: '查看 Archive fixture 的详情' }))
    expect(await screen.findByText('Create deterministic archives.')).toBeInTheDocument()
    expect(screen.getByText('application/zip')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '禁用' }))
    await waitFor(() => expect(setEnabled).toHaveBeenCalledWith(plugin, false))

    fireEvent.click(screen.getByRole('button', { name: '更新' }))
    await waitFor(() => expect(updatePlugin).toHaveBeenCalledWith(plugin, '/tmp/archive.shejane-plugin', false))

    fireEvent.click(screen.getByRole('button', { name: '回滚到 0.2.0' }))
    await waitFor(() => expect(rollbackPlugin).toHaveBeenCalledWith(detail, detail.versions[0].digest))

    fireEvent.click(screen.getByRole('button', { name: '移除' }))
    await waitFor(() => expect(removePlugin).toHaveBeenCalledWith(plugin))
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

    const disable = await screen.findByRole('button', { name: '禁用' })
    fireEvent.click(disable)
    await waitFor(() => expect(disable).toBeDisabled())
    rejectCommand(new Error('Runtime rejected plugin command'))

    expect(await screen.findByRole('alert')).toHaveTextContent('Runtime rejected plugin command')
    expect(disable).not.toBeDisabled()
  })
})
