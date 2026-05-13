import { AgentProgress } from './AgentProgress'
import { MessageBubble } from './MessageBubble'
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
        <div className="empty-state">
          <h1>把复杂的工作，简单做完</h1>
          <p>直接提问，或上传附件后让简单阅读。本地聊天历史会默认保存在本机。</p>
        </div>
      )}
    </section>
  )
}
