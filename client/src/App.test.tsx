import 'fake-indexeddb/auto'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'

const balance = {
  id: 'wallet-1',
  plan_code: 'free_trial',
  monthly_credit_limit: 10000,
  monthly_credits_used: 0,
  monthly_remaining: 10000,
  extra_credits_balance: 0,
  period_end: '2026-06-10T00:00:00Z',
  status: 'active',
}

describe('user client shell', () => {
  beforeEach(() => {
    indexedDB.deleteDatabase('jiandanly-chat')
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('does not show the admin entry for regular users', async () => {
    mockFetch('user')

    render(<App />)
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'user@example.com' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByText('创建账号'))

    await screen.findByText('user@example.com')
    expect(screen.queryByText('管理后台')).not.toBeInTheDocument()
  })

  it('does not include the admin entry even for admin users', async () => {
    mockFetch('admin')

    render(<App />)
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'admin@example.com' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByText('创建账号'))

    await screen.findByText('admin@example.com')
    expect(screen.queryByText('管理后台')).not.toBeInTheDocument()
    expect(screen.queryByText('运营概览')).not.toBeInTheDocument()
  })

  it('keeps documents inside the unified chat composer instead of a separate workspace', async () => {
    mockFetch('user')

    render(<App />)
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'user@example.com' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByText('创建账号'))

    await screen.findByText('user@example.com')

    expect(screen.queryByText('文档阅读')).not.toBeInTheDocument()
    expect(screen.getByText('附件资料')).toBeInTheDocument()
    expect(screen.getByLabelText('上传附件')).toBeInTheDocument()
    expect(screen.getByText('roadmap.pdf')).toBeInTheDocument()
  })

  it('uploads a document from the composer and attaches it to the next message', async () => {
    const calls = mockFetch('user')

    render(<App />)
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'user@example.com' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByText('创建账号'))

    await screen.findByText('user@example.com')
    const file = new File(['hello'], 'brief.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    })
    fireEvent.change(screen.getByLabelText('上传附件'), { target: { files: [file] } })

    expect(await screen.findByText('已附加 brief.docx')).toBeInTheDocument()
    expect(calls.some((call) => call.url === 'https://s3.example.com/upload' && call.init?.method === 'PUT')).toBe(true)
    expect(calls.some((call) => call.url.endsWith('/api/v1/documents/doc-upload/complete'))).toBe(true)
  })

  it('sends attached document questions through agent runs and stores the answer in chat history', async () => {
    const calls = mockFetch('user')

    render(<App />)
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'user@example.com' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByText('创建账号'))

    await screen.findByText('user@example.com')
    fireEvent.click(screen.getByText('roadmap.pdf'))
    expect(screen.getByText('已附加 roadmap.pdf')).toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText('描述你的问题、任务，或让简单阅读附件'), {
      target: { value: '这份文档的结论是什么？' },
    })
    fireEvent.click(screen.getByText('发送'))

    expect(await screen.findByText('文档回答')).toBeInTheDocument()
    expect(calls.some((call) => call.url.endsWith('/api/v1/agent/runs'))).toBe(true)
    expect(calls.some((call) => call.url.endsWith('/api/v1/agent/runs/run-doc/stream'))).toBe(true)
    expect(calls.some((call) => call.url.endsWith('/api/v1/documents/doc-ready/ask'))).toBe(false)
    expect(calls.some((call) => call.url.endsWith('/api/v1/chat/completions'))).toBe(false)
  })
})

function mockFetch(role: 'admin' | 'user') {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input)
    calls.push({ url, init })
    if (url.endsWith('/api/v1/auth/refresh')) {
      return jsonResponse({ code: 40001, message: '未登录', data: null }, 401)
    }
    if (url.endsWith('/api/v1/auth/register')) {
      return jsonResponse({
        code: 0,
        message: 'ok',
        data: {
          access_token: `${role}-token`,
          user: {
            id: `${role}-1`,
            email: `${role}@example.com`,
            name: role,
            role,
            status: 'active',
          },
        },
      })
    }
    if (url.endsWith('/api/v1/billing/balance')) {
      return jsonResponse({ code: 0, message: 'ok', data: balance })
    }
    if (url.endsWith('/api/v1/documents')) {
      return jsonResponse({
        code: 0,
        message: 'ok',
        data: [
          {
            id: 'doc-ready',
            user_id: `${role}-1`,
            original_name: 'roadmap.pdf',
            content_type: 'application/pdf',
            size_bytes: 1024,
            status: 'ready',
            source_object_key: 'documents/user/doc-ready/source.pdf',
            text_object_key: 'documents/user/doc-ready/extracted.txt',
            expires_at: '2026-05-17T00:00:00Z',
            created_at: '2026-05-10T00:00:00Z',
            updated_at: '2026-05-10T00:00:00Z',
          },
        ],
      })
    }
    if (url.endsWith('/api/v1/documents/uploads')) {
      return jsonResponse({
        code: 0,
        message: 'ok',
        data: {
          document: {
            id: 'doc-upload',
            user_id: `${role}-1`,
            original_name: 'brief.docx',
            content_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            size_bytes: 5,
            status: 'uploading',
            source_object_key: 'documents/user/doc-upload/source.docx',
            expires_at: '2026-05-17T00:00:00Z',
            created_at: '2026-05-10T00:00:00Z',
            updated_at: '2026-05-10T00:00:00Z',
          },
          upload: {
            method: 'PUT',
            url: 'https://s3.example.com/upload',
            headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
            expires_at: '2026-05-10T01:00:00Z',
          },
        },
      })
    }
    if (url === 'https://s3.example.com/upload') {
      return new Response(null, { status: 200 })
    }
    if (url.endsWith('/api/v1/documents/doc-upload/complete')) {
      return jsonResponse({
        code: 0,
        message: 'ok',
        data: {
          id: 'doc-upload',
          user_id: `${role}-1`,
          original_name: 'brief.docx',
          content_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          size_bytes: 5,
          status: 'ready',
          source_object_key: 'documents/user/doc-upload/source.docx',
          text_object_key: 'documents/user/doc-upload/extracted.txt',
          expires_at: '2026-05-17T00:00:00Z',
          created_at: '2026-05-10T00:00:00Z',
          updated_at: '2026-05-10T00:00:00Z',
        },
      })
    }
    if (url.endsWith('/api/v1/agent/runs')) {
      return jsonResponse({
        code: 0,
        message: 'ok',
        data: {
          id: 'run-doc',
          user_id: `${role}-1`,
          origin: 'cloud',
          status: 'queued',
          mode: 'fast',
          goal_summary: '用户任务（12 字，含附件 1 个）',
          expires_at: '2026-05-17T00:00:00Z',
          created_at: '2026-05-10T00:00:00Z',
          updated_at: '2026-05-10T00:00:00Z',
        },
      }, 201)
    }
    if (url.endsWith('/api/v1/agent/runs/run-doc/stream')) {
      return agentSSE([
        { event_type: 'skill.selected', payload: { skill: 'document-analysis' } },
        { event_type: 'tool.completed', payload: { tool: 'document.read' } },
        { event_type: 'llm.delta', payload: { content: '文档回答' } },
        { event_type: 'run.completed', payload: { request_id: 'req-doc-1', credits_cost: 18 } },
      ])
    }
    throw new Error(`Unexpected fetch ${url}`)
  })
  return calls
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function sseResponse(content: string): Response {
  return new Response(`data: {"choices":[{"delta":{"content":"${content}"}}]}\n\ndata: [DONE]\n\n`, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'X-Request-ID': 'req-doc-1',
    },
  })
}

function agentSSE(events: Array<{ event_type: string; payload: Record<string, unknown> }>): Response {
  const body = `${events
    .map((event, index) => `event: agent.event\ndata: ${JSON.stringify({ id: `event-${index}`, run_id: 'run-doc', seq: index + 1, created_at: '2026-05-10T00:00:00Z', ...event })}`)
    .join('\n\n')}\n\ndata: [DONE]\n\n`
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'X-Request-ID': 'req-doc-1',
    },
  })
}
