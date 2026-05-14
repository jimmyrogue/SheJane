import { AgentProgress } from './AgentProgress'
import { MessageBubble } from './MessageBubble'
import { IconCodeDots, IconPalette, IconSearch, IconWriting } from '@tabler/icons-react'
import type { LocalPermissionScope } from '@/shared/local-host/client'
import type { Conversation } from '@/shared/local-data/types'
import { useSmartAutoScroll } from '@/shared/streaming/useSmartAutoScroll'

export function ChatThread({
  conversation,
  onOpenArtifact,
  onOpenDiagnostics,
  onPermissionDecision,
}: {
  conversation?: Conversation
  onOpenArtifact: (artifactID: string) => void
  onOpenDiagnostics: (runID: string) => void
  onPermissionDecision: (messageID: string, requestID: string, decision: 'approve' | 'deny', scope?: LocalPermissionScope) => void
}) {
  const messageCount = conversation?.messages.length ?? 0
  const lastMessageContent = conversation?.messages.at(-1)?.content ?? ''
  const scrollRef = useSmartAutoScroll<HTMLDivElement>([messageCount, lastMessageContent.length], { bottomThreshold: 120 })

  return (
    <section className="chat-surface">
      {conversation?.messages.length ? (
        <div className="messages" ref={scrollRef}>
          {conversation.messages.map((message) => (
            <MessageBubble message={message} key={message.id}>
              <AgentProgress
                message={message}
                onOpenArtifact={onOpenArtifact}
                onOpenDiagnostics={onOpenDiagnostics}
                onPermissionDecision={(requestID, decision, scope) => onPermissionDecision(message.id, requestID, decision, scope)}
              />
            </MessageBubble>
          ))}
        </div>
      ) : (
        <div className="empty-state welcome-body">
          <div className="logo" aria-hidden="true">简</div>
          <h1>把复杂的工作，简单做完</h1>
          <p>本地保存聊天历史，云端只处理账号、计费和必要的模型请求。</p>
          <div className="suggest-grid" aria-label="建议任务">
            <button className="suggest-tile" type="button">
              <span className="tag tag-code"><IconCodeDots size={14} /> Code</span>
              <span className="text">让 Agent 帮你拆解一个实现任务</span>
            </button>
            <button className="suggest-tile" type="button">
              <span className="tag tag-write"><IconWriting size={14} /> Write</span>
              <span className="text">整理文档、规格或发布说明</span>
            </button>
            <button className="suggest-tile" type="button">
              <span className="tag tag-research"><IconSearch size={14} /> Research</span>
              <span className="text">收集信息并产出可追溯结论</span>
            </button>
            <button className="suggest-tile" type="button">
              <span className="tag tag-create"><IconPalette size={14} /> Create</span>
              <span className="text">生成界面方向、草稿或检查清单</span>
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
