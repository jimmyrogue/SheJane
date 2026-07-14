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
  discoverLocalModels,
  listLocalModelProviders,
  upsertLocalModelProvider,
  type DiscoveredLocalModel,
  type LocalHostConfig,
  type LocalModelProfile,
  type LocalModelProvider,
} from '@/shared/local-host/client'

const PROVIDER_TEMPLATES = [
  { id: 'openai', name: 'OpenAI', kind: 'openai_compatible', baseURL: 'https://api.openai.com/v1' },
  { id: 'openrouter', name: 'OpenRouter', kind: 'openai_compatible', baseURL: 'https://openrouter.ai/api/v1' },
  { id: 'deepseek', name: 'DeepSeek', kind: 'openai_compatible', baseURL: 'https://api.deepseek.com/v1' },
  { id: 'anthropic', name: 'Anthropic', kind: 'anthropic', baseURL: 'https://api.anthropic.com' },
  { id: 'custom-openai', name: '', kind: 'openai_compatible', baseURL: '' },
  { id: 'custom-anthropic', name: '', kind: 'anthropic', baseURL: '' },
] as const

type ProviderTemplateID = typeof PROVIDER_TEMPLATES[number]['id']
type ProviderKind = LocalModelProvider['kind']

function customProviderID(kind: ProviderKind) {
  return `custom-${kind === 'anthropic' ? 'anthropic' : 'openai'}-${Date.now().toString(36)}`.slice(0, 32)
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
  const [providerKind, setProviderKind] = useState<ProviderKind>('openai_compatible')
  const [baseURL, setBaseURL] = useState('https://api.openai.com/v1')
  const [apiKey, setAPIKey] = useState('')
  const [selectedModels, setSelectedModels] = useState<LocalModelProfile[]>([])
  const [manualModelIDs, setManualModelIDs] = useState<string[]>([''])
  const [modelQuery, setModelQuery] = useState('')
  const [maxInputTokens, setMaxInputTokens] = useState('')
  const [maxOutputTokens, setMaxOutputTokens] = useState('')
  const [requiresAPIKey, setRequiresAPIKey] = useState(true)
  const [discoveredModels, setDiscoveredModels] = useState<DiscoveredLocalModel[]>([])
  const [manualModelID, setManualModelID] = useState(true)
  const [discovering, setDiscovering] = useState(false)
  const [savedCredentialConfigured, setSavedCredentialConfigured] = useState(false)
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
    setProviderID(nextID.startsWith('custom-') ? customProviderID(template.kind) : template.id)
    setName(template.name)
    setProviderKind(template.kind)
    setBaseURL(template.baseURL)
    setRequiresAPIKey(true)
    setAPIKey('')
    setSelectedModels([])
    setManualModelIDs([''])
    setModelQuery('')
    setDiscoveredModels([])
    setManualModelID(true)
    setSavedCredentialConfigured(false)
  }

  const startAdding = () => {
    selectTemplate('openai')
    setSelectedModels([])
    setManualModelIDs([''])
    setModelQuery('')
    setMaxInputTokens('')
    setMaxOutputTokens('')
    setDiscoveredModels([])
    setManualModelID(true)
    setSavedCredentialConfigured(false)
    setEditing(false)
    setError('')
    setDialogOpen(true)
  }

  const editProvider = (provider: LocalModelProvider) => {
    const model = provider.models[0]
    const sharedMaxInputTokens = model?.max_input_tokens !== undefined
      && provider.models.every((candidate) => candidate.max_input_tokens === model.max_input_tokens)
      ? model.max_input_tokens
      : undefined
    const sharedMaxOutputTokens = model?.max_output_tokens !== undefined
      && provider.models.every((candidate) => candidate.max_output_tokens === model.max_output_tokens)
      ? model.max_output_tokens
      : undefined
    const knownTemplate = PROVIDER_TEMPLATES.find((template) => (
      template.id === provider.id && template.kind === provider.kind
    ))
    setTemplateID(knownTemplate?.id ?? (
      provider.kind === 'anthropic' ? 'custom-anthropic' : 'custom-openai'
    ))
    setProviderID(provider.id)
    setName(provider.name)
    setProviderKind(provider.kind)
    setBaseURL(provider.base_url)
    setAPIKey('')
    setSelectedModels(provider.models)
    setManualModelIDs(provider.models.length > 0
      ? provider.models.map((candidate) => candidate.model_id)
      : [''])
    setModelQuery('')
    setMaxInputTokens(sharedMaxInputTokens?.toString() ?? '')
    setMaxOutputTokens(sharedMaxOutputTokens?.toString() ?? '')
    setRequiresAPIKey(provider.requires_api_key)
    setDiscoveredModels(provider.models.map((candidate) => ({
      model_id: candidate.model_id,
      display_name: candidate.display_name,
    })))
    setManualModelID(false)
    setSavedCredentialConfigured(provider.credential_configured)
    setEditing(true)
    setError('')
    setDialogOpen(true)
  }

  const discoverModels = async () => {
    if (!config) return
    setDiscovering(true)
    setError('')
    try {
      const models = await discoverLocalModels(
        {
          provider_id: providerID,
          kind: providerKind,
          base_url: baseURL,
          api_key: apiKey || undefined,
        },
        config,
      )
      const discovered = [...models]
      for (const selected of selectedModels) {
        if (!discovered.some((candidate) => candidate.model_id === selected.model_id)) {
          discovered.push({
            model_id: selected.model_id,
            display_name: selected.display_name,
          })
        }
      }
      setDiscoveredModels(discovered)
      setModelQuery('')
      if (models.length === 0) {
        setManualModelID(true)
        setError(t('settings.models.noModelsFound'))
        return
      }
      setManualModelID(false)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setDiscovering(false)
    }
  }

  const toggleModel = (model: DiscoveredLocalModel) => {
    setSelectedModels((current) => current.some((candidate) => candidate.model_id === model.model_id)
      ? current.filter((candidate) => candidate.model_id !== model.model_id)
      : [...current, {
          model_id: model.model_id,
          display_name: model.display_name,
          tool_calling: true,
          streaming: true,
        }])
  }

  const updateManualModel = (index: number, value: string) => {
    const values = manualModelIDs.map((candidate, candidateIndex) => (
      candidateIndex === index ? value : candidate
    ))
    setManualModelIDs(values)
    const ids = [...new Set(values.map((candidate) => candidate.trim()).filter(Boolean))]
    setSelectedModels((current) => ids.map((modelID) => current.find(
      (candidate) => candidate.model_id === modelID,
    ) ?? {
      model_id: modelID,
      display_name: modelID,
      tool_calling: true,
      streaming: true,
    }))
  }

  const showModelConfiguration = !requiresAPIKey || Boolean(apiKey.trim()) || savedCredentialConfigured
  const normalizedModelQuery = modelQuery.trim().toLocaleLowerCase()
  const visibleModels = normalizedModelQuery
    ? discoveredModels.filter((model) => `${model.display_name} ${model.model_id}`.toLocaleLowerCase().includes(normalizedModelQuery))
    : discoveredModels

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
          kind: providerKind,
          base_url: baseURL,
          requires_api_key: requiresAPIKey,
          api_key: apiKey || undefined,
          models: selectedModels.map((model) => ({
            ...model,
            max_input_tokens: maxInputTokens
              ? Number(maxInputTokens)
              : model.max_input_tokens,
            max_output_tokens: maxOutputTokens
              ? Number(maxOutputTokens)
              : model.max_output_tokens,
          })),
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
                      {template.id === 'custom-openai'
                        ? t('settings.models.customOpenAI')
                        : template.id === 'custom-anthropic'
                          ? t('settings.models.customAnthropic')
                          : template.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>

            {templateID.startsWith('custom-') ? (
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

            {showModelConfiguration ? (
              <>
                <div className="settings-provider-field settings-provider-model-picker">
                  <div className="settings-provider-model-heading">
                    <span>{t('settings.models.model')}</span>
                    <button
                      type="button"
                      className="settings-row-button settings-provider-discover"
                      disabled={discovering || !baseURL || (requiresAPIKey && !editing && !apiKey)}
                      onClick={() => void discoverModels()}
                    >
                      {discovering ? t('settings.models.fetchingModels') : t('settings.models.fetchModels')}
                    </button>
                  </div>
                  {manualModelID ? (
                    <div className="settings-provider-manual-models">
                      {manualModelIDs.map((modelID, index) => (
                        <div className="settings-provider-manual-row" key={index}>
                          <Input
                            aria-label={`${t('settings.models.modelId')} ${index + 1}`}
                            value={modelID}
                            placeholder={t('settings.models.modelIdHint')}
                            onChange={(event) => updateManualModel(index, event.target.value)}
                          />
                          {index === manualModelIDs.length - 1 ? (
                            <button
                              type="button"
                              className="settings-provider-add-model"
                              aria-label={t('settings.models.addModel')}
                              disabled={!modelID.trim()}
                              onClick={() => setManualModelIDs((current) => [...current, ''])}
                            >
                              <IconPlus size={15} aria-hidden="true" />
                            </button>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="settings-provider-model-controls">
                      <Input
                        aria-label={t('settings.models.searchModels')}
                        value={modelQuery}
                        placeholder={t('settings.models.searchModels')}
                        onChange={(event) => setModelQuery(event.target.value)}
                      />
                      <div
                        className="settings-provider-model-list"
                        role="group"
                        aria-label={t('settings.models.model')}
                      >
                        {visibleModels.map((model) => (
                          <label className="settings-provider-model-choice" key={model.model_id}>
                            <input
                              type="checkbox"
                              checked={selectedModels.some((candidate) => candidate.model_id === model.model_id)}
                              aria-label={`${model.display_name} (${model.model_id})`}
                              onChange={() => toggleModel(model)}
                            />
                            <span className="settings-provider-model-option">
                              <span>{model.display_name}</span>
                              {model.display_name !== model.model_id ? (
                                <span className="settings-provider-model-id">{model.model_id}</span>
                              ) : null}
                            </span>
                          </label>
                        ))}
                      </div>
                      <div className="settings-provider-model-footer">
                        <span>{t('settings.models.selectedCount', { count: selectedModels.length })}</span>
                        <button
                          type="button"
                          className="settings-provider-manual-model"
                          onClick={() => {
                            setManualModelIDs(selectedModels.length > 0
                              ? selectedModels.map((model) => model.model_id)
                              : [''])
                            setManualModelID(true)
                          }}
                        >
                          {t('settings.models.enterModelId')}
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                <details className="settings-provider-advanced">
                  <summary>{t('settings.models.advanced')}</summary>
                  <div className="settings-provider-advanced-fields">
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
              </>
            ) : null}

            {error ? <p className="settings-provider-error">{error}</p> : null}
            <DialogFooter className="settings-provider-actions">
              <button type="button" className="settings-row-button" disabled={saving} onClick={() => setDialogOpen(false)}>
                {t('common.cancel')}
              </button>
              <button type="submit" className="settings-primary-button" disabled={saving || selectedModels.length === 0}>
                {saving ? t('settings.models.saving') : t('settings.models.save')}
              </button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
