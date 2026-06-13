import { describe, expect, it } from 'vitest'
import { findConversationPendingPlanApproval } from './pendingPlanApproval'
import type { Conversation } from '@/shared/local-data/types'

function conversation(messages: Conversation['messages']): Conversation {
  return {
    id: 'c1',
    title: 't',
    archived: false,
    createdAt: '2026-06-13T00:00:00Z',
    updatedAt: '2026-06-13T00:00:00Z',
    messages,
  }
}

describe('findConversationPendingPlanApproval', () => {
  it('returns null when there is no pending plan', () => {
    expect(findConversationPendingPlanApproval(undefined)).toBeNull()
    expect(
      findConversationPendingPlanApproval(
        conversation([
          {
            id: 'm1',
            role: 'assistant',
            content: '',
            createdAt: '2026-06-13T00:00:00Z',
            status: 'done',
            agentEvents: [{ type: 'tool.completed', label: 'x' }],
          },
        ]),
      ),
    ).toBeNull()
  })

  it('ignores resolved plan approvals', () => {
    expect(
      findConversationPendingPlanApproval(
        conversation([
          {
            id: 'm1',
            role: 'assistant',
            content: '',
            createdAt: '2026-06-13T00:00:00Z',
            status: 'waiting_input',
            agentEvents: [
              {
                type: 'plan.approval_required',
                label: '等待计划审批',
                planApprovalRequestId: 'plan-1',
                planTodos: [{ content: 'Write tests', status: 'pending' }],
              },
              {
                type: 'plan.approval_resolved',
                label: '计划已批准',
                planApprovalRequestId: 'plan-1',
                planApprovalDecision: 'approve',
              },
            ],
          },
        ]),
      ),
    ).toBeNull()
  })

  it('returns the newest unresolved plan approval', () => {
    const result = findConversationPendingPlanApproval(
      conversation([
        {
          id: 'm1',
          role: 'assistant',
          content: '',
          createdAt: '2026-06-13T00:00:00Z',
          status: 'waiting_input',
          agentEvents: [
            {
              type: 'plan.approval_required',
              label: '旧计划',
              planApprovalRequestId: 'old',
              planTodos: [{ content: 'Old', status: 'pending' }],
            },
            {
              type: 'plan.approval_resolved',
              label: '旧计划已处理',
              planApprovalRequestId: 'old',
              planApprovalDecision: 'reject',
            },
          ],
        },
        {
          id: 'm2',
          role: 'assistant',
          content: '',
          createdAt: '2026-06-13T00:01:00Z',
          status: 'waiting_input',
          agentEvents: [
            {
              type: 'plan.approval_required',
              label: '等待计划审批',
              planApprovalRequestId: 'plan-2',
              planTodos: [{ content: 'New plan', status: 'pending' }],
            },
          ],
        },
      ]),
    )

    expect(result).toEqual({
      messageID: 'm2',
      requestID: 'plan-2',
      todos: [{ content: 'New plan', status: 'pending' }],
    })
  })
})
