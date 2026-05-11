export type MessageRole = 'system' | 'user' | 'assistant'
export type ChatMode = 'fast' | 'deep'
export type MessageStatus = 'pending' | 'streaming' | 'done' | 'error'

export interface AgentTimelineItem {
  type: string
  label: string
}

export interface ChatMessage {
  id: string
  role: MessageRole
  content: string
  createdAt: string
  status: MessageStatus
  requestId?: string
  runId?: string
  creditsCost?: number
  agentEvents?: AgentTimelineItem[]
}

export interface Conversation {
  id: string
  title: string
  archived: boolean
  createdAt: string
  updatedAt: string
  messages: ChatMessage[]
}

export interface ConversationExport {
  version: 1
  exportedAt: string
  conversations: Conversation[]
}
