import { useRef, useState, type ReactNode } from 'react'
import { IconLogout, IconTrash } from '@tabler/icons-react'
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
import type { WalletBalance } from '@/shared/api/client'
import type { AdvancedAgentSettings, AgentSettings } from '@/shared/local-host/client'

type SettingsSectionID = 'account' | 'agent' | 'run' | 'quality' | 'capability' | 'general' | 'data'

const runFields = [
  ['maxModelCalls', 1, 100, '20'],
  ['maxHistoryTurns', 1, 200, '40'],
  ['maxModelRetries', 0, 5, '2'],
  ['maxToolRetries', 0, 5, '2'],
  ['researchSearchLimit', 1, 20, '3'],
  ['toolSelectorMax', 0, 50, '0'],
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

function formatCredits(value: number): string {
  return Math.max(0, Math.round(value)).toLocaleString()
}

function displayInitial(email: string): string {
  return (email.trim().charAt(0) || 'S').toUpperCase()
}

export function SettingsView({
  isDesktop = true,
  userEmail,
  balance,
  agentSettings,
  onAgentSettingsChange,
  onClearMemory,
  onRecharge,
  onShowSpendHistory,
  onLogout,
  onImportLocalData,
  onExportLocalData,
}: {
  isDesktop?: boolean
  userEmail: string
  balance?: WalletBalance | null
  agentSettings: Required<AgentSettings>
  onAgentSettingsChange: (next: Required<AgentSettings>) => void
  onClearMemory?: () => Promise<number>
  onRecharge?: () => void
  onShowSpendHistory?: () => void
  onLogout?: () => void
  onImportLocalData: (file?: File) => void
  onExportLocalData?: () => void
}) {
  const { t, locale, setLocale } = useI18n()
  const importInputRef = useRef<HTMLInputElement>(null)
  const [activeSection, setActiveSection] = useState<SettingsSectionID>('account')
  const [clearMemoryConfirmOpen, setClearMemoryConfirmOpen] = useState(false)
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false)
  const [clearingMemory, setClearingMemory] = useState(false)

  const memoryEnabled = (agentSettings.memory ?? 'on') === 'on'
  const skillsEnabled = (agentSettings.skills ?? 'on') === 'on'
  const mcpEnabled = (agentSettings.mcp ?? 'on') === 'on'
  const adv: AdvancedAgentSettings = agentSettings.advanced ?? {}
  const setAdv = (patch: Partial<AdvancedAgentSettings>) =>
    onAgentSettingsChange({ ...agentSettings, advanced: { ...adv, ...patch } })
  const availableCredits = Math.max(0, (balance?.monthly_remaining ?? 0) + (balance?.extra_credits_balance ?? 0))

  const navItems: Array<{ id: SettingsSectionID, label: string }> = [
    { id: 'account', label: t('settings.group.account') },
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
  ]

  const selectSection = (id: SettingsSectionID) => {
    setActiveSection(id)
    document.getElementById(`settings-${id}`)?.scrollIntoView?.({ block: 'start' })
  }

  return (
    <section className="workspace">
      <header className="topbar topbar-page">
        <div className="chat-toolbar-title">
          <span>{t('sidebar.settings')}</span>
        </div>
      </header>

      <div className="skills-scroll">
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
              <SettingsSection id="account" title={t('settings.group.account')}>
                <div className="settings-account-head">
                  <div className="settings-avatar" aria-hidden="true">{displayInitial(userEmail)}</div>
                  <div className="settings-account-copy">
                    <div className="settings-account-email">{userEmail}</div>
                    <div className="settings-account-type">{t('settings.accountType')}</div>
                  </div>
                </div>
                <div className="settings-balance-row">
                  <div>
                    <div className="settings-balance-label">{t('settings.balanceCredits')}</div>
                    <div className="settings-balance-value">{formatCredits(availableCredits)}</div>
                  </div>
                  <div className="settings-account-actions">
                    {onShowSpendHistory ? (
                      <button type="button" className="settings-inline-button" onClick={onShowSpendHistory}>
                        {t('sidebar.account.spendHistory')}
                      </button>
                    ) : null}
                    {onRecharge ? (
                      <button type="button" className="settings-primary-button" onClick={onRecharge}>
                        {t('sidebar.account.recharge')}
                      </button>
                    ) : null}
                  </div>
                </div>
              </SettingsSection>

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
                    <SettingRow label={t('sidebar.agentSettings.advanced.reflect.label')} hint={t('sidebar.agentSettings.advanced.reflect.hint')}>
                      <Switch
                        checked={adv.reflect ?? false}
                        aria-label={t('sidebar.agentSettings.advanced.reflect.label')}
                        onCheckedChange={(checked) => setAdv({ reflect: checked })}
                      />
                    </SettingRow>
                    <SettingRow label={t('sidebar.agentSettings.advanced.toolCritic.label')} hint={t('sidebar.agentSettings.advanced.toolCritic.hint')}>
                      <Select
                        value={adv.toolCritic ?? '__default__'}
                        onValueChange={(value) =>
                          setAdv({ toolCritic: value === '__default__' ? undefined : (value as 'off' | 'watch' | 'nudge' | 'block') })
                        }
                      >
                        <SelectTrigger className="settings-select-trigger" aria-label={t('sidebar.agentSettings.advanced.toolCritic.label')}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__default__">{t('sidebar.agentSettings.advanced.default')}</SelectItem>
                          <SelectItem value="off">off</SelectItem>
                          <SelectItem value="watch">watch</SelectItem>
                          <SelectItem value="nudge">nudge</SelectItem>
                          <SelectItem value="block">block</SelectItem>
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
                          setAdv({ inputGuard: value === '__default__' ? undefined : (value as 'observe' | 'block') })
                        }
                      >
                        <SelectTrigger className="settings-select-trigger" aria-label={t('sidebar.agentSettings.advanced.inputGuard.label')}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__default__">{t('sidebar.agentSettings.advanced.default')}</SelectItem>
                          <SelectItem value="observe">observe</SelectItem>
                          <SelectItem value="block">block</SelectItem>
                        </SelectContent>
                      </Select>
                    </SettingRow>
                    <SettingRow label={t('sidebar.agentSettings.advanced.piiRedact.label')} hint={t('sidebar.agentSettings.advanced.piiRedact.hint')}>
                      <Input
                        type="text"
                        className="settings-text-input"
                        aria-label={t('sidebar.agentSettings.advanced.piiRedact.label')}
                        placeholder="email, credit_card"
                        value={adv.piiRedact ?? ''}
                        onChange={(e) => setAdv({ piiRedact: e.target.value === '' ? undefined : e.target.value })}
                      />
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
                {onLogout ? (
                  <SettingRow
                    label={t('sidebar.account.logout')}
                    hint={t('settings.logoutHint')}
                    danger
                  >
                    <SettingsRowButton danger onClick={() => setLogoutConfirmOpen(true)}>
                      {t('settings.logoutAction')}
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

      {onLogout ? (
        <AlertDialog open={logoutConfirmOpen} onOpenChange={setLogoutConfirmOpen}>
          <AlertDialogContent className="conversation-delete-dialog">
            <AlertDialogHeader className="conversation-delete-header">
              <AlertDialogMedia className="conversation-delete-media">
                <IconLogout aria-hidden="true" />
              </AlertDialogMedia>
              <AlertDialogTitle>{t('sidebar.account.logoutConfirmTitle')}</AlertDialogTitle>
              <AlertDialogDescription>{t('sidebar.account.logoutConfirmBody')}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter className="conversation-delete-footer">
              <AlertDialogCancel variant="outline" autoFocus>
                <span className="conversation-delete-button-label">{t('sidebar.dialog.cancel')}</span>
              </AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={() => {
                  setLogoutConfirmOpen(false)
                  onLogout()
                }}
              >
                <span className="conversation-delete-button-label">{t('sidebar.account.logoutConfirmAction')}</span>
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </section>
  )
}
