import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/shared/i18n/i18n'
import type { Conversation, MessageStatus } from '@/shared/local-data/types'
import { ConversationSidebar } from './ConversationSidebar'

describe('ConversationSidebar', () => {
  afterEach(() => {
    cleanup()
    localStorage.clear()
  })

  it('marks inactive completed and permission-waiting chats while showing running chats as loading', () => {
    renderSidebar([
      conversation('done-inactive', '完成的后台任务', 'done'),
      conversation('permission-inactive', '等待授权的后台任务', 'waiting_permission'),
      conversation('running-inactive', '正在执行的后台任务', 'streaming'),
      conversation('done-active', '当前打开的完成任务', 'done'),
    ], 'done-active')

    expect(screen.getAllByLabelText('需要用户操作')).toHaveLength(2)
    expect(screen.getByLabelText('对话正在执行')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '当前打开的完成任务' })).toBeInTheDocument()
  })

  it('clears the attention dot after the user opens that chat once', () => {
    const conversations = [
      conversation('permission-inactive', '等待授权的后台任务', 'waiting_permission'),
      emptyConversation('current-chat', '当前对话'),
    ]
    const { rerender } = renderSidebar(conversations, 'current-chat')

    expect(screen.getByLabelText('需要用户操作')).toBeInTheDocument()

    rerender(sidebarElement(conversations, 'permission-inactive'))
    expect(screen.queryByLabelText('需要用户操作')).not.toBeInTheDocument()

    rerender(sidebarElement(conversations, 'current-chat'))
    expect(screen.queryByLabelText('需要用户操作')).not.toBeInTheDocument()
  })

  it('keeps the attention dot closed after the sidebar remounts', () => {
    const conversations = [
      conversation('permission-inactive', '等待授权的后台任务', 'waiting_permission'),
      emptyConversation('current-chat', '当前对话'),
    ]
    const { unmount } = renderSidebar(conversations, 'permission-inactive')

    unmount()
    renderSidebar(conversations, 'current-chat')

    expect(screen.queryByLabelText('需要用户操作')).not.toBeInTheDocument()
  })

  it('renders pinned conversations above unpinned chats, and splits chats vs projects', () => {
    const { container } = renderSidebar([
      emptyConversation('recent-chat', '普通对话'),
      emptyConversation('pinned-chat', '固定对话', { pinned: true }),
      emptyConversation('project-chat', '我的项目', { project: { name: '我的项目' } }),
    ])

    // The pinned section + the two unpinned section labels render in
    // visual order. Pull them by their CSS class so they're not
    // ambiguous with the same-text top tab buttons. The first entry
    // ('工作区') belongs to the top-level Workspace section that hosts
    // the Chats/Tools/Projects tab buttons — we just check it comes
    // before the conversation-list labels.
    const sectionLabels = Array.from(container.querySelectorAll('.sidebar-section-label')) as HTMLElement[]
    const labelTexts = sectionLabels.map((el) => el.textContent?.trim())
    expect(labelTexts).toEqual(['工作区', '已固定', '对话', '项目'])

    const pinnedConversation = screen.getByRole('button', { name: '固定对话' })
    const recentConversation = screen.getByRole('button', { name: '普通对话' })
    const projectConversation = screen.getByRole('button', { name: '我的项目' })

    // pinned label → pinned row → chats label → chat row → projects label → project row
    expect(sectionLabels[1].compareDocumentPosition(pinnedConversation) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(pinnedConversation.compareDocumentPosition(sectionLabels[2]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(sectionLabels[2].compareDocumentPosition(recentConversation) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(recentConversation.compareDocumentPosition(sectionLabels[3]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(sectionLabels[3].compareDocumentPosition(projectConversation) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    expect(screen.getAllByTitle('更多 固定对话')).toHaveLength(1)
    expect(screen.getAllByTitle('更多 普通对话')).toHaveLength(1)
    expect(screen.getAllByTitle('更多 我的项目')).toHaveLength(1)
  })

  it('exposes row actions for pinning, renaming, adding to a project, and deleting', async () => {
    const handlers = {
      onTogglePinConversation: vi.fn(),
      onRenameConversation: vi.fn(),
      onAddConversationToProject: vi.fn(),
      onDeleteConversation: vi.fn(),
    }
    renderSidebar([emptyConversation('target-chat', '操作目标')], undefined, handlers)

    openConversationActions('操作目标')
    fireEvent.click(await screen.findByText('固定'))
    expect(handlers.onTogglePinConversation).toHaveBeenCalledWith('target-chat')

    openConversationActions('操作目标')
    fireEvent.click(await screen.findByText('重命名'))
    fireEvent.change(await screen.findByLabelText('对话名称'), { target: { value: '新的标题' } })
    fireEvent.click(screen.getByText('保存名称'))
    expect(handlers.onRenameConversation).toHaveBeenCalledWith('target-chat', '新的标题')

    openConversationActions('操作目标')
    fireEvent.click(await screen.findByText('添加到项目'))
    fireEvent.change(await screen.findByLabelText('项目名称'), { target: { value: '客户项目' } })
    fireEvent.click(screen.getByRole('button', { name: '添加到项目' }))
    expect(handlers.onAddConversationToProject).toHaveBeenCalledWith('target-chat', '客户项目')

    openConversationActions('操作目标')
    fireEvent.click(await screen.findByText('删除'))
    const deleteDialog = await screen.findByRole('alertdialog', { name: '删除这个对话？' })
    expect(within(deleteDialog).getByText('操作目标')).toBeInTheDocument()
    expect(within(deleteDialog).getByText(/全部 0 条消息将被永久删除/)).toBeInTheDocument()
    expect(within(deleteDialog).getByRole('button', { name: '取消' })).toBeInTheDocument()
    fireEvent.click(within(deleteDialog).getByRole('button', { name: '删除' }))
    expect(handlers.onDeleteConversation).toHaveBeenCalledWith('target-chat')
  })

  it('shows only the extra-credits line in the account menu (monthly quota line is hidden)', async () => {
    // Product moved away from a monthly subscription. The
    // `monthly_credit_limit` / `monthly_remaining` values still come
    // back from the API, but we no longer surface them — only the
    // pay-as-you-go `extra_credits_balance` is shown.
    render(
      <I18nProvider>
        <ConversationSidebar
          conversations={[]}
          userEmail="test@example.com"
          balance={{
            id: 'w1',
            plan_code: 'free',
            monthly_credit_limit: 1000,
            monthly_credits_used: 200,
            monthly_remaining: 800,
            extra_credits_balance: 50,
            period_end: '',
            status: 'active',
          }}
          onNewConversation={vi.fn()}
          onSelectConversation={vi.fn()}
          onExportConversation={vi.fn()}
          onImportLocalData={vi.fn()}
          onTogglePinConversation={vi.fn()}
          onRenameConversation={vi.fn()}
          onAddConversationToProject={vi.fn()}
          onDeleteConversation={vi.fn()}
          onCollapseSidebar={vi.fn()}
        />
      </I18nProvider>,
    )

    const trigger = screen.getByRole('button', { name: '账户菜单' })
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'Enter', code: 'Enter' })
    // Extra balance shows; the monthly line is gone, both for finite
    // quotas ("本月余额 X/Y") and the unlimited variant ("本月额度不限量").
    expect(await screen.findByText('剩余Token数 50')).toBeInTheDocument()
    expect(screen.queryByText(/本月余额/)).not.toBeInTheDocument()
    expect(screen.queryByText(/本月额度不限量/)).not.toBeInTheDocument()
  })

  it('AccountBalance renders nothing when there are no extra credits', async () => {
    // The component now early-returns null when `extra_credits_balance` is 0.
    // Previously it would always show a "本月余额 / 不限量" line — that's
    // gone now, so an empty wallet should render no balance UI at all.
    render(
      <I18nProvider>
        <ConversationSidebar
          conversations={[]}
          userEmail="test@example.com"
          balance={{
            id: 'w1',
            plan_code: 'free',
            monthly_credit_limit: 0,
            monthly_credits_used: 0,
            monthly_remaining: 0,
            extra_credits_balance: 0,
            period_end: '',
            status: 'active',
          }}
          onNewConversation={vi.fn()}
          onSelectConversation={vi.fn()}
          onExportConversation={vi.fn()}
          onImportLocalData={vi.fn()}
          onTogglePinConversation={vi.fn()}
          onRenameConversation={vi.fn()}
          onAddConversationToProject={vi.fn()}
          onDeleteConversation={vi.fn()}
          onCollapseSidebar={vi.fn()}
        />
      </I18nProvider>,
    )
    const trigger = screen.getByRole('button', { name: '账户菜单' })
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'Enter', code: 'Enter' })
    // Menu opens (logout button present) but no balance lines render.
    expect(await screen.findByText('退出登录')).toBeInTheDocument()
    expect(screen.queryByText(/剩余Token数/)).not.toBeInTheDocument()
    expect(screen.queryByText(/本月余额/)).not.toBeInTheDocument()
    expect(screen.queryByText(/本月额度不限量/)).not.toBeInTheDocument()
  })

  it('toggles the memory agent setting from the account menu dialog', async () => {
    const onAgentSettingsChange = vi.fn()
    render(
      <I18nProvider>
        <ConversationSidebar
          conversations={[]}
          userEmail="test@example.com"
          onNewConversation={vi.fn()}
          onSelectConversation={vi.fn()}
          onExportConversation={vi.fn()}
          onImportLocalData={vi.fn()}
          onTogglePinConversation={vi.fn()}
          onRenameConversation={vi.fn()}
          onAddConversationToProject={vi.fn()}
          onDeleteConversation={vi.fn()}
          onCollapseSidebar={vi.fn()}
          agentSettings={{ memory: 'off', skills: 'off' }}
          onAgentSettingsChange={onAgentSettingsChange}
        />
      </I18nProvider>,
    )

    const trigger = screen.getByRole('button', { name: '账户菜单' })
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'Enter', code: 'Enter' })
    fireEvent.click(await screen.findByText('Agent 设置'))

    const dialog = await screen.findByRole('dialog', { name: 'Agent 设置' })
    const memoryGroup = within(dialog).getByRole('group', { name: '记忆' })
    fireEvent.click(within(memoryGroup).getByRole('button', { name: '开启' }))
    expect(onAgentSettingsChange).toHaveBeenCalledWith({ memory: 'on', skills: 'off' })
  })

  it('toggles the skills agent setting from the account menu dialog', async () => {
    const onAgentSettingsChange = vi.fn()
    render(
      <I18nProvider>
        <ConversationSidebar
          conversations={[]}
          userEmail="test@example.com"
          onNewConversation={vi.fn()}
          onSelectConversation={vi.fn()}
          onExportConversation={vi.fn()}
          onImportLocalData={vi.fn()}
          onTogglePinConversation={vi.fn()}
          onRenameConversation={vi.fn()}
          onAddConversationToProject={vi.fn()}
          onDeleteConversation={vi.fn()}
          onCollapseSidebar={vi.fn()}
          agentSettings={{ memory: 'off', skills: 'off' }}
          onAgentSettingsChange={onAgentSettingsChange}
        />
      </I18nProvider>,
    )

    const trigger = screen.getByRole('button', { name: '账户菜单' })
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'Enter', code: 'Enter' })
    fireEvent.click(await screen.findByText('Agent 设置'))

    const dialog = await screen.findByRole('dialog', { name: 'Agent 设置' })
    const skillsGroup = within(dialog).getByRole('group', { name: '技能' })
    fireEvent.click(within(skillsGroup).getByRole('button', { name: '开启' }))
    expect(onAgentSettingsChange).toHaveBeenCalledWith({ memory: 'off', skills: 'on' })
  })

  it('opens the skills view when the skills nav item is clicked', () => {
    const onOpenSkills = vi.fn()
    renderSidebar([], undefined, { onOpenSkills })
    fireEvent.click(screen.getByText('技能'))
    expect(onOpenSkills).toHaveBeenCalledTimes(1)
  })

  it('marks the active workspace tab and switches back to chats from the chats tab', () => {
    const onOpenChats = vi.fn()
    render(
      <I18nProvider>
        <ConversationSidebar
          conversations={[]}
          userEmail="test@example.com"
          onNewConversation={vi.fn()}
          onSelectConversation={vi.fn()}
          onExportConversation={vi.fn()}
          onImportLocalData={vi.fn()}
          onTogglePinConversation={vi.fn()}
          onRenameConversation={vi.fn()}
          onAddConversationToProject={vi.fn()}
          onDeleteConversation={vi.fn()}
          onCollapseSidebar={vi.fn()}
          onOpenSkills={vi.fn()}
          onOpenChats={onOpenChats}
          activeView="skills"
        />
      </I18nProvider>,
    )
    // Top tab buttons (not the section labels) — use the button role to
    // disambiguate from the same-text section header that now also renders
    // "对话" in the empty-state.
    const skillsItem = screen.getByRole('button', { name: '技能' })
    const chatsItem = screen.getByRole('button', { name: '对话' })
    expect(skillsItem.className).toContain('active')
    expect(chatsItem.className).not.toContain('active')
    fireEvent.click(chatsItem)
    expect(onOpenChats).toHaveBeenCalledTimes(1)
  })
})

function openConversationActions(title: string) {
  const trigger = screen.getByTitle(`更多 ${title}`)
  trigger.focus()
  fireEvent.keyDown(trigger, { key: 'Enter', code: 'Enter' })
}

function renderSidebar(
  conversations: Conversation[],
  activeID?: string,
  handlers: Partial<ConversationSidebarHandlers> = {},
) {
  return render(sidebarElement(conversations, activeID, handlers))
}

function sidebarElement(
  conversations: Conversation[],
  activeID?: string,
  handlers: Partial<ConversationSidebarHandlers> = {},
) {
  return (
    <I18nProvider>
      <ConversationSidebar
        conversations={conversations}
        activeID={activeID}
        userEmail="test@example.com"
        onNewConversation={vi.fn()}
        onSelectConversation={vi.fn()}
        onExportConversation={vi.fn()}
        onImportLocalData={vi.fn()}
        onTogglePinConversation={handlers.onTogglePinConversation ?? vi.fn()}
        onRenameConversation={handlers.onRenameConversation ?? vi.fn()}
        onAddConversationToProject={handlers.onAddConversationToProject ?? vi.fn()}
        onDeleteConversation={handlers.onDeleteConversation ?? vi.fn()}
        onCollapseSidebar={vi.fn()}
        onOpenSkills={handlers.onOpenSkills ?? vi.fn()}
      />
    </I18nProvider>
  )
}

interface ConversationSidebarHandlers {
  onTogglePinConversation: (conversationID: string) => void
  onRenameConversation: (conversationID: string, title: string) => void
  onAddConversationToProject: (conversationID: string, projectName: string) => void
  onDeleteConversation: (conversationID: string) => void
  onOpenSkills: () => void
}

function emptyConversation(id: string, title: string, overrides: Partial<Conversation> = {}): Conversation {
  return {
    id,
    title,
    archived: false,
    createdAt: '2026-05-14T00:00:00Z',
    updatedAt: '2026-05-14T00:01:00Z',
    messages: [],
    ...overrides,
  }
}

function conversation(id: string, title: string, status: MessageStatus): Conversation {
  return {
    id,
    title,
    archived: false,
    createdAt: '2026-05-14T00:00:00Z',
    updatedAt: '2026-05-14T00:01:00Z',
    messages: [
      {
        id: `${id}-user`,
        role: 'user',
        content: title,
        createdAt: '2026-05-14T00:00:00Z',
        status: 'done',
      },
      {
        id: `${id}-assistant`,
        role: 'assistant',
        content: 'result',
        createdAt: '2026-05-14T00:00:01Z',
        status,
      },
    ],
  }
}
