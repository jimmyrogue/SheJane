import { useRef, useState } from 'react'
import {
  IconDots,
  IconDownload,
  IconFolderOpen,
  IconFolders,
  IconHistory,
  IconMessageCircle,
  IconPlus,
  IconSettings,
  IconTool,
  IconUpload,
} from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useI18n } from '@/shared/i18n/i18n'
import type { WalletBalance } from '@/shared/api/client'
import type { Conversation } from '@/shared/local-data/types'

export function ConversationSidebar({
  conversations,
  activeID,
  balance,
  userEmail,
  onNewConversation,
  onSelectConversation,
  onExportConversation,
  onImportLocalData,
}: {
  conversations: Conversation[]
  activeID?: string
  balance?: WalletBalance | null
  userEmail: string
  onNewConversation: () => void
  onSelectConversation: (conversationID: string) => void
  onExportConversation: (conversationID: string) => void
  onImportLocalData: (file?: File) => void
}) {
  const { t } = useI18n()
  const importInputRef = useRef<HTMLInputElement>(null)
  const [actionConversationID, setActionConversationID] = useState<string>()
  const actionConversation = conversations.find((conversation) => conversation.id === actionConversationID)

  return (
    <aside className="sidebar">
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

      <div className="sidebar-section conversation-list">
        <div className="sidebar-section-label">{t('sidebar.recent')}</div>
        {conversations.length ? (
          conversations.map((conversation) => (
            <div className={conversation.id === activeID ? 'conversation-row active' : 'conversation-row'} key={conversation.id}>
              <Button
                className="conversation"
                variant="ghost"
                onClick={() => onSelectConversation(conversation.id)}
              >
                <span>{conversation.title}</span>
              </Button>
              <Button
                className="conversation-more"
                variant="ghost"
                size="icon-xs"
                title={t('sidebar.moreFor', { title: conversation.title })}
                aria-label={t('sidebar.moreFor', { title: conversation.title })}
                onClick={() => setActionConversationID(conversation.id)}
              >
                <IconDots size={15} />
              </Button>
            </div>
          ))
        ) : (
          <div className="sidebar-empty">{t('sidebar.empty')}</div>
        )}
      </div>

      <div className="sidebar-footer">
        <div className="avatar">{avatarInitials(userEmail)}</div>
        <div className="sidebar-footer-copy">
          <div className="name">{userEmail.split('@')[0] || 'Jiandanly'}</div>
          <div className="plan">{balance ? `${balance.plan_code ?? 'free'} · ${balance.monthly_remaining}` : t('sidebar.localFirst')}</div>
        </div>
        <IconSettings size={15} aria-hidden="true" />
      </div>

      <input
        ref={importInputRef}
        type="file"
        accept="application/json"
        hidden
        onChange={(event) => {
          onImportLocalData(event.currentTarget.files?.[0])
          event.currentTarget.value = ''
          setActionConversationID(undefined)
        }}
      />
      <Dialog open={Boolean(actionConversation)} onOpenChange={(open) => !open && setActionConversationID(undefined)}>
        <DialogContent className="conversation-actions-dialog sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>{t('sidebar.dialog.title')}</DialogTitle>
            <DialogDescription>
              {t('sidebar.dialog.description', { title: actionConversation?.title ?? t('sidebar.dialog.currentConversation') })}
            </DialogDescription>
          </DialogHeader>
          <div className="conversation-action-list">
            <Button
              type="button"
              variant="outline"
              disabled={!actionConversation}
              onClick={() => {
                if (actionConversation) {
                  onExportConversation(actionConversation.id)
                  setActionConversationID(undefined)
                }
              }}
            >
              <IconDownload data-icon="inline-start" />
              {t('sidebar.dialog.export')}
            </Button>
            <Button type="button" variant="outline" onClick={() => importInputRef.current?.click()}>
              <IconUpload data-icon="inline-start" />
              {t('sidebar.dialog.import')}
            </Button>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setActionConversationID(undefined)}>
              {t('sidebar.dialog.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  )
}

function avatarInitials(email: string): string {
  const label = email.trim().split('@')[0] || 'JD'
  return label.slice(0, 2).toUpperCase()
}
