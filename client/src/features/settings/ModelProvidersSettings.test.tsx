import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/shared/i18n/i18n'
import { ModelProvidersSettings } from './ModelProvidersSettings'

const { listLocalModelProviders, upsertLocalModelProvider } = vi.hoisted(() => ({
  listLocalModelProviders: vi.fn(),
  upsertLocalModelProvider: vi.fn(),
}))

vi.mock('@/shared/local-host/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/shared/local-host/client')>()),
  listLocalModelProviders,
  upsertLocalModelProvider,
  deleteLocalModelProvider: vi.fn(),
}))

describe('ModelProvidersSettings', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('saves an OpenAI-compatible provider without retaining the key in React state', async () => {
    listLocalModelProviders.mockResolvedValue([])
    upsertLocalModelProvider.mockResolvedValue({})
    const onChanged = vi.fn()
    render(
      <I18nProvider>
        <ModelProvidersSettings
          config={{ baseURL: 'http://127.0.0.1:17371', token: 'tok' }}
          onChanged={onChanged}
        />
      </I18nProvider>,
    )

    fireEvent.change(screen.getByPlaceholderText('供应商 ID，例如 ollama'), { target: { value: 'ollama' } })
    fireEvent.change(screen.getByPlaceholderText('显示名称'), { target: { value: 'Local Ollama' } })
    fireEvent.change(screen.getByPlaceholderText('http://127.0.0.1:11434/v1'), { target: { value: 'http://127.0.0.1:11434/v1' } })
    fireEvent.change(screen.getByPlaceholderText('模型 ID'), { target: { value: 'qwen3:8b' } })
    fireEvent.change(screen.getByPlaceholderText('最大输入 Token（可选）'), { target: { value: '32768' } })
    fireEvent.change(screen.getByPlaceholderText('最大输出 Token（可选）'), { target: { value: '4096' } })
    fireEvent.change(screen.getByPlaceholderText('API Key'), { target: { value: 'secret-key' } })
    fireEvent.click(screen.getByRole('button', { name: '保存供应商' }))

    await waitFor(() => expect(upsertLocalModelProvider).toHaveBeenCalledWith(
      'ollama',
      expect.objectContaining({
        base_url: 'http://127.0.0.1:11434/v1',
        api_key: 'secret-key',
        models: [expect.objectContaining({
          model_id: 'qwen3:8b',
          max_input_tokens: 32768,
          max_output_tokens: 4096,
        })],
      }),
      expect.objectContaining({ token: 'tok' }),
    ))
    expect(onChanged).toHaveBeenCalled()
    expect(screen.getByPlaceholderText('API Key')).toHaveValue('')
  })
})
