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
    expect(screen.getByText('正在打开受控网页 weather.com')).toBeInTheDocument()
  })

  it('does not show "已完成 X" as the live headline while the run is still active', () => {
    // Regression for the user-reported "为什么显示的都是 已完成xxx" bug.
    // Between two tool calls the latest activity event is
    // tool.completed for the PREVIOUS tool — but the run keeps going.
    // We re-frame that completed tool as "正在 X" (the agent is still
    // working on its results). We do NOT fall back to "正在思考" here
    // because the ThinkingIndicator above the bubble already says
    // that — duplicate labels read as a broken UI.
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
    expect(screen.queryByText('正在思考')).not.toBeInTheDocument()
    expect(screen.getByText('正在搜索网页')).toBeInTheDocument()
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
    expect(screen.getByText('正在读取文件 README.md')).toBeInTheDocument()
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
    ).toMatchObject({ tone: 'working', label: '正在阅读网页正文' })
  })
})

function renderAgentProgress(node: ReactElement) {
  return render(<I18nProvider>{node}</I18nProvider>)
}
