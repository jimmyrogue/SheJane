export type MessageRole = 'system' | 'user' | 'assistant'
export type ChatMode = 'fast' | 'deep'
export type MessageStatus = 'pending' | 'streaming' | 'waiting_permission' | 'done' | 'error'

export interface AgentTimelineItem {
  type: string
  label: string
  eventId?: string
  permissionRequestId?: string
  permissionTool?: string
  permissionDecision?: 'approve' | 'deny'
  permissionScope?: 'once' | 'run'
  artifactId?: string
  artifactTitle?: string
  artifactTool?: string
  sourceTitle?: string
  sourceUrl?: string
  verificationStatus?: 'passed' | 'failed'
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
