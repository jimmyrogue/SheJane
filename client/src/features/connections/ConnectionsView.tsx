import { useEffect, useMemo, useState } from 'react'
import { IconCalendar, IconMail, IconMessageCircle, IconPlus } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { useI18n, type Translator } from '@/shared/i18n/i18n'
import {
  clearLocalLarkCache,
  connectLocalLark,
  discoverLocalLarkSources,
  disconnectLocalLark,
  getLocalLarkStatus,
  listLocalLarkSources,
  previewLocalLark,
  syncLocalLark,
  updateLocalLarkConnection,
  updateLocalLarkSource,
  type ClearLocalLarkCacheResponse,
  type LocalHostConfig,
  type LocalLarkConnectResponse,
  type LocalLarkConnection,
  type LocalLarkSource,
  type LocalLarkStatus,
  type PreviewLocalLarkRequest,
  type PreviewLocalLarkResponse,
  type SyncLocalLarkRequest,
  type SyncLocalLarkResponse,
  type UpdateLocalLarkConnectionRequest,
  type UpdateLocalLarkSourceRequest,
} from '@/shared/local-host/client'
import {
  WORK_CONNECTORS,
  countSelectedSources,
  filterWorkConnectorSources,
  toLarkSourceView,
  translateWorkConnectors,
  type WorkConnectorID,
  type WorkConnectorDescriptor,
} from './work-connectors'

interface ConnectionsViewApi {
  getLarkStatus: (config: LocalHostConfig) => Promise<LocalLarkStatus>
  listLarkSources: (config: LocalHostConfig) => Promise<LocalLarkSource[]>
  discoverLarkSources: (config: LocalHostConfig) => Promise<LocalLarkSource[]>
  updateLarkSource: (
    sourceID: string,
    input: UpdateLocalLarkSourceRequest,
    config: LocalHostConfig,
  ) => Promise<LocalLarkSource>
  connectLark: (config: LocalHostConfig) => Promise<LocalLarkConnectResponse>
  disconnectLark: (config: LocalHostConfig) => Promise<LocalLarkStatus>
  updateLarkConnection: (
    input: UpdateLocalLarkConnectionRequest,
    config: LocalHostConfig,
  ) => Promise<LocalLarkConnection>
  syncLark: (input: SyncLocalLarkRequest, config: LocalHostConfig) => Promise<SyncLocalLarkResponse>
  previewLark: (input: PreviewLocalLarkRequest, config: LocalHostConfig) => Promise<PreviewLocalLarkResponse>
  clearLarkCache: (config: LocalHostConfig) => Promise<ClearLocalLarkCacheResponse>
}

interface ConnectionsViewProps {
  localHostConfig?: LocalHostConfig | null
  api?: Partial<ConnectionsViewApi>
}

const DEFAULT_API: ConnectionsViewApi = {
  getLarkStatus: getLocalLarkStatus,
  listLarkSources: listLocalLarkSources,
  discoverLarkSources: discoverLocalLarkSources,
  updateLarkSource: updateLocalLarkSource,
  connectLark: connectLocalLark,
  disconnectLark: disconnectLocalLark,
  updateLarkConnection: updateLocalLarkConnection,
  syncLark: syncLocalLark,
  previewLark: previewLocalLark,
  clearLarkCache: clearLocalLarkCache,
}

const LARK_RETENTION_DAY_OPTIONS = [1, 3, 7, 14, 30] as const
const LARK_AUTO_SYNC_INTERVAL_OPTIONS = [1, 2, 5, 10, 15] as const
const LARK_AUTH_POLL_INTERVAL_MS = 2_000
const LARK_AUTH_POLL_TIMEOUT_MS = 180_000
const LARK_DEFAULT_EXTRACTION_PROVIDER: SyncLocalLarkRequest['extraction_provider'] = 'cloud_redacted'

function connectionIcon(id: WorkConnectorID) {
  if (id === 'calendar') return <IconCalendar size={17} aria-hidden="true" />
  if (id === 'imap') return <IconMail size={17} aria-hidden="true" />
  return <IconMessageCircle size={17} aria-hidden="true" />
}

function connectorLabel(t: Translator, status: LocalLarkStatus | null): string | null {
  if (!status) return null
  if (status.connector.source === 'bundled') return t('connections.lark.connectorBundled')
  if (status.connector.source === 'system') return t('connections.lark.connectorSystem')
  return t('connections.lark.connectorMissing')
}

function larkAccountLabel(status: LocalLarkStatus | null): string | null {
  const parts = [status?.connection.account_label, status?.connection.tenant_label].filter(Boolean)
  return parts.length > 0 ? parts.join(' · ') : null
}

function larkStatusText(
  t: Translator,
  status: LocalLarkStatus | null,
  loading: boolean,
  localHostConfig: LocalHostConfig | null | undefined,
): string {
  if (loading) return t('connections.lark.checking')
  if (localHostConfig === null) return t('connections.lark.localHostMissing')
  if (!status?.connector.available) return t('connections.lark.connectorMissing')
  if (status.connection.status === 'connected') return t('connections.connected')
  if (status.connection.status === 'needs_auth') return t('connections.lark.needsAuth')
  if (status.connection.status === 'error') return t('connections.lark.error')
  return t('connections.lark.disconnected')
}

async function openExternalURL(url: string): Promise<boolean> {
  const openExternal = window.shejaneDesktop?.openExternal
  if (!openExternal) return false
  try {
    await openExternal(url)
    return true
  } catch {
    return false
  }
}

function isLarkAuthRequiredError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return [
    'lark_auth_required',
    'lark_auth_scope_required',
    'lark_user_auth_required',
  ].includes(message)
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, milliseconds)
  })
}

export function ConnectionsView({ localHostConfig, api }: ConnectionsViewProps = {}) {
  const { t } = useI18n()
  const larkManaged = localHostConfig !== undefined
  const larkApi = useMemo<ConnectionsViewApi>(() => {
    const merged = { ...DEFAULT_API, ...api }
    if (!api?.discoverLarkSources && api?.listLarkSources) {
      merged.discoverLarkSources = api.listLarkSources
    }
    return merged
  }, [api])
  const [states, setStates] = useState<Record<WorkConnectorID, boolean>>(() =>
    WORK_CONNECTORS.reduce(
      (next, connection) => ({ ...next, [connection.id]: connection.connected }),
      {} as Record<WorkConnectorID, boolean>,
    ),
  )
  const [larkStatus, setLarkStatus] = useState<LocalLarkStatus | null>(null)
  const [larkSources, setLarkSources] = useState<LocalLarkSource[]>([])
  const [larkPreview, setLarkPreview] = useState<PreviewLocalLarkResponse | null>(null)
  const [larkLoading, setLarkLoading] = useState(false)
  const [larkBusy, setLarkBusy] = useState(false)
  const [larkSourceBusy, setLarkSourceBusy] = useState<string | null>(null)
  const [larkRetentionDays, setLarkRetentionDays] = useState(7)
  const [larkAutoSync, setLarkAutoSync] = useState(false)
  const [larkAutoSyncIntervalMinutes, setLarkAutoSyncIntervalMinutes] = useState(5)
  const [larkMessage, setLarkMessage] = useState<string | null>(null)
  const [larkAuthorizationUrl, setLarkAuthorizationUrl] = useState<string | null>(null)
  const [larkError, setLarkError] = useState<string | null>(null)
  const [larkSettingsOpen, setLarkSettingsOpen] = useState(false)
  const [larkSourcePickerOpen, setLarkSourcePickerOpen] = useState(false)
  const [larkSourceQuery, setLarkSourceQuery] = useState('')
  const managedStates = useMemo(
    () => ({
      ...states,
      lark: larkManaged ? larkStatus?.connection.status === 'connected' : states.lark,
    }),
    [larkManaged, larkStatus, states],
  )
  const connections = useMemo(() => translateWorkConnectors(t, managedStates), [managedStates, t])
  const larkSourceViews = useMemo(
    () => larkSources.map((source) => toLarkSourceView(t, source)),
    [larkSources, t],
  )
  const selectedLarkSourceCount = useMemo(
    () => countSelectedSources(larkSourceViews),
    [larkSourceViews],
  )
  const filteredLarkSources = useMemo(
    () => filterWorkConnectorSources(larkSourceViews, larkSourceQuery),
    [larkSourceQuery, larkSourceViews],
  )

  function applyLarkConnection(connection: LocalLarkConnection) {
    setLarkStatus((current) => (current ? { ...current, connection } : current))
    setLarkRetentionDays(connection.data_retention_days)
    setLarkAutoSync(connection.auto_sync_enabled)
    setLarkAutoSyncIntervalMinutes(connection.auto_sync_interval_minutes)
  }

  async function refreshLarkStatusAfterAuthRequired() {
    if (!localHostConfig) return
    try {
      const next = await larkApi.getLarkStatus(localHostConfig)
      setLarkStatus(next)
      applyLarkConnection(next.connection)
    } catch {
      setLarkStatus((current) => current
        ? {
            ...current,
            connection: {
              ...current.connection,
              status: 'needs_auth',
              last_error_code: 'lark_auth_required',
            },
          }
        : current)
    }
  }

  async function waitForLarkDeviceAuthorization() {
    if (!localHostConfig) return
    const deadline = Date.now() + LARK_AUTH_POLL_TIMEOUT_MS
    let firstAttempt = true
    while (Date.now() < deadline) {
      if (!firstAttempt) {
        await wait(LARK_AUTH_POLL_INTERVAL_MS)
      }
      firstAttempt = false
      const next = await larkApi.getLarkStatus(localHostConfig)
      setLarkStatus(next)
      applyLarkConnection(next.connection)
      if (next.connection.status === 'connected') {
        setLarkAuthorizationUrl(null)
        setLarkMessage(t('connections.lark.authCompleted'))
        try {
          const sources = await larkApi.discoverLarkSources(localHostConfig)
          setLarkSources(sources)
        } catch {
          // Keep the next-step dialog available even if source refresh needs a retry.
        }
        setLarkSourcePickerOpen(true)
        return
      }
      if (next.connection.status === 'error') {
        return
      }
    }
  }

  useEffect(() => {
    if (!larkManaged) return
    setLarkMessage(null)
    setLarkAuthorizationUrl(null)
    setLarkError(null)
    if (!localHostConfig) {
      setLarkStatus(null)
      setLarkSources([])
      setLarkPreview(null)
      setLarkLoading(false)
      return
    }
    let canceled = false
    setLarkLoading(true)
    Promise.all([larkApi.getLarkStatus(localHostConfig), larkApi.listLarkSources(localHostConfig)])
      .then(([next, sources]) => {
        if (!canceled) {
          setLarkStatus(next)
          setLarkSources(sources)
          setLarkRetentionDays(next.connection.data_retention_days)
          setLarkAutoSync(next.connection.auto_sync_enabled)
          setLarkAutoSyncIntervalMinutes(next.connection.auto_sync_interval_minutes)
        }
      })
      .catch((error: unknown) => {
        if (!canceled) {
          setLarkError(error instanceof Error ? error.message : t('connections.lark.error'))
          setLarkStatus(null)
        }
      })
      .finally(() => {
        if (!canceled) {
          setLarkLoading(false)
        }
      })
    return () => {
      canceled = true
    }
  }, [larkApi, larkManaged, localHostConfig, t])

  function connect(id: WorkConnectorID) {
    setStates((current) => ({ ...current, [id]: true }))
  }

  async function handleConnectLark() {
    if (!localHostConfig || larkBusy) return
    setLarkBusy(true)
    setLarkMessage(null)
    setLarkAuthorizationUrl(null)
    setLarkError(null)
    try {
      const next = await larkApi.connectLark(localHostConfig)
      setLarkStatus({ connection: next.connection, connector: next.connector })
      applyLarkConnection(next.connection)
      if (next.authorization_url) {
        setLarkAuthorizationUrl(next.authorization_url)
        const opened = await openExternalURL(next.authorization_url)
        setLarkMessage(opened ? t('connections.lark.authStarted') : t('connections.lark.authRequested'))
        if (next.device_code) {
          await waitForLarkDeviceAuthorization()
        }
      } else {
        setLarkMessage(t('connections.lark.authRequested'))
        if (next.connection.status === 'connected') {
          const sources = await larkApi.discoverLarkSources(localHostConfig)
          setLarkSources(sources)
          setLarkSourcePickerOpen(true)
        }
      }
    } catch (error) {
      setLarkError(error instanceof Error ? error.message : t('connections.lark.error'))
    } finally {
      setLarkBusy(false)
    }
  }

  async function handleDisconnectLark() {
    if (!localHostConfig || larkBusy) return
    setLarkBusy(true)
    setLarkMessage(null)
    setLarkError(null)
    try {
      const next = await larkApi.disconnectLark(localHostConfig)
      setLarkStatus(next)
      applyLarkConnection(next.connection)
      setLarkMessage(t('connections.lark.disconnected'))
    } catch (error) {
      setLarkError(error instanceof Error ? error.message : t('connections.lark.error'))
    } finally {
      setLarkBusy(false)
    }
  }

  async function handleSyncLark() {
    if (!localHostConfig || larkBusy) return
    setLarkBusy(true)
    setLarkMessage(null)
    setLarkError(null)
    try {
      if (LARK_DEFAULT_EXTRACTION_PROVIDER === 'cloud_redacted' && !larkPreview) {
        const preview = await larkApi.previewLark({ limit: 100 }, localHostConfig)
        setLarkPreview(preview)
        setLarkMessage(t('connections.lark.previewResult', { count: preview.candidate_count }))
        return
      }
      const result = await larkApi.syncLark(
        {
          limit: 100,
          extraction_provider: LARK_DEFAULT_EXTRACTION_PROVIDER,
        },
        localHostConfig,
      )
      const nextSources = await larkApi.listLarkSources(localHostConfig)
      setLarkSources(nextSources)
      setLarkPreview(null)
      const onlyDiscoveredSources = result.processed_messages === 0
        && result.created_todos === 0
        && nextSources.length > 0
        && nextSources.every((source) => !source.sync_enabled)
      setLarkMessage(
        result.error_code
          ? t('connections.lark.syncCloudUnavailable')
          : onlyDiscoveredSources
            ? t('connections.lark.sourcesDiscovered', { count: nextSources.length })
            : t('connections.lark.syncResult', { processed: result.processed_messages, created: result.created_todos }),
      )
    } catch (error) {
      if (isLarkAuthRequiredError(error)) {
        await refreshLarkStatusAfterAuthRequired()
        setLarkMessage(t('connections.lark.reauthRequired'))
        return
      }
      setLarkError(error instanceof Error ? error.message : t('connections.lark.syncFailed'))
    } finally {
      setLarkBusy(false)
    }
  }

  async function handlePreviewLark() {
    if (!localHostConfig || larkBusy) return
    setLarkBusy(true)
    setLarkMessage(null)
    setLarkError(null)
    try {
      const result = await larkApi.previewLark({ limit: 100 }, localHostConfig)
      setLarkPreview(result)
      setLarkMessage(t('connections.lark.previewResult', { count: result.candidate_count }))
    } catch (error) {
      if (isLarkAuthRequiredError(error)) {
        await refreshLarkStatusAfterAuthRequired()
        setLarkMessage(t('connections.lark.reauthRequired'))
        return
      }
      setLarkError(error instanceof Error ? error.message : t('connections.lark.previewFailed'))
    } finally {
      setLarkBusy(false)
    }
  }

  async function handleChangeLarkRetentionDays(value: string) {
    if (!localHostConfig || larkBusy) return
    const next = Number(value)
    if (!Number.isFinite(next)) return
    const previous = larkRetentionDays
    setLarkRetentionDays(next)
    setLarkMessage(null)
    setLarkError(null)
    try {
      const connection = await larkApi.updateLarkConnection({ data_retention_days: next }, localHostConfig)
      applyLarkConnection(connection)
    } catch (error) {
      setLarkRetentionDays(previous)
      setLarkError(error instanceof Error ? error.message : t('connections.lark.error'))
    }
  }

  async function handleToggleLarkAutoSync(enabled: boolean) {
    if (!localHostConfig || larkBusy) return
    const previous = larkAutoSync
    setLarkAutoSync(enabled)
    setLarkMessage(null)
    setLarkError(null)
    try {
      const connection = await larkApi.updateLarkConnection({ auto_sync_enabled: enabled }, localHostConfig)
      applyLarkConnection(connection)
    } catch (error) {
      setLarkAutoSync(previous)
      setLarkError(error instanceof Error ? error.message : t('connections.lark.error'))
    }
  }

  async function handleChangeLarkAutoSyncInterval(value: string) {
    if (!localHostConfig || larkBusy) return
    const next = Number(value)
    if (!Number.isFinite(next)) return
    const previous = larkAutoSyncIntervalMinutes
    setLarkAutoSyncIntervalMinutes(next)
    setLarkMessage(null)
    setLarkError(null)
    try {
      const connection = await larkApi.updateLarkConnection(
        { auto_sync_interval_minutes: next },
        localHostConfig,
      )
      applyLarkConnection(connection)
    } catch (error) {
      setLarkAutoSyncIntervalMinutes(previous)
      setLarkError(error instanceof Error ? error.message : t('connections.lark.error'))
    }
  }

  async function handleClearLarkCache() {
    if (!localHostConfig || larkBusy) return
    setLarkBusy(true)
    setLarkMessage(null)
    setLarkError(null)
    try {
      const result = await larkApi.clearLarkCache(localHostConfig)
      setLarkSources([])
      setLarkPreview(null)
      setLarkMessage(t('connections.lark.cacheCleared', { messages: result.deleted_messages, todos: result.deleted_todos }))
    } catch (error) {
      setLarkError(error instanceof Error ? error.message : t('connections.lark.clearFailed'))
    } finally {
      setLarkBusy(false)
    }
  }

  async function handleToggleLarkSource(source: LocalLarkSource, syncEnabled: boolean) {
    if (!localHostConfig || larkSourceBusy) return
    setLarkSourceBusy(source.id)
    setLarkMessage(null)
    setLarkError(null)
    const previous = larkSources
    setLarkSources((current) =>
      current.map((item) => (item.id === source.id ? { ...item, sync_enabled: syncEnabled } : item)),
    )
    try {
      const updated = await larkApi.updateLarkSource(source.id, { sync_enabled: syncEnabled }, localHostConfig)
      setLarkSources((current) => current.map((item) => (item.id === source.id ? updated : item)))
      setLarkPreview(null)
    } catch (error) {
      setLarkSources(previous)
      setLarkError(error instanceof Error ? error.message : t('connections.lark.error'))
    } finally {
      setLarkSourceBusy(null)
    }
  }

  async function openLarkSourcePicker() {
    setLarkSettingsOpen(false)
    setLarkSourcePickerOpen(true)
    setLarkSourceQuery('')
    if (!localHostConfig) return
    try {
      const sources = await larkApi.discoverLarkSources(localHostConfig)
      setLarkSources(sources)
    } catch (error) {
      setLarkError(error instanceof Error ? error.message : t('connections.lark.error'))
    }
  }

  function renderLarkDetails() {
    if (!larkManaged) return null
    const pieces = [connectorLabel(t, larkStatus), larkAccountLabel(larkStatus)].filter(Boolean)
    return (
      <div className="connection-detail-stack">
        <div className="connection-detail">
          {pieces.length > 0
            ? pieces.map((piece) => <span key={piece}>{piece}</span>)
            : <span>{larkError ? t('connections.lark.error') : larkStatusText(t, larkStatus, larkLoading, localHostConfig)}</span>}
          {larkStatus?.connection.status === 'connected' ? (
            <span>{t('connections.lark.selectedSources', { count: selectedLarkSourceCount })}</span>
          ) : null}
          {larkMessage ? <span>{larkMessage}</span> : null}
          {larkAuthorizationUrl ? (
            <a
              className="connection-detail-link"
              href={larkAuthorizationUrl}
              rel="noreferrer"
              target="_blank"
              onClick={(event) => {
                if (window.shejaneDesktop?.openExternal) {
                  event.preventDefault()
                  void openExternalURL(larkAuthorizationUrl)
                }
              }}
            >
              {larkAuthorizationUrl}
            </a>
          ) : null}
          {larkError ? <span className="connection-detail-error">{larkError}</span> : null}
        </div>
      </div>
    )
  }

  function renderLarkActions(connection: WorkConnectorDescriptor & { name: string; desc: string }) {
    const statusText = larkError ? t('connections.lark.error') : larkStatusText(t, larkStatus, larkLoading, localHostConfig)
    const statusClass = larkStatus?.connection.status === 'error' || larkError ? ' is-error' : connection.connected ? '' : ' is-muted'
    const connectorAvailable = larkStatus?.connector.available ?? false
    const canConnect = Boolean(localHostConfig && connectorAvailable && larkStatus?.connection.status !== 'connected')
    const canSync = Boolean(localHostConfig && connectorAvailable && larkStatus?.connection.status === 'connected')
    return (
      <div className="connection-actions">
        <div className={`connection-status${statusClass}`}>
          <span className="connection-status-dot" aria-hidden="true" />
          {statusText}
        </div>
        {canSync ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="connection-action"
            aria-label={t('connections.syncAria', { name: connection.name })}
            disabled={larkBusy}
            onClick={() => void handleSyncLark()}
          >
            {larkBusy ? t('connections.working') : t('connections.sync')}
          </Button>
        ) : null}
        {canSync ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="connection-action"
            aria-label={t('connections.settingsAria', { name: connection.name })}
            disabled={larkBusy}
            onClick={() => setLarkSettingsOpen(true)}
          >
            {t('connections.settings')}
          </Button>
        ) : null}
        {canConnect ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="connection-action"
            aria-label={t('connections.connectAria', { name: connection.name })}
            disabled={larkBusy}
            onClick={() => void handleConnectLark()}
          >
            {larkBusy ? t('connections.working') : t('connections.connect')}
          </Button>
        ) : null}
      </div>
    )
  }

  function renderLarkSettingsDialog() {
    return (
      <Dialog modal={false} open={larkSettingsOpen} onOpenChange={setLarkSettingsOpen}>
        <DialogContent className="connection-dialog">
          <DialogHeader>
            <DialogTitle>{t('connections.lark.settingsTitle')}</DialogTitle>
            <DialogDescription>{t('connections.lark.settingsDesc')}</DialogDescription>
          </DialogHeader>

          <div className="connection-dialog-body">
            <section className="connection-settings-section">
              <div className="connection-settings-heading">{t('connections.lark.sourcePickerTitle')}</div>
              <div className="connection-settings-inline">
                <span>{t('connections.lark.selectedSources', { count: selectedLarkSourceCount })}</span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="connection-action"
                  onClick={() => void openLarkSourcePicker()}
                >
                  {t('connections.lark.sourcePickerAction')}
                </Button>
              </div>
            </section>

            <section className="connection-settings-section">
              <div className="connection-settings-heading">{t('connections.lark.syncSettingsTitle')}</div>
              <label className="connection-select connection-settings-control">
                <span>{t('connections.lark.retention')}</span>
                <select
                  aria-label={t('connections.lark.retentionAria')}
                  value={String(larkRetentionDays)}
                  disabled={larkBusy}
                  onChange={(event) => void handleChangeLarkRetentionDays(event.currentTarget.value)}
                >
                  {LARK_RETENTION_DAY_OPTIONS.map((days) => (
                    <option key={days} value={String(days)}>
                      {t('connections.lark.days', { count: days })}
                    </option>
                  ))}
                </select>
              </label>
              <label className="connection-toggle connection-settings-control">
                <Switch
                  checked={larkAutoSync}
                  disabled={larkBusy}
                  aria-label={t('connections.lark.autoSyncAria')}
                  onCheckedChange={(checked) => void handleToggleLarkAutoSync(checked)}
                />
                <span>{t('connections.lark.autoSync')}</span>
              </label>
              <label className="connection-select connection-settings-control">
                <span>{t('connections.lark.interval')}</span>
                <select
                  aria-label={t('connections.lark.intervalAria')}
                  value={String(larkAutoSyncIntervalMinutes)}
                  disabled={larkBusy || !larkAutoSync}
                  onChange={(event) => void handleChangeLarkAutoSyncInterval(event.currentTarget.value)}
                >
                  {LARK_AUTO_SYNC_INTERVAL_OPTIONS.map((minutes) => (
                    <option key={minutes} value={String(minutes)}>
                      {t('connections.lark.minutes', { count: minutes })}
                    </option>
                  ))}
                </select>
              </label>
            </section>

            <section className="connection-settings-section connection-settings-danger">
              <div className="connection-settings-heading">{t('connections.lark.dangerZone')}</div>
              <div className="connection-settings-inline">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="connection-action connection-action-ghost"
                  aria-label={t('connections.disconnectAria', { name: t('connections.lark.name') })}
                  disabled={larkBusy}
                  onClick={() => void handleDisconnectLark()}
                >
                  {t('connections.disconnect')}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="connection-action connection-action-ghost connection-action-danger"
                  aria-label={t('connections.clearCacheAria', { name: t('connections.lark.name') })}
                  disabled={larkBusy}
                  onClick={() => void handleClearLarkCache()}
                >
                  {t('connections.clearCache')}
                </Button>
              </div>
            </section>
          </div>
        </DialogContent>
      </Dialog>
    )
  }

  function renderLarkSourcePickerDialog() {
    return (
      <Dialog modal={false} open={larkSourcePickerOpen} onOpenChange={setLarkSourcePickerOpen}>
        <DialogContent className="connection-dialog connection-source-dialog">
          <DialogHeader>
            <DialogTitle>{t('connections.lark.sourcePickerTitle')}</DialogTitle>
            <DialogDescription>{t('connections.lark.sourcePickerDesc')}</DialogDescription>
          </DialogHeader>

          <div className="connection-source-toolbar">
            <input
              type="search"
              className="connection-source-search"
              aria-label={t('connections.lark.searchSources')}
              placeholder={t('connections.lark.searchSources')}
              value={larkSourceQuery}
              onChange={(event) => setLarkSourceQuery(event.currentTarget.value)}
            />
          </div>

          <div className="connection-source-scroll" aria-label={t('connections.lark.sources')}>
            {filteredLarkSources.length > 0 ? filteredLarkSources.map((sourceView) => {
              return (
                <label className="connection-source-row" key={sourceView.id}>
                  <Switch
                    checked={sourceView.selected}
                    disabled={Boolean(larkSourceBusy)}
                    aria-label={t('connections.lark.sourceSyncAria', { name: sourceView.label })}
                    onCheckedChange={(checked) => void handleToggleLarkSource(sourceView.source, checked)}
                  />
                  <span className="connection-source-name">{sourceView.label}</span>
                  <span className="connection-source-type">{sourceView.sourceType}</span>
                </label>
              )
            }) : (
              <div className="connection-source-empty">{t('connections.lark.noSources')}</div>
            )}
          </div>

          <DialogFooter className="connection-dialog-footer">
            <div className="connection-source-count">
              {t('connections.lark.selectedSourceCount', { count: selectedLarkSourceCount })}
            </div>
            <Button type="button" size="sm" variant="outline" onClick={() => setLarkSourcePickerOpen(false)}>
              {t('connections.done')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <section className="workspace">
      <header className="topbar topbar-page">
        <div className="chat-toolbar-title">
          <span>{t('connections.title')}</span>
        </div>
      </header>

      <div className="skills-scroll">
        <div className="connections-content">
          <p className="connections-lead">{t('connections.intro')}</p>

          <div className="connections-list">
            {connections.map((connection) => (
              <div className="connection-row" key={connection.id}>
                <div className="connection-icon" aria-hidden="true">
                  <span className="connection-glyph">{connection.glyph}</span>
                  <span className="connection-symbol">{connectionIcon(connection.id)}</span>
                </div>
                <div className="connection-copy">
                  <div className="connection-name">{connection.name}</div>
                  <div className="connection-desc">{connection.desc}</div>
                  {connection.id === 'lark' ? renderLarkDetails() : null}
                </div>
                {connection.id === 'lark' && larkManaged ? renderLarkActions(connection) : connection.connected ? (
                  <div className="connection-status">
                    <span className="connection-status-dot" aria-hidden="true" />
                    {t('connections.connected')}
                  </div>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="connection-action"
                    aria-label={t('connections.connectAria', { name: connection.name })}
                    onClick={() => connect(connection.id)}
                  >
                    {t('connections.connect')}
                  </Button>
                )}
              </div>
            ))}
          </div>

          <button type="button" className="connections-add">
            <IconPlus size={13} aria-hidden="true" />
            {t('connections.add')}
          </button>
        </div>
      </div>
      {larkManaged ? renderLarkSettingsDialog() : null}
      {larkManaged ? renderLarkSourcePickerDialog() : null}
    </section>
  )
}
