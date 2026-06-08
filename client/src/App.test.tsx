import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The composer's document upload now goes through an XHR-based helper
// (for upload progress reporting); jsdom can't hit the real S3 host
// the upload tests assert against, so we stub the helper to immediately
// succeed and mirror the request onto the shared mockFetch `calls`
// recorder. Tests can then keep asserting on `calls.some(call => …)`
// without caring whether the underlying transport was fetch or XHR.
const recordedUploadCalls: Array<{ url: string; method: string }> = []
vi.mock('./shared/api/uploadWithProgress', () => ({
  uploadWithProgress: vi.fn(async (options: { method: string; url: string; onProgress?: (e: { loaded: number; total: number; percent: number }) => void }) => {
    recordedUploadCalls.push({ url: options.url, method: options.method })
    options.onProgress?.({ loaded: 100, total: 100, percent: 100 })
    return { status: 200, ok: true, body: '' }
  }),
}))

import { App } from './App'
import { $createParagraphNode, $createTextNode, $getRoot } from 'lexical'

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
    const freshIndexedDB = new IDBFactory()
    Object.defineProperty(globalThis, 'indexedDB', { value: freshIndexedDB, configurable: true })
    Object.defineProperty(window, 'indexedDB', { value: freshIndexedDB, configurable: true })
    localStorage.clear()
    window.shejaneDesktop = undefined
    recordedUploadCalls.length = 0
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

    await awaitSignedIn()
    expect(screen.queryByText('管理后台')).not.toBeInTheDocument()
    expect(document.querySelector('.window-titlebar')).toBeNull()
    expect(screen.getByRole('button', { name: '收起侧栏' })).toBeInTheDocument()
    // Search button used to be asserted here as a sanity check that
    // the sidebar header rendered. It's been removed product-side, so
    // we just keep the "收起侧栏" assertion as the sidebar-rendered
    // signal.
  })

  it('does not include the admin entry even for admin users', async () => {
    mockFetch('admin')

    render(<App />)
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'admin@example.com' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByText('创建账号'))

    await awaitSignedIn()
    expect(screen.queryByText('管理后台')).not.toBeInTheDocument()
    expect(screen.queryByText('运营概览')).not.toBeInTheDocument()
  })

  it('lets users resize the sidebar within fixed bounds and persists the width', async () => {
    mockFetch('user')

    render(<App />)
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'user@example.com' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByText('创建账号'))

    await awaitSignedIn()
    const resizeHandle = screen.getByRole('separator', { name: '调整侧栏宽度' })
    const shell = resizeHandle.closest('.app-shell') as HTMLElement

    expect(shell.style.getPropertyValue('--sidebar-width')).toBe('220px')
    expect(resizeHandle).toHaveAttribute('aria-valuemin', '176')
    expect(resizeHandle).toHaveAttribute('aria-valuemax', '340')

    fireEvent.keyDown(resizeHandle, { key: 'Home' })
    expect(shell.style.getPropertyValue('--sidebar-width')).toBe('176px')
    expect(resizeHandle).toHaveAttribute('aria-valuenow', '176')

    fireEvent.keyDown(resizeHandle, { key: 'End' })
    expect(shell.style.getPropertyValue('--sidebar-width')).toBe('340px')
    await waitFor(() => expect(localStorage.getItem('shejane.sidebar.width.v1')).toBe('340'))

    // Collapsing is now a separate state (data-collapsed) rather than a width clamp.
    fireEvent.click(screen.getByRole('button', { name: '收起侧栏' }))
    expect(shell).toHaveAttribute('data-collapsed', 'true')
  })

  it('restores an Electron login session through the desktop auth bridge on startup', async () => {
    const calls = mockFetch('user')
    const refresh = vi.fn().mockResolvedValue({
      access_token: 'electron-token',
      user: {
        id: 'electron-1',
        email: 'electron@example.com',
        name: 'Electron',
        role: 'user',
        status: 'active',
      },
    })
    window.shejaneDesktop = {
      platform: 'darwin',
      auth: {
        register: vi.fn(),
        login: vi.fn(),
        refresh,
        logout: vi.fn(),
      },
    }

    render(<App />)

    await openAccountMenu()
    expect(await screen.findByText('electron@example.com')).toBeInTheDocument()
    expect(refresh).toHaveBeenCalled()
    expect(calls.some((call) => call.url.endsWith('/api/v1/auth/refresh'))).toBe(false)
  })

  it('opens the Stripe checkout from the account-menu top-up entry', async () => {
    const calls = mockFetch('user')
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null)

    render(<App />)
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'user@example.com' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByText('创建账号'))

    await awaitSignedIn()
    await openAccountMenu()
    fireEvent.click(await screen.findByText('充值'))

    await waitFor(() =>
      expect(calls.some((call) => call.url.endsWith('/api/v1/billing/subscription/checkout'))).toBe(true),
    )
    await waitFor(() =>
      expect(openSpy).toHaveBeenCalledWith('https://stripe.example.com/checkout/sess_test', '_blank', 'noopener,noreferrer'),
    )
  })

  it('shows the login screen when the Electron auth bridge cannot refresh the session', async () => {
    const calls = mockFetch('user')
    const refresh = vi.fn().mockRejectedValue(new Error('expired'))
    window.shejaneDesktop = {
      platform: 'darwin',
      auth: {
        register: vi.fn(),
        login: vi.fn(),
        refresh,
        logout: vi.fn(),
      },
    }

    render(<App />)

    expect(await screen.findByText('创建账号')).toBeInTheDocument()
    expect(refresh).toHaveBeenCalled()
    expect(calls.some((call) => call.url.endsWith('/api/v1/auth/refresh'))).toBe(false)
  })

  it('renders the auth screen for sign up and sign in', async () => {
    mockFetch('user')

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: 'English' }))

    expect(screen.getByRole('heading', { name: 'Create your account' })).toBeInTheDocument()
    expect(screen.getByText('Free forever. Upgrade when you outgrow it.')).toBeInTheDocument()
    expect(screen.getByLabelText('Email')).toBeInTheDocument()
    expect(screen.getByLabelText('Password')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Sign in/i }))

    expect(screen.getByRole('heading', { name: 'Welcome back' })).toBeInTheDocument()
    expect(screen.getByText('Keep me signed in on this device')).toBeInTheDocument()
  })

  it('switches the client between Chinese and English and persists the choice', async () => {
    mockFetch('user')

    const { unmount } = render(<App />)

    expect(await screen.findByRole('heading', { name: '创建你的账号' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'English' }))

    expect(screen.getByRole('heading', { name: 'Create your account' })).toBeInTheDocument()
    expect(localStorage.getItem('shejane.locale')).toBe('en')

    unmount()
    render(<App />)

    expect(await screen.findByRole('heading', { name: 'Create your account' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '中文' }))
    expect(screen.getByRole('heading', { name: '创建你的账号' })).toBeInTheDocument()
    expect(localStorage.getItem('shejane.locale')).toBe('zh')
  })

  it('uploads a document from the composer and attaches it to the next message', async () => {
    const calls = mockFetch('user')

    render(<App />)
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'user@example.com' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByText('创建账号'))

    await awaitSignedIn()
    const file = new File(['hello'], 'brief.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    })
    // The attach button now opens the OS file picker directly; in
    // jsdom we drive the hidden <input type="file"> via its aria-label.
    fireEvent.change(screen.getByLabelText('上传附件'), { target: { files: [file] } })

    // The chip is a thumbnail tile that exposes the filename only via
    // its `title` attribute (browser tooltip on long hover).
    expect(await screen.findByTitle('brief.docx')).toBeInTheDocument()
    // S3 PUT now goes through the XHR-based uploadWithProgress helper
    // (so the chip can show byte-level upload progress on slow
    // cross-border S3 puts). The recorder above captures every helper
    // call; we assert against it instead of `fetch`.
    expect(recordedUploadCalls.some((call) => call.url === 'https://s3.example.com/upload' && call.method === 'PUT')).toBe(true)
    expect(calls.some((call) => call.url.endsWith('/api/v1/documents/doc-upload/complete'))).toBe(true)
  })

  it('sends attached document questions through agent runs and stores the answer in chat history', async () => {
    const calls = mockFetch('user')

    render(<App />)
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'user@example.com' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByText('创建账号'))

    await awaitSignedIn()
    // Previously this test re-attached a pre-existing document from a
    // dialog list; that UI is gone, so upload a fresh file. (The mock
    // upload endpoint hardcodes `brief.docx` as original_name regardless
    // of what we send — see the `/api/v1/documents/uploads` mock below.)
    const file = new File(['hello'], 'brief.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    })
    fireEvent.change(screen.getByLabelText('上传附件'), { target: { files: [file] } })
    // The chip is a thumbnail tile that exposes the filename only via
    // its `title` attribute (browser tooltip on long hover).
    expect(await screen.findByTitle('brief.docx')).toBeInTheDocument()

    typeComposer('这份文档的结论是什么？')
    fireEvent.click(screen.getByText('发送'))

    // useSmoothTextStream animates the reply in character-by-character;
    // bump the wait so the full text drains even on slower CI.
    await waitFor(() => expect(screen.getByText('文档回答')).toBeInTheDocument(), { timeout: 3000 })
    expect(calls.some((call) => call.url.endsWith('/api/v1/agent/runs'))).toBe(true)
    expect(calls.some((call) => call.url.endsWith('/api/v1/agent/runs/run-doc/stream'))).toBe(true)
    expect(calls.some((call) => call.url.endsWith('/api/v1/documents/doc-ready/ask'))).toBe(false)
    expect(calls.some((call) => call.url.endsWith('/api/v1/chat/completions'))).toBe(false)
  })

  it('keeps a blank new chat active when an older cloud stream updates in the background', async () => {
    const agentStream = createDeferredAgentStream('run-doc')
    mockFetch('user', { agentStream })

    render(<App />)
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'user@example.com' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByText('创建账号'))

    await awaitSignedIn()
    typeComposer('旧任务')
    fireEvent.click(screen.getByText('发送'))

    expect((await screen.findAllByText('旧任务')).length).toBeGreaterThan(0)
    fireEvent.click(screen.getAllByRole('button', { name: '新对话' })[0])
    expect(await screen.findByText('把复杂的工作，简单做完')).toBeInTheDocument()

    act(() => {
      agentStream.emit({ event_type: 'llm.delta', payload: { content: '旧回答' } })
      agentStream.emit({ event_type: 'run.completed', payload: { request_id: 'req-old-1', credits_cost: 2 } })
      agentStream.done()
    })
    await settleStreamRender()

    expect(screen.getByText('把复杂的工作，简单做完')).toBeInTheDocument()
    expect(screen.queryByText('旧回答')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '旧任务' }))
    expect(await screen.findByText('旧回答')).toBeInTheDocument()
  })

  it('keeps a new chat active when an older local harness stream updates after permission waiting', async () => {
    const localRunStream = createDeferredAgentStream('local-run')
    mockFetch('user', { localRunStream })
    window.shejaneDesktop = {
      platform: 'darwin',
      localHost: {
        baseURL: 'http://127.0.0.1:17371',
        token: 'local-token',
      },
    }

    render(<App />)
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'user@example.com' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByText('创建账号'))

    await awaitSignedIn()
    // (workspace binding removed — routing to the local harness no
    // longer requires a bound workspace; UI entry was retired in
    // feat/client-ui)
    typeComposer('运行本地检查')
    fireEvent.click(screen.getByText('发送'))

    expect((await screen.findAllByText('运行本地检查')).length).toBeGreaterThan(0)
    act(() => {
      localRunStream.emit({ id: 'local-event-1', event_type: 'permission.required', payload: { request_id: 'perm-shell', tool: 'shell.run' } })
    })
    expect((await screen.findAllByText('等待批准：运行命令')).length).toBeGreaterThan(0)

    fireEvent.click(screen.getAllByRole('button', { name: '新对话' })[0])
    expect(await screen.findByText('把复杂的工作，简单做完')).toBeInTheDocument()

    act(() => {
      localRunStream.emit({ id: 'local-event-2', event_type: 'llm.delta', payload: { content: '本地执行完成' } })
      localRunStream.emit({ id: 'local-event-3', event_type: 'run.completed', payload: { final: '本地执行完成' } })
      localRunStream.done()
    })
    await settleStreamRender()

    expect(screen.getByText('把复杂的工作，简单做完')).toBeInTheDocument()
    expect(screen.queryByText('本地执行完成')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '运行本地检查' }))
    expect(await screen.findByText('本地执行完成')).toBeInTheDocument()
  })

  it('fires a desktop notification when a local run fails', async () => {
    const localRunStream = createDeferredAgentStream('local-run')
    mockFetch('user', { localRunStream })
    const notify = vi.fn(async () => true)
    window.shejaneDesktop = {
      platform: 'darwin',
      notify,
      localHost: {
        baseURL: 'http://127.0.0.1:17371',
        token: 'local-token',
      },
    }

    render(<App />)
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'user@example.com' } })
    fireEvent.change(screen.getByLabelText('密码', { exact: true }), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByText('创建账号'))
    await awaitSignedIn()

    typeComposer('运行本地检查')
    fireEvent.click(screen.getByText('发送'))
    expect((await screen.findAllByText('运行本地检查')).length).toBeGreaterThan(0)

    act(() => {
      localRunStream.emit({ id: 'fail-event-1', event_type: 'run.failed', payload: { message: '工具调用超时' } })
      localRunStream.done()
    })
    await settleStreamRender()

    await waitFor(() => {
      expect(notify).toHaveBeenCalledWith({ title: '石间任务失败', body: '工具调用超时' })
    })
  })

  it('fires the completion notification on a successful local run', async () => {
    const localRunStream = createDeferredAgentStream('local-run')
    mockFetch('user', { localRunStream })
    const notify = vi.fn(async () => true)
    window.shejaneDesktop = {
      platform: 'darwin',
      notify,
      localHost: {
        baseURL: 'http://127.0.0.1:17371',
        token: 'local-token',
      },
    }

    render(<App />)
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'user@example.com' } })
    fireEvent.change(screen.getByLabelText('密码', { exact: true }), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByText('创建账号'))
    await awaitSignedIn()

    typeComposer('运行本地检查')
    fireEvent.click(screen.getByText('发送'))
    expect((await screen.findAllByText('运行本地检查')).length).toBeGreaterThan(0)

    act(() => {
      localRunStream.emit({ id: 'ok-event-1', event_type: 'llm.delta', payload: { content: '完成了' } })
      localRunStream.emit({ id: 'ok-event-2', event_type: 'run.completed', payload: { final: '完成了' } })
      localRunStream.done()
    })
    await settleStreamRender()

    await waitFor(() => {
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: '石间回复完成' }))
    })
  })

  it('deletes a message pair after confirming in the dialog', async () => {
    const localRunStream = createDeferredAgentStream('local-run')
    mockFetch('user', { localRunStream })
    window.shejaneDesktop = {
      platform: 'darwin',
      localHost: {
        baseURL: 'http://127.0.0.1:17371',
        token: 'local-token',
      },
    }

    render(<App />)
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'user@example.com' } })
    fireEvent.change(screen.getByLabelText('密码', { exact: true }), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByText('创建账号'))
    await awaitSignedIn()

    typeComposer('要删除的问题')
    fireEvent.click(screen.getByText('发送'))
    expect((await screen.findAllByText('要删除的问题')).length).toBeGreaterThan(0)
    act(() => {
      localRunStream.emit({ id: 'del-1', event_type: 'llm.delta', payload: { content: '要删除的回答' } })
      localRunStream.emit({ id: 'del-2', event_type: 'run.completed', payload: { final: '要删除的回答' } })
      localRunStream.done()
    })
    await settleStreamRender()
    expect(await screen.findByText('要删除的回答')).toBeInTheDocument()

    // Delete the user message (the first 删除 button) → confirm in the dialog.
    fireEvent.click(screen.getAllByRole('button', { name: '删除' })[0])
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: '删除' }))

    // The reply text lives only in the timeline (not the sidebar title), so
    // its removal proves the pair was deleted.
    await waitFor(() => {
      expect(screen.queryByText('要删除的回答')).not.toBeInTheDocument()
    })
  })

  it('shows the email-verification banner and resends on click', async () => {
    const calls = mockFetch('user', { emailVerified: false })
    window.shejaneDesktop = {
      platform: 'darwin',
      localHost: { baseURL: 'http://127.0.0.1:17371', token: 'local-token' },
    }

    render(<App />)
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'user@example.com' } })
    fireEvent.change(screen.getByLabelText('密码', { exact: true }), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByText('创建账号'))
    await awaitSignedIn()

    expect(await screen.findByText('邮箱尚未验证,请查收验证邮件')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '重新发送' }))
    await waitFor(() =>
      expect(calls.some((call) => call.url.endsWith('/api/v1/auth/email/verify-request'))).toBe(true),
    )
  })

  it('hides the email-verification banner for a verified user', async () => {
    mockFetch('user', { emailVerified: true })
    window.shejaneDesktop = {
      platform: 'darwin',
      localHost: { baseURL: 'http://127.0.0.1:17371', token: 'local-token' },
    }

    render(<App />)
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'user@example.com' } })
    fireEvent.change(screen.getByLabelText('密码', { exact: true }), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByText('创建账号'))
    await awaitSignedIn()

    expect(screen.queryByText('邮箱尚未验证,请查收验证邮件')).not.toBeInTheDocument()
  })

  it('syncs the cloud login session into the paired Local Harness', async () => {
    const calls = mockFetch('user')
    window.shejaneDesktop = {
      platform: 'darwin',
      localHost: {
        baseURL: 'http://127.0.0.1:17371',
        token: 'local-token',
      },
    }

    render(<App />)
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'user@example.com' } })
    fireEvent.change(screen.getByLabelText('密码', { exact: true }), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByText('创建账号'))

    await awaitSignedIn()
    // The renderer pushes the cloud session (base URL + access token) to the
    // paired daemon so its gateway-billed tools can call the cloud.
    await waitFor(() => {
      expect(
        calls.some(
          (call) =>
            call.url === 'http://127.0.0.1:17371/local/v1/session' &&
            call.init?.method === 'POST' &&
            call.init.body === JSON.stringify({ cloud_base_url: 'http://localhost:8080', access_token: 'user-token' }),
        ),
      ).toBe(true)
    })
  })

  it('binds a picked Electron workspace and sends its path with local runs', async () => {
    const calls = mockFetch('user')
    window.shejaneDesktop = {
      platform: 'darwin',
      localHost: {
        baseURL: 'http://127.0.0.1:17371',
        token: 'local-token',
      },
      selectWorkspaceDirectory: vi.fn().mockResolvedValue('/tmp/picked-workspace'),
    }

    render(<App />)
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'user@example.com' } })
    fireEvent.change(screen.getByLabelText('密码', { exact: true }), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByText('创建账号'))

    await awaitSignedIn()
    // Bind a workspace via the project picker (native folder chooser stubbed).
    fireEvent.click(await screen.findByRole('button', { name: '添加项目' }))
    expect((await screen.findAllByText('picked-workspace')).length).toBeGreaterThan(0)
    typeComposer('检查这个项目')
    fireEvent.click(screen.getByText('发送'))

    // The workspace was authorized with the daemon, and its path rides along
    // with the run that the bound conversation starts.
    expect(calls.some((call) => call.url === 'http://127.0.0.1:17371/local/v1/workspaces' && call.init?.method === 'POST')).toBe(true)
    await waitFor(() => {
      const bodies = calls
        .filter((call) => call.url === 'http://127.0.0.1:17371/local/v1/runs' && call.init?.method === 'POST')
        .map((call) => JSON.parse(call.init?.body as string))
      expect(bodies).toContainEqual(expect.objectContaining({ goal: '检查这个项目', workspace_path: '/tmp/picked-workspace' }))
    })
  })

  it('hides recent local runs from the sidebar', async () => {
    mockFetch('user', {
      localRuns: [
        {
          id: 'recover-run',
          goal: 'Resume workspace scan',
          status: 'running',
          created_at: '2026-05-11T00:00:00Z',
          updated_at: '2026-05-11T00:00:01Z',
          events_count: 2,
        },
      ],
    })
    window.shejaneDesktop = {
      platform: 'darwin',
      localHost: {
        baseURL: 'http://127.0.0.1:17371',
        token: 'local-token',
      },
    }

    render(<App />)
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'user@example.com' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByText('创建账号'))

    await awaitSignedIn()
    expect(screen.queryByText('最近本地任务')).not.toBeInTheDocument()
    expect(screen.queryByText('Resume workspace scan')).not.toBeInTheDocument()
  })

  it('exposes import and export in each conversation more menu', async () => {
    mockFetch('user')
    const createObjectURL = vi.fn(() => 'blob:conversation-export')
    const revokeObjectURL = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true })
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)

    render(<App />)
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'user@example.com' } })
    fireEvent.change(screen.getByLabelText('密码', { exact: true }), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByText('创建账号'))

    await awaitSignedIn()
    typeComposer('你好')
    fireEvent.click(screen.getByText('发送'))

    // Import/export live in the per-conversation row menu ("更多 {title}"),
    // not a global topbar menu (which was removed).
    openMoreMenu(await screen.findByTitle('更多 你好'))
    expect(await screen.findByText('导出此对话')).toBeInTheDocument()
    expect(screen.getByText('导入聊天数据')).toBeInTheDocument()
    fireEvent.click(screen.getByText('导出此对话'))
    await waitFor(() => expect(createObjectURL).toHaveBeenCalled())
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:conversation-export')
    expect(await screen.findByText('已导出对话：你好')).toBeInTheDocument()
  })

  it('stores workspace references per conversation', async () => {
    const selectWorkspaceDirectory = vi
      .fn()
      .mockResolvedValueOnce('/tmp/one')
      .mockResolvedValueOnce('/tmp/two')
    const calls = mockFetch('user')
    window.shejaneDesktop = {
      platform: 'darwin',
      localHost: {
        baseURL: 'http://127.0.0.1:17371',
        token: 'local-token',
      },
      selectWorkspaceDirectory,
    }

    render(<App />)
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'user@example.com' } })
    fireEvent.change(screen.getByLabelText('密码', { exact: true }), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByText('创建账号'))

    await awaitSignedIn()
    // First conversation bound to /tmp/one.
    fireEvent.click(await screen.findByRole('button', { name: '添加项目' }))
    expect((await screen.findAllByText('one')).length).toBeGreaterThan(0)
    typeComposer('第一个任务')
    fireEvent.click(screen.getByText('发送'))
    expect((await screen.findAllByText('等待批准：运行命令')).length).toBeGreaterThan(0)

    // New conversation, bound to a different workspace /tmp/two.
    fireEvent.click(screen.getAllByRole('button', { name: '新对话' })[0])
    fireEvent.click(await screen.findByRole('button', { name: '添加项目' }))
    expect((await screen.findAllByText('two')).length).toBeGreaterThan(0)
    typeComposer('第二个任务')
    fireEvent.click(screen.getByText('发送'))

    // Each conversation's run carried its OWN workspace path.
    await waitFor(() => {
      const bodies = calls
        .filter((call) => call.url === 'http://127.0.0.1:17371/local/v1/runs' && call.init?.method === 'POST')
        .map((call) => JSON.parse(call.init?.body as string))
      expect(bodies).toContainEqual(expect.objectContaining({ goal: '第一个任务', workspace_path: '/tmp/one' }))
      expect(bodies).toContainEqual(expect.objectContaining({ goal: '第二个任务', workspace_path: '/tmp/two' }))
    })
  })
})

function typeComposer(value: string) {
  const element = document.querySelector('[data-lexical-editor="true"]') as unknown as {
    __lexicalEditor?: {
      update: (fn: () => void, options?: { discrete?: boolean }) => void
    }
  } | null
  const editor = element?.__lexicalEditor
  if (!editor) {
    throw new Error('composer editor not mounted')
  }
  act(() => {
    editor.update(
      () => {
        const root = $getRoot()
        root.clear()
        const paragraph = $createParagraphNode()
        paragraph.append($createTextNode(value))
        root.append(paragraph)
      },
      { discrete: true },
    )
  })
}

function openMoreMenu(trigger: HTMLElement) {
  trigger.focus()
  fireEvent.keyDown(trigger, { key: 'Enter', code: 'Enter' })
}

// The signed-in shell no longer prints the full email in always-visible chrome;
// it lives behind the bottom "设置" (settings) dropdown — the stable "we are
// logged in" signal is that trigger being present in the sidebar.
async function awaitSignedIn(): Promise<HTMLElement> {
  return screen.findByRole('button', { name: '设置' })
}

async function openAccountMenu(): Promise<void> {
  const trigger = await awaitSignedIn()
  trigger.focus()
  fireEvent.keyDown(trigger, { key: 'Enter', code: 'Enter' })
}

async function settleStreamRender() {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 90))
  })
}

interface DeferredAgentStream {
  emit: (event: { id?: string; event_type: string; payload: Record<string, unknown> }) => void
  done: () => void
  response: () => Response
}

function createDeferredAgentStream(runID: string): DeferredAgentStream {
  const encoder = new TextEncoder()
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  let seq = 0
  const stream = new ReadableStream<Uint8Array>({
    start(nextController) {
      controller = nextController
    },
  })
  return {
    emit(event) {
      seq += 1
      controller?.enqueue(
        encoder.encode(
          `event: agent.event\ndata: ${JSON.stringify({
            id: event.id ?? `event-${seq}`,
            run_id: runID,
            seq,
            created_at: '2026-05-10T00:00:00Z',
            ...event,
          })}\n\n`,
        ),
      )
    },
    done() {
      controller?.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller?.close()
    },
    response() {
      return new Response(stream, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'X-Request-ID': 'req-doc-1',
        },
      })
    },
  }
}

function mockFetch(
  role: 'admin' | 'user',
  options: {
    workspaces?: Array<{ id: string; path: string; label: string }>
    localRuns?: Array<{ id: string; goal: string; status: string; created_at: string; updated_at: string; events_count?: number }>
    agentStream?: DeferredAgentStream
    localRunStream?: DeferredAgentStream
    emailVerified?: boolean
  } = {},
) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  let workspaces = options.workspaces ?? []
  const localRuns = options.localRuns ?? []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input)
    calls.push({ url, init })
    if (url.endsWith('/api/v1/auth/refresh')) {
      return jsonResponse({ code: 40001, message: '未登录', data: null }, 401)
    }
    if (url === 'http://127.0.0.1:17371/local/v1/health') {
      return new Response(
        JSON.stringify({
          status: 'ok',
          mode: 'daemon',
          worker: 'user',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    if (url === 'http://127.0.0.1:17371/local/v1/session' && init?.method === 'POST') {
      return new Response(
        JSON.stringify({
          connected: true,
          cloud_base_url: 'http://localhost:8080',
          auth: 'bearer',
          updated_at: '2026-05-11T00:00:00Z',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    if (url === 'http://127.0.0.1:17371/local/v1/session' && init?.method === 'DELETE') {
      return new Response(JSON.stringify({ connected: false }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (url === 'http://127.0.0.1:17371/local/v1/runs' && init?.method === 'POST') {
      return new Response(
        JSON.stringify({
          id: 'local-run',
          goal: '运行本地检查',
          status: 'queued',
          created_at: '2026-05-11T00:00:00Z',
          updated_at: '2026-05-11T00:00:00Z',
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      )
    }
    if (url === 'http://127.0.0.1:17371/local/v1/runs') {
      return new Response(JSON.stringify({ runs: localRuns }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (url === 'http://127.0.0.1:17371/local/v1/workspaces' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body ?? '{}')) as { path?: string }
      const path = body.path ?? ''
      const workspace = {
        id: 'workspace-picked',
        path,
        label: path.split('/').filter(Boolean).at(-1) ?? path,
      }
      workspaces = [workspace, ...workspaces.filter((item) => item.id !== workspace.id && item.path !== workspace.path)]
      return new Response(
        JSON.stringify({
          ...workspace,
          created_at: '2026-05-11T00:00:00Z',
          last_used_at: '2026-05-11T00:00:00Z',
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      )
    }
    if (url === 'http://127.0.0.1:17371/local/v1/workspaces/diagnose') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { path?: string }
      const workspace = workspaces.find((item) => item.path === body.path)
      return new Response(
        JSON.stringify({
          path: body.path,
          exists: true,
          is_directory: true,
          authorized: Boolean(workspace),
          reason: workspace ? 'authorized' : 'not_authorized',
          workspace,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    if (url.startsWith('http://127.0.0.1:17371/local/v1/workspaces/') && init?.method === 'DELETE') {
      const id = url.split('/').at(-1)
      const workspace = workspaces.find((item) => item.id === id)
      workspaces = workspaces.filter((item) => item.id !== id)
      return new Response(
        JSON.stringify({
          ...workspace,
          revoked: true,
        }),
        { status: workspace ? 200 : 404, headers: { 'Content-Type': 'application/json' } },
      )
    }
    if (url === 'http://127.0.0.1:17371/local/v1/workspaces') {
      return new Response(JSON.stringify({ workspaces }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (url === 'http://127.0.0.1:17371/local/v1/runs/local-run/stream') {
      if (options.localRunStream) {
        return options.localRunStream.response()
      }
      const permissionApproved = calls.some((call) => call.url === 'http://127.0.0.1:17371/local/v1/permissions/perm-shell')
      return agentSSE(
        permissionApproved
          ? [
              { id: 'local-event-1', event_type: 'permission.required', payload: { request_id: 'perm-shell', tool: 'shell.run' } },
              { id: 'local-event-2', event_type: 'permission.resolved', payload: { request_id: 'perm-shell', decision: 'approve', tool: 'shell.run', scope: 'run' } },
              { id: 'local-event-3', event_type: 'artifact.created', payload: { artifact_id: 'artifact-shell', title: 'shell output', tool: 'shell.run' } },
              { id: 'local-event-4', event_type: 'source.collected', payload: { title: 'Example Source', url: 'https://example.com/source', artifact_id: 'artifact-shell', tool: 'browser.read' } },
              { id: 'local-event-5', event_type: 'verification.completed', payload: { tool: 'shell.run', status: 'passed' } },
              { id: 'local-event-6', event_type: 'llm.delta', payload: { content: '本地执行完成' } },
              { id: 'local-event-7', event_type: 'run.completed', payload: { final: '本地执行完成' } },
            ]
          : [
              { id: 'local-event-1', event_type: 'permission.required', payload: { request_id: 'perm-shell', tool: 'shell.run' } },
              { id: 'local-event-3', event_type: 'artifact.created', payload: { artifact_id: 'artifact-shell', title: 'shell output', tool: 'shell.run' } },
            ],
        'local-run',
      )
    }
    if (url === 'http://127.0.0.1:17371/local/v1/runs/local-run/diagnostics') {
      return new Response(
        JSON.stringify({
          schema_version: 1,
          exported_at: '2026-05-11T00:00:03Z',
          run: {
            id: 'local-run',
            goal: '运行本地检查',
            status: 'completed',
            created_at: '2026-05-11T00:00:00Z',
            updated_at: '2026-05-11T00:00:03Z',
          },
          events: [
            { id: 'diag-event-1', event_type: 'source.collected', payload: { title: 'Example Source', url: 'https://example.com/source' } },
            { id: 'diag-event-2', event_type: 'verification.completed', payload: { tool: 'browser.verify', status: 'passed' } },
            { id: 'diag-event-3', event_type: 'tool.failed', payload: { tool: 'browser.open', error_code: 'browser_http_error' } },
          ],
          permissions: [
            {
              id: 'perm-shell',
              run_id: 'local-run',
              tool_call_id: 'call-shell',
              tool_name: 'shell.run',
              arguments: { command: 'printf ok' },
              status: 'approved',
              scope: 'run',
              created_at: '2026-05-11T00:00:01Z',
              resolved_at: '2026-05-11T00:00:02Z',
            },
          ],
          artifacts: [
            {
              id: 'artifact-shell',
              run_id: 'local-run',
              kind: 'tool_output',
              title: 'shell output',
              content_type: 'text/plain',
              bytes: 22,
              tool_name: 'shell.run',
              created_at: '2026-05-11T00:00:02Z',
            },
          ],
          latest_checkpoint: { id: 'checkpoint-local', step: 2, reason: 'permission_resolved', messages_count: 4 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    if (url === 'http://127.0.0.1:17371/local/v1/runs/recover-run/stream') {
      return agentSSE([
        { id: 'recover-event-1', event_type: 'checkpoint.resumed', payload: { checkpoint_id: 'checkpoint-1', reason: 'test_resume' } },
        { id: 'recover-event-2', event_type: 'llm.delta', payload: { content: '恢复后的本地结果' } },
        { id: 'recover-event-3', event_type: 'run.completed', payload: { final: '恢复后的本地结果' } },
      ], 'recover-run')
    }
    if (url === 'http://127.0.0.1:17371/local/v1/runs/recover-run/diagnostics') {
      return new Response(
        JSON.stringify({
          schema_version: 1,
          exported_at: '2026-05-11T00:00:02Z',
          run: localRuns[0],
          events: [],
          permissions: [],
          artifacts: [],
          latest_checkpoint: { id: 'checkpoint-1', step: 1, reason: 'test_resume', messages_count: 3 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    if (url === 'http://127.0.0.1:17371/local/v1/permissions/perm-shell') {
      return new Response(JSON.stringify({ status: 'recorded' }), { status: 202 })
    }
    if (url === 'http://127.0.0.1:17371/local/v1/artifacts/artifact-shell') {
      return new Response(
        JSON.stringify({
          id: 'artifact-shell',
          title: 'shell output',
          content: 'artifact preview content',
          tool_name: 'shell.run',
          created_at: '2026-05-11T00:00:00Z',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
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
            email_verified: options.emailVerified ?? true,
          },
        },
      })
    }
    if (url.endsWith('/api/v1/auth/email/verify-request')) {
      return jsonResponse({ code: 0, message: 'ok', data: { sent: true } })
    }
    if (url.endsWith('/api/v1/auth/email/verify-confirm')) {
      return jsonResponse({ code: 0, message: 'ok', data: { verified: true } })
    }
    if (url.endsWith('/api/v1/billing/balance')) {
      return jsonResponse({ code: 0, message: 'ok', data: balance })
    }
    if (url.endsWith('/api/v1/billing/subscription/checkout')) {
      return jsonResponse({ code: 0, message: 'ok', data: { checkout_url: 'https://stripe.example.com/checkout/sess_test' } })
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
      if (options.agentStream) {
        return options.agentStream.response()
      }
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

function agentSSE(events: Array<{ id?: string; event_type: string; payload: Record<string, unknown> }>, runID = 'run-doc'): Response {
  const body = `${events
    .map((event, index) => `event: agent.event\ndata: ${JSON.stringify({ id: event.id ?? `event-${index}`, run_id: runID, seq: index + 1, created_at: '2026-05-10T00:00:00Z', ...event })}`)
    .join('\n\n')}\n\ndata: [DONE]\n\n`
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'X-Request-ID': 'req-doc-1',
    },
  })
}
