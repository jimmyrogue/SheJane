import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentProgress, deriveAgentProgress } from './AgentProgress'
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

  it('prioritizes the current pending permission and does not render every prior event', () => {
    const onDecision = vi.fn()
    const current = message({
      status: 'waiting_permission',
      agentEvents: [
        { type: 'source.collected', label: '收集来源：Example Source', sourceTitle: 'Example Source', sourceUrl: 'https://example.com/source' },
        { type: 'verification.completed', label: '验证通过：搜索网页', verificationStatus: 'passed' },
        { type: 'permission.required', label: '需要权限：运行命令', permissionRequestId: 'perm-shell', permissionTool: '运行命令' },
      ],
    })

    render(
      <AgentProgress
        message={current}
        onOpenArtifact={vi.fn()}
        onOpenDiagnostics={vi.fn()}
        onPermissionDecision={onDecision}
      />,
    )

    expect(screen.getByText('等待批准：运行命令')).toBeInTheDocument()
    expect(screen.getByText('已收集 1 个来源')).toBeInTheDocument()
    expect(screen.queryByText('收集来源：Example Source')).not.toBeInTheDocument()
    expect(screen.queryByText('验证通过：搜索网页')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('本会话始终允许'))
    expect(onDecision).toHaveBeenCalledWith('perm-shell', 'approve', 'run')
  })

  it('summarizes sources and artifacts while keeping preview and diagnostics actions', () => {
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

    render(
      <AgentProgress
        message={current}
        onOpenArtifact={onOpenArtifact}
        onOpenDiagnostics={onOpenDiagnostics}
        onPermissionDecision={vi.fn()}
      />,
    )

    expect(screen.getByText('任务完成')).toBeInTheDocument()
    expect(screen.getByText('已收集 2 个来源')).toBeInTheDocument()
    expect(screen.getByText('生成 1 个 Artifact')).toBeInTheDocument()

    fireEvent.click(screen.getByText('查看 artifact'))
    expect(onOpenArtifact).toHaveBeenCalledWith('artifact-1')

    fireEvent.click(screen.getByTitle('查看诊断 run-local'))
    expect(onOpenDiagnostics).toHaveBeenCalledWith('run-local')
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
