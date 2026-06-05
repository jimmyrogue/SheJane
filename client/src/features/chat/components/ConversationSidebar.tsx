import { useEffect, useRef, useState } from 'react'
import {
  IconAdjustmentsHorizontal,
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
import { useI18n, formatRelativeTime, type Translator } from '@/shared/i18n/i18n'
import type { WalletBalance } from '@/shared/api/client'
import type { AgentSettings } from '@/shared/local-host/client'
import type { Conversation } from '@/shared/local-data/types'

type ConversationSidebarStatus = 'needs_attention' | 'running'

const seenConversationVersionsStorageKey = 'shejane.sidebar.seenConversationVersions.v1'

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
  }
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
        <DialogContent className="conversation-actions-dialog sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>{t('sidebar.agentSettings.title')}</DialogTitle>
            <DialogDescription>{t('sidebar.agentSettings.description')}</DialogDescription>
          </DialogHeader>
          <div className="agent-settings-card">
            <div className="agent-settings-card-row">
              <div className="agent-settings-card-copy">
                <div className="agent-settings-card-label">{t('sidebar.agentSettings.memory.label')}</div>
                <div className="agent-settings-card-hint">{t('sidebar.agentSettings.memory.hint')}</div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={memoryEnabled}
                aria-label={t('sidebar.agentSettings.memory.label')}
                className="agent-settings-switch"
                onClick={() =>
                  onAgentSettingsChange?.({
                    ...currentAgentSettings,
                    memory: memoryEnabled ? 'off' : 'on',
                  })
                }
              />
            </div>
            <div className="agent-settings-card-row">
              <div className="agent-settings-card-copy">
                <div className="agent-settings-card-label">{t('sidebar.agentSettings.skills.label')}</div>
                <div className="agent-settings-card-hint">{t('sidebar.agentSettings.skills.hint')}</div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={skillsEnabled}
                aria-label={t('sidebar.agentSettings.skills.label')}
                className="agent-settings-switch"
                onClick={() =>
                  onAgentSettingsChange?.({
                    ...currentAgentSettings,
                    skills: skillsEnabled ? 'off' : 'on',
                  })
                }
              />
            </div>
            <div className="agent-settings-card-row">
              <div className="agent-settings-card-copy">
                <div className="agent-settings-card-label">{t('sidebar.agentSettings.mcp.label')}</div>
                <div className="agent-settings-card-hint">{t('sidebar.agentSettings.mcp.hint')}</div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={mcpEnabled}
                aria-label={t('sidebar.agentSettings.mcp.label')}
                className="agent-settings-switch"
                onClick={() =>
                  onAgentSettingsChange?.({
                    ...currentAgentSettings,
                    mcp: mcpEnabled ? 'off' : 'on',
                  })
                }
              />
            </div>
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
          <DialogFooter>
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
