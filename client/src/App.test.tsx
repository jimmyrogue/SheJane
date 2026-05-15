import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
    const freshIndexedDB = new IDBFactory()
    Object.defineProperty(globalThis, 'indexedDB', { value: freshIndexedDB, configurable: true })
    Object.defineProperty(window, 'indexedDB', { value: freshIndexedDB, configurable: true })
    localStorage.clear()
    window.jiandanDesktop = undefined
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
    expect(document.querySelector('.window-titlebar')).toBeNull()
    expect(screen.getByRole('button', { name: '收起侧栏' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '搜索' })).toBeInTheDocument()
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

  it('lets users resize the sidebar within fixed bounds and persists the width', async () => {
    mockFetch('user')

    render(<App />)
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'user@example.com' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByText('创建账号'))

    await screen.findByText('user@example.com')
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
    await waitFor(() => expect(localStorage.getItem('jiandanly.sidebar.width.v1')).toBe('340'))

    fireEvent.click(screen.getByRole('button', { name: '收起侧栏' }))
    expect(shell.style.getPropertyValue('--sidebar-width')).toBe('176px')
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
    window.jiandanDesktop = {
      platform: 'darwin',
      auth: {
        register: vi.fn(),
        login: vi.fn(),
        refresh,
        logout: vi.fn(),
      },
    }

    render(<App />)

    await screen.findByText('electron@example.com')
    expect(refresh).toHaveBeenCalled()
    expect(calls.some((call) => call.url.endsWith('/api/v1/auth/refresh'))).toBe(false)
  })

  it('shows the login screen when the Electron auth bridge cannot refresh the session', async () => {
    const calls = mockFetch('user')
    const refresh = vi.fn().mockRejectedValue(new Error('expired'))
    window.jiandanDesktop = {
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

  it('renders the Atlas two-column auth structure for sign up and sign in', async () => {
    mockFetch('user')

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: 'English' }))

    expect(screen.getByText(/Get started in/)).toBeInTheDocument()
    expect(screen.getByText(/Free forever/)).toBeInTheDocument()
    expect(screen.getByText('Google')).toBeInTheDocument()
    expect(screen.getByText('Apple')).toBeInTheDocument()
    expect(screen.getByText('GitHub')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Create your account' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Sign in/i }))

    expect(screen.getByText(/Your AI agent/)).toBeInTheDocument()
    expect(screen.getByText(/Keep me signed in on this device/)).toBeInTheDocument()
    expect(screen.getByText('Continue with Google')).toBeInTheDocument()
  })

  it('switches the client between Chinese and English and persists the choice', async () => {
    mockFetch('user')

    const { unmount } = render(<App />)

    expect(await screen.findByText(/一分钟内开始使用/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'English' }))

    expect(screen.getByText(/Get started in/)).toBeInTheDocument()
    expect(localStorage.getItem('jiandanly.locale')).toBe('en')

    unmount()
    render(<App />)

    expect(await screen.findByText(/Get started in/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '中文' }))
    expect(screen.getByText(/一分钟内开始使用/)).toBeInTheDocument()
    expect(localStorage.getItem('jiandanly.locale')).toBe('zh')
  })

  it('localizes the sidebar navigation labels in Chinese and English', async () => {
    mockFetch('user')

    render(<App />)
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'user@example.com' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByText('创建账号'))

    await screen.findByText('user@example.com')
    expect(screen.getAllByText('工作区').length).toBeGreaterThan(0)
    expect(screen.getByText('对话')).toBeInTheDocument()
    expect(screen.getAllByText('工具').length).toBeGreaterThan(0)
    expect(screen.getByText('项目')).toBeInTheDocument()
    expect(screen.getByText('历史')).toBeInTheDocument()
    expect(screen.getByText('最近')).toBeInTheDocument()
    expect(screen.queryByText('WORKSPACE')).not.toBeInTheDocument()

    openMoreMenu(await screen.findByTitle('更多'))
    fireEvent.click(await screen.findByRole('button', { name: 'English' }))

    expect(screen.getByText('WORKSPACE')).toBeInTheDocument()
    expect(screen.getByText('Chats')).toBeInTheDocument()
    expect(screen.getByText('Tools')).toBeInTheDocument()
    expect(screen.getByText('Projects')).toBeInTheDocument()
    expect(screen.getByText('History')).toBeInTheDocument()
    expect(screen.getByText('RECENT')).toBeInTheDocument()
  })

  it('keeps documents inside the unified chat composer instead of a separate workspace', async () => {
    mockFetch('user')

    render(<App />)
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'user@example.com' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByText('创建账号'))

    await screen.findByText('user@example.com')

    expect(screen.queryByText('文档阅读')).not.toBeInTheDocument()
    expect(screen.queryByText('附件资料')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /附件/ }))
    expect(await screen.findByText('当前对话附件')).toBeInTheDocument()
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
    fireEvent.click(screen.getByRole('button', { name: /附件/ }))
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
    fireEvent.click(screen.getByRole('button', { name: /附件/ }))
    fireEvent.click(screen.getByText('roadmap.pdf'))
    expect(screen.getByText('已附加 roadmap.pdf')).toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText('描述你的问题、任务，或让简单 AI 阅读附件'), {
      target: { value: '这份文档的结论是什么？' },
    })
    fireEvent.click(screen.getByText('发送'))

    expect(await screen.findByText('文档回答')).toBeInTheDocument()
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

    await screen.findByText('user@example.com')
    fireEvent.change(screen.getByPlaceholderText('描述你的问题、任务，或让简单 AI 阅读附件'), {
      target: { value: '旧任务' },
    })
    fireEvent.click(screen.getByText('发送'))

    await screen.findByText('旧任务')
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
    window.jiandanDesktop = {
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

    await screen.findByText('user@example.com')
    await bindWorkspace('/tmp/jiandanly-workspace')
    fireEvent.change(screen.getByPlaceholderText('描述你的问题、任务，或让简单 AI 阅读附件'), {
      target: { value: '运行本地检查' },
    })
    fireEvent.click(screen.getByText('发送'))

    await screen.findByText('运行本地检查')
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

  it('uses the paired local harness for workspace tasks and can approve permission requests', async () => {
    const calls = mockFetch('user')
    const createObjectURL = vi.fn(() => 'blob:current-diagnostics')
    const revokeObjectURL = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true })
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    window.jiandanDesktop = {
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

    await screen.findByText('user@example.com')
    openMoreMenu(await screen.findByTitle('更多'))
    expect(await screen.findByText('当前本地状态')).toBeInTheDocument()
    expect(screen.getByText(/本地服务已连接/)).toBeInTheDocument()
    expect(screen.queryByText('Fast agent')).not.toBeInTheDocument()
    expect(screen.queryByText('Local Harness')).not.toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' })
    await bindWorkspace('/tmp/jiandanly-workspace')
    fireEvent.change(screen.getByPlaceholderText('描述你的问题、任务，或让简单 AI 阅读附件'), {
      target: { value: '运行本地检查' },
    })
    fireEvent.click(screen.getByText('发送'))

    expect((await screen.findAllByText('等待批准：运行命令')).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByText('本会话始终允许'))

    expect(await screen.findByText('本地执行完成')).toBeInTheDocument()
    expect((await screen.findAllByText('任务完成')).length).toBeGreaterThan(0)
    expect((await screen.findAllByText('已收集 1 个来源')).length).toBeGreaterThan(0)
    expect((await screen.findAllByText('生成 1 个 Artifact')).length).toBeGreaterThan(0)
    expect(screen.queryByText('收集来源：Example Source')).not.toBeInTheDocument()
    expect(screen.queryByText('https://example.com/source')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTitle('查看诊断 local-run'))
    expect(await screen.findByText('任务诊断：local-run')).toBeInTheDocument()
    expect(screen.getByText('状态 completed')).toBeInTheDocument()
    expect(screen.getByText('事件 3')).toBeInTheDocument()
    expect(screen.getByText('权限 1')).toBeInTheDocument()
    expect(screen.getByText('Artifact 1')).toBeInTheDocument()
    expect(screen.getByText(/最新检查点：checkpoint-local/)).toBeInTheDocument()
    expect(screen.getByText('source.collected')).toBeInTheDocument()
    expect(screen.getByText('verification.completed')).toBeInTheDocument()
    fireEvent.click(screen.getByText('导出当前诊断'))
    expect(await screen.findByText('诊断已导出：local-run')).toBeInTheDocument()
    expect(createObjectURL).toHaveBeenCalled()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:current-diagnostics')
    expect(calls.some((call) => call.url === 'http://127.0.0.1:17371/local/v1/runs' && call.init?.method === 'POST')).toBe(true)
    expect(calls.some((call) =>
      call.url === 'http://127.0.0.1:17371/local/v1/runs'
      && call.init?.method === 'POST'
      && call.init.body === JSON.stringify({ goal: '运行本地检查', workspace_path: '/tmp/jiandanly-workspace' }),
    )).toBe(true)
    expect(calls.some((call) => call.url === 'http://127.0.0.1:17371/local/v1/runs/local-run/diagnostics')).toBe(true)
    expect(calls.some((call) =>
      call.url === 'http://127.0.0.1:17371/local/v1/permissions/perm-shell'
      && call.init?.method === 'POST'
      && call.init.body === JSON.stringify({ decision: 'approve', scope: 'run' }),
    )).toBe(true)
    expect(calls.some((call) => call.url.endsWith('/api/v1/agent/runs'))).toBe(false)
  })

  it('syncs the cloud login session into the paired Local Harness and shows local status in the topbar menu', async () => {
    const calls = mockFetch('user')
    window.jiandanDesktop = {
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

    await screen.findByText('user@example.com')
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

    openMoreMenu(await screen.findByTitle('更多'))
    expect(await screen.findByText('当前本地状态')).toBeInTheDocument()
    expect(screen.getByText(/本地服务已连接/)).toBeInTheDocument()
  })

  it('previews local artifacts from the agent timeline', async () => {
    mockFetch('user')
    window.jiandanDesktop = {
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

    await screen.findByText('user@example.com')
    await bindWorkspace('/tmp/jiandanly-workspace')
    fireEvent.change(screen.getByPlaceholderText('描述你的问题、任务，或让简单 AI 阅读附件'), {
      target: { value: '读取大文件' },
    })
    fireEvent.click(screen.getByText('发送'))

    const artifactButtons = await screen.findAllByText('查看 artifact')
    fireEvent.click(artifactButtons[0])

    expect(await screen.findByText('Artifact: shell output')).toBeInTheDocument()
    expect(screen.getByText('artifact preview content')).toBeInTheDocument()
  })

  it('authorizes a picked Electron workspace before creating local runs', async () => {
    const calls = mockFetch('user')
    window.jiandanDesktop = {
      platform: 'darwin',
      localHost: {
        baseURL: 'http://127.0.0.1:17371',
        token: 'local-token',
      },
      selectWorkspaceDirectory: vi.fn().mockResolvedValue('/tmp/picked-workspace'),
    }

    render(<App />)
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'user@example.com' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByText('创建账号'))

    await screen.findByText('user@example.com')
    fireEvent.click(await readyWorkspaceButton())
    fireEvent.click(await screen.findByText('选择文件夹'))

    expect(await screen.findByLabelText('当前对话工作区路径')).toHaveValue('/tmp/picked-workspace')
    fireEvent.click(screen.getByText('授权并绑定'))
    expect(await screen.findByText('本地项目：picked-workspace')).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText('描述你的问题、任务，或让简单 AI 阅读附件'), {
      target: { value: '检查这个项目' },
    })
    fireEvent.click(screen.getByText('发送'))

    expect((await screen.findAllByText('等待批准：运行命令')).length).toBeGreaterThan(0)
    expect(calls.some((call) => call.url === 'http://127.0.0.1:17371/local/v1/workspaces' && call.init?.method === 'POST')).toBe(true)
    await waitFor(() => {
      expect(
        calls
          .filter((call) => call.url === 'http://127.0.0.1:17371/local/v1/runs' && call.init?.method === 'POST')
          .map((call) => call.init?.body),
      ).toContain(JSON.stringify({ goal: '检查这个项目', workspace_path: '/tmp/picked-workspace' }))
    })
  })

  it('keeps workspace authorization in the composer dialog instead of the sidebar', async () => {
    const calls = mockFetch('user', {
      workspaces: [{ id: 'workspace-1', path: '/tmp/project', label: 'project' }],
    })
    window.jiandanDesktop = {
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

    await screen.findByText('user@example.com')
    expect(screen.queryByText('本地工作区')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('本地工作区路径')).not.toBeInTheDocument()
    expect(screen.queryByText('授权当前路径')).not.toBeInTheDocument()
    fireEvent.click(await readyWorkspaceButton())
    fireEvent.change(await screen.findByLabelText('当前对话工作区路径'), { target: { value: '/tmp/project' } })
    fireEvent.click(screen.getByText('诊断路径'))
    expect(await screen.findByText('路径已授权：project')).toBeInTheDocument()
    fireEvent.click(screen.getByText('授权并绑定'))
    expect(await screen.findByText('本地项目：project')).toBeInTheDocument()
    expect(calls.some((call) => call.url === 'http://127.0.0.1:17371/local/v1/workspaces/diagnose' && call.init?.method === 'POST')).toBe(true)
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
    window.jiandanDesktop = {
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

    await screen.findByText('user@example.com')
    expect(screen.queryByText('最近本地任务')).not.toBeInTheDocument()
    expect(screen.queryByText('Resume workspace scan')).not.toBeInTheDocument()
  })

  it('moves import and export into each conversation more menu', async () => {
    mockFetch('user')
    const createObjectURL = vi.fn(() => 'blob:conversation-export')
    const revokeObjectURL = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true })
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)

    render(<App />)
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'user@example.com' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByText('创建账号'))

    await screen.findByText('user@example.com')
    expect(screen.queryByText('导出此对话')).not.toBeInTheDocument()
    expect(screen.queryByText('导入聊天数据')).not.toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText('描述你的问题、任务，或让简单 AI 阅读附件'), { target: { value: '你好' } })
    fireEvent.click(screen.getByText('发送'))

    await screen.findByTitle('更多 你好')
    openMoreMenu(screen.getByTitle('更多'))
    expect(await screen.findByText('导出当前对话')).toBeInTheDocument()
    expect(screen.getByText('当前本地状态')).toBeInTheDocument()
    fireEvent.click(screen.getByText('导出当前对话'))
    await waitFor(() => expect(createObjectURL).toHaveBeenCalled())
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:conversation-export')
    const exportToast = await screen.findByText('已导出对话：你好')
    expect(exportToast.closest('[data-sonner-toast]')).toBeTruthy()
    expect(document.querySelector('.notice')).toBeNull()
    createObjectURL.mockClear()
    revokeObjectURL.mockClear()

    openMoreMenu(screen.getByTitle('更多 你好'))
    expect(await screen.findByText('导出此对话')).toBeInTheDocument()
    expect(screen.getByText('导入聊天数据')).toBeInTheDocument()
    fireEvent.click(screen.getByText('导出此对话'))
    await waitFor(() => expect(createObjectURL).toHaveBeenCalled())
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:conversation-export')
    expect(await screen.findByText('已导出对话：你好')).toBeInTheDocument()
  })

  it('stores workspace references per conversation', async () => {
    const calls = mockFetch('user', {
      workspaces: [{ id: 'workspace-one', path: '/tmp/one', label: 'one' }],
    })
    window.jiandanDesktop = {
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

    await screen.findByText('user@example.com')
    await bindWorkspace('/tmp/one')
    fireEvent.change(screen.getByPlaceholderText('描述你的问题、任务，或让简单 AI 阅读附件'), {
      target: { value: '第一个任务' },
    })
    fireEvent.click(screen.getByText('发送'))
    expect((await screen.findAllByText('等待批准：运行命令')).length).toBeGreaterThan(0)

    fireEvent.click(screen.getAllByRole('button', { name: '新对话' })[0])
    await waitFor(() => expect(screen.queryByText('本地项目：one')).not.toBeInTheDocument())
    await bindWorkspace('/tmp/two')
    fireEvent.change(screen.getByPlaceholderText('描述你的问题、任务，或让简单 AI 阅读附件'), {
      target: { value: '第二个任务' },
    })
    fireEvent.click(screen.getByText('发送'))

    await waitFor(() => {
      const bodies = calls
        .filter((call) => call.url === 'http://127.0.0.1:17371/local/v1/runs' && call.init?.method === 'POST')
        .map((call) => call.init?.body)
      expect(bodies).toHaveLength(2)
      expect(bodies).toContain(JSON.stringify({ goal: '第一个任务', workspace_path: '/tmp/one' }))
      expect(bodies).toContain(JSON.stringify({ goal: '第二个任务', workspace_path: '/tmp/two' }))
    })
  })
})

async function readyWorkspaceButton(): Promise<HTMLElement> {
  await waitFor(() => {
    expect(screen.getByRole('button', { name: '工作区' })).not.toBeDisabled()
  })
  return screen.getByRole('button', { name: '工作区' })
}

async function bindWorkspace(path: string) {
  const label = path.split('/').filter(Boolean).at(-1) ?? path
  fireEvent.click(await readyWorkspaceButton())
  fireEvent.change(await screen.findByLabelText('当前对话工作区路径'), { target: { value: path } })
  fireEvent.click(screen.getByText('授权并绑定'))
  expect(await screen.findByText(`本地项目：${label}`)).toBeInTheDocument()
}

function openMoreMenu(trigger: HTMLElement) {
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
