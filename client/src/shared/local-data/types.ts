export type MessageRole = 'system' | 'user' | 'assistant'
/** The model the user picked in the composer: Auto sentinels (`auto`,
 *  `auto.fast`, `auto.smart`) or a concrete catalog model id from
 *  GET /api/v1/models. The `string & {}` keeps Auto autocompletion while
 *  allowing any model id. */
export type ChatMode = 'auto' | 'auto.fast' | 'auto.smart' | (string & {})
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

export interface AgentToolDetail {
  /** `host` means render with the globe icon; `text` is the default
   *  inline string display; `count` is a numeric/short summary. */
  kind: 'host' | 'text' | 'count'
  /** The user-visible short text (host name, basename, query …).
   *  Already truncated; the renderer may further ellipsis on overflow. */
  text: string
  /** Optional full string (full path, full URL) for the title=
   *  tooltip when the user hovers the truncated text. */
  tooltip?: string
  /** Web tools (web.fetch, browser.open, open.url, browser.task) ask
   *  the renderer to draw the default IconWorld glyph alongside the
   *  host. We don't fetch real favicons — privacy + no external deps. */
  showWebIcon?: boolean
}

export interface StoredCloudToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface StoredCloudLLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolCallId?: string
  name?: string
  toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[]
}

export interface CloudToolContinuation {
  requestId: string
  goal: string
  mode: ChatMode
  messages: StoredCloudLLMMessage[]
  tools: StoredCloudToolDefinition[]
  maxSteps: number
}

export interface AgentPlanTodo {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

export interface AgentTimelineItem {
  type: string
  label: string
  eventId?: string
  handoffLedgerState?: 'not_required' | 'missing' | 'fresh' | 'stale'
  handoffLedgerMessage?: string
  failureCategory?: string
  failureRetryable?: boolean
  failureActionKind?: 'retry' | 'user_action' | 'repair' | 'operator_action' | 'inspect'
  failureRecoveryAction?: 'retry' | 'repair' | 'recharge' | 'refresh_session' | 'workspace' | 'diagnostics'
  failureSuggestedAction?: string
  retryAttempt?: number
  retrySourceRunId?: string
  retrySourceMessageId?: string
  repairAttempt?: number
  repairWorkflowStatus?: 'started' | 'completed' | 'failed' | 'rejected' | 'canceled'
  repairSourceRunId?: string
  repairSourceMessageId?: string
  tool?: string
  /** Daemon-assigned ID for the underlying LLM tool_call. Same value on
   *  the `tool.requested`, `tool.completed`, and `tool.failed` items of
   *  one logical call, so the renderer can correlate phases when many
   *  calls are in flight (notably `task` subagent dispatches running in
   *  parallel). Populated by `timelineItem()` from `payload.tool_call_id`. */
  toolCallId?: string
  /** Back-compat single-string identifier (host, basename, etc.).
   *  New code should set `toolDetail` instead; the renderer prefers
   *  toolDetail when both are present. */
  target?: string
  /** Rich per-tool primary-argument badge — populated by
   *  `toolDetail()` in chatStore.ts when the agent calls a tool whose
   *  args are surfaced via the `tool.requested` event. */
  toolDetail?: AgentToolDetail
  tokens?: number
  permissionRequestId?: string
  permissionTool?: string
  permissionDecision?: 'approve' | 'deny'
  permissionScope?: 'once' | 'run'
  planApprovalRequestId?: string
  planApprovalDecision?: 'approve' | 'modify' | 'reject'
  planTodos?: AgentPlanTodo[]
  questionRequestId?: string
  questions?: AgentQuestionItem[]
  questionAnswers?: Record<string, string[]>
  artifactId?: string
  artifactTitle?: string
  artifactTool?: string
  sourceTitle?: string
  sourceUrl?: string
  verificationStatus?: 'passed' | 'failed'
  /** Base64-encoded image/png payloads captured from a `code.execute`
   *  tool.completed event's `data.results[].data["image/png"]` (and
   *  variants). Populated by chatStore.ts so the message renderer can
   *  show matplotlib figures inline without re-parsing the wire
   *  envelope. Empty/absent when the tool produced no images. */
  codeExecImages?: string[]
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
  /** UI model badge for the completed turn. Auto runs update this from
   *  `model.selected` ("自动/更快/更强 → Pro"); concrete model picks store
   *  their selected model ID directly so every assistant turn can surface
   *  the model used. */
  runMode?: {
    /** User-facing label for the Auto sentinel, if provided by the cloud. */
    requested?: string
    /** The concrete model id the cloud resolved an "auto" run to. */
    resolved: string
    reason: string
  }
  /** Web build only: saved browser-orchestrated tool-loop state when the
   *  run reaches its configured step cap and waits for the user to continue. */
  cloudToolContinuation?: CloudToolContinuation
}

export interface ConversationWorkspace {
  path: string
  label: string
  authorized: boolean
  authorizationId?: string
}

/**
 * Currently-previewed office document.
 *
 * Set whenever something in the UI wants to surface a .docx / .xlsx in
 * the right-side DocPreviewPanel — three known triggers:
 *  1. Successful `office.read` tool call (App.tsx mines the tool result
 *     and opens with a local-file loader).
 *  2. Click on a recognized filename in agent text (MessageBubble
 *     resolves it against `conversation.workspace.path` and opens).
 *  3. Click on a user-uploaded office attachment (MessageBubble passes a
 *     cloud-fetch loader).
 *
 * The renderer (DocxPreview / XlsxPreview) consumes `loadBytes()` and
 * doesn't care where the bytes come from. `sourceKey` lets the panel
 * dedupe — opening the same path/document twice doesn't trigger a
 * spurious reload (we just bump the refresh key).
 */
/** Sparse, all-optional view of the server-side pdfinfo parse
 *  (api/internal/documents/extract.go::parsePDFInfo). Lives here
 *  (the dependency-free leaf module) rather than in api/client.ts
 *  so OpenDocument can reference it without a circular import;
 *  client.ts re-exports it for API-response typing. Encrypted /
 *  legacy / corrupted PDFs may surface only a subset. */
export interface PdfDocumentMetadata {
  title?: string
  author?: string
  creator?: string
  producer?: string
  subject?: string
  keywords?: string
  pages?: number
  encrypted?: boolean
  pdf_version?: string
  page_size?: string
}

export interface OpenDocument {
  /** Stable identifier for this document — used to dedupe opens.
   *  Format: `local:<absolute-path>` for workspace files,
   *  `cloud:<documentId>` for uploaded ones. */
  sourceKey: string
  /** "word", "excel", "powerpoint", or "pdf" — drives which preview
   *  component the panel mounts (DocxPreview / XlsxPreview /
   *  PptxPreview / PdfPreview). */
  kind: 'word' | 'excel' | 'powerpoint' | 'pdf'
  /** Display label — typically the basename. */
  name: string
  /** Optional full path or description shown as tooltip on the header. */
  tooltip?: string
  /** Optional document metadata (currently PDFs only — pdfinfo
   *  output captured server-side at upload). The preview header
   *  renders a "15 页 · Author" badge when present. Undefined for
   *  local workspace files and for cloud docs missing from the
   *  current documents list. */
  metadata?: PdfDocumentMetadata
  /** Resolves with the file's raw bytes. Closure over whatever
   *  authenticated fetch backs this source (workspace endpoint, S3
   *  presigned GET, etc.).
   *
   *  For .pptx the preview uses the outline endpoint instead of these
   *  bytes (no mature pure-browser pptx renderer exists), but the
   *  loader is still required by the panel shell — pass a no-op
   *  ArrayBuffer resolver, or wire to fetchWorkspaceFile if you want
   *  the bytes available for a later "download" affordance. */
  loadBytes: () => Promise<ArrayBuffer>
  /** Absolute filesystem path on the user's machine. Required when
   *  `kind === 'powerpoint'` so the preview can call the outline
   *  endpoint + the "open natively" button can hand the path to the
   *  Electron shell. Optional for cloud-sourced docs (which lack a
   *  local path). */
  localPath?: string
}

/** Reference to an office file living inside an authorized workspace.
 *  Emitted by detectors / clickable-filename handlers; App.tsx wraps
 *  it into a full OpenDocument by binding `fetchWorkspaceFile`. */
export interface LocalOfficeFileRef {
  /** Absolute path on the user's machine. Must be inside an
   *  authorized workspace (the daemon enforces this on fetch). */
  path: string
  kind: 'word' | 'excel' | 'powerpoint'
  /** Display name — typically the basename. */
  name: string
}

/** One slide's outline data returned by the daemon's
 *  GET /local/v1/pptx-outline endpoint (and equivalently by the
 *  office.read_slides tool). The PptxPreview component renders one
 *  card per entry. */
export interface PptxSlideOutline {
  index: number
  layout: string
  title: string
  bullets: string[]
  notes: string
  shape_count: number
  image_count: number
}

/** Reference to a previewable file in the cloud documents service
 *  (uploaded via the composer's attachment flow). Originally only
 *  office types; PDF was added when the side-panel learned to
 *  render PDFs via Chromium's embedded viewer. Name kept as
 *  `CloudOfficeAttachmentRef` for git-blame continuity, but the
 *  scope is wider than "office" now. */
export interface CloudOfficeAttachmentRef {
  documentId: string
  kind: 'word' | 'excel' | 'pdf'
  name: string
}

/**
 * A conversation belongs to a "project" when it was created by clicking
 * the Projects sidebar button — which prompts for a directory and binds
 * that directory's workspace into the conversation upfront.
 *
 * `project.name` is the directory's basename by default. The sidebar
 * uses `conversation.project` to decide whether the row goes in the
 * "Chats" group or the "Projects" group; the agent itself doesn't read
 * this field (it only reads `conversation.workspace`).
 */
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
