import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { IconTrash } from '@tabler/icons-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useI18n, type Locale } from '@/shared/i18n/i18n'
import type { AdvancedAgentSettings, AgentSettings, LocalHostConfig } from '@/shared/local-host/client'
import { ModelProvidersSettings } from './ModelProvidersSettings'

type SettingsSectionID = 'runtime' | 'models' | 'agent' | 'run' | 'quality' | 'capability' | 'general' | 'data'

const SETTINGS_SECTION_TOP_OFFSET = 72

const runFields = [
  ['maxModelCalls', 1, 100, '20'],
  ['maxToolRetries', 0, 5, '2'],
  ['researchSearchLimit', 1, 20, '3'],
] as const

function SettingRow({
  label,
  hint,
  children,
  danger = false,
}: {
  label: string
  hint?: string
  children?: ReactNode
  danger?: boolean
}) {
  return (
    <div className={`settings-row${danger ? ' settings-danger' : ''}`}>
      <div className="settings-row-copy">
        <div className="settings-row-label">{label}</div>
        {hint ? <div className="settings-row-hint">{hint}</div> : null}
      </div>
      {children ? <div className="settings-row-control">{children}</div> : null}
    </div>
  )
}

function SettingsRowButton({
  children,
  danger,
  onClick,
}: {
  children: ReactNode
  danger?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className={`settings-row-button${danger ? ' settings-row-button-danger' : ''}`}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

function SettingsSection({
  id,
  title,
  note,
  children,
}: {
  id: SettingsSectionID
  title: string
  note?: string
  children: ReactNode
}) {
  return (
    <section id={`settings-${id}`} className="settings-section">
      <div className="settings-section-head">
        <h2>{title}</h2>
        {note ? <p>{note}</p> : null}
      </div>
      <div className="settings-card">{children}</div>
    </section>
  )
}

type RuntimeConnectionSummary = Awaited<ReturnType<NonNullable<NonNullable<Window['shejaneDesktop']>['runtimeConnection']>['get']>>

function RuntimeConnectionSettings() {
  const { t } = useI18n()
  const bridge = window.shejaneDesktop?.runtimeConnection
  const [current, setCurrent] = useState<RuntimeConnectionSummary>()
  const [mode, setMode] = useState<'bundled' | 'external-local'>('bundled')
  const [baseURL, setBaseURL] = useState('http://127.0.0.1:17371')
  const [token, setToken] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!bridge) return
    let cancelled = false
    void bridge.get().then((connection) => {
      if (cancelled) return
      setCurrent(connection)
      setMode(connection.mode)
      if (connection.baseURL) setBaseURL(connection.baseURL)
    }).catch((caught) => {
      if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught))
    })
    return () => {
      cancelled = true
    }
  }, [bridge])

  const managedByEnvironment = current?.source === 'environment'

  async function saveConnection() {
    if (!bridge || managedByEnvironment) return
    setSaving(true)
    setError('')
    try {
      await bridge.set(mode === 'bundled'
        ? { mode: 'bundled' }
        : {
            mode: 'external-local',
            baseURL,
            ...(token.trim() ? { token: token.trim() } : {}),
          })
      setToken('')
      await bridge.restartApp()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      setSaving(false)
    }
  }

  if (!bridge) {
    return <SettingRow label={t('settings.runtime.unavailable')} />
  }

  return (
    <>
      <SettingRow
        label={current?.state === 'ready' ? t('settings.runtime.ready') : t('settings.runtime.offline')}
        hint={managedByEnvironment ? t('settings.runtime.environment') : current?.error || error || undefined}
      >
        <span className="settings-row-value">{current?.mode === 'external-local' ? t('settings.runtime.externalLocal') : t('settings.runtime.bundled')}</span>
      </SettingRow>
      <SettingRow label={t('settings.runtime.mode')}>
        <Select
          value={mode}
          disabled={managedByEnvironment || saving}
          onValueChange={(value) => setMode(value as 'bundled' | 'external-local')}
        >
          <SelectTrigger className="settings-select-trigger" aria-label={t('settings.runtime.mode')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="bundled">{t('settings.runtime.bundled')}</SelectItem>
            <SelectItem value="external-local">{t('settings.runtime.externalLocal')}</SelectItem>
          </SelectContent>
        </Select>
      </SettingRow>
      {mode === 'external-local' ? (
        <>
          <SettingRow label={t('settings.runtime.url')} hint={t('settings.runtime.urlHint')}>
            <Input
              type="url"
              className="settings-text-input"
              aria-label={t('settings.runtime.url')}
              disabled={managedByEnvironment || saving}
              value={baseURL}
              onChange={(event) => setBaseURL(event.target.value)}
            />
          </SettingRow>
          <SettingRow label={t('settings.runtime.token')}>
            <Input
              type="password"
              className="settings-text-input"
              aria-label={t('settings.runtime.token')}
              autoComplete="off"
              disabled={managedByEnvironment || saving}
              placeholder={current?.tokenConfigured ? t('settings.runtime.tokenSaved') : t('settings.runtime.tokenRequired')}
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
          </SettingRow>
        </>
      ) : null}
      <SettingRow label={error || current?.error || t('settings.runtime.applyHint')}>
        <button
          type="button"
          className="settings-primary-button"
          disabled={managedByEnvironment || saving}
          onClick={() => void saveConnection()}
        >
          {saving ? t('settings.runtime.saving') : t('settings.runtime.save')}
        </button>
      </SettingRow>
    </>
  )
}

export function SettingsView({
  isDesktop = true,
  agentSettings,
  onAgentSettingsChange,
  onClearMemory,
  onImportLocalData,
  onExportLocalData,
  localHostConfig,
  onModelProvidersChange,
}: {
  isDesktop?: boolean
  agentSettings: Required<AgentSettings>
  onAgentSettingsChange: (next: Required<AgentSettings>) => void
  onClearMemory?: () => Promise<number>
  onImportLocalData: (file?: File) => void
  onExportLocalData?: () => void
  localHostConfig?: LocalHostConfig | null
  onModelProvidersChange?: () => void
}) {
  const { t, locale, setLocale } = useI18n()
  const importInputRef = useRef<HTMLInputElement>(null)
  const settingsScrollRef = useRef<HTMLDivElement>(null)
  const [activeSection, setActiveSection] = useState<SettingsSectionID>(
    isDesktop ? 'models' : 'general',
  )
  const [clearMemoryConfirmOpen, setClearMemoryConfirmOpen] = useState(false)
  const [clearingMemory, setClearingMemory] = useState(false)

  const memoryEnabled = (agentSettings.memory ?? 'on') === 'on'
  const skillsEnabled = (agentSettings.skills ?? 'on') === 'on'
  const mcpEnabled = (agentSettings.mcp ?? 'on') === 'on'
  const adv: AdvancedAgentSettings = agentSettings.advanced ?? {}
  const setAdv = (patch: Partial<AdvancedAgentSettings>) =>
    onAgentSettingsChange({ ...agentSettings, advanced: { ...adv, ...patch } })

  const navItems = useMemo<Array<{ id: SettingsSectionID, label: string }>>(
    () => [
      ...(isDesktop
        ? [
            { id: 'runtime' as const, label: t('settings.group.runtime') },
            { id: 'models' as const, label: t('settings.group.models') },
          ]
        : []),
      { id: 'agent', label: t('settings.group.agent') },
      ...(isDesktop
        ? [
            { id: 'run' as const, label: t('sidebar.agentSettings.advanced.group.run') },
            { id: 'quality' as const, label: t('sidebar.agentSettings.advanced.group.quality') },
            { id: 'capability' as const, label: t('sidebar.agentSettings.advanced.group.capability') },
          ]
        : []),
      { id: 'general', label: t('settings.group.general') },
      { id: 'data', label: t('settings.group.dataSecurity') },
    ],
    [isDesktop, t],
  )

  const updateActiveSectionFromScroll = useCallback(() => {
    const scrollRoot = settingsScrollRef.current
    if (!scrollRoot) return

    const rootTop = scrollRoot.getBoundingClientRect().top
    const sectionPositions = navItems
      .map((item) => {
        const section = document.getElementById(`settings-${item.id}`)
        if (!section) return null
        return {
          id: item.id,
          top: section.getBoundingClientRect().top - rootTop,
        }
      })
      .filter((item): item is { id: SettingsSectionID, top: number } => item !== null)

    if (sectionPositions.length === 0) return

    const hasScrollableLayout = scrollRoot.scrollHeight > scrollRoot.clientHeight
    const hasMeasuredSections = sectionPositions.some((position, index) =>
      index === 0 ? position.top !== 0 : position.top !== sectionPositions[0].top,
    )
    if (!hasScrollableLayout && !hasMeasuredSections) return

    const atBottom = hasScrollableLayout
      && scrollRoot.scrollTop + scrollRoot.clientHeight >= scrollRoot.scrollHeight - 8
    const nextActive = atBottom
      ? sectionPositions[sectionPositions.length - 1].id
      : sectionPositions.reduce<SettingsSectionID>((current, position) => (
          position.top <= SETTINGS_SECTION_TOP_OFFSET ? position.id : current
        ), sectionPositions[0].id)

    setActiveSection((current) => (current === nextActive ? current : nextActive))
  }, [navItems])

  useEffect(() => {
    updateActiveSectionFromScroll()
  }, [updateActiveSectionFromScroll])

  const selectSection = (id: SettingsSectionID) => {
    setActiveSection(id)
    const scrollRoot = settingsScrollRef.current
    const section = document.getElementById(`settings-${id}`)
    if (!section) return
    if (!scrollRoot) {
      section.scrollIntoView?.({ block: 'start' })
      return
    }

    const rootTop = scrollRoot.getBoundingClientRect().top
    const sectionTop = section.getBoundingClientRect().top - rootTop + scrollRoot.scrollTop
    const nextTop = Math.max(0, sectionTop - 12)
    if (typeof scrollRoot.scrollTo === 'function') {
      scrollRoot.scrollTo({
        top: nextTop,
        behavior: 'smooth',
      })
    } else {
      scrollRoot.scrollTop = nextTop
    }
  }

  return (
    <section className="workspace">
      <header className="topbar topbar-page">
        <div className="chat-toolbar-title">
          <span>{t('sidebar.settings')}</span>
        </div>
      </header>

      <div ref={settingsScrollRef} className="skills-scroll settings-scroll" onScroll={updateActiveSectionFromScroll}>
        <div className="settings-layout">
          <nav className="settings-nav" aria-label={t('settings.navAria')}>
            {navItems.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`settings-nav-item${activeSection === item.id ? ' active' : ''}`}
                aria-current={activeSection === item.id ? 'page' : undefined}
                onClick={() => selectSection(item.id)}
              >
                {item.label}
              </button>
            ))}
          </nav>

          <div className="settings-main-scroll">
            <div className="settings-main">
              {isDesktop ? (
                <SettingsSection
                  id="runtime"
                  title={t('settings.group.runtime')}
                  note={t('settings.runtime.note')}
                >
                  <RuntimeConnectionSettings />
                </SettingsSection>
              ) : null}

              {isDesktop ? (
                <SettingsSection
                  id="models"
                  title={t('settings.group.models')}
                  note={t('settings.models.note')}
                >
                  <ModelProvidersSettings
                    config={localHostConfig}
                    onChanged={onModelProvidersChange}
                  />
                </SettingsSection>
              ) : null}

              <SettingsSection id="agent" title={t('settings.group.agent')}>
                <SettingRow label={t('sidebar.agentSettings.memory.label')} hint={t('sidebar.agentSettings.memory.hint')}>
                  <Switch
                    checked={memoryEnabled}
                    aria-label={t('sidebar.agentSettings.memory.label')}
                    onCheckedChange={(checked) =>
                      onAgentSettingsChange({ ...agentSettings, memory: checked ? 'on' : 'off' })
                    }
                  />
                </SettingRow>
                {isDesktop ? (
                  <>
                    <SettingRow label={t('sidebar.agentSettings.skills.label')} hint={t('sidebar.agentSettings.skills.hint')}>
                      <Switch
                        checked={skillsEnabled}
                        aria-label={t('sidebar.agentSettings.skills.label')}
                        onCheckedChange={(checked) =>
                          onAgentSettingsChange({ ...agentSettings, skills: checked ? 'on' : 'off' })
                        }
                      />
                    </SettingRow>
                    <SettingRow label={t('sidebar.agentSettings.mcp.label')} hint={t('sidebar.agentSettings.mcp.hint')}>
                      <Switch
                        checked={mcpEnabled}
                        aria-label={t('sidebar.agentSettings.mcp.label')}
                        onCheckedChange={(checked) =>
                          onAgentSettingsChange({ ...agentSettings, mcp: checked ? 'on' : 'off' })
                        }
                      />
                    </SettingRow>
                  </>
                ) : null}
              </SettingsSection>

              {isDesktop ? (
                <>
                  <SettingsSection
                    id="run"
                    title={t('sidebar.agentSettings.advanced.group.run')}
                    note={t('sidebar.agentSettings.advanced.description')}
                  >
                    {runFields.map(([key, min, max, ph]) => (
                      <SettingRow
                        key={key}
                        label={t(`sidebar.agentSettings.advanced.${key}.label`)}
                        hint={t(`sidebar.agentSettings.advanced.${key}.hint`)}
                      >
                        <Input
                          type="number"
                          inputMode="numeric"
                          min={min}
                          max={max}
                          className="settings-number-input"
                          aria-label={t(`sidebar.agentSettings.advanced.${key}.label`)}
                          placeholder={ph}
                          value={(adv[key] as number | undefined) ?? ''}
                          onChange={(e) => {
                            const n = Number(e.target.value)
                            setAdv({ [key]: e.target.value === '' || !Number.isFinite(n) ? undefined : n })
                          }}
                        />
                      </SettingRow>
                    ))}
                  </SettingsSection>

                  <SettingsSection id="quality" title={t('sidebar.agentSettings.advanced.group.quality')}>
                    <SettingRow label={t('sidebar.agentSettings.advanced.planFirst.label')} hint={t('sidebar.agentSettings.advanced.planFirst.hint')}>
                      <Select
                        value={adv.planFirst ?? '__default__'}
                        onValueChange={(value) =>
                          setAdv({ planFirst: value === '__default__' ? undefined : (value as 'off' | 'auto' | 'always') })
                        }
                      >
                        <SelectTrigger className="settings-select-trigger" aria-label={t('sidebar.agentSettings.advanced.planFirst.label')}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__default__">{t('sidebar.agentSettings.advanced.default')}</SelectItem>
                          <SelectItem value="off">off</SelectItem>
                          <SelectItem value="auto">auto</SelectItem>
                          <SelectItem value="always">always</SelectItem>
                        </SelectContent>
                      </Select>
                    </SettingRow>
                  </SettingsSection>

                  <SettingsSection id="capability" title={t('sidebar.agentSettings.advanced.group.capability')}>
                    <SettingRow label={t('sidebar.agentSettings.advanced.subagents.label')} hint={t('sidebar.agentSettings.advanced.subagents.hint')}>
                      <Switch
                        checked={adv.subagents ?? true}
                        aria-label={t('sidebar.agentSettings.advanced.subagents.label')}
                        onCheckedChange={(checked) => setAdv({ subagents: checked })}
                      />
                    </SettingRow>
                    <SettingRow label={t('sidebar.agentSettings.advanced.browserHeadless.label')} hint={t('sidebar.agentSettings.advanced.browserHeadless.hint')}>
                      <Switch
                        checked={adv.browserHeadless ?? true}
                        aria-label={t('sidebar.agentSettings.advanced.browserHeadless.label')}
                        onCheckedChange={(checked) => setAdv({ browserHeadless: checked })}
                      />
                    </SettingRow>
                    <SettingRow label={t('sidebar.agentSettings.advanced.inputGuard.label')} hint={t('sidebar.agentSettings.advanced.inputGuard.hint')}>
                      <Select
                        value={adv.inputGuard ?? '__default__'}
                        onValueChange={(value) =>
                          setAdv({ inputGuard: value === '__default__' ? undefined : (value as 'off' | 'observe' | 'block') })
                        }
                      >
                        <SelectTrigger className="settings-select-trigger" aria-label={t('sidebar.agentSettings.advanced.inputGuard.label')}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__default__">{t('sidebar.agentSettings.advanced.default')}</SelectItem>
                          <SelectItem value="off">off</SelectItem>
                          <SelectItem value="observe">observe</SelectItem>
                          <SelectItem value="block">block</SelectItem>
                        </SelectContent>
                      </Select>
                    </SettingRow>
                  </SettingsSection>
                </>
              ) : null}

              <SettingsSection id="general" title={t('settings.group.general')}>
                <SettingRow label={t('settings.language')}>
                  <Select value={locale} onValueChange={(value) => setLocale(value as Locale)}>
                    <SelectTrigger className="settings-language-select" aria-label={t('settings.language')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="zh">中文</SelectItem>
                      <SelectItem value="en">English</SelectItem>
                    </SelectContent>
                  </Select>
                </SettingRow>
              </SettingsSection>

              <SettingsSection id="data" title={t('settings.group.dataSecurity')}>
                <SettingRow label={t('settings.import')} hint={t('settings.importHint')}>
                  <SettingsRowButton onClick={() => importInputRef.current?.click()}>
                    {t('settings.importAction')}
                  </SettingsRowButton>
                </SettingRow>
                <input
                  ref={importInputRef}
                  type="file"
                  accept="application/json"
                  hidden
                  onChange={(event) => {
                    onImportLocalData(event.currentTarget.files?.[0])
                    event.currentTarget.value = ''
                  }}
                />
                {onExportLocalData ? (
                  <SettingRow label={t('settings.export')} hint={t('settings.exportHint')}>
                    <SettingsRowButton onClick={onExportLocalData}>
                      {t('settings.exportAction')}
                    </SettingsRowButton>
                  </SettingRow>
                ) : null}
                {onClearMemory ? (
                  <SettingRow
                    label={t('sidebar.agentSettings.memory.clearAction')}
                    hint={t('sidebar.agentSettings.memory.clearHint')}
                    danger
                  >
                    <SettingsRowButton danger onClick={() => setClearMemoryConfirmOpen(true)}>
                      {t('settings.clearAction')}
                    </SettingsRowButton>
                  </SettingRow>
                ) : null}
              </SettingsSection>
            </div>
          </div>
        </div>
      </div>

      <AlertDialog open={clearMemoryConfirmOpen} onOpenChange={setClearMemoryConfirmOpen}>
        <AlertDialogContent className="conversation-delete-dialog">
          <AlertDialogHeader className="conversation-delete-header">
            <AlertDialogMedia className="conversation-delete-media">
              <IconTrash aria-hidden="true" />
            </AlertDialogMedia>
            <AlertDialogTitle>{t('sidebar.agentSettings.memory.clearConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('sidebar.agentSettings.memory.clearConfirmBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="conversation-delete-footer">
            <AlertDialogCancel variant="outline" autoFocus>
              <span className="conversation-delete-button-label">{t('sidebar.dialog.cancel')}</span>
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={clearingMemory || !onClearMemory}
              onClick={async (event) => {
                event.preventDefault()
                if (!onClearMemory) return
                setClearingMemory(true)
                try {
                  await onClearMemory()
                } finally {
                  setClearingMemory(false)
                  setClearMemoryConfirmOpen(false)
                }
              }}
            >
              <span className="conversation-delete-button-label">
                {t('sidebar.agentSettings.memory.clearConfirmAction')}
              </span>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

    </section>
  )
}
