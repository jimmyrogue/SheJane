import { useRef, useState } from 'react'
import { Download, Ellipsis, MessageSquare, Plus, Upload } from 'lucide-react'
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
  onNewConversation,
  onSelectConversation,
  onExportConversation,
  onImportLocalData,
}: {
  conversations: Conversation[]
  activeID?: string
  balance?: WalletBalance | null
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
      <div className="brand">
        <span className="brand-mark">简</span>
        <div>
          <strong>简单 Jiandan</strong>
          <small>AI, simplified.</small>
        </div>
      </div>

      <Button className="primary-action" onClick={onNewConversation}>
        <Plus size={18} />
        新对话
      </Button>

      <div className="conversation-list">
        {conversations.map((conversation) => (
          <div className={conversation.id === activeID ? 'conversation-row active' : 'conversation-row'} key={conversation.id}>
            <Button
              className="conversation"
              variant="ghost"
              onClick={() => onSelectConversation(conversation.id)}
            >
              <MessageSquare size={16} />
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
              <Ellipsis size={16} />
            </Button>
          </div>
        ))}
      </div>

      {balance ? (
        <div className="sidebar-quota">
          <span>本月 <strong>{balance.monthly_remaining}</strong></span>
          <span className="plan">{balance.plan_code ?? 'free'}</span>
        </div>
      ) : null}

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
