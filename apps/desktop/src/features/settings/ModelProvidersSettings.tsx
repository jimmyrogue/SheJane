import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { IconTrash } from '@tabler/icons-react'
import { Input } from '@/components/ui/input'
import { useI18n } from '@/shared/i18n/i18n'
import {
  deleteLocalModelProvider,
  listLocalModelProviders,
  upsertLocalModelProvider,
  type LocalHostConfig,
  type LocalModelProvider,
} from '@/shared/local-host/client'

export function ModelProvidersSettings({
  config,
  onChanged,
}: {
  config?: LocalHostConfig | null
  onChanged?: () => void
}) {
  const { t } = useI18n()
  const [providers, setProviders] = useState<LocalModelProvider[]>([])
  const [providerID, setProviderID] = useState('')
  const [name, setName] = useState('')
  const [baseURL, setBaseURL] = useState('')
  const [apiKey, setAPIKey] = useState('')
  const [modelID, setModelID] = useState('')
  const [modelName, setModelName] = useState('')
  const [maxInputTokens, setMaxInputTokens] = useState('')
  const [maxOutputTokens, setMaxOutputTokens] = useState('')
  const [requiresAPIKey, setRequiresAPIKey] = useState(true)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    if (!config) {
      setProviders([])
      return
    }
    setProviders(await listLocalModelProviders(config))
  }, [config])

  useEffect(() => {
    void refresh().catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
  }, [refresh])

  const resetForm = () => {
    setProviderID('')
    setName('')
    setBaseURL('')
    setAPIKey('')
    setModelID('')
    setModelName('')
    setMaxInputTokens('')
    setMaxOutputTokens('')
    setRequiresAPIKey(true)
    setEditing(false)
  }

  const editProvider = (provider: LocalModelProvider) => {
    const model = provider.models[0]
    setProviderID(provider.id)
    setName(provider.name)
    setBaseURL(provider.base_url)
    setAPIKey('')
    setModelID(model?.model_id ?? '')
    setModelName(model?.display_name ?? '')
    setMaxInputTokens(model?.max_input_tokens?.toString() ?? '')
    setMaxOutputTokens(model?.max_output_tokens?.toString() ?? '')
    setRequiresAPIKey(provider.requires_api_key)
    setEditing(true)
    setError('')
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!config) return
    setSaving(true)
    setError('')
    try {
      await upsertLocalModelProvider(
        providerID,
        {
          name,
          kind: 'openai_compatible',
          base_url: baseURL,
          requires_api_key: requiresAPIKey,
          api_key: apiKey || undefined,
          models: [{
            model_id: modelID,
            display_name: modelName || modelID,
            tool_calling: true,
            streaming: true,
            max_input_tokens: maxInputTokens ? Number(maxInputTokens) : undefined,
            max_output_tokens: maxOutputTokens ? Number(maxOutputTokens) : undefined,
          }],
          enabled: true,
        },
        config,
      )
      resetForm()
      await refresh()
      onChanged?.()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSaving(false)
    }
  }

  const remove = async (provider: LocalModelProvider) => {
    if (!config || !window.confirm(t('settings.models.deleteConfirm', { name: provider.name }))) return
    setError('')
    try {
      await deleteLocalModelProvider(provider.id, config)
      if (provider.id === providerID) resetForm()
      await refresh()
      onChanged?.()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  if (!config) {
    return <div className="settings-row-hint">{t('settings.models.runtimeOffline')}</div>
  }

  return (
    <div className="settings-model-providers">
      {providers.map((provider) => (
        <div className="settings-row" key={provider.id}>
          <button type="button" className="settings-row-copy settings-provider-summary" onClick={() => editProvider(provider)}>
            <span className="settings-row-label">{provider.name}</span>
            <span className="settings-row-hint">
              {provider.models.map((model) => model.display_name).join(', ')} · {provider.credential_configured
                ? t('settings.models.configured')
                : t('settings.models.missingCredential')}
            </span>
          </button>
          <button
            type="button"
            className="settings-row-button settings-row-button-danger"
            aria-label={t('settings.models.delete')}
            onClick={() => void remove(provider)}
          >
            <IconTrash size={15} aria-hidden="true" />
          </button>
        </div>
      ))}

      <form className="settings-provider-form" onSubmit={(event) => void submit(event)}>
        <Input required disabled={editing} value={providerID} placeholder={t('settings.models.providerId')} onChange={(event) => setProviderID(event.target.value.toLowerCase())} />
        <Input required value={name} placeholder={t('settings.models.providerName')} onChange={(event) => setName(event.target.value)} />
        <Input required type="url" value={baseURL} placeholder="http://127.0.0.1:11434/v1" onChange={(event) => setBaseURL(event.target.value)} />
        <Input required value={modelID} placeholder={t('settings.models.modelId')} onChange={(event) => setModelID(event.target.value)} />
        <Input value={modelName} placeholder={t('settings.models.modelName')} onChange={(event) => setModelName(event.target.value)} />
        <div className="settings-provider-limits-row">
          <Input
            type="number"
            min={1}
            value={maxInputTokens}
            placeholder={t('settings.models.maxInputTokens')}
            onChange={(event) => setMaxInputTokens(event.target.value)}
          />
          <Input
            type="number"
            min={128}
            value={maxOutputTokens}
            placeholder={t('settings.models.maxOutputTokens')}
            onChange={(event) => setMaxOutputTokens(event.target.value)}
          />
        </div>
        <div className="settings-provider-key-row">
          <Input
            required={requiresAPIKey && !editing}
            type="password"
            autoComplete="off"
            value={apiKey}
            placeholder={editing ? t('settings.models.keepCredential') : t('settings.models.apiKey')}
            onChange={(event) => setAPIKey(event.target.value)}
          />
          <label className="settings-provider-key-toggle">
            <span>{t('settings.models.requiresApiKey')}</span>
            <input
              type="checkbox"
              checked={requiresAPIKey}
              onChange={(event) => setRequiresAPIKey(event.target.checked)}
            />
          </label>
        </div>
        {error ? <p className="settings-provider-error">{error}</p> : null}
        <div className="settings-provider-actions">
          {editing ? (
            <button type="button" className="settings-row-button" onClick={resetForm}>
              {t('settings.models.cancel')}
            </button>
          ) : null}
          <button type="submit" className="settings-row-button" disabled={saving}>
            {saving ? t('settings.models.saving') : t('settings.models.save')}
          </button>
        </div>
      </form>
    </div>
  )
}
