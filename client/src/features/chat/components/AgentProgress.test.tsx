import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentProgress, deriveAgentProgress } from './AgentProgress'
import { I18nProvider } from '@/shared/i18n/i18n'
import type { ChatMessage } from '@/shared/local-data/types'

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'msg-agent',
    role: 'assistant',
    content: '',
    createdAt: '2026-05-13T00:00:00.000Z',
    status: 'streaming',
    runId: 'run-local',
    runOrigin: 'local',
    agentEvents: [],
    ...overrides,
  }
}

describe('AgentProgress', () => {
  afterEach(() => cleanup())

  it('does not render permission prompts inline (they move to the approval bar)', () => {
    const { container } = renderAgentProgress(
      <AgentProgress
        message={message({
          status: 'waiting_permission',
          agentEvents: [
            { type: 'source.collected', label: '收集来源：Example Source', sourceTitle: 'Example Source', sourceUrl: 'https://example.com/source' },
            { type: 'permission.required', label: '需要权限：运行命令', permissionRequestId: 'perm-shell', permissionTool: '运行命令' },
          ],
        })}
        onOpenArtifact={vi.fn()}
        onOpenDiagnostics={vi.fn()}
      />,
    )

    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByText('等待批准：运行命令')).not.toBeInTheDocument()
    expect(screen.queryByText('本会话始终允许')).not.toBeInTheDocument()
  })

  it('surfaces missing handoff ledger risk while waiting without restoring inline approval controls', () => {
    renderAgentProgress(
      <AgentProgress
        message={message({
          status: 'waiting_permission',
          agentEvents: [
            { type: 'permission.required', label: '需要权限：运行命令', permissionRequestId: 'perm-shell', permissionTool: '运行命令' },
            {
              type: 'run.waiting',
              label: '任务已暂停',
              handoffLedgerState: 'missing',
              handoffLedgerMessage: 'Progress ledger missing for handoff.',
            },
          ],
        })}
        onOpenArtifact={vi.fn()}
        onOpenDiagnostics={vi.fn()}
      />,
    )

    expect(screen.getByText('暂停交接需要注意')).toBeInTheDocument()
    expect(screen.getByText('暂停前缺少进展账本，恢复时上下文可能不完整。')).toBeInTheDocument()
    expect(screen.queryByText('等待批准：运行命令')).not.toBeInTheDocument()
    expect(screen.queryByText('本会话始终允许')).not.toBeInTheDocument()
  })

  it('collapses to an aggregated headline; expanding exposes only the diagnostics escape hatch', () => {
    // The expanded body used to dump a per-step list + source/artifact
    // tallies + a "view artifact" button. Users found it noisy and
    // mostly irrelevant — leaks internal events like graph.node /
    // llm.tool_call_chunk. Now expansion contains ONLY the
    // diagnostics button; everything else is gone.
    const onOpenDiagnostics = vi.fn()
    const current = message({
      status: 'done',
      agentEvents: [
        { type: 'tool.completed', label: '工具完成：读取文件', tool: 'fs.read' },
        { type: 'source.collected', label: '收集来源：Source A', sourceTitle: 'Source A', sourceUrl: 'https://a.example' },
        { type: 'source.collected', label: '收集来源：Source B', sourceTitle: 'Source B', sourceUrl: 'https://b.example' },
        { type: 'artifact.created', label: 'Artifact：browser output', artifactId: 'artifact-1', artifactTitle: 'browser output' },
        { type: 'run.completed', label: '任务完成' },
      ],
    })

    renderAgentProgress(
      <AgentProgress
        message={current}
        onOpenArtifact={vi.fn()}
        onOpenDiagnostics={onOpenDiagnostics}
      />,
    )

    // Finished: an aggregated tally, no success/failure word or step count.
    expect(screen.getByText('读取 1 个文件')).toBeInTheDocument()
    expect(screen.queryByText('任务完成')).not.toBeInTheDocument()
    // None of the removed UI should be present anywhere — even collapsed.
    expect(screen.queryByText('查看 artifact')).not.toBeInTheDocument()
    expect(screen.queryByText('已收集 2 个来源')).not.toBeInTheDocument()
    expect(screen.queryByTitle('查看诊断 run-local')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '展开步骤' }))

    // Source/artifact tallies and per-step list are gone for good —
    // the only thing in the expanded drawer is the diagnostics button.
    expect(screen.queryByText('已收集 2 个来源')).not.toBeInTheDocument()
    expect(screen.queryByText('生成 1 个 Artifact')).not.toBeInTheDocument()
    expect(screen.queryByText('查看 artifact')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTitle('查看诊断 run-local'))
    expect(onOpenDiagnostics).toHaveBeenCalledWith('run-local')
  })

  it('renders nothing for a tool-less direct answer (skill.selected is not an operation)', () => {
    const { container } = renderAgentProgress(
      <AgentProgress
        message={message({
          status: 'done',
          agentEvents: [{ type: 'skill.selected', label: '处理方式：local-task-execution' }],
        })}
        onOpenArtifact={vi.fn()}
        onOpenDiagnostics={vi.fn()}
      />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the current action with its concrete target while running', () => {
    renderAgentProgress(
      <AgentProgress
        message={message({
          status: 'streaming',
          agentEvents: [
            { type: 'tool.requested', label: '调用工具：打开受控网页', tool: 'browser.open', target: 'weather.com' },
          ],
        })}
        onOpenArtifact={vi.fn()}
        onOpenDiagnostics={vi.fn()}
      />,
    )
    // Headline carries just the verb in the `.name` span — "正在" prefix
    // removed, trailing dots are appended by CSS (::after). The concrete
    // target ("weather.com") renders in a separate span so it can be
    // styled (color, ellipsis) independently and optionally prefixed
    // with the globe icon for web tools.
    expect(screen.getByText('打开受控网页')).toBeInTheDocument()
    expect(screen.getByText('weather.com')).toBeInTheDocument()
  })

  it('uses repair workflow events as the live running headline', () => {
    renderAgentProgress(
      <AgentProgress
        message={message({
          status: 'streaming',
          agentEvents: [
            { type: 'repair.workflow', label: '修复开始：第 2/3 次', repairAttempt: 2 },
          ],
        })}
        onOpenArtifact={vi.fn()}
        onOpenDiagnostics={vi.fn()}
      />,
    )

    expect(screen.getByText('修复开始：第 2/3 次')).toBeInTheDocument()
    expect(screen.queryByText('思考')).not.toBeInTheDocument()
  })

  it('does not show "已完成 X" as the live headline while the run is still active', () => {
    // Regression for the user-reported "为什么显示的都是 已完成xxx" bug.
    // Between two tool calls the latest activity event is
    // tool.completed for the PREVIOUS tool — but the run keeps going.
    // We re-frame that completed tool as the in-progress label (the
    // agent is still working on its results). We do NOT fall back to
    // "思考" here because the ThinkingIndicator above the bubble
    // already says that — duplicate labels read as a broken UI.
    renderAgentProgress(
      <AgentProgress
        message={message({
          status: 'streaming',
          agentEvents: [
            { type: 'tool.requested', label: '调用工具：搜索网页', tool: 'web.search' },
            { type: 'tool.completed', label: '工具完成：搜索网页', tool: 'web.search' },
          ],
        })}
        onOpenArtifact={vi.fn()}
        onOpenDiagnostics={vi.fn()}
      />,
    )

    expect(screen.queryByText('已完成搜索网页')).not.toBeInTheDocument()
    expect(screen.queryByText('思考')).not.toBeInTheDocument()
    expect(screen.getByText('搜索网页')).toBeInTheDocument()
  })

  it('prefers an in-flight tool over a completed sibling for the headline', () => {
    // 3 parallel tools, 2 done, 1 still running. The live headline
    // must point at the one still running, not the completed ones.
    renderAgentProgress(
      <AgentProgress
        message={message({
          status: 'streaming',
          agentEvents: [
            { type: 'tool.requested', label: '调用工具：搜索网页', tool: 'web.search', target: '普吉岛天气' },
            { type: 'tool.requested', label: '调用工具：读取文件', tool: 'fs.read', target: 'README.md' },
            { type: 'tool.completed', label: '工具完成：搜索网页', tool: 'web.search' },
          ],
        })}
        onOpenArtifact={vi.fn()}
        onOpenDiagnostics={vi.fn()}
      />,
    )

    expect(screen.queryByText('已完成搜索网页')).not.toBeInTheDocument()
    // verb and target render in separate spans now
    expect(screen.getByText('读取文件')).toBeInTheDocument()
    expect(screen.getByText('README.md')).toBeInTheDocument()
  })

  it('still shows "已完成 X" as the final headline once the run is actually done', () => {
    // The fix above only applies during active runs — once the run is
    // finished the latest activity is correctly framed as completed.
    renderAgentProgress(
      <AgentProgress
        message={message({
          status: 'done',
          agentEvents: [
            { type: 'tool.requested', label: '调用工具：搜索网页', tool: 'web.search' },
            { type: 'tool.completed', label: '工具完成：搜索网页', tool: 'web.search', target: '普吉岛' },
            { type: 'run.completed', label: '任务完成' },
          ],
        })}
        onOpenArtifact={vi.fn()}
        onOpenDiagnostics={vi.fn()}
      />,
    )

    // Aggregated count wins when present:
    expect(screen.getByText('搜索 1 次')).toBeInTheDocument()
  })

  it('marks the failed state with the failed tone class', () => {
    // The old version of this test asserted that expanding the row
    // revealed individual step labels. The step list is gone — there's
    // no per-step view anymore — so this test now just verifies the
    // failed-tone class lands on the wrapper for CSS styling. The
    // headline itself still summarises the failure.
    const current = message({
      status: 'error',
      agentEvents: [
        { type: 'tool.requested', label: '调用工具：打开受控网页' },
        { type: 'tool.failed', label: '验证失败：打开受控网页', verificationStatus: 'failed' },
      ],
    })

    const { container } = renderAgentProgress(
      <AgentProgress
        message={current}
        onOpenArtifact={vi.fn()}
        onOpenDiagnostics={vi.fn()}
      />,
    )

    expect(container.querySelector('.agent-progress-failed')).toBeInTheDocument()
    // The expanded drawer (when opened) carries only the diagnostics
    // button — no step labels regardless of state.
    expect(screen.queryByText('调用工具：打开受控网页')).not.toBeInTheDocument()
  })

  it('shows the latest run failure label as the failed headline', () => {
    const current = message({
      status: 'error',
      agentEvents: [
        { type: 'tool.completed', label: '工具完成：读取文件', tool: 'fs.read' },
        { type: 'run.failed', label: 'missing API key · 需要你处理' },
      ],
    })

    renderAgentProgress(
      <AgentProgress
        message={current}
        onOpenArtifact={vi.fn()}
        onOpenDiagnostics={vi.fn()}
      />,
    )

    expect(screen.getByText('missing API key · 需要你处理')).toBeInTheDocument()
    expect(screen.queryByText('读取 1 个文件')).not.toBeInTheDocument()
  })

  it('shows localized next action guidance for user-action failures', () => {
    const current = message({
      status: 'error',
      agentEvents: [
        {
          type: 'run.failed',
          label: 'cloud session required · 需要你处理',
          failureCategory: 'auth',
          failureActionKind: 'user_action',
          failureSuggestedAction: 'Sign in to the Electron app or refresh the local cloud session, then retry.',
        },
      ],
    })

    renderAgentProgress(
      <AgentProgress
        message={current}
        onOpenArtifact={vi.fn()}
        onOpenDiagnostics={vi.fn()}
      />,
    )

    expect(screen.getByText('cloud session required · 需要你处理')).toBeInTheDocument()
    expect(screen.getByText('请重新登录或刷新本地云端会话，然后重试。')).toBeInTheDocument()
  })

  it('offers a top-up action for quota failures', () => {
    const onFailureAction = vi.fn()
    const current = message({
      status: 'error',
      agentEvents: [
        {
          type: 'run.failed',
          label: 'credits exhausted · 需要你处理',
          failureCategory: 'quota',
          failureActionKind: 'user_action',
        },
      ],
    })

    renderAgentProgress(
      <AgentProgress
        message={current}
        onOpenArtifact={vi.fn()}
        onOpenDiagnostics={vi.fn()}
        onFailureAction={onFailureAction}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '充值' }))
    expect(onFailureAction).toHaveBeenCalledWith('recharge', current)
  })

  it('offers a retry action for retryable failures', () => {
    const onFailureAction = vi.fn()
    const current = message({
      status: 'error',
      agentEvents: [
        {
          type: 'run.failed',
          label: 'provider overloaded · 可重试',
          failureCategory: 'transient',
          failureActionKind: 'retry',
        },
      ],
    })

    renderAgentProgress(
      <AgentProgress
        message={current}
        onOpenArtifact={vi.fn()}
        onOpenDiagnostics={vi.fn()}
        onFailureAction={onFailureAction}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(onFailureAction).toHaveBeenCalledWith('retry', current)
  })

  it('offers a distinct repair action for repairable validation failures', () => {
    const onFailureAction = vi.fn()
    const current = message({
      status: 'error',
      agentEvents: [
        {
          type: 'run.failed',
          label: 'invalid tool arguments · 需要修复',
          failureCategory: 'validation',
          failureActionKind: 'repair',
        },
      ],
    })

    renderAgentProgress(
      <AgentProgress
        message={current}
        onOpenArtifact={vi.fn()}
        onOpenDiagnostics={vi.fn()}
        onFailureAction={onFailureAction}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '尝试修复' }))
    expect(onFailureAction).toHaveBeenCalledWith('repair', current)
  })

  it('falls back to operator guidance for fatal failures without a category-specific action', () => {
    const progress = deriveAgentProgress(
      message({
        status: 'error',
        agentEvents: [
          {
            type: 'run.failed',
            label: 'RuntimeError · 需要运维处理',
            failureActionKind: 'operator_action',
            failureSuggestedAction: 'Inspect logs and fix implementation.',
          },
        ],
      }),
    )

    expect(progress).toMatchObject({
      tone: 'failed',
      label: 'RuntimeError · 需要运维处理',
      detail: '请检查本地日志或实现错误，修复后再重试。',
    })
  })

  it('parallel task dispatches: header shows count only; descriptions render as a per-task list below', () => {
    // When the agent emits multiple task() calls in one LLM message
    // (the case we engineered for in the C1+C2+C3 subagent prompt fix),
    // the timeline carries one tool.requested per dispatch. The header
    // collapses to "派发 · N 个子任务进行中" and each subtask appears as
    // a labelled row below — single line each, ellipsis on overflow.
    renderAgentProgress(
      <AgentProgress
        message={message({
          status: 'streaming',
          agentEvents: [
            {
              type: 'tool.requested',
              label: '调用工具：派发子任务',
              tool: 'task',
              toolCallId: 'call_1',
              toolDetail: { kind: 'text', text: '搜索成都5月底天气', tooltip: 'researcher: 搜索成都5月底天气' },
            },
            {
              type: 'tool.requested',
              label: '调用工具：派发子任务',
              tool: 'task',
              toolCallId: 'call_2',
              toolDetail: { kind: 'text', text: '搜索成都核心景点', tooltip: 'researcher: 搜索成都核心景点' },
            },
            {
              type: 'tool.requested',
              label: '调用工具：派发子任务',
              tool: 'task',
              toolCallId: 'call_3',
              toolDetail: { kind: 'text', text: '搜索成都必吃美食', tooltip: 'researcher: 搜索成都必吃美食' },
            },
          ],
        })}
        onOpenArtifact={vi.fn()}
        onOpenDiagnostics={vi.fn()}
      />,
    )

    // Header line: count only — descriptions are NOT here anymore.
    expect(screen.getByText('3 个子任务进行中')).toBeInTheDocument()
    // Each in-flight subtask becomes its own list item with a numbered
    // label. Labels are stable independent of order changes.
    expect(screen.getByText('子任务 1')).toBeInTheDocument()
    expect(screen.getByText('子任务 2')).toBeInTheDocument()
    expect(screen.getByText('子任务 3')).toBeInTheDocument()
    // Descriptions render in their own <li> (verified by structure, not
    // by appearing concatenated on the header).
    expect(screen.getByText('搜索成都5月底天气')).toBeInTheDocument()
    expect(screen.getByText('搜索成都核心景点')).toBeInTheDocument()
    expect(screen.getByText('搜索成都必吃美食')).toBeInTheDocument()
  })

  it('drops a task from the list once its tool.completed lands', () => {
    // 3 dispatched, 1 already completed → list shows the 2 still alive.
    renderAgentProgress(
      <AgentProgress
        message={message({
          status: 'streaming',
          agentEvents: [
            {
              type: 'tool.requested',
              label: '调用工具：派发子任务',
              tool: 'task',
              toolCallId: 'call_1',
              toolDetail: { kind: 'text', text: '已完成的任务' },
            },
            {
              type: 'tool.requested',
              label: '调用工具：派发子任务',
              tool: 'task',
              toolCallId: 'call_2',
              toolDetail: { kind: 'text', text: '搜索成都核心景点' },
            },
            {
              type: 'tool.requested',
              label: '调用工具：派发子任务',
              tool: 'task',
              toolCallId: 'call_3',
              toolDetail: { kind: 'text', text: '搜索成都必吃美食' },
            },
            { type: 'tool.completed', label: '工具完成：派发子任务', tool: 'task', toolCallId: 'call_1' },
          ],
        })}
        onOpenArtifact={vi.fn()}
        onOpenDiagnostics={vi.fn()}
      />,
    )

    expect(screen.getByText('2 个子任务进行中')).toBeInTheDocument()
    expect(screen.getByText('搜索成都核心景点')).toBeInTheDocument()
    expect(screen.getByText('搜索成都必吃美食')).toBeInTheDocument()
    expect(screen.queryByText('已完成的任务')).not.toBeInTheDocument()
  })

  it('long task descriptions are truncated to ~22 chars in the list rows', () => {
    // Each row stays scannable regardless of how chatty the agent was
    // when writing the dispatch description.
    const long1 =
      '研究成都5月底~6月初的天气情况。搜索并返回以下信息：1. 这个时间段成都的气温范围（白天最高、晚上最低）...'
    const long2 =
      '研究成都必吃美食和推荐餐厅。搜索并返回以下信息：1. 当地最具代表性的菜品和小吃...'
    renderAgentProgress(
      <AgentProgress
        message={message({
          status: 'streaming',
          agentEvents: [
            { type: 'tool.requested', label: '调用工具：派发子任务', tool: 'task', toolCallId: 'a', toolDetail: { kind: 'text', text: long1, tooltip: long1 } },
            { type: 'tool.requested', label: '调用工具：派发子任务', tool: 'task', toolCallId: 'b', toolDetail: { kind: 'text', text: long2, tooltip: long2 } },
          ],
        })}
        onOpenArtifact={vi.fn()}
        onOpenDiagnostics={vi.fn()}
      />,
    )

    // The full long description does NOT appear verbatim in the DOM —
    // it's been clipped + ellipsized so each row stays short.
    expect(screen.queryByText(long1)).not.toBeInTheDocument()
    expect(screen.queryByText(long2)).not.toBeInTheDocument()
    // Each row gets pre-truncated to TASK_DESC_MAX=22 chars in JS.
    // No `…` is appended — the CSS ::after on .agent-progress-task-desc
    // paints an animated "./../..." instead (same keyframes as the
    // headline's .name::after). CSS text-overflow:ellipsis still acts
    // as a secondary safety net for narrow viewports.
    const truncated1 = long1.slice(0, 22)
    const truncated2 = long2.slice(0, 22)
    expect(screen.getByText(truncated1)).toBeInTheDocument()
    expect(screen.getByText(truncated2)).toBeInTheDocument()
    // The visible truncated span carries the full original text in
    // its title="" attribute so hover reveals the whole dispatch
    // description.
    expect(screen.getByText(truncated1).getAttribute('title')).toBe(long1)
    expect(screen.getByText(truncated2).getAttribute('title')).toBe(long2)
  })

  it('with a single task in flight, no list is rendered (no chrome for the common case)', () => {
    // The list UI only kicks in for parallel runs (≥2 in flight).
    // A solo task dispatch keeps the existing simple single-line
    // headline so we don't add chrome around the common case.
    renderAgentProgress(
      <AgentProgress
        message={message({
          status: 'streaming',
          agentEvents: [
            {
              type: 'tool.requested',
              label: '调用工具：派发子任务',
              tool: 'task',
              toolCallId: 'call_solo',
              toolDetail: { kind: 'text', text: '搜索成都5月底天气' },
            },
          ],
        })}
        onOpenArtifact={vi.fn()}
        onOpenDiagnostics={vi.fn()}
      />,
    )

    expect(screen.queryByText(/1 个子任务进行中/)).not.toBeInTheDocument()
    expect(screen.queryByText('子任务 1')).not.toBeInTheDocument()
    expect(screen.getByText('搜索成都5月底天气')).toBeInTheDocument()
  })

  it('derives failed and active progress labels from existing timeline items', () => {
    expect(
      deriveAgentProgress(
        message({
          status: 'error',
          agentEvents: [{ type: 'tool.failed', label: '工具失败：搜索网页' }],
        }),
      ),
    ).toMatchObject({ tone: 'failed', label: '工具失败：搜索网页' })

    expect(
      deriveAgentProgress(
        message({
          status: 'streaming',
          agentEvents: [{ type: 'tool.requested', label: '调用工具：阅读网页正文' }],
        }),
      ),
    ).toMatchObject({ tone: 'working', label: '阅读网页正文' })

    expect(
      deriveAgentProgress(
        message({
          status: 'waiting_input',
          agentEvents: [],
        }),
      ),
    ).toMatchObject({ tone: 'working', label: '等待你的回答' })
  })
})

function renderAgentProgress(node: ReactElement) {
  return render(<I18nProvider>{node}</I18nProvider>)
}
