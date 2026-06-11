import { useRef, useState, type ReactNode } from 'react'
import { IconChevronRight, IconLogout, IconTrash } from '@tabler/icons-react'
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
import { Switch } from '@/components/ui/switch'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useI18n } from '@/shared/i18n/i18n'
import type { WalletBalance } from '@/shared/api/client'
import type { AdvancedAgentSettings, AgentSettings } from '@/shared/local-host/client'

/** One settings row: copy on the left (label + optional hint), a control or
 *  value on the right. Mirrors the v4 prototype's SjpSetRow (label flex:1,
 *  bottom hairline). */
function SettingRow({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children?: ReactNode
}) {
  return (
    <div className="settings-row">
      <div className="settings-row-copy">
        <div className="settings-row-label">{label}</div>
        {hint ? <div className="settings-row-hint">{hint}</div> : null}
      </div>
      {children ? <div className="settings-row-control">{children}</div> : null}
    </div>
  )
}

function SettingGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="settings-group">
      <div className="settings-group-label">{label}</div>
      {children}
    </section>
  )
}

/** A whole tappable row (the prototype's 模型 / 语言 / 导出 rows): label on the
 *  left, a value or chevron on the right, the entire row is the button. Avoids
 *  the redundant "label + same-text button" pairing. */
function SettingActionRow({
  label,
  hint,
  value,
  danger,
  onClick,
}: {
  label: string
  hint?: string
  value?: string
  danger?: boolean
  onClick: () => void
}) {
  return (
    <button type="button" className={`settings-row settings-action${danger ? ' settings-danger' : ''}`} onClick={onClick}>
      <div className="settings-row-copy">
        <div className="settings-row-label">{label}</div>
        {hint ? <div className="settings-row-hint">{hint}</div> : null}
      </div>
      {value ? (
        <span className="settings-row-value">{value}</span>
      ) : (
        <IconChevronRight size={15} className="settings-row-chevron" aria-hidden="true" />
      )}
    </button>
  )
}

function formatCredits(value: number): string {
  return Math.max(0, Math.round(value)).toLocaleString()
}

/**
 * The 设置 main view — a full page (not a dropdown/dialog) matching the v4
 * prototype's PageShell. Consolidates what used to live in the sidebar account
 * menu (account / billing / language / logout) and the Agent-settings dialog
 * (memory / skills / MCP + advanced run knobs) into grouped rows.
 */
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
}) {
  const { t, locale, setLocale } = useI18n()
  const importInputRef = useRef<HTMLInputElement>(null)
  const [clearMemoryConfirmOpen, setClearMemoryConfirmOpen] = useState(false)
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false)
  const [clearingMemory, setClearingMemory] = useState(false)

  const memoryEnabled = (agentSettings.memory ?? 'on') === 'on'
  const skillsEnabled = (agentSettings.skills ?? 'on') === 'on'
  const mcpEnabled = (agentSettings.mcp ?? 'on') === 'on'
  const adv: AdvancedAgentSettings = agentSettings.advanced ?? {}
  const setAdv = (patch: Partial<AdvancedAgentSettings>) =>
    onAgentSettingsChange({ ...agentSettings, advanced: { ...adv, ...patch } })

  const extraCredits = Math.max(0, balance?.extra_credits_balance ?? 0)

  return (
    <section className="workspace">
      <header className="topbar topbar-page">
        <div className="chat-toolbar-title">
          <span>{t('sidebar.settings')}</span>
        </div>
      </header>

      <div className="skills-scroll">
        <div className="settings-content">
          <SettingGroup label={t('settings.group.account')}>
            <SettingRow label={userEmail} />
            {extraCredits > 0 ? (
              <SettingRow label={t('settings.balance')}>
                <span className="settings-row-value">
                  {t('sidebar.account.creditsExtra', { extra: formatCredits(extraCredits) })}
                </span>
              </SettingRow>
            ) : null}
            {onRecharge ? <SettingActionRow label={t('sidebar.account.recharge')} onClick={onRecharge} /> : null}
            {onShowSpendHistory ? (
              <SettingActionRow label={t('sidebar.account.spendHistory')} onClick={onShowSpendHistory} />
            ) : null}
          </SettingGroup>

          <SettingGroup label={t('settings.group.agent')}>
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

                <Collapsible className="settings-advanced">
                  <CollapsibleTrigger className="settings-advanced-trigger group">
                    <span>{t('sidebar.agentSettings.advanced.title')}</span>
                    <IconChevronRight
                      size={15}
                      className="shrink-0 text-[var(--text-tertiary)] transition-transform duration-150 group-data-[state=open]:rotate-90"
                      aria-hidden="true"
                    />
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <p className="settings-advanced-desc">{t('sidebar.agentSettings.advanced.description')}</p>

                    <div className="settings-advanced-sub">{t('sidebar.agentSettings.advanced.group.run')}</div>
                    {(
                      [
                        ['maxModelCalls', 1, 100, '20'],
                        ['maxHistoryTurns', 1, 200, '40'],
                        ['maxModelRetries', 0, 5, '2'],
                        ['maxToolRetries', 0, 5, '2'],
                        ['researchSearchLimit', 1, 20, '3'],
                        ['toolSelectorMax', 0, 50, '0'],
                      ] as const
                    ).map(([key, min, max, ph]) => (
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
                          className="h-8 w-16 text-right tabular-nums"
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

                    <div className="settings-advanced-sub">{t('sidebar.agentSettings.advanced.group.quality')}</div>
                    <SettingRow label={t('sidebar.agentSettings.advanced.planFirst.label')} hint={t('sidebar.agentSettings.advanced.planFirst.hint')}>
                      <Select
                        value={adv.planFirst ?? '__default__'}
                        onValueChange={(value) =>
                          setAdv({ planFirst: value === '__default__' ? undefined : (value as 'off' | 'auto' | 'always') })
                        }
                      >
                        <SelectTrigger className="w-[136px]" aria-label={t('sidebar.agentSettings.advanced.planFirst.label')}>
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
                        <SelectTrigger className="w-[136px]" aria-label={t('sidebar.agentSettings.advanced.toolCritic.label')}>
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

                    <div className="settings-advanced-sub">{t('sidebar.agentSettings.advanced.group.capability')}</div>
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
                        <SelectTrigger className="w-[136px]" aria-label={t('sidebar.agentSettings.advanced.inputGuard.label')}>
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
                        className="h-8 w-[150px]"
                        aria-label={t('sidebar.agentSettings.advanced.piiRedact.label')}
                        placeholder="email, credit_card"
                        value={adv.piiRedact ?? ''}
                        onChange={(e) => setAdv({ piiRedact: e.target.value === '' ? undefined : e.target.value })}
                      />
                    </SettingRow>
                  </CollapsibleContent>
                </Collapsible>
              </>
            ) : null}

          </SettingGroup>

          <SettingGroup label={t('settings.group.general')}>
            <SettingActionRow
              label={t('settings.language')}
              value={locale === 'zh' ? '中文' : 'English'}
              onClick={() => setLocale(locale === 'zh' ? 'en' : 'zh')}
            />
          </SettingGroup>

          <SettingGroup label={t('settings.group.data')}>
            <SettingActionRow
              label={t('settings.import')}
              hint={t('settings.importHint')}
              onClick={() => importInputRef.current?.click()}
            />
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
          </SettingGroup>

          {onClearMemory || onLogout ? (
            <SettingGroup label={t('settings.group.accountSecurity')}>
              {onClearMemory ? (
                <SettingActionRow
                  label={t('sidebar.agentSettings.memory.clearAction')}
                  hint={t('sidebar.agentSettings.memory.clearHint')}
                  danger
                  onClick={() => setClearMemoryConfirmOpen(true)}
                />
              ) : null}
              {onLogout ? (
                <SettingActionRow
                  label={t('sidebar.account.logout')}
                  danger
                  onClick={() => setLogoutConfirmOpen(true)}
                />
              ) : null}
            </SettingGroup>
          ) : null}
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
