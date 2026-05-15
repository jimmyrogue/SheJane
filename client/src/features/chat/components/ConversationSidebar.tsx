import { useEffect, useRef, useState } from 'react'
import {
  IconChevronDown,
  IconDots,
  IconDownload,
  IconFolderPlus,
  IconFolderOpen,
  IconFolders,
  IconHistory,
  IconLayoutSidebarLeftCollapse,
  IconLoader2,
  IconLogout,
  IconMessageCircle,
  IconPencil,
  IconPin,
  IconPlus,
  IconSearch,
  IconTrash,
  IconTool,
  IconUpload,
  IconWorld,
  IconX,
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
import type { Conversation } from '@/shared/local-data/types'

type ConversationSidebarStatus = 'needs_attention' | 'running'

const seenConversationVersionsStorageKey = 'jiandanly.sidebar.seenConversationVersions.v1'

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
  onAddConversationToProject,
  onDeleteConversation,
  onCollapseSidebar,
  onLogout,
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
  onAddConversationToProject: (conversationID: string, projectName: string) => void
  onDeleteConversation: (conversationID: string) => void
  onCollapseSidebar: () => void
  onLogout?: () => void
}) {
  const { t, locale, setLocale } = useI18n()
  const importInputRef = useRef<HTMLInputElement>(null)
  const [renameConversationID, setRenameConversationID] = useState<string>()
  const [projectConversationID, setProjectConversationID] = useState<string>()
  const [deleteConversationID, setDeleteConversationID] = useState<string>()
  const [renameTitle, setRenameTitle] = useState('')
  const [projectName, setProjectName] = useState('')
  const [seenConversationVersions, setSeenConversationVersions] = useState<Record<string, string>>(readSeenConversationVersions)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)
  const renameConversation = conversations.find((conversation) => conversation.id === renameConversationID)
  const projectConversation = conversations.find((conversation) => conversation.id === projectConversationID)
  const deleteConversation = conversations.find((conversation) => conversation.id === deleteConversationID)
  const deleteConversationTitle = deleteConversation?.title ?? t('sidebar.dialog.currentConversation')
  const deleteMessageCount = deleteConversation?.messages.length ?? 0
  const activeConversation = conversations.find((conversation) => conversation.id === activeID)
  const normalizedQuery = searchQuery.trim().toLowerCase()
  const matchesQuery = (conversation: Conversation) =>
    !normalizedQuery || conversation.title.toLowerCase().includes(normalizedQuery)
  const pinnedConversations = conversations.filter((conversation) => conversation.pinned && matchesQuery(conversation))
  const recentConversations = conversations.filter((conversation) => !conversation.pinned && matchesQuery(conversation))

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
            <DropdownMenuItem
              onSelect={() => {
                setProjectConversationID(conversation.id)
                setProjectName(conversation.project?.name ?? '')
              }}
            >
              <IconFolderPlus />
              <span>{t('sidebar.actions.addToProject')}</span>
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
          <button
            className={searchOpen ? 'sidebar-window-control-button active' : 'sidebar-window-control-button'}
            type="button"
            title={t('app.search')}
            aria-label={t('app.search')}
            aria-pressed={searchOpen}
            onClick={toggleSearch}
          >
            <IconSearch aria-hidden="true" />
          </button>
        </div>
      </div>

      {searchOpen ? (
        <div className="sidebar-search">
          <IconSearch className="sidebar-search-icon" size={14} aria-hidden="true" />
          <Input
            ref={searchInputRef}
            type="search"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                toggleSearch()
              }
            }}
            placeholder={t('sidebar.searchPlaceholder')}
            aria-label={t('app.search')}
          />
          {searchQuery ? (
            <button
              type="button"
              className="sidebar-search-clear"
              title={t('sidebar.searchClear')}
              aria-label={t('sidebar.searchClear')}
              onClick={() => {
                setSearchQuery('')
                searchInputRef.current?.focus()
              }}
            >
              <IconX size={13} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      ) : null}

      <Button className="sidebar-newchat" aria-label={t('app.newChat')} onClick={onNewConversation}>
        <IconPlus size={15} />
        <span>{t('app.newChat')}</span>
        <span className="kbd">⌘N</span>
      </Button>

      <div className="sidebar-section">
        <div className="sidebar-section-label">{t('sidebar.workspace')}</div>
        <button className="sidebar-item active" type="button">
          <IconMessageCircle size={14} />
          <span>{t('sidebar.chats')}</span>
        </button>
        <button className="sidebar-item" type="button">
          <IconTool size={14} />
          <span>{t('sidebar.tools')}</span>
          <span className="badge">{conversations.length || 1}</span>
        </button>
        <button className="sidebar-item" type="button">
          <IconFolders size={14} />
          <span>{t('sidebar.projects')}</span>
        </button>
        <button className="sidebar-item" type="button">
          <IconHistory size={14} />
          <span>{t('sidebar.history')}</span>
        </button>
      </div>

      {pinnedConversations.length ? (
        <div className="sidebar-section pinned-conversation-list">
          <div className="sidebar-section-label">{t('sidebar.pinned')}</div>
          {pinnedConversations.map(renderConversationRow)}
        </div>
      ) : null}

      <div className="sidebar-section conversation-list">
        <div className="sidebar-section-label">{t('sidebar.recent')}</div>
        {recentConversations.length ? (
          recentConversations.map(renderConversationRow)
        ) : (
          <div className="sidebar-empty">
            {normalizedQuery
              ? t('sidebar.searchEmpty')
              : conversations.length
                ? t('sidebar.emptyRecent')
                : t('sidebar.empty')}
          </div>
        )}
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className="sidebar-account" aria-label={t('sidebar.account.menu')}>
            <span className="sidebar-account-avatar">{avatarInitials(userEmail)}</span>
            <span className="sidebar-account-meta">
              <span className="sidebar-account-name">{accountName(userEmail) || t('app.productName')}</span>
              <span className="sidebar-account-dot" aria-hidden="true">·</span>
              <span className="sidebar-account-plan">{planLabel(balance, t)}</span>
            </span>
            <IconChevronDown size={14} className="sidebar-account-caret" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" sideOffset={8} className="sidebar-account-menu">
          <div className="sidebar-account-head">
            <span className="sidebar-account-avatar lg">{avatarInitials(userEmail)}</span>
            <div className="sidebar-account-head-copy">
              <div className="sidebar-account-head-email">{userEmail}</div>
              <div className="sidebar-account-head-plan">{planLabel(balance, t)}</div>
            </div>
          </div>
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
      <Dialog open={Boolean(projectConversation)} onOpenChange={(open) => !open && setProjectConversationID(undefined)}>
        <DialogContent className="conversation-actions-dialog sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>{t('sidebar.project.title')}</DialogTitle>
            <DialogDescription>
              {t('sidebar.project.description', { title: projectConversation?.title ?? t('sidebar.dialog.currentConversation') })}
            </DialogDescription>
          </DialogHeader>
          <form
            className="conversation-action-form"
            onSubmit={(event) => {
              event.preventDefault()
              if (!projectConversation || !projectName.trim()) {
                return
              }
              onAddConversationToProject(projectConversation.id, projectName.trim())
              setProjectConversationID(undefined)
            }}
          >
            <label htmlFor="conversation-project-input">{t('sidebar.project.nameLabel')}</label>
            <Input
              id="conversation-project-input"
              value={projectName}
              onChange={(event) => setProjectName(event.currentTarget.value)}
            />
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setProjectConversationID(undefined)}>
                {t('sidebar.dialog.close')}
              </Button>
              <Button type="submit" disabled={!projectName.trim()}>
                {t('sidebar.project.save')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
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

function accountName(email: string): string {
  return email.trim().split('@')[0] ?? ''
}

function planLabel(balance: WalletBalance | null | undefined, t: Translator): string {
  if (!balance) {
    return t('sidebar.localFirst')
  }
  const code = (balance.plan_code ?? 'free').trim()
  return code.charAt(0).toUpperCase() + code.slice(1)
}
