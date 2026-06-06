import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  IconAdjustmentsHorizontal,
  IconChevronRight,
  IconDots,
  IconDownload,
  IconLayoutSidebarLeftCollapse,
  IconLoader2,
  IconLogout,
  IconPencil,
  IconPin,
  IconPlus,
  IconServer,
  IconSettings,
  IconTrash,
  IconTool,
  IconUpload,
  IconWorld,
} from '@tabler/icons-react'
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
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
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
import { cn } from '@/lib/utils'
import { useI18n, formatRelativeTime, type Translator } from '@/shared/i18n/i18n'
import type { WalletBalance } from '@/shared/api/client'
import type { AdvancedAgentSettings, AgentSettings } from '@/shared/local-host/client'
import type { Conversation } from '@/shared/local-data/types'

type ConversationSidebarStatus = 'needs_attention' | 'running'

const seenConversationVersionsStorageKey = 'shejane.sidebar.seenConversationVersions.v1'

// One labelled row in the "Advanced" agent-settings section: copy on the left,
// a control (number input / switch / select) on the right. Mirrors the
// `agent-settings-card-row` layout the basic toggles above it use.
function AdvSettingRow({
  label,
  hint,
  className,
  children,
}: {
  label: string
  hint: string
  className?: string
  children: ReactNode
}) {
  return (
    <div className={cn('agent-settings-card-row', className)}>
      <div className="agent-settings-card-copy">
        <div className="agent-settings-card-label">{label}</div>
        <div className="agent-settings-card-hint">{hint}</div>
      </div>
      {children}
    </div>
  )
}

export function ConversationSidebar({
  conversations,
  activeID,
  balance,
  userEmail,
  onNewConversation,
  onSelectConversation,
  onExportConversation,
  onImportLocalData,
  onTogglePinConversation,
  onRenameConversation,
  onDeleteConversation,
  onCollapseSidebar,
  onLogout,
  onOpenSkills,
  onOpenMcp,
  activeView = 'chat',
  agentSettings,
  onAgentSettingsChange,
  onClearMemory,
}: {
  conversations: Conversation[]
  activeID?: string
  balance?: WalletBalance | null
  userEmail: string
  onNewConversation: () => void
  onSelectConversation: (conversationID: string) => void
  onExportConversation: (conversationID: string) => void
  onImportLocalData: (file?: File) => void
  onTogglePinConversation: (conversationID: string) => void
  onRenameConversation: (conversationID: string, title: string) => void
  onDeleteConversation: (conversationID: string) => void
  onCollapseSidebar: () => void
  onLogout?: () => void
  onOpenSkills?: () => void
  onOpenMcp?: () => void
  activeView?: 'chat' | 'skills' | 'mcp'
  agentSettings?: Required<AgentSettings>
  onAgentSettingsChange?: (next: Required<AgentSettings>) => void
  /** Wipe every persisted note in the agent's long-term memory namespace.
   *  Called after the user confirms the destructive prompt; resolves with
   *  the number of notes that were deleted so the toast can be accurate. */
  onClearMemory?: () => Promise<number>
}) {
  const { t, locale, setLocale } = useI18n()
  const importInputRef = useRef<HTMLInputElement>(null)
  const [renameConversationID, setRenameConversationID] = useState<string>()
  const [deleteConversationID, setDeleteConversationID] = useState<string>()
  const [renameTitle, setRenameTitle] = useState('')
  const [seenConversationVersions, setSeenConversationVersions] = useState<Record<string, string>>(readSeenConversationVersions)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [clearMemoryConfirmOpen, setClearMemoryConfirmOpen] = useState(false)
  const [clearingMemory, setClearingMemory] = useState(false)
  // Memory + skills + MCP default ON to match the client default; the
  // daemon also treats a missing `settings.*` as on. Keep both ends
  // aligned.
  const memoryEnabled = (agentSettings?.memory ?? 'on') === 'on'
  const skillsEnabled = (agentSettings?.skills ?? 'on') === 'on'
  const mcpEnabled = (agentSettings?.mcp ?? 'on') === 'on'
  const currentAgentSettings: Required<AgentSettings> = agentSettings ?? {
    memory: 'on',
    skills: 'on',
    mcp: 'on',
    mcpDisabled: [],
    advanced: {},
  }
  // "Advanced" section state. `adv` is the current advanced knobs; `setAdv`
  // merges a patch and bubbles the whole settings object up to be persisted.
  const adv: AdvancedAgentSettings = currentAgentSettings.advanced ?? {}
  const setAdv = (patch: Partial<AdvancedAgentSettings>) =>
    onAgentSettingsChange?.({ ...currentAgentSettings, advanced: { ...adv, ...patch } })
  const searchInputRef = useRef<HTMLInputElement>(null)
  const renameConversation = conversations.find((conversation) => conversation.id === renameConversationID)
  const deleteConversation = conversations.find((conversation) => conversation.id === deleteConversationID)
  const deleteConversationTitle = deleteConversation?.title ?? t('sidebar.dialog.currentConversation')
  const deleteMessageCount = deleteConversation?.messages.length ?? 0
  const activeConversation = conversations.find((conversation) => conversation.id === activeID)
  const normalizedQuery = searchQuery.trim().toLowerCase()
  const matchesQuery = (conversation: Conversation) =>
    !normalizedQuery || conversation.title.toLowerCase().includes(normalizedQuery)
  const pinnedConversations = conversations.filter((conversation) => conversation.pinned && matchesQuery(conversation))
  // Single unified list — projects (workspace-bound conversations) and casual
  // chats live together, sorted by updatedAt desc (handled upstream by
  // LocalConversationStore.list). The composer's project chip is now how
  // users tell a workspace-bound chat apart from a free-form one.
  const recentConversations = conversations.filter(
    (conversation) => !conversation.pinned && matchesQuery(conversation),
  )

  useEffect(() => {
    if (!activeConversation) {
      return
    }
    const version = conversationSidebarVersion(activeConversation)
    if (!version) {
      return
    }
    setSeenConversationVersions((current) => {
      if (current[activeConversation.id] === version) {
        return current
      }
      const next = { ...current, [activeConversation.id]: version }
      writeSeenConversationVersions(next)
      return next
    })
  }, [activeConversation])

  useEffect(() => {
    if (searchOpen) {
      searchInputRef.current?.focus()
    }
  }, [searchOpen])

  function toggleSearch() {
    setSearchOpen((open) => {
      if (open) {
        setSearchQuery('')
      }
      return !open
    })
  }

  function renderConversationRow(conversation: Conversation) {
    return (
      <div className={conversation.id === activeID ? 'conversation-row active' : 'conversation-row'} key={conversation.id}>
        <Button
          className="conversation"
          variant="ghost"
          onClick={() => onSelectConversation(conversation.id)}
        >
          <span>{conversation.title}</span>
        </Button>
        <span className="conversation-time" aria-hidden="true">
          {formatRelativeTime(conversation.updatedAt, locale, t)}
        </span>
        <ConversationStatusIndicator
          status={conversationSidebarStatus(
            conversation,
            conversation.id === activeID,
            seenConversationVersions[conversation.id],
          )}
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              className="conversation-more"
              variant="ghost"
              size="icon-xs"
              title={t('sidebar.moreFor', { title: conversation.title })}
              aria-label={t('sidebar.moreFor', { title: conversation.title })}
            >
              <IconDots size={15} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="conversation-row-menu">
            <DropdownMenuItem onSelect={() => onTogglePinConversation(conversation.id)}>
              <IconPin />
              <span>{conversation.pinned ? t('sidebar.actions.unpin') : t('sidebar.actions.pin')}</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => {
                setRenameConversationID(conversation.id)
                setRenameTitle(conversation.title)
              }}
            >
              <IconPencil />
              <span>{t('sidebar.actions.rename')}</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onExportConversation(conversation.id)}>
              <IconDownload />
              <span>{t('sidebar.dialog.export')}</span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => importInputRef.current?.click()}>
              <IconUpload />
              <span>{t('sidebar.dialog.import')}</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="conversation-row-menu-danger" onSelect={() => setDeleteConversationID(conversation.id)}>
              <IconTrash />
              <span>{t('sidebar.actions.delete')}</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    )
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-window-controls">
        <div className="sidebar-window-actions" aria-label={t('app.windowActions')}>
          <button className="sidebar-window-control-button" type="button" title={t('app.collapseSidebar')} aria-label={t('app.collapseSidebar')} onClick={onCollapseSidebar}>
            <IconLayoutSidebarLeftCollapse aria-hidden="true" />
          </button>
          {/* Search toggle button + the expandable search input panel
           * are hidden for now per product feedback. The underlying
           * state (searchOpen / searchQuery / filter logic) is kept
           * intact so the feature can be re-enabled by restoring just
           * the JSX. See git history for the original implementation. */}
        </div>
      </div>

      <div className="sidebar-section">
        <button
          className="sidebar-item"
          type="button"
          aria-label={t('app.newChat')}
          onClick={onNewConversation}
        >
          <IconPlus size={14} />
          <span>{t('app.newChat')}</span>
          <span className="sidebar-item-hint">⌘N</span>
        </button>
      </div>

      <div className="sidebar-section">
        <div className="sidebar-section-label">{t('sidebar.section.tools')}</div>
        <button
          className={`sidebar-item${activeView === 'skills' ? ' active' : ''}`}
          type="button"
          onClick={() => onOpenSkills?.()}
        >
          <IconTool size={14} />
          <span>{t('sidebar.skills')}</span>
        </button>
        <button
          className={`sidebar-item${activeView === 'mcp' ? ' active' : ''}`}
          type="button"
          onClick={() => onOpenMcp?.()}
        >
          <IconServer size={14} />
          <span>{t('sidebar.mcp')}</span>
        </button>
      </div>

      {pinnedConversations.length ? (
        <div className="sidebar-section pinned-conversation-list">
          <div className="sidebar-section-label">{t('sidebar.pinned')}</div>
          {pinnedConversations.map(renderConversationRow)}
        </div>
      ) : null}

      <div className="sidebar-section conversation-list">
        <div className="sidebar-section-label">{t('sidebar.section.chats')}</div>
        {recentConversations.length ? (
          recentConversations.map(renderConversationRow)
        ) : (
          <div className="sidebar-empty">
            {normalizedQuery ? t('sidebar.searchEmpty') : t('sidebar.empty')}
          </div>
        )}
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className="sidebar-settings-trigger" aria-label={t('sidebar.settings')}>
            <IconSettings size={14} aria-hidden="true" />
            <span>{t('sidebar.settings')}</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" sideOffset={8} className="sidebar-account-menu">
          <div className="sidebar-account-head">
            <span className="sidebar-account-avatar lg">{avatarInitials(userEmail)}</span>
            <div className="sidebar-account-head-copy">
              <div className="sidebar-account-head-email">{userEmail}</div>
            </div>
          </div>
          {balance ? <AccountBalance balance={balance} t={t} /> : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault()
              setSettingsOpen(true)
            }}
          >
            <IconAdjustmentsHorizontal />
            <span>{t('sidebar.account.agentSettings')}</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault()
              setLocale(locale === 'zh' ? 'en' : 'zh')
            }}
          >
            <IconWorld />
            <span>{t('sidebar.account.language')}</span>
            <span className="sidebar-account-item-hint">{locale === 'zh' ? '中文' : 'English'}</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="sidebar-account-menu-danger"
            disabled={!onLogout}
            onSelect={() => onLogout?.()}
          >
            <IconLogout />
            <span>{t('sidebar.account.logout')}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

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
      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="conversation-actions-dialog flex max-h-[85dvh] flex-col gap-3 sm:max-w-[460px]">
          <DialogHeader className="shrink-0">
            <DialogTitle>{t('sidebar.agentSettings.title')}</DialogTitle>
            <DialogDescription>{t('sidebar.agentSettings.description')}</DialogDescription>
          </DialogHeader>
          <div className="-mx-1 min-h-0 overflow-y-auto px-1">
            <div className="agent-settings-card">
              <AdvSettingRow
                label={t('sidebar.agentSettings.memory.label')}
                hint={t('sidebar.agentSettings.memory.hint')}
              >
                <Switch
                  checked={memoryEnabled}
                  aria-label={t('sidebar.agentSettings.memory.label')}
                  onCheckedChange={(checked) =>
                    onAgentSettingsChange?.({
                      ...currentAgentSettings,
                      memory: checked ? 'on' : 'off',
                    })
                  }
                />
              </AdvSettingRow>
              <AdvSettingRow
                label={t('sidebar.agentSettings.skills.label')}
                hint={t('sidebar.agentSettings.skills.hint')}
              >
                <Switch
                  checked={skillsEnabled}
                  aria-label={t('sidebar.agentSettings.skills.label')}
                  onCheckedChange={(checked) =>
                    onAgentSettingsChange?.({
                      ...currentAgentSettings,
                      skills: checked ? 'on' : 'off',
                    })
                  }
                />
              </AdvSettingRow>
              <AdvSettingRow
                label={t('sidebar.agentSettings.mcp.label')}
                hint={t('sidebar.agentSettings.mcp.hint')}
              >
                <Switch
                  checked={mcpEnabled}
                  aria-label={t('sidebar.agentSettings.mcp.label')}
                  onCheckedChange={(checked) =>
                    onAgentSettingsChange?.({
                      ...currentAgentSettings,
                      mcp: checked ? 'on' : 'off',
                    })
                  }
                />
              </AdvSettingRow>
            <Collapsible className="agent-settings-advanced">
              <CollapsibleTrigger className="group flex w-full items-center justify-between gap-2 bg-transparent px-4 py-3 text-left text-sm font-semibold text-[var(--text-primary)] outline-none transition-colors hover:bg-black/[0.02] focus-visible:bg-black/[0.03]">
                <span>{t('sidebar.agentSettings.advanced.title')}</span>
                <IconChevronRight
                  size={15}
                  className="shrink-0 text-[var(--text-tertiary)] transition-transform duration-150 group-data-[state=open]:rotate-90"
                  aria-hidden="true"
                />
              </CollapsibleTrigger>
              <CollapsibleContent>
                <p className="agent-settings-advanced-desc">
                  {t('sidebar.agentSettings.advanced.description')}
                </p>
                <div className="agent-settings-advanced-body">
                  <div className="agent-settings-group">{t('sidebar.agentSettings.advanced.group.run')}</div>

                  <AdvSettingRow
                    label={t('sidebar.agentSettings.advanced.maxModelCalls.label')}
                    hint={t('sidebar.agentSettings.advanced.maxModelCalls.hint')}
                  >
                    <Input
                      type="number"
                      inputMode="numeric"
                      min={1}
                      className="h-8 w-16 text-right tabular-nums"
                      aria-label={t('sidebar.agentSettings.advanced.maxModelCalls.label')}
                      placeholder="20"
                      value={adv.maxModelCalls ?? ''}
                      onChange={(e) => {
                        const n = Number(e.target.value)
                        setAdv({
                          maxModelCalls: e.target.value === '' || !Number.isFinite(n) ? undefined : n,
                        })
                      }}
                    />
                  </AdvSettingRow>

                  <AdvSettingRow
                    label={t('sidebar.agentSettings.advanced.maxToolRetries.label')}
                    hint={t('sidebar.agentSettings.advanced.maxToolRetries.hint')}
                  >
                    <Input
                      type="number"
                      inputMode="numeric"
                      min={0}
                      className="h-8 w-16 text-right tabular-nums"
                      aria-label={t('sidebar.agentSettings.advanced.maxToolRetries.label')}
                      placeholder="2"
                      value={adv.maxToolRetries ?? ''}
                      onChange={(e) => {
                        const n = Number(e.target.value)
                        setAdv({
                          maxToolRetries: e.target.value === '' || !Number.isFinite(n) ? undefined : n,
                        })
                      }}
                    />
                  </AdvSettingRow>

                  <AdvSettingRow
                    label={t('sidebar.agentSettings.advanced.toolSelectorMax.label')}
                    hint={t('sidebar.agentSettings.advanced.toolSelectorMax.hint')}
                  >
                    <Input
                      type="number"
                      inputMode="numeric"
                      min={0}
                      className="h-8 w-16 text-right tabular-nums"
                      aria-label={t('sidebar.agentSettings.advanced.toolSelectorMax.label')}
                      placeholder="0"
                      value={adv.toolSelectorMax ?? ''}
                      onChange={(e) => {
                        const n = Number(e.target.value)
                        setAdv({
                          toolSelectorMax: e.target.value === '' || !Number.isFinite(n) ? undefined : n,
                        })
                      }}
                    />
                  </AdvSettingRow>

                  <div className="agent-settings-group">{t('sidebar.agentSettings.advanced.group.quality')}</div>

                  <AdvSettingRow
                    label={t('sidebar.agentSettings.advanced.planFirst.label')}
                    hint={t('sidebar.agentSettings.advanced.planFirst.hint')}
                  >
                    <Select
                      value={adv.planFirst ?? '__default__'}
                      onValueChange={(value) =>
                        setAdv({
                          planFirst:
                            value === '__default__' ? undefined : (value as 'off' | 'auto' | 'always'),
                        })
                      }
                    >
                      <SelectTrigger
                        className="w-[136px]"
                        aria-label={t('sidebar.agentSettings.advanced.planFirst.label')}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__default__">{t('sidebar.agentSettings.advanced.default')}</SelectItem>
                        <SelectItem value="off">off</SelectItem>
                        <SelectItem value="auto">auto</SelectItem>
                        <SelectItem value="always">always</SelectItem>
                      </SelectContent>
                    </Select>
                  </AdvSettingRow>

                  <AdvSettingRow
                    label={t('sidebar.agentSettings.advanced.reflect.label')}
                    hint={t('sidebar.agentSettings.advanced.reflect.hint')}
                  >
                    <Switch
                      checked={adv.reflect ?? false}
                      aria-label={t('sidebar.agentSettings.advanced.reflect.label')}
                      onCheckedChange={(checked) => setAdv({ reflect: checked })}
                    />
                  </AdvSettingRow>

                  <AdvSettingRow
                    label={t('sidebar.agentSettings.advanced.toolCritic.label')}
                    hint={t('sidebar.agentSettings.advanced.toolCritic.hint')}
                  >
                    <Select
                      value={adv.toolCritic ?? '__default__'}
                      onValueChange={(value) =>
                        setAdv({
                          toolCritic:
                            value === '__default__'
                              ? undefined
                              : (value as 'off' | 'watch' | 'nudge' | 'block'),
                        })
                      }
                    >
                      <SelectTrigger
                        className="w-[136px]"
                        aria-label={t('sidebar.agentSettings.advanced.toolCritic.label')}
                      >
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
                  </AdvSettingRow>

                  <div className="agent-settings-group">{t('sidebar.agentSettings.advanced.group.capability')}</div>

                  <AdvSettingRow
                    label={t('sidebar.agentSettings.advanced.subagents.label')}
                    hint={t('sidebar.agentSettings.advanced.subagents.hint')}
                  >
                    <Switch
                      checked={adv.subagents ?? true}
                      aria-label={t('sidebar.agentSettings.advanced.subagents.label')}
                      onCheckedChange={(checked) => setAdv({ subagents: checked })}
                    />
                  </AdvSettingRow>

                  <AdvSettingRow
                    label={t('sidebar.agentSettings.advanced.browserHeadless.label')}
                    hint={t('sidebar.agentSettings.advanced.browserHeadless.hint')}
                  >
                    <Switch
                      checked={adv.browserHeadless ?? true}
                      aria-label={t('sidebar.agentSettings.advanced.browserHeadless.label')}
                      onCheckedChange={(checked) => setAdv({ browserHeadless: checked })}
                    />
                  </AdvSettingRow>

                  <AdvSettingRow
                    label={t('sidebar.agentSettings.advanced.inputGuard.label')}
                    hint={t('sidebar.agentSettings.advanced.inputGuard.hint')}
                  >
                    <Select
                      value={adv.inputGuard ?? '__default__'}
                      onValueChange={(value) =>
                        setAdv({
                          inputGuard:
                            value === '__default__' ? undefined : (value as 'observe' | 'block'),
                        })
                      }
                    >
                      <SelectTrigger
                        className="w-[136px]"
                        aria-label={t('sidebar.agentSettings.advanced.inputGuard.label')}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__default__">{t('sidebar.agentSettings.advanced.default')}</SelectItem>
                        <SelectItem value="observe">observe</SelectItem>
                        <SelectItem value="block">block</SelectItem>
                      </SelectContent>
                    </Select>
                  </AdvSettingRow>

                  <AdvSettingRow
                    label={t('sidebar.agentSettings.advanced.piiRedact.label')}
                    hint={t('sidebar.agentSettings.advanced.piiRedact.hint')}
                  >
                    <Input
                      type="text"
                      className="h-8 w-[150px]"
                      aria-label={t('sidebar.agentSettings.advanced.piiRedact.label')}
                      placeholder="email, credit_card"
                      value={adv.piiRedact ?? ''}
                      onChange={(e) => setAdv({ piiRedact: e.target.value === '' ? undefined : e.target.value })}
                    />
                  </AdvSettingRow>
                </div>
              </CollapsibleContent>
            </Collapsible>
            {onClearMemory && (
              <div className="agent-settings-card-row">
                <div className="agent-settings-card-copy">
                  <div className="agent-settings-card-label">{t('sidebar.agentSettings.memory.clearAction')}</div>
                  <div className="agent-settings-card-hint">{t('sidebar.agentSettings.memory.clearHint')}</div>
                </div>
                <Button
                  type="button"
                  size="sm"
                  className="agent-settings-reset-btn"
                  disabled={clearingMemory}
                  onClick={() => setClearMemoryConfirmOpen(true)}
                >
                  {clearingMemory ? (
                    <IconLoader2 size={14} className="animate-spin" aria-hidden="true" />
                  ) : null}
                  <span>{t('sidebar.agentSettings.memory.clearButton')}</span>
                </Button>
              </div>
            )}
            </div>
          </div>
          <DialogFooter className="shrink-0">
            <Button type="button" onClick={() => setSettingsOpen(false)}>
              {t('sidebar.agentSettings.done')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={Boolean(renameConversation)} onOpenChange={(open) => !open && setRenameConversationID(undefined)}>
        <DialogContent className="conversation-actions-dialog sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>{t('sidebar.rename.title')}</DialogTitle>
            <DialogDescription>
              {t('sidebar.rename.description', { title: renameConversation?.title ?? t('sidebar.dialog.currentConversation') })}
            </DialogDescription>
          </DialogHeader>
          <form
            className="conversation-action-form"
            onSubmit={(event) => {
              event.preventDefault()
              if (!renameConversation || !renameTitle.trim()) {
                return
              }
              onRenameConversation(renameConversation.id, renameTitle.trim())
              setRenameConversationID(undefined)
            }}
          >
            <label htmlFor="conversation-rename-input">{t('sidebar.rename.nameLabel')}</label>
            <Input
              id="conversation-rename-input"
              value={renameTitle}
              onChange={(event) => setRenameTitle(event.currentTarget.value)}
            />
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setRenameConversationID(undefined)}>
                {t('sidebar.dialog.close')}
              </Button>
              <Button type="submit" disabled={!renameTitle.trim()}>
                {t('sidebar.rename.save')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <AlertDialog open={clearMemoryConfirmOpen} onOpenChange={setClearMemoryConfirmOpen}>
        <AlertDialogContent className="conversation-delete-dialog">
          <AlertDialogHeader className="conversation-delete-header">
            <AlertDialogMedia className="conversation-delete-media">
              <IconTrash aria-hidden="true" />
            </AlertDialogMedia>
            <AlertDialogTitle>{t('sidebar.agentSettings.memory.clearConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('sidebar.agentSettings.memory.clearConfirmBody')}
            </AlertDialogDescription>
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
      <AlertDialog open={Boolean(deleteConversation)} onOpenChange={(open) => !open && setDeleteConversationID(undefined)}>
        <AlertDialogContent className="conversation-delete-dialog">
          <AlertDialogHeader className="conversation-delete-header">
            <AlertDialogMedia className="conversation-delete-media">
              <IconTrash aria-hidden="true" />
            </AlertDialogMedia>
            <AlertDialogTitle>{t('sidebar.delete.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              <strong>{deleteConversationTitle}</strong>
              {t('sidebar.delete.descriptionAfterTitle', { count: deleteMessageCount })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="conversation-delete-footer">
            <AlertDialogCancel variant="outline" autoFocus onClick={() => setDeleteConversationID(undefined)}>
              <span className="conversation-delete-button-label">{t('sidebar.dialog.cancel')}</span>
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={!deleteConversation}
              onClick={() => {
                if (deleteConversation) {
                  onDeleteConversation(deleteConversation.id)
                  setDeleteConversationID(undefined)
                }
              }}
            >
              <span className="conversation-delete-button-label">{t('sidebar.delete.confirm')}</span>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </aside>
  )
}

function ConversationStatusIndicator({ status }: { status: ConversationSidebarStatus | null }) {
  const { t } = useI18n()
  if (status === 'running') {
    return (
      <span className="conversation-status-slot conversation-status-loading" role="status" aria-label={t('sidebar.status.running')}>
        <IconLoader2 size={14} aria-hidden="true" />
      </span>
    )
  }
  if (status === 'needs_attention') {
    return <span className="conversation-status-slot conversation-status-attention" role="status" aria-label={t('sidebar.status.needsAttention')} />
  }
  return <span className="conversation-status-slot" aria-hidden="true" />
}

function conversationSidebarStatus(conversation: Conversation, isActive: boolean, seenVersion?: string): ConversationSidebarStatus | null {
  const latestAssistant = [...conversation.messages].reverse().find((message) => message.role === 'assistant')
  if (!latestAssistant) {
    return null
  }
  if (latestAssistant.status === 'streaming' || latestAssistant.status === 'pending') {
    return 'running'
  }
  const currentVersion = conversationSidebarVersion(conversation)
  if (!isActive && currentVersion !== seenVersion && (latestAssistant.status === 'done' || latestAssistant.status === 'waiting_permission')) {
    return 'needs_attention'
  }
  return null
}

function conversationSidebarVersion(conversation: Conversation): string {
  const latestAssistant = [...conversation.messages].reverse().find((message) => message.role === 'assistant')
  if (!latestAssistant) {
    return ''
  }
  return [
    latestAssistant.id,
    latestAssistant.status,
    latestAssistant.content.length,
    latestAssistant.agentEvents?.length ?? 0,
    conversation.updatedAt,
  ].join(':')
}

function readSeenConversationVersions(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(seenConversationVersionsStorageKey)
    if (!raw) {
      return {}
    }
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}
    }
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    )
  } catch {
    return {}
  }
}

function writeSeenConversationVersions(value: Record<string, string>) {
  try {
    window.localStorage.setItem(seenConversationVersionsStorageKey, JSON.stringify(value))
  } catch {
    // Ignore storage failures; the in-memory state still keeps the current session correct.
  }
}

function avatarInitials(email: string): string {
  const label = email.trim().split('@')[0] || 'JD'
  return label.slice(0, 2).toUpperCase()
}

function formatCredits(value: number): string {
  return Math.max(0, Math.round(value)).toLocaleString()
}

function AccountBalance({ balance, t }: { balance: WalletBalance; t: Translator }) {
  // The monthly-subscription quota line (`creditsMonthly` /
  // `creditsUnlimited`) is hidden — product direction moved away from
  // a monthly plan. The pay-as-you-go `extra_credits_balance` is the
  // only balance worth showing now. Keep the wallet fields and i18n
  // strings around so the line can be restored if that changes.
  const extra = Math.max(0, balance.extra_credits_balance ?? 0)
  if (extra <= 0) {
    return null
  }
  return (
    <div className="sidebar-account-balance">
      <span className="sab-line">{t('sidebar.account.creditsExtra', { extra: formatCredits(extra) })}</span>
    </div>
  )
}
