export type MessageRole = 'system' | 'user' | 'assistant'
export type ChatMode = 'fast' | 'deep'
export type MessageStatus = 'pending' | 'streaming' | 'done' | 'error'

export interface ChatMessage {
  id: string
  role: MessageRole
  content: string
  createdAt: string
  status: MessageStatus
  requestId?: string
  creditsCost?: number
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
