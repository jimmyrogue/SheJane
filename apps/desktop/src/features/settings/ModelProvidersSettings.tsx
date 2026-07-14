import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { IconPlus, IconTrash } from '@tabler/icons-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useI18n } from '@/shared/i18n/i18n'
import {
  deleteLocalModelProvider,
  listLocalModelProviders,
  upsertLocalModelProvider,
  type LocalHostConfig,
  type LocalModelProvider,
} from '@/shared/local-host/client'

const PROVIDER_TEMPLATES = [
  { id: 'openai', name: 'OpenAI', baseURL: 'https://api.openai.com/v1', requiresAPIKey: true },
  { id: 'openrouter', name: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', requiresAPIKey: true },
  { id: 'deepseek', name: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', requiresAPIKey: true },
  { id: 'ollama', name: 'Ollama', baseURL: 'http://127.0.0.1:11434/v1', requiresAPIKey: false },
  { id: 'lmstudio', name: 'LM Studio', baseURL: 'http://127.0.0.1:1234/v1', requiresAPIKey: false },
  { id: 'custom', name: '', baseURL: '', requiresAPIKey: true },
] as const

type ProviderTemplateID = typeof PROVIDER_TEMPLATES[number]['id']

function customProviderID() {
  return `custom-${Date.now().toString(36)}`.slice(0, 32)
}

export function ModelProvidersSettings({
  config,
  onChanged,
}: {
  config?: LocalHostConfig | null
  onChanged?: () => void
}) {
  const { t } = useI18n()
  const [providers, setProviders] = useState<LocalModelProvider[]>([])
  const [dialogOpen, setDialogOpen] = useState(false)
  const [templateID, setTemplateID] = useState<ProviderTemplateID>('openai')
  const [providerID, setProviderID] = useState('openai')
  const [name, setName] = useState('OpenAI')
  const [baseURL, setBaseURL] = useState('https://api.openai.com/v1')
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

  const selectTemplate = (nextID: ProviderTemplateID) => {
    const template = PROVIDER_TEMPLATES.find((candidate) => candidate.id === nextID)!
    setTemplateID(nextID)
    setProviderID(nextID === 'custom' ? customProviderID() : template.id)
    setName(template.name)
    setBaseURL(template.baseURL)
    setRequiresAPIKey(template.requiresAPIKey)
    setAPIKey('')
  }

  const startAdding = () => {
    selectTemplate('openai')
    setModelID('')
    setModelName('')
    setMaxInputTokens('')
    setMaxOutputTokens('')
    setEditing(false)
    setError('')
    setDialogOpen(true)
  }

  const editProvider = (provider: LocalModelProvider) => {
    const model = provider.models[0]
    const knownTemplate = PROVIDER_TEMPLATES.find((template) => template.id === provider.id)
    setTemplateID(knownTemplate?.id ?? 'custom')
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
    setDialogOpen(true)
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
      setAPIKey('')
      setDialogOpen(false)
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
      await refresh()
      onChanged?.()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  if (!config) {
    return <div className="settings-provider-empty">{t('settings.models.runtimeOffline')}</div>
  }

  return (
    <div className="settings-model-providers">
      {providers.length === 0 ? (
        <div className="settings-provider-empty">
          <strong>{t('settings.models.empty')}</strong>
          <span>{t('settings.models.emptyHint')}</span>
        </div>
      ) : providers.map((provider) => (
        <div className="settings-provider-row" key={provider.id}>
          <button type="button" className="settings-provider-summary" onClick={() => editProvider(provider)}>
            <span className="settings-row-label">{provider.name}</span>
            <span className="settings-row-hint">
              {provider.base_url} · {t('settings.models.modelCount', { count: provider.models.length })}
            </span>
          </button>
          <span className={`settings-provider-state${provider.credential_configured ? '' : ' missing'}`}>
            {provider.requires_api_key
              ? (provider.credential_configured ? t('settings.models.configured') : t('settings.models.missingCredential'))
              : t('settings.models.noCredentialNeeded')}
          </span>
          <button
            type="button"
            className="settings-provider-delete"
            aria-label={t('settings.models.delete')}
            onClick={() => void remove(provider)}
          >
            <IconTrash size={15} aria-hidden="true" />
          </button>
        </div>
      ))}

      <button type="button" className="settings-provider-add" onClick={startAdding}>
        <IconPlus size={16} aria-hidden="true" />
        {t('settings.models.add')}
      </button>

      <Dialog open={dialogOpen} onOpenChange={(open) => !saving && setDialogOpen(open)}>
        <DialogContent className="settings-provider-dialog sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>{editing ? t('settings.models.editTitle') : t('settings.models.addTitle')}</DialogTitle>
            <DialogDescription>{t('settings.models.dialogDescription')}</DialogDescription>
          </DialogHeader>

          <form className="settings-provider-form" onSubmit={(event) => void submit(event)}>
            <label className="settings-provider-field">
              <span>{t('settings.models.providerType')}</span>
              <Select
                value={templateID}
                disabled={editing}
                onValueChange={(value) => selectTemplate(value as ProviderTemplateID)}
              >
                <SelectTrigger aria-label={t('settings.models.providerType')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROVIDER_TEMPLATES.map((template) => (
                    <SelectItem key={template.id} value={template.id}>
                      {template.id === 'custom' ? t('settings.models.customProvider') : template.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>

            {templateID === 'custom' ? (
              <label className="settings-provider-field">
                <span>{t('settings.models.providerName')}</span>
                <Input required value={name} onChange={(event) => setName(event.target.value)} />
              </label>
            ) : null}

            <label className="settings-provider-field">
              <span>{t('settings.models.baseURL')}</span>
              <Input required type="url" value={baseURL} onChange={(event) => setBaseURL(event.target.value)} />
            </label>

            {requiresAPIKey ? (
              <label className="settings-provider-field">
                <span>{t('settings.models.apiKey')}</span>
                <Input
                  required={!editing}
                  type="password"
                  autoComplete="off"
                  value={apiKey}
                  placeholder={editing ? t('settings.models.keepCredential') : undefined}
                  onChange={(event) => setAPIKey(event.target.value)}
                />
              </label>
            ) : null}

            <label className="settings-provider-field">
              <span>{t('settings.models.modelId')}</span>
              <Input required value={modelID} placeholder={t('settings.models.modelIdHint')} onChange={(event) => setModelID(event.target.value)} />
            </label>

            <details className="settings-provider-advanced">
              <summary>{t('settings.models.advanced')}</summary>
              <div className="settings-provider-advanced-fields">
                <label className="settings-provider-field">
                  <span>{t('settings.models.modelName')}</span>
                  <Input value={modelName} onChange={(event) => setModelName(event.target.value)} />
                </label>
                <div className="settings-provider-limits-row">
                  <label className="settings-provider-field">
                    <span>{t('settings.models.maxInputTokens')}</span>
                    <Input type="number" min={1} value={maxInputTokens} onChange={(event) => setMaxInputTokens(event.target.value)} />
                  </label>
                  <label className="settings-provider-field">
                    <span>{t('settings.models.maxOutputTokens')}</span>
                    <Input type="number" min={128} value={maxOutputTokens} onChange={(event) => setMaxOutputTokens(event.target.value)} />
                  </label>
                </div>
              </div>
            </details>

            {error ? <p className="settings-provider-error">{error}</p> : null}
            <DialogFooter className="settings-provider-actions">
              <button type="button" className="settings-row-button" disabled={saving} onClick={() => setDialogOpen(false)}>
                {t('common.cancel')}
              </button>
              <button type="submit" className="settings-primary-button" disabled={saving}>
                {saving ? t('settings.models.saving') : t('settings.models.save')}
              </button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
