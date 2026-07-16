import { useCallback, useEffect, useState } from 'react'
import { IconBox, IconRefresh, IconUpload, IconX } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useI18n } from '@/shared/i18n/i18n'
import {
  RuntimeHTTPError,
  parseRuntimeModelSpec,
  type PluginDetail,
  type PluginSourceDetail,
  type PluginSourcePackageSummary,
  type PluginSourceSummary,
  type PluginSummary,
  type RuntimeModelSpec,
} from '@/shared/local-host/client'

interface VisionModelOption {
  id: RuntimeModelSpec
  label: string
  vendor: string
}

export interface PluginsViewProps {
  listPlugins: () => Promise<PluginSummary[]>
  listSources?: () => Promise<PluginSourceSummary[]>
  getSource?: (sourceId: string) => Promise<PluginSourceDetail>
  refreshVersion?: number
  visionModels?: VisionModelOption[]
  getPlugin?: (pluginId: string) => Promise<PluginDetail>
  selectPackage?: () => Promise<string | undefined>
  installPlugin?: (sourcePath: string, allowUnsigned: boolean) => Promise<unknown>
  setEnabled?: (plugin: PluginSummary, enabled: boolean) => Promise<unknown>
  updatePlugin?: (
    plugin: PluginSummary,
    sourcePath: string,
    allowUnsigned: boolean,
  ) => Promise<unknown>
  rollbackPlugin?: (plugin: PluginSummary, targetDigest: string) => Promise<unknown>
  removePlugin?: (plugin: PluginSummary) => Promise<unknown>
  bindVisionModel?: (plugin: PluginDetail, model: RuntimeModelSpec) => Promise<unknown>
  addSource?: (indexURL: string, signatureURL: string, publicKey: string) => Promise<unknown>
  refreshSource?: (source: PluginSourceSummary) => Promise<unknown>
  removeSource?: (source: PluginSourceSummary) => Promise<unknown>
  installSource?: (
    source: PluginSourceSummary,
    pluginPackage: PluginSourcePackageSummary,
    expectedActiveDigest?: string,
  ) => Promise<unknown>
}

export function PluginsView({
  listPlugins,
  listSources,
  getSource,
  refreshVersion,
  visionModels = [],
  getPlugin,
  selectPackage,
  installPlugin,
  setEnabled,
  updatePlugin,
  rollbackPlugin,
  removePlugin,
  bindVisionModel,
  addSource,
  refreshSource,
  removeSource,
  installSource,
}: PluginsViewProps) {
  const { t } = useI18n()
  const [plugins, setPlugins] = useState<PluginSummary[]>([])
  const [sources, setSources] = useState<PluginSourceSummary[]>([])
  const [sourceDetail, setSourceDetail] = useState<PluginSourceDetail>()
  const [detail, setDetail] = useState<PluginDetail>()
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()

  const refresh = useCallback(async () => {
    setLoading(true)
    setFailed(false)
    try {
      const [nextPlugins, nextSources] = await Promise.all([
        listPlugins(),
        listSources ? listSources() : Promise.resolve([]),
      ])
      setPlugins(nextPlugins)
      setSources(nextSources)
    } catch {
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }, [listPlugins, listSources])

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

  const showSource = async (source: PluginSourceSummary) => {
    if (!getSource) return
    setBusy(`source:detail:${source.source_id}`)
    setError(undefined)
    try {
      setSourceDetail(await getSource(source.source_id))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <section className="workspace skills-view plugins-view">
      <header className="topbar topbar-page">
        <div className="chat-toolbar-title">{t('plugins.title')}</div>
      </header>

      <div className="skills-scroll">
        <div className="skills-content">
          <div className="skills-toolbar">
            <p className="plugins-intro">{t('plugins.intro')}</p>
            <div className="plugins-toolbar-actions">
              {selectPackage && installPlugin ? (
                <Button
                  type="button"
                  size="sm"
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

          {listSources ? (
            <PluginSources
              sources={sources}
              detail={sourceDetail}
              installedPlugins={plugins}
              busy={Boolean(busy)}
              onAdd={
                addSource
                  ? (indexURL, signatureURL, publicKey) =>
                      mutate('source:add', () => addSource(indexURL, signatureURL, publicKey))
                  : undefined
              }
              onRefresh={
                refreshSource
                  ? async (source) => {
                      setSourceDetail(undefined)
                      await mutate(`source:refresh:${source.source_id}`, () => refreshSource(source))
                    }
                  : undefined
              }
              onRemove={
                removeSource
                  ? async (source) => {
                      if (!window.confirm(t('plugins.sources.confirmRemove', { name: source.name }))) return
                      setSourceDetail(undefined)
                      await mutate(`source:remove:${source.source_id}`, () => removeSource(source))
                    }
                  : undefined
              }
              onInspect={getSource ? showSource : undefined}
              onInstall={
                installSource
                  ? (source, pluginPackage, expectedActiveDigest) =>
                      mutate(`source:install:${pluginPackage.package_digest}`, () =>
                        installSource(source, pluginPackage, expectedActiveDigest),
                      )
                  : undefined
              }
            />
          ) : null}

          {failed ? (
            <div className="skills-section-empty">{t('plugins.loadError')}</div>
          ) : !loading && plugins.length === 0 ? (
            <div className="skills-section-empty">{t('plugins.empty')}</div>
          ) : (
            <div className="skills-grid" role="list">
              {plugins.map((plugin) => (
                <article className="skill-card plugin-card" role="listitem" key={plugin.id}>
                  <div className="skill-card-head">
                    <div className="skill-card-title">
                      <span className="skill-card-icon" aria-hidden="true">
                        <IconBox size={15} />
                      </span>
                      <span className="skill-card-name">{plugin.name}</span>
                    </div>
                    <span className="plugin-version">v{plugin.version}</span>
                  </div>
                  <code className="plugin-id">{plugin.id}</code>
                  <div className="plugin-meta">
                    <span>{plugin.execution_kind === 'wasi' ? 'WASI' : 'Managed Worker'}</span>
                    <span>{plugin.signature_status}</span>
                  </div>
                  <div className="skill-card-footer">
                    <span className="skill-card-kind">{plugin.publisher.name}</span>
                    <span className={`plugin-status${plugin.enabled ? ' enabled' : ''}`}>
                      {plugin.retired
                        ? t('plugins.status.retired')
                        : plugin.compatibility === 'incompatible'
                          ? t('plugins.status.incompatible')
                          : plugin.enabled
                            ? t('plugins.status.enabled')
                            : t('plugins.status.disabled')}
                    </span>
                  </div>
                  <div className="plugin-card-actions">
                    {getPlugin ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        aria-label={t('plugins.viewDetails', { name: plugin.name })}
                        onClick={() => void showDetail(plugin)}
                        disabled={Boolean(busy)}
                      >
                        {t('plugins.details')}
                      </Button>
                    ) : null}
                    {setEnabled && !plugin.retired && plugin.compatibility === 'compatible' ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          void mutate(`enabled:${plugin.id}`, () =>
                            setEnabled(plugin, !plugin.enabled),
                          ).catch(() => undefined)
                        }
                        disabled={Boolean(busy)}
                      >
                        {plugin.enabled ? t('plugins.disable') : t('plugins.enable')}
                      </Button>
                    ) : null}
                    {updatePlugin && selectPackage && !plugin.retired ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          void (async () => {
                            const sourcePath = await selectPackage()
                            if (!sourcePath) return
                            await mutate(`update:${plugin.id}`, () =>
                              withUnsignedConfirmation((allowUnsigned) =>
                                updatePlugin(plugin, sourcePath, allowUnsigned),
                              ),
                            )
                          })().catch(() => undefined)
                        }
                        disabled={Boolean(busy)}
                      >
                        {t('plugins.update')}
                      </Button>
                    ) : null}
                    {removePlugin && !plugin.retired ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          if (!window.confirm(t('plugins.confirmRemove', { name: plugin.name }))) return
                          void mutate(`remove:${plugin.id}`, () => removePlugin(plugin)).catch(
                            () => undefined,
                          )
                        }}
                        disabled={Boolean(busy)}
                      >
                        {t('plugins.remove')}
                      </Button>
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

interface PluginSourcesProps {
  sources: PluginSourceSummary[]
  detail?: PluginSourceDetail
  installedPlugins: PluginSummary[]
  busy: boolean
  onAdd?: (indexURL: string, signatureURL: string, publicKey: string) => Promise<unknown>
  onRefresh?: (source: PluginSourceSummary) => Promise<unknown>
  onRemove?: (source: PluginSourceSummary) => Promise<unknown>
  onInspect?: (source: PluginSourceSummary) => Promise<unknown>
  onInstall?: (
    source: PluginSourceSummary,
    pluginPackage: PluginSourcePackageSummary,
    expectedActiveDigest?: string,
  ) => Promise<unknown>
}

function PluginSources({
  sources,
  detail,
  installedPlugins,
  busy,
  onAdd,
  onRefresh,
  onRemove,
  onInspect,
  onInstall,
}: PluginSourcesProps) {
  const { t } = useI18n()
  const [indexURL, setIndexURL] = useState('')
  const [signatureURL, setSignatureURL] = useState('')
  const [publicKey, setPublicKey] = useState('')

  const submit = async () => {
    if (!onAdd) return
    await onAdd(indexURL.trim(), signatureURL.trim(), publicKey.trim())
    setIndexURL('')
    setSignatureURL('')
    setPublicKey('')
  }

  return (
    <section className="plugin-sources" aria-labelledby="plugin-sources-title">
      <div className="plugin-source-heading">
        <div>
          <h2 id="plugin-sources-title">{t('plugins.sources.title')}</h2>
          <p>{t('plugins.sources.intro')}</p>
        </div>
      </div>
      {onAdd ? (
        <form
          className="plugin-source-form"
          onSubmit={(event) => {
            event.preventDefault()
            void submit().catch(() => undefined)
          }}
        >
          <label>
            <span>{t('plugins.sources.indexURL')}</span>
            <Input
              type="url"
              required
              value={indexURL}
              onChange={(event) => setIndexURL(event.target.value)}
            />
          </label>
          <label>
            <span>{t('plugins.sources.signatureURL')}</span>
            <Input
              type="url"
              required
              value={signatureURL}
              onChange={(event) => setSignatureURL(event.target.value)}
            />
          </label>
          <label>
            <span>{t('plugins.sources.publicKey')}</span>
            <Input
              required
              value={publicKey}
              onChange={(event) => setPublicKey(event.target.value)}
            />
          </label>
          <Button type="submit" size="sm" disabled={busy}>
            {t('plugins.sources.add')}
          </Button>
        </form>
      ) : null}
      {sources.length === 0 ? (
        <div className="plugin-source-empty">{t('plugins.sources.empty')}</div>
      ) : (
        <div className="skills-grid" role="list">
          {sources.map((source) => (
            <article className="skill-card plugin-card" role="listitem" key={source.source_id}>
              <div className="skill-card-head">
                <div className="skill-card-title">
                  <span className="skill-card-icon" aria-hidden="true"><IconBox size={15} /></span>
                  <span className="skill-card-name">{source.name}</span>
                </div>
                <span className="plugin-version">r{source.revision}</span>
              </div>
              <code className="plugin-id">{source.index_url}</code>
              <div className="plugin-meta">
                <span>{t('plugins.sources.packageCount', { count: source.package_count })}</span>
                <span>{source.key_id}</span>
              </div>
              <div className="plugin-card-actions">
                {onInspect ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    aria-label={t('plugins.sources.inspectAria', { name: source.name })}
                    onClick={() => void onInspect(source).catch(() => undefined)}
                  >
                    {t('plugins.sources.inspect')}
                  </Button>
                ) : null}
                {onRefresh ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    aria-label={t('plugins.sources.refreshAria', { name: source.name })}
                    onClick={() => void onRefresh(source).catch(() => undefined)}
                  >
                    {t('plugins.sources.refresh')}
                  </Button>
                ) : null}
                {onRemove ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    aria-label={t('plugins.sources.removeAria', { name: source.name })}
                    onClick={() => void onRemove(source).catch(() => undefined)}
                  >
                    {t('plugins.sources.remove')}
                  </Button>
                ) : null}
              </div>
              {detail?.source_id === source.source_id ? (
                <div className="plugin-source-packages">
                  {detail.packages.length === 0 ? (
                    <span className="plugin-source-empty">{t('plugins.sources.noPackages')}</span>
                  ) : detail.packages.map((pluginPackage) => (
                    <div className="plugin-source-package" key={`${pluginPackage.plugin_id}:${pluginPackage.version}:${pluginPackage.execution_kind}:${pluginPackage.platform}`}>
                      <div>
                        <strong>{pluginPackage.name}</strong>
                        <span>v{pluginPackage.version} · {pluginPackage.execution_kind === 'wasi' ? 'WASI' : 'Managed Worker'} · {pluginPackage.platform}</span>
                      </div>
                      {onInstall ? (
                        <Button
                          type="button"
                          size="sm"
                          disabled={busy}
                          aria-label={t('plugins.sources.installAria', { name: pluginPackage.name, version: pluginPackage.version })}
                          onClick={() =>
                            void onInstall(
                              source,
                              pluginPackage,
                              installedPlugins.find(
                                (installed) => installed.id === pluginPackage.plugin_id,
                              )?.digest,
                            ).catch(() => undefined)
                          }
                        >
                          {t('plugins.sources.install')}
                        </Button>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null}
            </article>
          ))}
        </div>
      )}
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
        <div><dt>{t('plugins.execution')}</dt><dd>{plugin.execution_kind === 'wasi' ? 'WASI' : 'Managed Worker'}</dd></div>
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
