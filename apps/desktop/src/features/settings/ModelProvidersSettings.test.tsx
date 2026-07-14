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

  it('uses a provider preset and keeps advanced fields out of the default flow', async () => {
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

    fireEvent.click(screen.getByRole('button', { name: '添加供应商' }))

    expect(screen.queryByLabelText('最大输入 Token（可选）')).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('模型 ID'), { target: { value: 'gpt-4.1' } })
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'secret-key' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(upsertLocalModelProvider).toHaveBeenCalledWith(
      'openai',
      expect.objectContaining({
        name: 'OpenAI',
        base_url: 'https://api.openai.com/v1',
        api_key: 'secret-key',
        models: [expect.objectContaining({
          model_id: 'gpt-4.1',
        })],
      }),
      expect.objectContaining({ token: 'tok' }),
    ))
    expect(onChanged).toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
