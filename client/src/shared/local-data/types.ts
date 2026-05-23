export type MessageRole = 'system' | 'user' | 'assistant'
/** User-visible model mode picked in the composer. The daemon resolves
 *  'auto' via an LLM classifier (see local_host/agent/auto_router.py).
 *  'pro' is the UI label for the cheaper internal "deep" wire value —
 *  the Go LLM router still speaks fast/deep, so the daemon translates
 *  pro→deep before calling the cloud. */
export type ChatMode = 'auto' | 'fast' | 'pro'
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

export interface MessageAttachment {
  documentId: string
  name: string
  contentType: string
  /** Small inline data: URL for image previews (durable across reload). */
  previewDataUrl?: string
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
  attachments?: MessageAttachment[]
  /** Thinking-mode trace from the model (DeepSeek `reasoning_content`).
   *  Accumulated from `llm.reasoning` SSE events for backend round-trip
   *  to subsequent LLM calls (DeepSeek API requires reasoning_content
   *  be passed back). NOT rendered to the user — only its presence +
   *  `status === 'streaming'` triggers the ephemeral "Thinking…"
   *  indicator above the bubble. */
  reasoning?: string
  /** Set only when the run was started with mode='auto' AND the daemon's
   *  classifier picked a concrete model. UI uses this to show a small
   *  "Auto → Pro" badge in the message meta row so the user can see what
   *  the auto-router decided. Absent when the user picked fast/pro
   *  manually (no need to repeat what's in the composer). */
  runMode?: {
    resolved: 'fast' | 'pro'
    reason: string
  }
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
