/* Dev-only design-QA harness. NOT shipped. Mounts the real shell components
 * with mock data against the real styles.css so we can screenshot each surface
 * and diff it against the v4 design. Switch surface with ?view=chat|skills|mcp|connections|preview.
 *
 * This file deliberately bypasses auth + the local daemon — every callback is a
 * no-op and every data source is a literal mock. It is never imported by the
 * real app (main.tsx renders <App/>, not this).
 */
import { StrictMode, useEffect, useRef, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { IconLayoutSidebarLeftExpand } from '@tabler/icons-react'
import '../styles.css'
import { I18nProvider } from '@/shared/i18n/i18n'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConversationSidebar } from '@/features/chat/components/ConversationSidebar'
import { ChatThread } from '@/features/chat/components/ChatThread'
import { Composer } from '@/features/chat/components/Composer'
import { ConnectionsView } from '@/features/connections/ConnectionsView'
import { SkillsView } from '@/features/skills/SkillsView'
import { MCPView } from '@/features/mcp/MCPView'
import { RechargeDialog } from '@/features/billing/RechargeDialog'
import { SettingsView } from '@/features/settings/SettingsView'
import { SpendHistoryDialog } from '@/features/billing/SpendHistoryDialog'
import { TodayView } from '@/features/today/TodayView'
import type { ChatMode, Conversation, ChatMessage } from '@/shared/local-data/types'
import type { ModelOption } from '@/features/chat/components/ModeSelector'
import type { UserDocument, WalletBalance, WalletTransaction } from '@/shared/api/client'
import type { AgentSettings, InstalledSkill, McpServerInfo } from '@/shared/local-host/client'

const HOUR = 3600_000
const DAY = 24 * HOUR
const now = Date.now()
const iso = (ms: number) => new Date(ms).toISOString()

function msg(id: string, role: ChatMessage['role'], content: string, atMs: number): ChatMessage {
  return { id, role, content, createdAt: iso(atMs), status: 'done' }
}

const richReply = `整理好了。下面是 Q2 的对数与 8 页骨架。

| 月份 | 营收 | 同比 |
| --- | --- | --- |
| 4 月 | 512 | +3.2% |
| 5 月 | 589 | -3.8% |
| 6 月 | 639 | +8.5% |

**汇报骨架（8 页）**

1. 结论先行：超额完成，完成率 97%
2. 中台迁移单独一页：进展 70%、灰度零事故
3. 风险与资源：2 个接口未适配，需要数据组两周

> 老板要求 ≤15 分钟，讲稿按 9 分钟设计，留足问答。

需要我把封面也配一版吗？`

const activeConvo: Conversation = {
  id: 'c-active',
  title: '季度汇报准备',
  archived: false,
  createdAt: iso(now - 2 * HOUR),
  updatedAt: iso(now - 5 * 60_000),
  messages: [
    msg('m1', 'user', '帮我把 Q2 的营收数据整理成汇报，老板要看完成率和趋势。', now - 90 * 60_000),
    {
      ...msg('m2', 'assistant', richReply, now - 88 * 60_000),
      creditsCost: 9383,
      runMode: { requested: '自动', resolved: 'DeepSeek Flash', reason: '需要整理数据并生成汇报骨架。' },
      agentEvents: [
        { type: 'tool.completed', label: '工具完成：读取文件', tool: 'fs.read' },
        { type: 'tool.completed', label: '工具完成：运行命令', tool: 'shell.run' },
        { type: 'tool.completed', label: '工具完成：运行命令', tool: 'shell.run' },
      ],
    },
    {
      ...msg('m2-paused', 'assistant', '', now - 8 * 60_000),
      status: 'streaming',
      runId: 'run-paused',
      runOrigin: 'local',
      runMode: { requested: '自动', resolved: 'DeepSeek Flash', reason: '正在恢复本地执行上下文。' },
      agentEvents: [
        {
          type: 'tool.requested',
          label: '调用工具：生成图片',
          tool: 'image.generate',
          toolDetail: {
            kind: 'text',
            text: '一只可爱的橘色小猫，毛茸茸的，大眼睛，坐在草地上，阳光温暖，高清写实风格',
          },
        },
        {
          type: 'run.waiting',
          label: '任务已暂停',
          handoffLedgerState: 'missing',
          handoffLedgerMessage: 'Progress ledger missing for handoff.',
        },
      ],
    },
    msg('m3', 'user', '很好。汇总这件事以后每个月都要做，帮我写一个能自己跑的脚本。', now - 6 * 60_000),
    {
      ...msg('m4', 'assistant', '可以。我会写一个按月拉取数据、生成同样表格与骨架的脚本，跑完直接产出 pptx。先确认数据源是飞书多维表还是导出的 xlsx？', now - 5 * 60_000),
      creditsCost: 4210,
      runMode: { resolved: 'deepseek-v4-pro', reason: '' },
      agentEvents: [{ type: 'tool.completed', label: '工具完成：读取文件', tool: 'fs.read' }],
    },
  ],
}

const providerErrorLabel = 'model provider is not configured (missing API key or base URL): missing API key or base URL · 需要你处理'

const providerErrorConvo: Conversation = {
  id: 'c-provider-error',
  title: '配置失败预览',
  archived: false,
  createdAt: iso(now - HOUR),
  updatedAt: iso(now - 19 * 60_000),
  messages: [
    msg('m-provider-user', 'user', '帮我生成一张可爱小猫图片。', now - 20 * 60_000),
    {
      ...msg('m-provider-assistant', 'assistant', providerErrorLabel, now - 19 * 60_000),
      status: 'error',
      runId: 'run-provider-error',
      runOrigin: 'local',
      runMode: { resolved: 'DeepSeek V4 Flash', reason: '' },
      agentEvents: [
        {
          type: 'run.failed',
          label: providerErrorLabel,
          failureCategory: 'configuration',
          failureActionKind: 'user_action',
        },
      ],
    },
  ],
}

const conversations: Conversation[] = [
  activeConvo,
  { id: 'c2', title: '整理本周周报', archived: false, createdAt: iso(now - 3 * HOUR), updatedAt: iso(now - 40 * 60_000), messages: [] },
  { id: 'c3', title: '会议纪要：产品评审', archived: false, createdAt: iso(now - DAY), updatedAt: iso(now - DAY - HOUR), messages: [] },
  { id: 'c4', title: '出差报销流程咨询', archived: false, createdAt: iso(now - 4 * DAY), updatedAt: iso(now - 4 * DAY), messages: [] },
  { id: 'c5', title: '竞品功能对比表', archived: false, createdAt: iso(now - 8 * DAY), updatedAt: iso(now - 8 * DAY), messages: [] },
  { id: 'c-pin', title: '常用：日报模板', archived: false, pinned: true, createdAt: iso(now - 10 * DAY), updatedAt: iso(now - 2 * HOUR), messages: [] },
]

const balance: WalletBalance = {
  id: 'w1', plan_code: 'payg', monthly_credit_limit: 0, monthly_credits_used: 0,
  monthly_remaining: 0, extra_credits_balance: 35190, period_end: iso(now + 20 * DAY), status: 'active',
}

const mockTransactions: WalletTransaction[] = [
  { id: 'tx1', wallet_id: 'w1', type: 'usage_settle', amount: -1280, monthly_used_after: 1280, extra_balance_after: 35190, description: 'deepseek-fast · 工具运行', created_at: iso(now - 2 * HOUR) },
  { id: 'tx2', wallet_id: 'w1', type: 'subscription_grant', amount: 9000, monthly_used_after: 0, extra_balance_after: 36470, description: '月度订阅', created_at: iso(now - DAY) },
  { id: 'tx3', wallet_id: 'w1', type: 'usage_settle', amount: -460, monthly_used_after: 1740, extra_balance_after: 35190, description: '文档解析', created_at: iso(now - 2 * DAY) },
]

const agentSettings: Required<AgentSettings> = {
  memory: 'on', skills: 'on', mcp: 'on', mcpDisabled: [], advanced: {},
}

const mockSkills: InstalledSkill[] = [
  { name: 'daily-digest', description: '把当天接入的 IM 消息归拢成有优先级的一天。', path: '/Users/x/.shejane/skills/daily-digest/SKILL.md', source: 'shejane', root_path: '/Users/x/.shejane/skills' },
  { name: 'write', description: '去 AI 味，把中英文改写得自然。', path: '/Users/x/.shejane/skills/write/SKILL.md', source: 'shejane', root_path: '/Users/x/.shejane/skills' },
  { name: 'docx', description: '创建、读取、编辑 Word 文档，保真排版。', path: '/Users/x/.claude/skills/docx/SKILL.md', source: 'claude', root_path: '/Users/x/.claude/skills' },
  { name: 'pptx', description: '生成与解析演示文稿。', path: '/Users/x/.claude/skills/pptx/SKILL.md', source: 'claude', root_path: '/Users/x/.claude/skills' },
]

const mockServers: McpServerInfo[] = [
  { name: 'context7', transport: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp'], env_keys: [], source: 'shejane', source_path: '/Users/x/.shejane/mcp.json' },
  { name: 'postgres', transport: 'stdio', command: 'mcp-postgres', args: [], env_keys: ['DATABASE_URL'], source: 'cursor', source_path: '/Users/x/.cursor/mcp.json' },
  { name: 'github', transport: 'streamable_http', args: [], url: 'https://api.githubcopilot.com/mcp/', env_keys: ['GITHUB_TOKEN'], source: 'claude-desktop', source_path: '/Users/x/Library/Application Support/Claude/claude_desktop_config.json' },
]

const mockChatModels: ModelOption[] = [
  { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', vendor: 'DeepSeek', vendor_info: '深度求索，推理能力与性价比突出。', capability_tier: 'fast', description: '速度优先' },
  { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', vendor: 'DeepSeek', vendor_info: '深度求索，推理能力与性价比突出。', capability_tier: 'max', description: '复杂推理' },
  { id: 'mimo-v2-5', label: 'Mimo V2.5', vendor: 'Xiaomi', vendor_info: '小米模型，适合快速问答与编码辅助。', capability_tier: 'balanced', description: '代码生成' },
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', vendor: 'Claude', vendor_info: 'Anthropic 出品，擅长写作、代码与长文理解。', capability_tier: 'max', description: '复杂推理和长文' },
]

const noop = () => {}
const params = new URLSearchParams(location.search)
const view = params.get('view') ?? 'chat'
const harnessCase = params.get('case') ?? ''
const useEmptyConversation = params.get('conversation') === 'empty'
const initialSidebarCollapsed = params.get('collapsed') === '1'
const initialMode = (params.get('model') || 'auto') as ChatMode
const showComposerAttachment = params.get('attachment') === '1'
const sidebarMotionMs = 220

const mockComposerAttachment: UserDocument = {
  id: 'doc-harness',
  user_id: 'user-harness',
  original_name: 'quarterly-brief.pdf',
  content_type: 'application/pdf',
  size_bytes: 2048,
  status: 'ready',
  source_object_key: 'documents/harness/doc-harness/source.pdf',
  text_object_key: 'documents/harness/doc-harness/extracted.txt',
  expires_at: iso(now + 7 * DAY),
  created_at: iso(now),
  updated_at: iso(now),
}

function Shell() {
  const [draft, setDraft] = useState('')
  const [mode, setMode] = useState<ChatMode>(initialMode)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(initialSidebarCollapsed)
  const [sidebarMotion, setSidebarMotion] = useState<'idle' | 'closing' | 'opening'>('idle')
  const sidebarMotionTimerRef = useRef<number>()
  const [rechargeOpen, setRechargeOpen] = useState(false)
  const [spendHistoryOpen, setSpendHistoryOpen] = useState(false)
  const [mainView, setMainView] = useState<'chat' | 'skills' | 'mcp' | 'connections' | 'settings' | 'today'>(
    view === 'skills'
      ? 'skills'
      : view === 'mcp'
        ? 'mcp'
        : view === 'connections'
          ? 'connections'
          : view === 'settings'
            ? 'settings'
            : view === 'today'
              ? 'today'
              : 'chat',
  )
  const displayedConversation = harnessCase === 'provider-error'
    ? providerErrorConvo
    : useEmptyConversation
      ? { ...activeConvo, id: 'c-empty', title: '新对话', messages: [] }
      : activeConvo

  useEffect(() => {
    return () => {
      if (sidebarMotionTimerRef.current) {
        window.clearTimeout(sidebarMotionTimerRef.current)
      }
    }
  }, [])

  function collapseSidebar() {
    if (sidebarMotionTimerRef.current) {
      window.clearTimeout(sidebarMotionTimerRef.current)
    }
    setSidebarMotion('closing')
    setSidebarCollapsed(true)
    sidebarMotionTimerRef.current = window.setTimeout(() => setSidebarMotion('idle'), sidebarMotionMs)
  }

  function expandSidebar() {
    if (sidebarMotionTimerRef.current) {
      window.clearTimeout(sidebarMotionTimerRef.current)
    }
    setSidebarMotion('opening')
    setSidebarCollapsed(false)
    sidebarMotionTimerRef.current = window.setTimeout(() => setSidebarMotion('idle'), sidebarMotionMs)
  }

  return (
    <main className="app-window-shell electron-window-shell">
      <div className="window-drag-layer" aria-hidden="true" />
      <div
        className="app-shell"
        style={{ ['--sidebar-width' as string]: '252px' }}
        data-collapsed={sidebarCollapsed ? 'true' : undefined}
        data-sidebar-motion={sidebarMotion === 'idle' ? undefined : sidebarMotion}
      >
        <ConversationSidebar
          conversations={conversations}
          activeID="c-active"
          onNewConversation={noop}
          onSelectConversation={noop}
          onExportConversation={noop}
          onImportLocalData={noop}
          onTogglePinConversation={noop}
          onRenameConversation={noop}
          onDeleteConversation={noop}
          onCollapseSidebar={collapseSidebar}
          isDesktop
          onOpenToday={() => setMainView('today')}
          onOpenSkills={() => setMainView('skills')}
          onOpenMcp={() => setMainView('mcp')}
          onOpenConnections={() => setMainView('connections')}
          onOpenSettings={() => setMainView('settings')}
          activeView={mainView}
          resizeHandle={(
            <div className="sidebar-resize-handle" role="separator" aria-orientation="vertical" tabIndex={0} />
          )}
        />
        <div className="view-transition" key={mainView}>
          {mainView === 'today' ? (
            <TodayView onQuoteToChat={() => setMainView('chat')} />
          ) : mainView === 'skills' ? (
            <SkillsView
              listInstalled={async () => ({ skills: mockSkills, roots: [] })}
              onCreateSkill={async () => {}}
              onLoadSkill={async (name) => ({
                name,
                description: 'Mock skill body for visual QA.',
                path: `/Users/x/.shejane/skills/${name}/SKILL.md`,
                root_path: '/Users/x/.shejane/skills',
                content: `---\nname: ${name}\ndescription: Mock skill body for visual QA.\n---\n\n# ${name}\n`,
              })}
              onUpdateSkill={async () => {}}
              onDeleteSkill={async () => {}}
              onOpenFolder={noop}
            />
          ) : mainView === 'mcp' ? (
            <MCPView
              listCatalog={async () => ({ servers: mockServers, sources_scanned: [] })}
              disabledServers={['postgres']}
              onDisabledChange={noop}
              onCreateServer={async () => {}}
              onUpdateServer={async () => {}}
              onDeleteServer={async () => {}}
              onOpenFolder={noop}
            />
          ) : mainView === 'connections' ? (
            <ConnectionsView />
          ) : mainView === 'settings' ? (
            <SettingsView
              isDesktop
              userEmail="jimmy@shejane.com"
              balance={balance}
              agentSettings={agentSettings}
              onAgentSettingsChange={noop}
              onRecharge={() => setRechargeOpen(true)}
              onShowSpendHistory={() => setSpendHistoryOpen(true)}
              onLogout={noop}
              onImportLocalData={noop}
              onExportLocalData={noop}
              onClearMemory={async () => 0}
            />
          ) : (
            <section className="workspace">
              <header className="topbar">
                {sidebarCollapsed ? (
                  <div className="topbar-expand-hotspot">
                    <button
                      type="button"
                      className="topbar-expand-button"
                      title="展开侧栏"
                      aria-label="展开侧栏"
                      onClick={expandSidebar}
                    >
                      <IconLayoutSidebarLeftExpand size={16} aria-hidden="true" />
                    </button>
                  </div>
                ) : null}
                <div className="chat-toolbar-title"><span>{displayedConversation.title}</span></div>
                <div className="topbar-status">
                  <span className="topbar-daemon-dot is-online" />
                </div>
              </header>
              <ChatThread conversation={displayedConversation} onOpenArtifact={noop} onOpenDiagnostics={noop} onPickSuggestion={setDraft} />
              <div className="composer-dock">
                <Composer
                  draft={draft}
                  onDraftChange={setDraft}
                  isSending={false}
                  attachedDocuments={showComposerAttachment ? [mockComposerAttachment] : undefined}
                  isUploading={false}
                  onUploadDocument={noop}
                  onDetachDocument={noop}
                  onSend={noop}
                  onStop={noop}
                  listSkills={async () => mockSkills as never}
                  mode={mode}
                  models={mockChatModels}
                  onModeChange={setMode}
                  isDesktop
                />
                <p className="composer-disclaimer">石间可能出错，重要决定请自行确认</p>
              </div>
            </section>
          )}
          <RechargeDialog open={rechargeOpen} onOpenChange={setRechargeOpen} balance={balance} onConfirm={noop} />
          <SpendHistoryDialog
            open={spendHistoryOpen}
            onOpenChange={setSpendHistoryOpen}
            fetchTransactions={async () => mockTransactions}
          />
        </div>
      </div>
    </main>
  )
}

type HarnessWindow = Window & {
  __shejaneHarnessRoot?: ReturnType<typeof ReactDOM.createRoot>
}

const rootEl = document.getElementById('root')!
const harnessWindow = window as HarnessWindow
const root = harnessWindow.__shejaneHarnessRoot ?? ReactDOM.createRoot(rootEl)
harnessWindow.__shejaneHarnessRoot = root

root.render(
  <StrictMode>
    <I18nProvider>
      <TooltipProvider>
        <Shell />
      </TooltipProvider>
    </I18nProvider>
  </StrictMode>,
)
