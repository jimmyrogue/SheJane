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

  it('collapses the completed summary by default and reveals sources, artifacts and diagnostics on expand', () => {
    const onOpenArtifact = vi.fn()
    const onOpenDiagnostics = vi.fn()
    const current = message({
      status: 'done',
      agentEvents: [
        { type: 'source.collected', label: '收集来源：Source A', sourceTitle: 'Source A', sourceUrl: 'https://a.example' },
        { type: 'source.collected', label: '收集来源：Source B', sourceTitle: 'Source B', sourceUrl: 'https://b.example' },
        { type: 'artifact.created', label: 'Artifact：browser output', artifactId: 'artifact-1', artifactTitle: 'browser output' },
        { type: 'run.completed', label: '任务完成' },
      ],
    })

    renderAgentProgress(
      <AgentProgress
        message={current}
        onOpenArtifact={onOpenArtifact}
        onOpenDiagnostics={onOpenDiagnostics}
      />,
    )

    // Collapsed by default: only the muted summary line, no detail rows.
    expect(screen.getByText('任务完成')).toBeInTheDocument()
    expect(screen.queryByText('已收集 2 个来源')).not.toBeInTheDocument()
    expect(screen.queryByText('查看 artifact')).not.toBeInTheDocument()
    expect(screen.queryByTitle('查看诊断 run-local')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '展开步骤' }))

    expect(screen.getByText('已收集 2 个来源')).toBeInTheDocument()
    expect(screen.getByText('生成 1 个 Artifact')).toBeInTheDocument()

    fireEvent.click(screen.getByText('查看 artifact'))
    expect(onOpenArtifact).toHaveBeenCalledWith('artifact-1')

    fireEvent.click(screen.getByTitle('查看诊断 run-local'))
    expect(onOpenDiagnostics).toHaveBeenCalledWith('run-local')
  })

  it('keeps the failed state muted and only shows the failing steps when expanded', () => {
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
    // Step labels are hidden until the row is expanded.
    expect(screen.queryByText('调用工具：打开受控网页')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '展开步骤' }))
    expect(screen.getByText('调用工具：打开受控网页')).toBeInTheDocument()
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
