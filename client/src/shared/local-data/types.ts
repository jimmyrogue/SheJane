export type MessageRole = 'system' | 'user' | 'assistant'
export type ChatMode = 'fast' | 'deep'
export type MessageStatus = 'pending' | 'streaming' | 'waiting_permission' | 'waiting_input' | 'done' | 'error'

export interface AgentQuestionChoice {
  label: string
  description?: string
}

export interface AgentQuestionItem {
  question: string
  header: string
  multiSelect?: boolean
  options: AgentQuestionChoice[]
}

export interface AgentTimelineItem {
  type: string
  label: string
  eventId?: string
  tool?: string
  target?: string
  tokens?: number
  permissionRequestId?: string
  permissionTool?: string
  permissionDecision?: 'approve' | 'deny'
  permissionScope?: 'once' | 'run'
  questionRequestId?: string
  questions?: AgentQuestionItem[]
  questionAnswers?: Record<string, string[]>
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
  runOrigin?: 'cloud' | 'local'
  creditsCost?: number
  tokens?: number
  agentEvents?: AgentTimelineItem[]
}

export interface ConversationWorkspace {
  path: string
  label: string
  authorized: boolean
  authorizationId?: string
}

export interface ConversationProject {
  name: string
}

export interface Conversation {
  id: string
  title: string
  archived: boolean
  pinned?: boolean
  createdAt: string
  updatedAt: string
  project?: ConversationProject
  workspace?: ConversationWorkspace
  messages: ChatMessage[]
}

export interface ConversationExport {
  version: 1
  exportedAt: string
  conversations: Conversation[]
}
