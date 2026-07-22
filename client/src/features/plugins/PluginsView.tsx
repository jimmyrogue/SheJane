import { useCallback, useEffect, useState } from 'react'
import { IconBox, IconRefresh, IconSearch, IconTrash, IconUpload, IconX } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { useI18n } from '@/shared/i18n/i18n'
import {
  RuntimeHTTPError,
  parseRuntimeModelSpec,
  type PluginDetail,
  type PluginSummary,
  type RuntimeModelSpec,
} from '@/runtime/client'

interface VisionModelOption {
  id: RuntimeModelSpec
  label: string
  vendor: string
}

export interface PluginsViewProps {
  listPlugins: () => Promise<PluginSummary[]>
  embedded?: boolean
  refreshVersion?: number
  visionModels?: VisionModelOption[]
  getPlugin?: (pluginId: string) => Promise<PluginDetail>
  selectPackage?: () => Promise<string | undefined>
  installPlugin?: (sourcePath: string, allowUnsigned: boolean) => Promise<unknown>
  setEnabled?: (plugin: PluginSummary, enabled: boolean) => Promise<unknown>
  rollbackPlugin?: (plugin: PluginSummary, targetDigest: string) => Promise<unknown>
  removePlugin?: (plugin: PluginSummary) => Promise<unknown>
  bindVisionModel?: (plugin: PluginDetail, model: RuntimeModelSpec) => Promise<unknown>
}

function executionLabel(kind: PluginSummary['execution_kind']): string {
  return kind === 'wasi' ? 'WASI' : kind === 'managed_worker' ? 'Managed Worker' : 'Built-in'
}

export function PluginsView({
  listPlugins,
  embedded = false,
  refreshVersion,
  visionModels = [],
  getPlugin,
  selectPackage,
  installPlugin,
  setEnabled,
  rollbackPlugin,
  removePlugin,
  bindVisionModel,
}: PluginsViewProps) {
  const { t } = useI18n()
  const [plugins, setPlugins] = useState<PluginSummary[]>([])
  const [detail, setDetail] = useState<PluginDetail>()
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const [query, setQuery] = useState('')

  const refresh = useCallback(async () => {
    setLoading(true)
    setFailed(false)
    try {
      setPlugins(await listPlugins())
    } catch {
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }, [listPlugins])

  useEffect(() => {
    void refresh()
  }, [refresh, refreshVersion])

  const reloadDetail = useCallback(async () => {
    if (detail && getPlugin) setDetail(await getPlugin(detail.id))
  }, [detail, getPlugin])

  const mutate = useCallback(
    async (key: string, action: () => Promise<unknown>) => {
      setBusy(key)
      setError(undefined)
      try {
        await action()
        await Promise.all([refresh(), reloadDetail()])
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
        throw cause
      } finally {
        setBusy(undefined)
      }
    },
    [refresh, reloadDetail],
  )

  const withUnsignedConfirmation = useCallback(
    async (operation: (allowUnsigned: boolean) => Promise<unknown>) => {
      try {
        await operation(false)
      } catch (cause) {
        if (
          !(cause instanceof RuntimeHTTPError) ||
          cause.code !== 'unsigned_plugin_confirmation_required' ||
          !window.confirm(t('plugins.confirmUnsigned'))
        ) {
          throw cause
        }
        await operation(true)
      }
    },
    [t],
  )

  const importPlugin = async () => {
    const sourcePath = await selectPackage?.()
    if (!sourcePath || !installPlugin) return
    await mutate('install', () =>
      withUnsignedConfirmation((allowUnsigned) => installPlugin(sourcePath, allowUnsigned)),
    )
  }

  const showDetail = async (plugin: PluginSummary) => {
    if (!getPlugin) return
    setBusy(`detail:${plugin.id}`)
    setError(undefined)
    try {
      setDetail(await getPlugin(plugin.id))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(undefined)
    }
  }

  const normalizedQuery = query.trim().toLocaleLowerCase()
  const installedPlugins = plugins.filter((plugin) => !plugin.retired)
  const filteredPlugins = normalizedQuery
    ? installedPlugins.filter((plugin) =>
        [plugin.name, plugin.id, plugin.publisher.name]
          .some((value) => value.toLocaleLowerCase().includes(normalizedQuery)),
      )
    : installedPlugins

  return (
    <section className="workspace skills-view plugins-view">
      {!embedded ? (
        <header className="topbar topbar-page">
          <div className="chat-toolbar-title">{t('plugins.title')}</div>
        </header>
      ) : null}

      <div className="skills-scroll">
        <div className="skills-content">
          <div className="skills-toolbar">
            <div className="skills-search">
              <IconSearch className="skills-search-icon" size={15} aria-hidden="true" />
              <Input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('plugins.searchPlaceholder')}
                aria-label={t('plugins.searchPlaceholder')}
              />
            </div>
            <div className="skills-toolbar-actions">
              {selectPackage && installPlugin ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="skills-new-button"
                  onClick={() => void importPlugin().catch(() => undefined)}
                  disabled={Boolean(busy)}
                >
                  <IconUpload size={14} aria-hidden="true" />
                  {t('plugins.import')}
                </Button>
              ) : null}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="skills-refresh-button"
                onClick={() => void refresh()}
                disabled={loading || Boolean(busy)}
                aria-label={t('plugins.refresh')}
                title={t('plugins.refresh')}
              >
                <IconRefresh size={14} aria-hidden="true" />
              </Button>
            </div>
          </div>

          {error ? <div className="plugins-error" role="alert">{error}</div> : null}

          {failed ? (
            <div className="skills-section-empty">{t('plugins.loadError')}</div>
          ) : installedPlugins.length === 0 ? (
            loading ? null : <div className="skills-section-empty">{t('plugins.empty')}</div>
          ) : filteredPlugins.length === 0 ? (
            <div className="skills-section-empty">{t('plugins.notFound')}</div>
          ) : (
            <div className="skills-grid" role="list">
              {filteredPlugins.map((plugin) => (
                <article className="skill-card plugin-card" role="listitem" key={plugin.id}>
                  <div className="skill-card-head">
                    <button
                      type="button"
                      className="skill-card-title plugin-card-title-button"
                      aria-label={t('plugins.viewDetails', { name: plugin.name })}
                      onClick={() => void showDetail(plugin)}
                      disabled={!getPlugin || Boolean(busy)}
                    >
                      <span className="skill-card-icon" aria-hidden="true">
                        <IconBox size={15} />
                      </span>
                      <span className="skill-card-name">{plugin.name}</span>
                    </button>
                    <span className="plugin-version">v{plugin.version}</span>
                  </div>
                  <div className="skill-card-footer">
                    {removePlugin ? (
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        className="plugin-remove-button"
                        aria-label={t('plugins.removeAria', { name: plugin.name })}
                        title={t('plugins.remove')}
                        onClick={() => {
                          if (!window.confirm(t('plugins.confirmRemove', { name: plugin.name }))) return
                          void (async () => {
                            await mutate(`remove:${plugin.id}`, () => removePlugin(plugin))
                            if (detail?.id === plugin.id) setDetail(undefined)
                          })().catch(() => undefined)
                        }}
                        disabled={Boolean(busy)}
                      >
                        <IconTrash size={15} aria-hidden="true" />
                      </Button>
                    ) : null}
                    {setEnabled ? (
                      <Switch
                        checked={plugin.enabled}
                        onCheckedChange={(enabled) =>
                          void mutate(`enabled:${plugin.id}`, () =>
                            setEnabled(plugin, enabled),
                          ).catch(() => undefined)
                        }
                        disabled={Boolean(busy) || plugin.compatibility === 'incompatible'}
                        aria-label={t('plugins.toggleAria', { name: plugin.name })}
                        title={plugin.compatibility === 'incompatible'
                          ? t('plugins.status.incompatible')
                          : undefined}
                      />
                    ) : null}
                  </div>
                </article>
              ))}
            </div>
          )}

          {detail ? (
            <PluginDetails
              plugin={detail}
              busy={Boolean(busy)}
              visionModels={visionModels}
              onClose={() => setDetail(undefined)}
              onRollback={
                rollbackPlugin
                  ? (targetDigest) =>
                      mutate(`rollback:${detail.id}`, () => rollbackPlugin(detail, targetDigest))
                  : undefined
              }
              onBindVisionModel={
                bindVisionModel
                  ? (model) =>
                      mutate(`model:${detail.id}`, () => bindVisionModel(detail, model))
                  : undefined
              }
            />
          ) : null}
        </div>
      </div>
    </section>
  )
}

function PluginDetails({
  plugin,
  busy,
  visionModels,
  onClose,
  onRollback,
  onBindVisionModel,
}: {
  plugin: PluginDetail
  busy: boolean
  visionModels: VisionModelOption[]
  onClose: () => void
  onRollback?: (targetDigest: string) => Promise<unknown>
  onBindVisionModel?: (model: RuntimeModelSpec) => Promise<unknown>
}) {
  const { t } = useI18n()
  const requiresVisionModel = plugin.actions.some((action) =>
    action.capabilities.includes('model.vision.invoke'),
  )
  const [selectedModel, setSelectedModel] = useState<RuntimeModelSpec | ''>(() =>
    parseRuntimeModelSpec(plugin.model_binding?.requested_model ?? '') ?? '',
  )

  useEffect(() => {
    setSelectedModel(parseRuntimeModelSpec(plugin.model_binding?.requested_model ?? '') ?? '')
  }, [plugin.id, plugin.model_binding?.requested_model])

  return (
    <section className="plugin-detail" aria-label={t('plugins.detailTitle', { name: plugin.name })}>
      <div className="plugin-detail-head">
        <div>
          <h2>{plugin.name}</h2>
          <code>{plugin.id}</code>
        </div>
        <Button type="button" size="icon-sm" variant="ghost" onClick={onClose} aria-label={t('plugins.closeDetails')}>
          <IconX aria-hidden="true" />
        </Button>
      </div>
      <p>{plugin.description}</p>
      <dl className="plugin-detail-facts">
        <div><dt>{t('plugins.publisher')}</dt><dd>{plugin.publisher.name}</dd></div>
        <div><dt>{t('plugins.execution')}</dt><dd>{executionLabel(plugin.execution_kind)}</dd></div>
        <div><dt>{t('plugins.signature')}</dt><dd>{plugin.signature_status}</dd></div>
        <div><dt>{t('plugins.digest')}</dt><dd><code>{plugin.digest}</code></dd></div>
      </dl>

      {requiresVisionModel ? (
        <>
          <h3>{t('plugins.visionModel')}</h3>
          <div className="plugin-model-binding">
            <p>
              {plugin.model_binding
                ? t('plugins.visionModel.current', {
                    model: plugin.model_binding.requested_model,
                  })
                : t('plugins.visionModel.unconfigured')}
            </p>
            <select
              aria-label={t('plugins.visionModel.select')}
              value={selectedModel}
              onChange={(event) =>
                setSelectedModel(event.target.value as RuntimeModelSpec | '')
              }
              disabled={busy || !onBindVisionModel}
            >
              <option value="">{t('plugins.visionModel.placeholder')}</option>
              {visionModels.map((model) => (
                <option value={model.id} key={model.id}>
                  {model.label} · {model.vendor}
                </option>
              ))}
            </select>
            {onBindVisionModel ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy || !selectedModel}
                onClick={() => {
                  if (
                    selectedModel &&
                    window.confirm(t('plugins.visionModel.confirm', { model: selectedModel }))
                  ) {
                    void onBindVisionModel(selectedModel).catch(() => undefined)
                  }
                }}
              >
                {t('plugins.visionModel.bind')}
              </Button>
            ) : null}
          </div>
        </>
      ) : null}

      <h3>{t('plugins.versions')}</h3>
      <div className="plugin-version-list">
        {plugin.versions.map((version) => (
          <div className="plugin-version-row" key={version.digest}>
            <span>v{version.version}{version.active ? ` · ${t('plugins.active')}` : ''}</span>
            <code>{version.digest.slice(0, 20)}…</code>
            {!version.active && onRollback && version.compatibility === 'compatible' ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                aria-label={t('plugins.rollbackTo', { version: version.version })}
                disabled={busy}
                onClick={() => void onRollback(version.digest).catch(() => undefined)}
              >
                {t('plugins.rollback')}
              </Button>
            ) : null}
          </div>
        ))}
      </div>

      <h3>{t('plugins.actions')}</h3>
      {plugin.actions.length === 0 ? <p>{t('plugins.none')}</p> : plugin.actions.map((action) => (
        <article className="plugin-contribution" key={action.id}>
          <strong>{action.title}</strong>
          <code>{action.id}</code>
          <p>{action.description}</p>
          <div className="plugin-tags">
            {[...action.consumes, ...action.produces, ...action.capabilities].map((item) => <span key={item}>{item}</span>)}
          </div>
          <small>{action.limits.timeout_ms} ms · {action.limits.memory_mb} MiB · {action.limits.output_mb} MiB output</small>
        </article>
      ))}

      <h3>{t('plugins.commands')}</h3>
      {plugin.commands.length === 0 ? <p>{t('plugins.none')}</p> : plugin.commands.map((command) => (
        <article className="plugin-contribution" key={command.id}>
          <strong>{command.title}</strong>
          <code>/{command.id}</code>
          <p>{command.description}</p>
        </article>
      ))}

      <h3>{t('plugins.skills')}</h3>
      {plugin.skills.length === 0 ? <p>{t('plugins.none')}</p> : plugin.skills.map((skill) => (
        <article className="plugin-contribution" key={skill.id}>
          <strong>{skill.id}</strong>
          <code>{skill.path}</code>
        </article>
      ))}

      <h3>{t('plugins.mcpServers')}</h3>
      {plugin.mcp_servers.length === 0 ? <p>{t('plugins.none')}</p> : plugin.mcp_servers.map((server) => (
        <article className="plugin-contribution" key={server.id}>
          <strong>{server.id}</strong>
          <code>{server.path}</code>
        </article>
      ))}
    </section>
  )
}
