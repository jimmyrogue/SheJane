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
