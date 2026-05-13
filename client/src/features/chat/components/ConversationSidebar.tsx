import { useRef, useState } from 'react'
import { Download, Ellipsis, FolderOpen, History, MessageCircle, Plus, Settings, Upload, Wrench } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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
  const importInputRef = useRef<HTMLInputElement>(null)
  const [actionConversationID, setActionConversationID] = useState<string>()
  const actionConversation = conversations.find((conversation) => conversation.id === actionConversationID)

  return (
    <aside className="sidebar">
      <Button className="sidebar-newchat" aria-label="新对话" onClick={onNewConversation}>
        <Plus size={15} />
        <span>新对话</span>
        <span className="kbd">⌘N</span>
      </Button>

      <div className="sidebar-section">
        <div className="sidebar-section-label">Workspace</div>
        <button className="sidebar-item active" type="button">
          <MessageCircle size={14} />
          <span>Chats</span>
        </button>
        <button className="sidebar-item" type="button">
          <Wrench size={14} />
          <span>Tools</span>
          <span className="badge">{conversations.length || 1}</span>
        </button>
        <button className="sidebar-item" type="button">
          <FolderOpen size={14} />
          <span>Projects</span>
        </button>
        <button className="sidebar-item" type="button">
          <History size={14} />
          <span>History</span>
        </button>
      </div>

      <div className="sidebar-section conversation-list">
        <div className="sidebar-section-label">Recent</div>
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
                title={`更多 ${conversation.title}`}
                aria-label={`更多 ${conversation.title}`}
                onClick={() => setActionConversationID(conversation.id)}
              >
                <Ellipsis size={15} />
              </Button>
            </div>
          ))
        ) : (
          <div className="sidebar-empty">还没有本地对话</div>
        )}
      </div>

      <div className="sidebar-footer">
        <div className="avatar">{avatarInitials(userEmail)}</div>
        <div className="sidebar-footer-copy">
          <div className="name">{userEmail.split('@')[0] || 'Jiandanly'}</div>
          <div className="plan">{balance ? `${balance.plan_code ?? 'free'} · ${balance.monthly_remaining}` : 'Local-first'}</div>
        </div>
        <Settings size={15} aria-hidden="true" />
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
            <DialogTitle>对话更多功能</DialogTitle>
            <DialogDescription>
              {actionConversation?.title ?? '当前对话'} 的低频操作放在这里，避免侧栏变成工具箱。
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
              <Download data-icon="inline-start" />
              导出此对话
            </Button>
            <Button type="button" variant="outline" onClick={() => importInputRef.current?.click()}>
              <Upload data-icon="inline-start" />
              导入聊天数据
            </Button>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setActionConversationID(undefined)}>
              关闭
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
