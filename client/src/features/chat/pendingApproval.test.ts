import { describe, expect, it } from 'vitest'
import { findConversationPendingApproval } from './pendingApproval'
import { createTranslator } from '@/shared/i18n/i18n'
import type { Conversation } from '@/shared/local-data/types'

const t = createTranslator('zh')

function conversation(messages: Conversation['messages']): Conversation {
  return {
    id: 'c1',
    title: 't',
    archived: false,
    createdAt: '2026-05-13T00:00:00Z',
    updatedAt: '2026-05-13T00:00:00Z',
    messages,
  }
}

describe('findConversationPendingApproval', () => {
  it('returns null with no conversation or no pending permission', () => {
    expect(findConversationPendingApproval(undefined, t)).toBeNull()
    expect(
      findConversationPendingApproval(
        conversation([
          {
            id: 'm1',
            role: 'assistant',
            content: '',
            createdAt: '2026-05-13T00:00:00Z',
            status: 'done',
            agentEvents: [{ type: 'tool.completed', label: 'x' }],
          },
        ]),
        t,
      ),
    ).toBeNull()
  })

  it('ignores resolved, auto-approved, and locally submitted requests', () => {
    expect(
      findConversationPendingApproval(
        conversation([
          {
            id: 'm1',
            role: 'assistant',
            content: '',
            createdAt: '2026-05-13T00:00:00Z',
            status: 'done',
            agentEvents: [
              { type: 'permission.required', label: '需要权限：运行命令', permissionRequestId: 'p1', permissionTool: '运行命令' },
              { type: 'permission.resolved', label: '已处理', permissionRequestId: 'p1' },
              { type: 'permission.required', label: '需要权限：打开网页', permissionRequestId: 'p2', permissionTool: '打开网页' },
              { type: 'permission.auto_approved', label: '自动允许', permissionRequestId: 'p2' },
              { type: 'permission.required', label: '需要权限：写文件', permissionRequestId: 'p3', permissionTool: '写文件' },
              { type: 'ui.permission_decision_pending', label: '已提交', permissionRequestId: 'p3' },
            ],
          },
        ]),
        t,
      ),
    ).toBeNull()
  })

  it('keeps a submitted request hidden when an older Runtime projection arrives late', () => {
    const staleProjection = conversation([{
      id: 'm1',
      role: 'assistant',
      content: '',
      createdAt: '2026-05-13T00:00:00Z',
      status: 'waiting_permission',
      agentEvents: [{
        type: 'permission.required',
        label: '需要权限：写文件',
        permissionRequestId: 'p-stale',
        permissionTool: '写文件',
      }],
    }])

    expect(findConversationPendingApproval(staleProjection, t)).toMatchObject({
      requestID: 'p-stale',
    })
    expect(
      findConversationPendingApproval(staleProjection, t, new Set(['p-stale'])),
    ).toBeNull()
  })

  it('returns the newest unresolved request scanning messages newest-first', () => {
    const result = findConversationPendingApproval(
      conversation([
        {
          id: 'm1',
          role: 'assistant',
          content: '',
          createdAt: '2026-05-13T00:00:00Z',
          status: 'done',
          agentEvents: [
            { type: 'permission.required', label: '需要权限：旧', permissionRequestId: 'old', permissionTool: '旧工具' },
            { type: 'permission.resolved', label: '', permissionRequestId: 'old' },
          ],
        },
        {
          id: 'm2',
          role: 'assistant',
          content: '',
          createdAt: '2026-05-13T00:01:00Z',
          status: 'waiting_permission',
          agentEvents: [
            { type: 'permission.required', label: '需要权限：运行命令', permissionRequestId: 'p9', permissionTool: '运行命令' },
          ],
        },
      ]),
      t,
    )
    expect(result).toEqual({ kind: 'approval', messageID: 'm2', requestID: 'p9', tool: '运行命令', toolName: '', arguments: {}, canGrantForRun: false })
  })

  it('falls back to the stripped label when permissionTool is absent', () => {
    const result = findConversationPendingApproval(
      conversation([
        {
          id: 'm1',
          role: 'assistant',
          content: '',
          createdAt: '2026-05-13T00:00:00Z',
          status: 'waiting_permission',
          agentEvents: [{ type: 'permission.required', label: '需要权限：打开受控网页', permissionRequestId: 'p1' }],
        },
      ]),
      t,
    )
    expect(result?.tool).toBe('打开受控网页')
  })

  it('returns an unresolved tool reconciliation and clears it after resolution', () => {
    const pending = findConversationPendingApproval(
      conversation([{
        id: 'm1',
        role: 'assistant',
        content: '',
        createdAt: '2026-05-13T00:00:00Z',
        status: 'waiting_permission',
        agentEvents: [{
          type: 'tool.reconciliation_required',
          label: '需要核对工具结果：运行命令',
          permissionRequestId: 'toolop-1',
          permissionTool: '运行命令',
        }],
      }]),
      t,
    )
    expect(pending?.kind).toBe('reconciliation')

    const resolved = findConversationPendingApproval(
      conversation([{
        id: 'm1',
        role: 'assistant',
        content: '',
        createdAt: '2026-05-13T00:00:00Z',
        status: 'done',
        agentEvents: [
          { type: 'tool.reconciliation_required', label: '', permissionRequestId: 'toolop-1' },
          { type: 'tool.reconciliation_resolved', label: '', permissionRequestId: 'toolop-1' },
        ],
      }]),
      t,
    )
    expect(resolved).toBeNull()
  })
})
