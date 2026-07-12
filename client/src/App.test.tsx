import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'

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
import type { WalletBalance } from './shared/api/client'
import { LocalConversationStore } from './shared/local-data/localConversations'
import type { Conversation } from './shared/local-data/types'

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
    toast.dismiss()
  })

  afterEach(() => {
    toast.dismiss()
    cleanup()
    vi.restoreAllMocks()
  })

  it('does not show the admin entry for regular users', async () => {
    mockFetch('user')

    render(<App />)
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Test User' } })
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
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Test User' } })
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'admin@example.com' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByText('创建账号'))

    await awaitSignedIn()
    expect(screen.queryByText('管理后台')).not.toBeInTheDocument()
    expect(screen.queryByText('运营概览')).not.toBeInTheDocument()
  })

  it('keeps saved Auto intent modes after catalog reconciliation', async () => {
    localStorage.setItem('shejane.chatMode.v2', 'auto.smart')
    const calls = mockFetch('user')

    render(<App />)
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Test User' } })
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'user@example.com' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByText('创建账号'))

    await awaitSignedIn()
    await waitFor(() => expect(calls.some((call) => call.url.endsWith('/api/v1/models'))).toBe(true))
    expect(localStorage.getItem('shejane.chatMode.v2')).toBe('auto.smart')
  })

  it('marks orphaned web cloud tool loops as failed when loading user conversations', async () => {
    const localData = new LocalConversationStore('shejane-local:user-1')
    const conversation: Conversation = {
      id: 'conv-orphan-cloud-loop',
      title: '生成图片',
      archived: false,
      createdAt: '2026-05-10T00:00:00.000Z',
      updatedAt: '2026-05-10T00:00:00.000Z',
      messages: [
        { id: 'msg-user', role: 'user', content: '生成图片', createdAt: '2026-05-10T00:00:00.000Z', status: 'done' },
        {
          id: 'msg-assistant',
          role: 'assistant',
          content: '',
          createdAt: '2026-05-10T00:00:01.000Z',
          status: 'streaming',
          runId: 'run_interrupted_web_loop',
          runOrigin: 'cloud',
        },
      ],
    }
    await localData.save(conversation)
    mockFetch('user')

    render(<App />)
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Test User' } })
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'user@example.com' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByText('创建账号'))

    await awaitSignedIn()
    await waitFor(async () => {
      const assistant = (await localData.get('conv-orphan-cloud-loop'))?.messages.at(-1)
      expect(assistant).toMatchObject({
        status: 'error',
        content: '这次云端工具循环在浏览器刷新或关闭后中断，无法继续。请重新发送。',
      })
      expect(assistant?.agentEvents?.at(-1)).toMatchObject({ type: 'run.failed' })
    })
  })

  it('surfaces a restart recovery notice for persisted failed assistant messages', async () => {
    const localData = new LocalConversationStore('shejane-local:user-1')
    await localData.save({
      id: 'conv-recoverable-failure',
      title: '失败任务',
      archived: false,
      createdAt: '2026-05-10T00:00:00.000Z',
      updatedAt: '2026-05-10T00:00:01.000Z',
      messages: [
        { id: 'msg-user-failed', role: 'user', content: '继续任务', createdAt: '2026-05-10T00:00:00.000Z', status: 'done' },
        {
          id: 'msg-assistant-failed',
          role: 'assistant',
          content: 'rate limited',
          createdAt: '2026-05-10T00:00:01.000Z',
          status: 'error',
          runId: 'run-failed',
          runOrigin: 'local',
          agentEvents: [
            {
              type: 'run.failed',
              label: 'rate limited · 可重试',
              failureCategory: 'transient',
              failureActionKind: 'retry',
              failureRecoveryAction: 'retry',
            },
          ],
        },
      ],
    })
    mockFetch('user')

    render(<App />)
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Test User' } })
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'user@example.com' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByText('创建账号'))

    await awaitSignedIn()
    expect(await screen.findByText('有任务上次失败后仍可恢复，已为你保留在原对话里')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '打开对话' })).toBeInTheDocument()
  })

  it('lets users resize the sidebar within fixed bounds and persists the width', async () => {
    mockFetch('user')

    render(<App />)
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Test User' } })
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'user@example.com' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByText('创建账号'))

    await awaitSignedIn()
    const resizeHandle = screen.getByRole('separator', { name: '调整侧栏宽度' })
    const shell = resizeHandle.closest('.app-shell') as HTMLElement

    expect(shell.style.getPropertyValue('--sidebar-width')).toBe('252px')
    expect(resizeHandle).toHaveAttribute('aria-valuemin', '190')
    expect(resizeHandle).toHaveAttribute('aria-valuemax', '340')

    fireEvent.keyDown(resizeHandle, { key: 'Home' })
    expect(shell.style.getPropertyValue('--sidebar-width')).toBe('190px')
    expect(resizeHandle).toHaveAttribute('aria-valuenow', '190')

    fireEvent.keyDown(resizeHandle, { key: 'End' })
    expect(shell.style.getPropertyValue('--sidebar-width')).toBe('340px')
    await waitFor(() => expect(localStorage.getItem('shejane.sidebar.width.v2')).toBe('340'))

    // Collapsing is now a separate state (data-collapsed) rather than a width clamp.
    fireEvent.click(screen.getByRole('button', { name: '收起侧栏' }))
    expect(shell).toHaveAttribute('data-collapsed', 'true')
    expect(screen.getByRole('button', { name: '展开侧栏' }).closest('.topbar-expand-hotspot')).not.toBeNull()
  })

  it('opens keyboard help and sidebar search from global shortcuts', async () => {
    mockFetch('user')

    render(<App />)
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Test User' } })
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'user@example.com' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByText('创建账号'))

    await awaitSignedIn()

    fireEvent.keyDown(window, { key: '?', shiftKey: true })
    expect(await screen.findByRole('dialog', { name: '快捷键' })).toBeInTheDocument()
    expect(screen.getByText('搜索 / 切换对话')).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '快捷键' })).not.toBeInTheDocument())

    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    const search = await screen.findByRole('searchbox', { name: '搜索' })
    await waitFor(() => expect(search).toHaveFocus())
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

  it('opens the recharge dialog from settings, shows payment progress, and opens top-up history after completion', async () => {
    const calls = mockFetch('user')
    const openExternal = vi.fn(async () => 'ok')
    window.shejaneDesktop = {
      platform: 'darwin',
      openExternal,
    }

    render(<App />)
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Test User' } })
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'user@example.com' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByText('创建账号'))

    await awaitSignedIn()
    await openAccountMenu()
    fireEvent.click(await screen.findByText('充值'))

    expect(await screen.findByRole('dialog', { name: '充值' })).toBeInTheDocument()
    await waitFor(() =>
      expect(calls.filter((call) => call.url.endsWith('/api/v1/billing/checkout/options')).length).toBeGreaterThanOrEqual(2),
    )
    expect(calls.some((call) => call.url.endsWith('/api/v1/billing/checkout'))).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '确认充值' }))

    await waitFor(() =>
      expect(calls.some((call) => call.url.endsWith('/api/v1/billing/checkout'))).toBe(true),
    )
    const checkoutCall = calls.find((call) => call.url.endsWith('/api/v1/billing/checkout'))
    expect(JSON.parse(String(checkoutCall?.init?.body ?? '{}'))).toMatchObject({
      amount: 1,
      return_target: 'electron',
    })
    await waitFor(() =>
      expect(openExternal).toHaveBeenCalledWith('https://stripe.example.com/checkout/sess_test'),
    )
    expect(await screen.findByRole('dialog', { name: '充值中' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '已完成' }))

    const historyDialog = await screen.findByRole('dialog', { name: '消费记录' })
    expect(historyDialog).toBeInTheDocument()
    expect(within(historyDialog).getByRole('button', { name: '充值' })).toHaveAttribute('aria-pressed', 'true')
    expect(calls.filter((call) => call.url.endsWith('/api/v1/billing/balance')).length).toBeGreaterThanOrEqual(2)
    expect(calls.some((call) => call.url.endsWith('/api/v1/billing/activities'))).toBe(true)
  })

  it('opens spend history directly from the settings page', async () => {
    const calls = mockFetch('user')

    render(<App />)
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Test User' } })
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'user@example.com' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByText('创建账号'))

    await openAccountMenu()
    fireEvent.click(await screen.findByText('消费记录'))

    expect(await screen.findByRole('dialog', { name: '消费记录' })).toBeInTheDocument()
    expect(await screen.findByText('注册赠送')).toBeInTheDocument()
    expect(calls.some((call) => call.url.endsWith('/api/v1/billing/activities'))).toBe(true)
  })

  it('exports local data directly from the settings page', async () => {
    mockFetch('user')
    const createObjectURL = vi.fn<(blob: Blob) => string>(() => 'blob:local-data-export')
    const revokeObjectURL = vi.fn()
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true })
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true })

    render(<App />)
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Test User' } })
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'user@example.com' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByText('创建账号'))

    await openAccountMenu()
    fireEvent.click(await screen.findByRole('button', { name: '导出…' }))

    await waitFor(() => expect(createObjectURL).toHaveBeenCalled())
    const blob = createObjectURL.mock.calls[0]?.[0] as Blob
    expect(blob).toBeInstanceOf(Blob)
    expect(blob.type).toBe('application/json')
    expect(anchorClick).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:local-data-export')
    expect(await screen.findByText('本地数据已导出')).toBeInTheDocument()
  })

  it('keeps the desktop Runtime usable when the cloud session cannot refresh', async () => {
    const calls = mockFetch('user')
    const refresh = vi.fn().mockRejectedValue(new Error('expired'))
    window.shejaneDesktop = {
      platform: 'darwin',
      localHost: { baseURL: 'http://127.0.0.1:17371', session: 'desktop' },
      auth: {
        register: vi.fn(),
        login: vi.fn(),
        refresh,
        logout: vi.fn(),
      },
    }

    render(<App />)

    expect(await screen.findByText('今天想从哪件事开始？琐事交给石间，你只管要紧的。')).toBeInTheDocument()
    expect(screen.queryByText('创建账号')).not.toBeInTheDocument()
    expect(refresh).toHaveBeenCalled()
    expect(calls.some((call) => call.url.endsWith('/api/v1/auth/refresh'))).toBe(false)

    typeComposer('纯本地任务')
    fireEvent.click(screen.getByText('发送'))
    await waitFor(() => {
      expect(calls.some((call) => call.url === 'http://127.0.0.1:17371/local/v1/runs')).toBe(true)
    })
    expect(calls.some((call) => call.url.endsWith('/api/v1/agent/runs'))).toBe(false)
  })

  it('redelivers an unacknowledged Runtime command after the desktop restarts', async () => {
    const localData = new LocalConversationStore('shejane-local:runtime:local-owner')
    await localData.saveWithPendingRuntimeCommand(
      {
        id: 'conv-pending-restart',
        title: '恢复任务',
        archived: false,
        createdAt: '2026-05-10T00:00:00.000Z',
        updatedAt: '2026-05-10T00:00:00.000Z',
        messages: [
          {
            id: 'msg-pending-restart',
            commandId: 'cmd-pending-restart',
            role: 'user',
            content: '继续未确认任务',
            createdAt: '2026-05-10T00:00:00.000Z',
            status: 'done',
          },
        ],
      },
      {
        type: 'run.start',
        commandId: 'cmd-pending-restart',
        createdAt: '2026-05-10T00:00:00.000Z',
        input: {
          commandId: 'cmd-pending-restart',
          clientMessageId: 'msg-pending-restart',
          threadId: 'conv-pending-restart',
          goal: '继续未确认任务',
        },
      },
    )
    const calls = mockFetch('user')
    window.shejaneDesktop = {
      platform: 'darwin',
      localHost: { baseURL: 'http://127.0.0.1:17371', session: 'desktop' },
    }

    render(<App />)

    await waitFor(() => {
      const post = calls.find(
        (call) => call.url === 'http://127.0.0.1:17371/local/v1/runs' && call.init?.method === 'POST',
      )
      expect(JSON.parse(String(post?.init?.body ?? '{}'))).toMatchObject({
        command_id: 'cmd-pending-restart',
        client_message_id: 'msg-pending-restart',
      })
    })
    await waitFor(async () => expect(await localData.listPendingRuntimeCommands()).toEqual([]))
  })

  it('keeps an unacknowledged command pending instead of inventing a failed Run', async () => {
    const localData = new LocalConversationStore('shejane-local:runtime:local-owner')
    mockFetch('user', { localRunCreateFailures: 10 })
    window.shejaneDesktop = {
      platform: 'darwin',
      localHost: { baseURL: 'http://127.0.0.1:17371', session: 'desktop' },
    }
    render(<App />)
    expect(await screen.findByText('今天想从哪件事开始？琐事交给石间，你只管要紧的。')).toBeInTheDocument()

    typeComposer('等待运行时确认')
    fireEvent.click(screen.getByText('发送'))

    await waitFor(async () => {
      const [conversation] = await localData.list()
      expect(conversation?.messages.at(-1)).toMatchObject({
        role: 'assistant',
        status: 'pending',
        runOrigin: 'local',
      })
      expect(await localData.listPendingRuntimeCommands()).toHaveLength(1)
    })
  })

  it('removes a Runtime thread when its conversation is deleted during delivery', async () => {
    let releaseCreate!: () => void
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve
    })
    const localData = new LocalConversationStore('shejane-local:runtime:local-owner')
    await localData.saveWithPendingRuntimeCommand(
      {
        id: 'conv-delete-during-delivery',
        title: '删除投递中任务',
        archived: false,
        createdAt: '2026-05-10T00:00:00.000Z',
        updatedAt: '2026-05-10T00:00:00.000Z',
        messages: [],
      },
      {
        type: 'run.start',
        commandId: 'cmd-delete-during-delivery',
        createdAt: '2026-05-10T00:00:00.000Z',
        input: {
          commandId: 'cmd-delete-during-delivery',
          clientMessageId: 'msg-delete-during-delivery',
          threadId: 'conv-delete-during-delivery',
          goal: 'must be deleted after acceptance',
        },
      },
    )
    const calls = mockFetch('user', {
      localRunCreateGate: createGate,
      requireRunCancelBeforeThreadDelete: true,
    })
    window.shejaneDesktop = {
      platform: 'darwin',
      localHost: { baseURL: 'http://127.0.0.1:17371', session: 'desktop' },
    }
    render(<App />)
    await waitFor(() => expect(calls.some(
      (call) => call.url.endsWith('/local/v1/runs') && call.init?.method === 'POST',
    )).toBe(true))
    await localData.delete('conv-delete-during-delivery')
    releaseCreate()

    await waitFor(() => expect(calls.some(
      (call) => call.url.endsWith('/local/v1/threads/conv-delete-during-delivery') &&
        call.init?.method === 'DELETE',
    )).toBe(true))
    const cancelIndex = calls.findIndex((call) =>
      call.url.endsWith('/local/v1/commands') && call.init?.method === 'POST')
    const streamIndex = calls.findIndex((call) => call.url.endsWith('/local/v1/runs/local-run/stream'))
    const deleteIndex = calls.findIndex((call) =>
      call.url.endsWith('/local/v1/threads/conv-delete-during-delivery') &&
      call.init?.method === 'DELETE')
    expect(cancelIndex).toBeGreaterThanOrEqual(0)
    expect(streamIndex).toBeGreaterThan(cancelIndex)
    expect(deleteIndex).toBeGreaterThan(streamIndex)
    await waitFor(async () => {
      expect(await localData.get('conv-delete-during-delivery')).toBeUndefined()
      expect(await localData.listPendingRuntimeCommands()).toEqual([])
    })
  })

  it('does not render a stale Runtime snapshot for a canceled conversation', async () => {
    const localData = new LocalConversationStore('shejane-local:runtime:local-owner')
    await localData.saveWithPendingRuntimeCommand(
      {
        id: 'conv-stale-canceled',
        title: '已删除对话',
        archived: false,
        createdAt: '2026-05-10T00:00:00.000Z',
        updatedAt: '2026-05-10T00:00:00.000Z',
        messages: [],
      },
      {
        type: 'run.start',
        commandId: 'cmd-stale-canceled',
        createdAt: '2026-05-10T00:00:00.000Z',
        input: {
          commandId: 'cmd-stale-canceled',
          clientMessageId: 'msg-stale-canceled',
          threadId: 'conv-stale-canceled',
          goal: 'must stay deleted',
        },
      },
    )
    await localData.delete('conv-stale-canceled')
    await localData.settleCanceledLocalRunCommand('conv-stale-canceled', 'cmd-stale-canceled')
    const now = '2026-07-12T00:00:00Z'
    const calls = mockFetch('user', {
      runtimeThreads: [{
        id: 'conv-stale-canceled',
        title: '过期投影',
        metadata: {},
        version: 2,
        created_at: now,
        updated_at: now,
      }],
      runtimeThreadSnapshots: {
        'conv-stale-canceled': {
          thread: {
            id: 'conv-stale-canceled',
            title: '过期投影',
            metadata: {},
            version: 2,
            created_at: now,
            updated_at: now,
          },
          items: [],
          runs: [],
          events: [],
          cursor: 2,
        },
      },
    })
    window.shejaneDesktop = {
      platform: 'darwin',
      localHost: { baseURL: 'http://127.0.0.1:17371', session: 'desktop' },
    }

    render(<App />)

    await waitFor(() => expect(calls.some(
      (call) => call.url.endsWith('/local/v1/threads/conv-stale-canceled'),
    )).toBe(true))
    expect(screen.queryByText('过期投影')).not.toBeInTheDocument()
    expect(await localData.get('conv-stale-canceled')).toBeUndefined()
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
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Test User' } })
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
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Test User' } })
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

  it('sends multiple attached documents in one agent run', async () => {
    const calls = mockFetch('user')

    render(<App />)
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Test User' } })
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'user@example.com' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByText('创建账号'))

    await awaitSignedIn()
    const files = [
      new File(['hello'], 'brief.docx', {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
      new File(['budget'], 'budget.xlsx', {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
    ]
    fireEvent.change(screen.getByLabelText('上传附件'), { target: { files } })
    expect(await screen.findByTitle(/brief\.docx/)).toBeInTheDocument()
    expect(await screen.findByTitle(/budget\.xlsx/)).toBeInTheDocument()

    typeComposer('对比这两份材料')
    fireEvent.click(screen.getByText('发送'))

    await waitFor(() => expect(screen.getByText('文档回答')).toBeInTheDocument(), { timeout: 3000 })
    const agentRunBody = calls
      .filter((call) => call.url.endsWith('/api/v1/agent/runs'))
      .map((call) => JSON.parse(String(call.init?.body ?? '{}')))
      .at(-1)
    expect(agentRunBody.attachments).toEqual([
      { type: 'document', document_id: 'doc-upload', name: 'brief.docx' },
      { type: 'document', document_id: 'doc-upload-2', name: 'budget.xlsx' },
    ])
  })

  it('keeps a blank new chat active when an older cloud stream updates in the background', async () => {
    const agentStream = createDeferredAgentStream('run-doc')
    mockFetch('user', { agentStream })

    render(<App />)
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Test User' } })
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'user@example.com' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByText('创建账号'))

    await awaitSignedIn()
    typeComposer('旧任务')
    fireEvent.click(screen.getByText('发送'))

    expect((await screen.findAllByText('旧任务')).length).toBeGreaterThan(0)
    fireEvent.click(screen.getAllByRole('button', { name: '新对话' })[0])
    expect(await screen.findByText('今天想从哪件事开始？琐事交给石间，你只管要紧的。')).toBeInTheDocument()

    act(() => {
      agentStream.emit({ event_type: 'llm.delta', payload: { content: '旧回答' } })
      agentStream.emit({ event_type: 'run.completed', payload: { request_id: 'req-old-1', credits_cost: 2 } })
      agentStream.done()
    })
    await settleStreamRender()

    expect(screen.getByText('今天想从哪件事开始？琐事交给石间，你只管要紧的。')).toBeInTheDocument()
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
        session: 'desktop',
      },
    }

    render(<App />)
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Test User' } })
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
    expect(await screen.findByText('今天想从哪件事开始？琐事交给石间，你只管要紧的。')).toBeInTheDocument()

    act(() => {
      localRunStream.emit({ id: 'local-event-2', event_type: 'llm.delta', payload: { content: '本地执行完成' } })
      localRunStream.emit({ id: 'local-event-3', event_type: 'run.completed', payload: { final: '本地执行完成' } })
      localRunStream.done()
    })
    await settleStreamRender()

    expect(screen.getByText('今天想从哪件事开始？琐事交给石间，你只管要紧的。')).toBeInTheDocument()
    expect(screen.queryByText('本地执行完成')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '运行本地检查' }))
    expect(await screen.findByText('本地执行完成')).toBeInTheDocument()
  })

  it('reconciles a missed terminal SSE event from the authoritative Runtime snapshot', async () => {
    const localRunStream = createDeferredAgentStream('local-run')
    const calls = mockFetch('user', {
      localRunStream,
      localThreadTerminal: {
        content: '快照中的权威回答',
        status: 'completed',
        eventType: 'run.completed',
      },
    })
    window.shejaneDesktop = {
      platform: 'darwin',
      localHost: { baseURL: 'http://127.0.0.1:17371', session: 'desktop' },
    }

    render(<App />)
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Test User' } })
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'user@example.com' } })
    fireEvent.change(screen.getByLabelText('密码', { exact: true }), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByText('创建账号'))
    await awaitSignedIn()

    typeComposer('只通过快照完成')
    fireEvent.click(screen.getByText('发送'))
    expect((await screen.findAllByText('只通过快照完成')).length).toBeGreaterThan(0)
    await waitFor(() => expect(
      calls.some((call) => call.url.endsWith('/local/v1/runs/local-run/stream')),
    ).toBe(true))

    act(() => localRunStream.done())

    await waitFor(() => expect(screen.getByText('快照中的权威回答')).toBeInTheDocument())
  })

  it('persists user cancellation as an immutable Runtime command', async () => {
    const localRunStream = createDeferredAgentStream('local-run')
    const calls = mockFetch('user', { localRunStream })
    window.shejaneDesktop = {
      platform: 'darwin',
      localHost: { baseURL: 'http://127.0.0.1:17371', session: 'desktop' },
    }
    render(<App />)
    expect(await screen.findByText('今天想从哪件事开始？琐事交给石间，你只管要紧的。')).toBeInTheDocument()

    typeComposer('取消这个任务')
    fireEvent.click(screen.getByText('发送'))
    await waitFor(() => expect(calls.some(
      (call) => call.url.endsWith('/local/v1/runs/local-run/stream'),
    )).toBe(true))
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 50)))
    fireEvent.click(screen.getByRole('button', { name: '停止生成' }))
    fireEvent.click(screen.getByRole('button', { name: '停止生成' }))

    await waitFor(() => {
      const commandCalls = calls.filter((call) =>
        call.url.endsWith('/local/v1/commands') && call.init?.method === 'POST')
      expect(commandCalls.length).toBeGreaterThan(0)
      expect(commandCalls.map((call) => JSON.parse(String(call.init?.body)))).toEqual(
        commandCalls.map(() => ({
          type: 'run.cancel',
          run_id: 'local-run',
          command_id: 'cancel_local-run',
        })),
      )
    })
    const localData = new LocalConversationStore('shejane-local:runtime:local-owner')
    await waitFor(async () => expect(await localData.listPendingRuntimeCommands()).toEqual([]))
    act(() => localRunStream.done())
  })

  it('keeps one durable question answer pending across transport failure', async () => {
    const localData = new LocalConversationStore('shejane-local:runtime:local-owner')
    await localData.save({
      id: 'conv-question-command',
      title: '等待回答',
      archived: false,
      createdAt: '2026-05-10T00:00:00.000Z',
      updatedAt: '2026-05-10T00:00:01.000Z',
      messages: [
        { id: 'question-user', role: 'user', content: '请选择模式', createdAt: '2026-05-10T00:00:00.000Z', status: 'done' },
        {
          id: 'question-assistant',
          role: 'assistant',
          content: '',
          createdAt: '2026-05-10T00:00:01.000Z',
          status: 'waiting_input',
          runId: 'local-run',
          runOrigin: 'local',
          agentEvents: [{
            type: 'question.asked',
            label: '需要你的回答',
            questionRequestId: 'question-command',
            questions: [{
              question: 'Which mode?',
              header: 'Mode',
              options: [{ label: 'Mode X' }, { label: 'Mode Y' }],
            }],
          }],
        },
      ],
    })
    const calls = mockFetch('user', { questionAnswerFailures: 10 })
    window.shejaneDesktop = {
      platform: 'darwin',
      localHost: { baseURL: 'http://127.0.0.1:17371', session: 'desktop' },
    }

    render(<App />)
    fireEvent.click(await screen.findByText('Mode X'))
    fireEvent.click(screen.getByText('Mode Y'))

    await waitFor(() => {
      const commands = calls.filter((call) =>
        call.url.endsWith('/local/v1/commands') &&
        JSON.parse(String(call.init?.body ?? '{}')).type === 'question.answer')
      expect(commands.length).toBeGreaterThan(0)
      expect(commands.map((command) => JSON.parse(String(command.init?.body ?? '{}')))).toEqual(
        commands.map(() => ({
        type: 'question.answer',
        command_id: 'answer_question-command',
        question_id: 'question-command',
        answers: { 'Which mode?': ['Mode X'] },
        })),
      )
    })
    await waitFor(async () => {
      expect(await localData.listPendingRuntimeCommands()).toEqual([
        expect.objectContaining({
          type: 'question.answer',
          commandId: 'answer_question-command',
          input: expect.objectContaining({ answers: { 'Which mode?': ['Mode X'] } }),
        }),
      ])
      expect((await localData.get('conv-question-command'))?.messages.at(-1)?.status).toBe(
        'waiting_input',
      )
    })
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
        session: 'desktop',
      },
    }

    render(<App />)
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Test User' } })
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

  it('fires and acknowledges a desktop notification when a scheduled local run finishes', async () => {
    const calls = mockFetch('user', {
      localSchedules: [
        {
          id: 'sched-1',
          goal: '每日总结',
          status: 'completed',
          run_at: '2026-06-13T10:00:00Z',
          result_text: '计划任务完成',
          run_id: 'run-scheduled-1',
          created_at: '2026-06-13T09:00:00Z',
          updated_at: '2026-06-13T10:01:00Z',
        },
      ],
      localRuns: [
        {
          id: 'run-scheduled-1',
          goal: '每日总结',
          status: 'completed',
          created_at: '2026-06-13T10:00:00Z',
          updated_at: '2026-06-13T10:01:00Z',
          events_count: 3,
        },
      ],
    })
    const notify = vi.fn(async () => true)
    window.shejaneDesktop = {
      platform: 'darwin',
      notify,
      localHost: {
        baseURL: 'http://127.0.0.1:17371',
        session: 'desktop',
      },
    }

    render(<App />)
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Test User' } })
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'user@example.com' } })
    fireEvent.change(screen.getByLabelText('密码', { exact: true }), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByText('创建账号'))
    await awaitSignedIn()

    await waitFor(() => {
      expect(notify).toHaveBeenCalledWith({ title: '石间定时任务完成', body: '计划任务完成' })
    })
    await waitFor(() => {
      expect(calls.some((call) => call.url === 'http://127.0.0.1:17371/local/v1/schedules/sched-1/notified' && call.init?.method === 'POST')).toBe(true)
    })
  })

  it('shows a pure local run.failed error only once in the progress card', async () => {
    const localRunStream = createDeferredAgentStream('local-run')
    mockFetch('user', { localRunStream })
    window.shejaneDesktop = {
      platform: 'darwin',
      localHost: {
        baseURL: 'http://127.0.0.1:17371',
        session: 'desktop',
      },
    }

    render(<App />)
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Test User' } })
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'user@example.com' } })
    fireEvent.change(screen.getByLabelText('密码', { exact: true }), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByText('创建账号'))
    await awaitSignedIn()

    typeComposer('运行本地检查')
    fireEvent.click(screen.getByText('发送'))
    expect((await screen.findAllByText('运行本地检查')).length).toBeGreaterThan(0)

    act(() => {
      localRunStream.emit({ id: 'fail-event-1', event_type: 'run.failed', payload: { error: 'missing API key', type: 'BackendLLMError' } })
      localRunStream.done()
    })
    await settleStreamRender()

    expect(screen.getByText('任务失败')).toBeInTheDocument()
    expect(screen.queryByText('missing API key')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '展开详情' }))
    const failureTexts = await screen.findAllByText('missing API key')
    expect(failureTexts).toHaveLength(1)
    expect(failureTexts.some((node) => node.closest('.message-content'))).toBe(false)
    expect(failureTexts.some((node) => node.closest('.agent-progress-notice-body'))).toBe(true)
  })

  it('opens top-up checkout from a quota failure action', async () => {
    const localRunStream = createDeferredAgentStream('local-run')
    const calls = mockFetch('user', { localRunStream })
    const openExternal = vi.fn(async () => 'ok')
    window.shejaneDesktop = {
      platform: 'darwin',
      openExternal,
      localHost: {
        baseURL: 'http://127.0.0.1:17371',
        session: 'desktop',
      },
    }

    render(<App />)
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Test User' } })
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'user@example.com' } })
    fireEvent.change(screen.getByLabelText('密码', { exact: true }), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByText('创建账号'))
    await awaitSignedIn()

    typeComposer('运行本地检查')
    fireEvent.click(screen.getByText('发送'))

    act(() => {
      localRunStream.emit({
        id: 'fail-event-1',
        event_type: 'run.failed',
        payload: {
          error: 'credits exhausted',
          category: 'quota',
          action_kind: 'user_action',
          retryable: false,
        },
      })
      localRunStream.done()
    })
    await settleStreamRender()

    await clickFailureAction('充值')

    await waitFor(() =>
      expect(calls.some((call) => call.url.endsWith('/api/v1/billing/checkout'))).toBe(true),
    )
    expect(openExternal).toHaveBeenCalledWith('https://stripe.example.com/checkout/sess_test')
  })

  it('opens only one checkout session when the same quota recovery action is clicked twice', async () => {
    const localRunStream = createDeferredAgentStream('local-run')
    const calls = mockFetch('user', { localRunStream })
    const openExternal = vi.fn(async () => 'ok')
    window.shejaneDesktop = {
      platform: 'darwin',
      openExternal,
      localHost: {
        baseURL: 'http://127.0.0.1:17371',
        session: 'desktop',
      },
    }

    render(<App />)
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Test User' } })
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'user@example.com' } })
    fireEvent.change(screen.getByLabelText('密码', { exact: true }), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByText('创建账号'))
    await awaitSignedIn()

    typeComposer('运行本地检查')
    fireEvent.click(screen.getByText('发送'))

    act(() => {
      localRunStream.emit({
        id: 'fail-event-1',
        event_type: 'run.failed',
        payload: {
          error: 'credits exhausted',
          category: 'quota',
          action_kind: 'user_action',
          retryable: false,
        },
      })
      localRunStream.done()
    })
    await settleStreamRender()

    fireEvent.click(screen.getByRole('button', { name: '展开详情' }))
    const rechargeButton = (await screen.findAllByRole('button', { name: '充值' })).find((button) =>
      button.closest('.agent-progress-actions'),
    )
    expect(rechargeButton).toBeTruthy()
    fireEvent.click(rechargeButton!)
    fireEvent.click(rechargeButton!)

    await waitFor(() => {
      expect(calls.filter((call) => call.url.endsWith('/api/v1/billing/checkout'))).toHaveLength(1)
      expect(openExternal).toHaveBeenCalledTimes(1)
    })
  })

  it('offers a retry confirmation after opening checkout for a quota failure', async () => {
    const localData = new LocalConversationStore('shejane-local:user-1')
    await localData.save({
      id: 'conv-quota-failure',
      title: '额度失败任务',
      archived: false,
      createdAt: '2026-05-10T00:00:00.000Z',
      updatedAt: '2026-05-10T00:00:01.000Z',
      messages: [
        { id: 'msg-user-quota', role: 'user', content: '继续运行本地检查', createdAt: '2026-05-10T00:00:00.000Z', status: 'done' },
        {
          id: 'msg-assistant-quota',
          role: 'assistant',
          content: 'credits exhausted',
          createdAt: '2026-05-10T00:00:01.000Z',
          status: 'error',
          runId: 'local-run-quota',
          runOrigin: 'local',
          agentEvents: [
            {
              type: 'run.failed',
              label: 'credits exhausted · 需要你处理',
              failureCategory: 'quota',
              failureActionKind: 'user_action',
            },
          ],
        },
      ],
    })
    const emptyWallet: WalletBalance = {
      ...balance,
      plan_code: 'free_trial',
      monthly_credits_used: 10000,
      monthly_remaining: 0,
      extra_credits_balance: 0,
      status: 'active',
    }
    const calls = mockFetch('user', { balance: () => emptyWallet })
    const openExternal = vi.fn(async () => 'ok')
    window.shejaneDesktop = {
      platform: 'darwin',
      openExternal,
      localHost: {
        baseURL: 'http://127.0.0.1:17371',
        session: 'desktop',
      },
    }

    render(<App />)
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Test User' } })
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'user@example.com' } })
    fireEvent.change(screen.getByLabelText('密码', { exact: true }), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByText('创建账号'))
    await awaitSignedIn()
    await selectConversationForTest('额度失败任务', 'credits exhausted')

    await clickFailureAction('充值')

    await waitFor(() =>
      expect(openExternal).toHaveBeenCalledWith('https://stripe.example.com/checkout/sess_test'),
    )
    expect(await screen.findByText('充值页面已打开，完成后可重试刚才的任务')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
    expect(calls.filter((call) => call.url === 'http://127.0.0.1:17371/local/v1/runs' && call.init?.method === 'POST')).toHaveLength(0)
  })

  it('observes checkout completion and offers retry without auto-running the failed task', async () => {
    const localData = new LocalConversationStore('shejane-local:user-1')
    await localData.save({
      id: 'conv-quota-failure',
      title: '额度失败任务',
      archived: false,
      createdAt: '2026-05-10T00:00:00.000Z',
      updatedAt: '2026-05-10T00:00:01.000Z',
      messages: [
        { id: 'msg-user-quota', role: 'user', content: '继续运行本地检查', createdAt: '2026-05-10T00:00:00.000Z', status: 'done' },
        {
          id: 'msg-assistant-quota',
          role: 'assistant',
          content: 'credits exhausted',
          createdAt: '2026-05-10T00:00:01.000Z',
          status: 'error',
          runId: 'local-run-quota',
          runOrigin: 'local',
          agentEvents: [
            {
              type: 'run.failed',
              label: 'credits exhausted · 需要你处理',
              failureCategory: 'quota',
              failureActionKind: 'user_action',
            },
          ],
        },
      ],
    })
    const emptyWallet: WalletBalance = {
      ...balance,
      plan_code: 'free_trial',
      monthly_credits_used: 10000,
      monthly_remaining: 0,
      extra_credits_balance: 0,
      status: 'active',
    }
    const paidWallet: WalletBalance = {
      ...balance,
      plan_code: 'pro',
      monthly_credit_limit: 50000,
      monthly_credits_used: 0,
      monthly_remaining: 50000,
      extra_credits_balance: 0,
      status: 'active',
    }
    let currentWallet = emptyWallet
    const calls = mockFetch('user', { balance: () => currentWallet })
    const openExternal = vi.fn(async () => 'ok')
    window.shejaneDesktop = {
      platform: 'darwin',
      openExternal,
      localHost: {
        baseURL: 'http://127.0.0.1:17371',
        session: 'desktop',
      },
    }

    render(<App />)
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Test User' } })
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'user@example.com' } })
    fireEvent.change(screen.getByLabelText('密码', { exact: true }), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByText('创建账号'))
    await awaitSignedIn()
    await selectConversationForTest('额度失败任务', 'credits exhausted')

    currentWallet = paidWallet
    await clickFailureAction('充值')

    await waitFor(() =>
      expect(openExternal).toHaveBeenCalledWith('https://stripe.example.com/checkout/sess_test'),
    )
    expect(await screen.findByText('充值已完成，可重试刚才的任务')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
    expect(calls.filter((call) => call.url === 'http://127.0.0.1:17371/local/v1/runs' && call.init?.method === 'POST')).toHaveLength(0)
  })

  it('keeps retry confirmations bound to the failed conversation after navigation', async () => {
    const localData = new LocalConversationStore('shejane-local:user-1')
    await localData.save({
      id: 'conv-quota-failure',
      title: '额度失败任务',
      archived: false,
      createdAt: '2026-05-10T00:00:00.000Z',
      updatedAt: '2026-05-10T00:00:01.000Z',
      messages: [
        { id: 'msg-user-quota', role: 'user', content: '继续运行本地检查', createdAt: '2026-05-10T00:00:00.000Z', status: 'done' },
        {
          id: 'msg-assistant-quota',
          role: 'assistant',
          content: 'credits exhausted',
          createdAt: '2026-05-10T00:00:01.000Z',
          status: 'error',
          runId: 'local-run-quota',
          runOrigin: 'local',
          agentEvents: [
            {
              type: 'run.failed',
              label: 'credits exhausted · 需要你处理',
              failureCategory: 'quota',
              failureActionKind: 'user_action',
            },
          ],
        },
      ],
    })
    await localData.save({
      id: 'conv-other',
      title: '其它对话',
      archived: false,
      createdAt: '2026-05-10T00:00:02.000Z',
      updatedAt: '2026-05-10T00:00:03.000Z',
      messages: [
        { id: 'msg-user-other', role: 'user', content: '普通任务', createdAt: '2026-05-10T00:00:02.000Z', status: 'done' },
        { id: 'msg-assistant-other', role: 'assistant', content: '普通回答', createdAt: '2026-05-10T00:00:03.000Z', status: 'done', runOrigin: 'cloud' },
      ],
    })
    const emptyWallet: WalletBalance = {
      ...balance,
      plan_code: 'free_trial',
      monthly_credits_used: 10000,
      monthly_remaining: 0,
      extra_credits_balance: 0,
      status: 'active',
    }
    const paidWallet: WalletBalance = {
      ...balance,
      plan_code: 'pro',
      monthly_credit_limit: 50000,
      monthly_credits_used: 0,
      monthly_remaining: 50000,
      extra_credits_balance: 0,
      status: 'active',
    }
    let currentWallet = emptyWallet
    const calls = mockFetch('user', { balance: () => currentWallet })
    const openExternal = vi.fn(async () => 'ok')
    window.shejaneDesktop = {
      platform: 'darwin',
      openExternal,
      localHost: {
        baseURL: 'http://127.0.0.1:17371',
        session: 'desktop',
      },
    }

    render(<App />)
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Test User' } })
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'user@example.com' } })
    fireEvent.change(screen.getByLabelText('密码', { exact: true }), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByText('创建账号'))
    await awaitSignedIn()
    await selectConversationForTest('额度失败任务', 'credits exhausted')

    await clickFailureAction('充值')
    await waitFor(() =>
      expect(openExternal).toHaveBeenCalledWith('https://stripe.example.com/checkout/sess_test'),
    )
    expect(await screen.findByText('充值页面已打开，完成后可重试刚才的任务')).toBeInTheDocument()

    await selectConversationForTest('其它对话', '普通回答')
    currentWallet = paidWallet
    fireEvent.click(screen.getByRole('button', { name: '重试' }))

    await waitFor(() => {
      const localRunPosts = calls.filter((call) => call.url === 'http://127.0.0.1:17371/local/v1/runs' && call.init?.method === 'POST')
      expect(localRunPosts).toHaveLength(1)
      expect(JSON.parse(String(localRunPosts[0].init?.body ?? '{}'))).toMatchObject({ goal: '继续运行本地检查' })
    })
  })

  it('does not retry a quota failure until checkout completion is reflected in the wallet', async () => {
    const localData = new LocalConversationStore('shejane-local:user-1')
    await localData.save({
      id: 'conv-quota-failure',
      title: '额度失败任务',
      archived: false,
      createdAt: '2026-05-10T00:00:00.000Z',
      updatedAt: '2026-05-10T00:00:01.000Z',
      messages: [
        { id: 'msg-user-quota', role: 'user', content: '继续运行本地检查', createdAt: '2026-05-10T00:00:00.000Z', status: 'done' },
        {
          id: 'msg-assistant-quota',
          role: 'assistant',
          content: 'credits exhausted',
          createdAt: '2026-05-10T00:00:01.000Z',
          status: 'error',
          runId: 'local-run-quota',
          runOrigin: 'local',
          agentEvents: [
            {
              type: 'run.failed',
              label: 'credits exhausted · 需要你处理',
              failureCategory: 'quota',
              failureActionKind: 'user_action',
            },
          ],
        },
      ],
    })
    const emptyWallet: WalletBalance = {
      ...balance,
      plan_code: 'free_trial',
      monthly_credits_used: 10000,
      monthly_remaining: 0,
      extra_credits_balance: 0,
      status: 'active',
    }
    const calls = mockFetch('user', { balance: () => emptyWallet })
    const openExternal = vi.fn(async () => 'ok')
    window.shejaneDesktop = {
      platform: 'darwin',
      openExternal,
      localHost: {
        baseURL: 'http://127.0.0.1:17371',
        session: 'desktop',
      },
    }

    render(<App />)
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Test User' } })
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'user@example.com' } })
    fireEvent.change(screen.getByLabelText('密码', { exact: true }), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByText('创建账号'))
    await awaitSignedIn()
    await selectConversationForTest('额度失败任务', 'credits exhausted')

    await clickFailureAction('充值')
    await waitFor(() =>
      expect(openExternal).toHaveBeenCalledWith('https://stripe.example.com/checkout/sess_test'),
    )

    fireEvent.click(screen.getByRole('button', { name: '重试' }))

    expect(await screen.findByText('还没有检测到充值完成，请完成支付后再重试')).toBeInTheDocument()
    expect(calls.filter((call) => call.url === 'http://127.0.0.1:17371/local/v1/runs' && call.init?.method === 'POST')).toHaveLength(0)
  })

  it('retries a quota failure after checkout completion is reflected in the wallet', async () => {
    const localData = new LocalConversationStore('shejane-local:user-1')
    await localData.save({
      id: 'conv-quota-failure',
      title: '额度失败任务',
      archived: false,
      createdAt: '2026-05-10T00:00:00.000Z',
      updatedAt: '2026-05-10T00:00:01.000Z',
      messages: [
        { id: 'msg-user-quota', role: 'user', content: '继续运行本地检查', createdAt: '2026-05-10T00:00:00.000Z', status: 'done' },
        {
          id: 'msg-assistant-quota',
          role: 'assistant',
          content: 'credits exhausted',
          createdAt: '2026-05-10T00:00:01.000Z',
          status: 'error',
          runId: 'local-run-quota',
          runOrigin: 'local',
          agentEvents: [
            {
              type: 'run.failed',
              label: 'credits exhausted · 需要你处理',
              failureCategory: 'quota',
              failureActionKind: 'user_action',
            },
          ],
        },
      ],
    })
    const emptyWallet: WalletBalance = {
      ...balance,
      plan_code: 'free_trial',
      monthly_credits_used: 10000,
      monthly_remaining: 0,
      extra_credits_balance: 0,
      status: 'active',
    }
    const paidWallet: WalletBalance = {
      ...balance,
      plan_code: 'pro',
      monthly_credit_limit: 50000,
      monthly_credits_used: 0,
      monthly_remaining: 50000,
      extra_credits_balance: 0,
      status: 'active',
    }
    let currentWallet = emptyWallet
    const calls = mockFetch('user', { balance: () => currentWallet })
    const openExternal = vi.fn(async () => 'ok')
    window.shejaneDesktop = {
      platform: 'darwin',
      openExternal,
      localHost: {
        baseURL: 'http://127.0.0.1:17371',
        session: 'desktop',
      },
    }

    render(<App />)
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Test User' } })
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'user@example.com' } })
    fireEvent.change(screen.getByLabelText('密码', { exact: true }), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByText('创建账号'))
    await awaitSignedIn()
    await selectConversationForTest('额度失败任务', 'credits exhausted')

    await clickFailureAction('充值')
    await waitFor(() =>
      expect(openExternal).toHaveBeenCalledWith('https://stripe.example.com/checkout/sess_test'),
    )
    currentWallet = paidWallet
    fireEvent.click(screen.getByRole('button', { name: '重试' }))

    await waitFor(() => {
      const localRunPosts = calls.filter((call) => call.url === 'http://127.0.0.1:17371/local/v1/runs' && call.init?.method === 'POST')
      expect(localRunPosts).toHaveLength(1)
      expect(JSON.parse(String(localRunPosts[0].init?.body ?? '{}'))).toMatchObject({ goal: '继续运行本地检查' })
    })
  })

  it('starts a repair run with source metadata from a repair failure action', async () => {
    const localData = new LocalConversationStore('shejane-local:runtime:local-owner')
    await localData.save({
      id: 'conv-repair-failure',
      title: '修复任务',
      archived: false,
      createdAt: '2026-05-10T00:00:00.000Z',
      updatedAt: '2026-05-10T00:00:01.000Z',
      messages: [
        { id: 'msg-user-repair', role: 'user', content: '读取 workspace 外的文件', createdAt: '2026-05-10T00:00:00.000Z', status: 'done' },
        {
          id: 'msg-assistant-repair',
          role: 'assistant',
          content: 'invalid tool arguments',
          createdAt: '2026-05-10T00:00:01.000Z',
          status: 'error',
          runId: 'local-run',
          runOrigin: 'local',
          agentEvents: [
            {
              type: 'run.failed',
              label: 'invalid tool arguments · 需要修复',
              failureCategory: 'validation',
              failureActionKind: 'repair',
            },
          ],
        },
      ],
    })
    const calls = mockFetch('user')
    window.shejaneDesktop = {
      platform: 'darwin',
      localHost: {
        baseURL: 'http://127.0.0.1:17371',
        session: 'desktop',
      },
    }

    render(<App />)
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Test User' } })
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'user@example.com' } })
    fireEvent.change(screen.getByLabelText('密码', { exact: true }), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByText('创建账号'))
    await awaitSignedIn()
    await selectConversationForTest('修复任务', 'invalid tool arguments')

    await clickFailureAction('尝试修复')

    await waitFor(() => {
      const localRunPosts = calls.filter((call) => call.url === 'http://127.0.0.1:17371/local/v1/runs' && call.init?.method === 'POST')
      expect(localRunPosts).toHaveLength(1)
      expect(JSON.parse(String(localRunPosts[0].init?.body ?? '{}'))).toMatchObject({
        goal: '读取 workspace 外的文件',
        parent_run_id: 'local-run',
        metadata: {
          intent: 'repair',
          source_run_id: 'local-run',
          source_message_id: 'msg-assistant-repair',
          attempt: 1,
          failure_category: 'validation',
          failure_action_kind: 'repair',
        },
      })
    })
    const updated = await localData.get('conv-repair-failure')
    const repairAssistant = updated?.messages.at(-1)
    expect(repairAssistant?.agentEvents?.[0]).toMatchObject({
      type: 'ui.action.requested',
      label: '请求操作：修复尝试 1',
      repairAttempt: 1,
      repairSourceRunId: 'local-run',
      repairSourceMessageId: 'msg-assistant-repair',
    })
  })

  it('starts only one repair run when the same repair action is clicked twice', async () => {
    const localData = new LocalConversationStore('shejane-local:user-1')
    await localData.save({
      id: 'conv-repair-dedupe',
      title: '修复去重任务',
      archived: false,
      createdAt: '2026-05-10T00:00:00.000Z',
      updatedAt: '2026-05-10T00:00:01.000Z',
      messages: [
        { id: 'msg-user-repair', role: 'user', content: '修复无效参数', createdAt: '2026-05-10T00:00:00.000Z', status: 'done' },
        {
          id: 'msg-assistant-repair',
          role: 'assistant',
          content: 'invalid tool arguments',
          createdAt: '2026-05-10T00:00:01.000Z',
          status: 'error',
          runId: 'local-run',
          runOrigin: 'local',
          agentEvents: [
            {
              type: 'run.failed',
              label: 'invalid tool arguments · 需要修复',
              failureCategory: 'validation',
              failureActionKind: 'repair',
            },
          ],
        },
      ],
    })
    const calls = mockFetch('user')
    window.shejaneDesktop = {
      platform: 'darwin',
      localHost: {
        baseURL: 'http://127.0.0.1:17371',
        session: 'desktop',
      },
    }

    render(<App />)
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Test User' } })
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'user@example.com' } })
    fireEvent.change(screen.getByLabelText('密码', { exact: true }), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByText('创建账号'))
    await awaitSignedIn()
    await selectConversationForTest('修复去重任务', 'invalid tool arguments')

    fireEvent.click(screen.getByRole('button', { name: '展开详情' }))
    const repairButton = await screen.findByRole('button', { name: '尝试修复' })
    fireEvent.click(repairButton)
    fireEvent.click(repairButton)

    await waitFor(() => {
      const localRunPosts = calls.filter((call) => call.url === 'http://127.0.0.1:17371/local/v1/runs' && call.init?.method === 'POST')
      expect(localRunPosts).toHaveLength(1)
      expect(JSON.parse(String(localRunPosts[0].init?.body ?? '{}'))).toMatchObject({
        goal: '修复无效参数',
        parent_run_id: 'local-run',
        metadata: {
          intent: 'repair',
          source_message_id: 'msg-assistant-repair',
        },
      })
    })
  })

  it('offers a retry confirmation after refreshing a failed local cloud session', async () => {
    const localData = new LocalConversationStore('shejane-local:user-1')
    await localData.save({
      id: 'conv-auth-failure',
      title: '会话过期任务',
      archived: false,
      createdAt: '2026-05-10T00:00:00.000Z',
      updatedAt: '2026-05-10T00:00:01.000Z',
      messages: [
        { id: 'msg-user-auth', role: 'user', content: '继续检查本地项目', createdAt: '2026-05-10T00:00:00.000Z', status: 'done' },
        {
          id: 'msg-assistant-auth',
          role: 'assistant',
          content: 'cloud session expired',
          createdAt: '2026-05-10T00:00:01.000Z',
          status: 'error',
          runId: 'local-run-auth',
          runOrigin: 'local',
          agentEvents: [
            {
              type: 'run.failed',
              label: 'cloud session expired · 需要你处理',
              failureCategory: 'auth',
              failureActionKind: 'user_action',
            },
          ],
        },
      ],
    })
    const calls = mockFetch('user')
    window.shejaneDesktop = {
      platform: 'darwin',
      localHost: {
        baseURL: 'http://127.0.0.1:17371',
        session: 'desktop',
      },
    }

    render(<App />)
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Test User' } })
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'user@example.com' } })
    fireEvent.change(screen.getByLabelText('密码', { exact: true }), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByText('创建账号'))
    await awaitSignedIn()
    await selectConversationForTest('会话过期任务', 'cloud session expired')

    await clickFailureAction('刷新会话')

    expect(await screen.findByText('本地云端会话已刷新，可重试刚才的任务')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))

	  await waitFor(() => {
	    const localRunPosts = calls.filter((call) => call.url === 'http://127.0.0.1:17371/local/v1/runs' && call.init?.method === 'POST')
	    expect(localRunPosts).toHaveLength(1)
	    expect(JSON.parse(String(localRunPosts[0].init?.body ?? '{}'))).toMatchObject({
	      goal: '继续检查本地项目',
        parent_run_id: 'local-run-auth',
        metadata: {
          intent: 'retry',
          source_run_id: 'local-run-auth',
          source_message_id: 'msg-assistant-auth',
          attempt: 1,
          failure_category: 'auth',
          failure_action_kind: 'user_action',
        },
	    })
	  })
	})

	it('clears the daemon cloud session on logout while keeping the local Runtime open', async () => {
	  const localData = new LocalConversationStore('shejane-local:user-1')
	  await localData.save({
	    id: 'conv-auth-pending',
	    title: '会话恢复任务',
	    archived: false,
	    createdAt: '2026-05-10T00:00:00.000Z',
	    updatedAt: '2026-05-10T00:00:01.000Z',
	    messages: [
	      { id: 'msg-user-auth-pending', role: 'user', content: '继续恢复本地任务', createdAt: '2026-05-10T00:00:00.000Z', status: 'done' },
	      {
	        id: 'msg-assistant-auth-pending',
	        role: 'assistant',
	        content: 'cloud session still expired',
	        createdAt: '2026-05-10T00:00:01.000Z',
	        status: 'error',
	        runId: 'local-run-auth-pending',
	        runOrigin: 'local',
	        agentEvents: [
	          {
	            type: 'run.failed',
	            label: 'cloud session still expired · 需要你处理',
	            failureCategory: 'auth',
	            failureActionKind: 'user_action',
	          },
	        ],
	      },
	    ],
	  })
	  await localData.save({
	    id: 'conv-newer-than-auth-pending',
	    title: '更新的其它会话',
	    archived: false,
	    createdAt: '2026-05-10T00:00:02.000Z',
	    updatedAt: '2026-05-10T00:00:03.000Z',
	    messages: [
	      { id: 'msg-newer-user', role: 'user', content: '其它任务', createdAt: '2026-05-10T00:00:02.000Z', status: 'done' },
	      { id: 'msg-newer-assistant', role: 'assistant', content: '其它回答', createdAt: '2026-05-10T00:00:03.000Z', status: 'done' },
	    ],
	  })
	  const calls = mockFetch('user', {
	    localSessionResponses: [
	      { body: { connected: false } },
	      { body: { connected: false } },
	      {
	        body: {
	          connected: true,
	          cloud_base_url: 'http://localhost:8080',
	          auth: 'bearer',
	          updated_at: '2026-05-11T00:00:00Z',
	        },
	      },
	    ],
	  })
	  window.shejaneDesktop = {
	    platform: 'darwin',
	    localHost: {
	      baseURL: 'http://127.0.0.1:17371',
	      session: 'desktop',
	    },
	  }

	  render(<App />)
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Test User' } })
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'user@example.com' } })
	  fireEvent.change(screen.getByLabelText('密码', { exact: true }), { target: { value: 'secret123' } })
	  fireEvent.click(screen.getByText('创建账号'))
	  await awaitSignedIn()
	  await waitFor(() => {
	    expect(
	      calls.filter(
	        (call) =>
	          call.url === 'http://127.0.0.1:17371/local/v1/session' &&
	          call.init?.method === 'POST' &&
	          call.init.body === JSON.stringify({ cloud_base_url: 'http://localhost:8080', access_token: 'user-token' }),
	      ),
	    ).toHaveLength(1)
	  })
	  await selectConversationForTest('会话恢复任务', 'cloud session still expired')

	  await clickFailureAction('刷新会话')
	  expect(await screen.findByText('刷新本地云端会话失败')).toBeInTheDocument()

	  await openAccountMenu()
	  fireEvent.click(await screen.findByRole('button', { name: '退出' }))
	  const logoutConfirm = await screen.findByRole('alertdialog')
	  fireEvent.click(within(logoutConfirm).getByRole('button', { name: '确认退出' }))
	  await waitFor(() => {
	    expect(calls.some(
	      (call) =>
	        call.url === 'http://127.0.0.1:17371/local/v1/session' &&
	        call.init?.method === 'DELETE',
	    )).toBe(true)
	  })
	  expect((await screen.findAllByRole('button', { name: '新对话' })).length).toBeGreaterThan(0)
	  expect(screen.queryByText('创建你的账号')).not.toBeInTheDocument()
	  expect(screen.getByRole('button', { name: '会话恢复任务' }).closest('.conversation-row')).toHaveClass('active')
	  expect(calls.filter((call) => call.url === 'http://127.0.0.1:17371/local/v1/runs' && call.init?.method === 'POST')).toHaveLength(0)
	})

	it('starts only one retry when the same recovery confirmation is clicked twice', async () => {
	  const localData = new LocalConversationStore('shejane-local:user-1')
	  await localData.save({
      id: 'conv-auth-failure',
      title: '会话过期任务',
      archived: false,
      createdAt: '2026-05-10T00:00:00.000Z',
      updatedAt: '2026-05-10T00:00:01.000Z',
      messages: [
        { id: 'msg-user-auth', role: 'user', content: '继续检查本地项目', createdAt: '2026-05-10T00:00:00.000Z', status: 'done' },
        {
          id: 'msg-assistant-auth',
          role: 'assistant',
          content: 'cloud session expired',
          createdAt: '2026-05-10T00:00:01.000Z',
          status: 'error',
          runId: 'local-run-auth',
          runOrigin: 'local',
          agentEvents: [
            {
              type: 'run.failed',
              label: 'cloud session expired · 需要你处理',
              failureCategory: 'auth',
              failureActionKind: 'user_action',
            },
          ],
        },
      ],
    })
    const localRunStream = createDeferredAgentStream('local-run')
    const calls = mockFetch('user', { localRunStream })
    window.shejaneDesktop = {
      platform: 'darwin',
      localHost: {
        baseURL: 'http://127.0.0.1:17371',
        session: 'desktop',
      },
    }

    render(<App />)
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Test User' } })
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'user@example.com' } })
    fireEvent.change(screen.getByLabelText('密码', { exact: true }), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByText('创建账号'))
    await awaitSignedIn()
    await selectConversationForTest('会话过期任务', 'cloud session expired')

    await clickFailureAction('刷新会话')
    expect(await screen.findByText('本地云端会话已刷新，可重试刚才的任务')).toBeInTheDocument()
    const retryButton = screen.getByRole('button', { name: '重试' })
    fireEvent.click(retryButton)
    fireEvent.click(retryButton)

    await waitFor(() => {
      const localRunPosts = calls.filter((call) => call.url === 'http://127.0.0.1:17371/local/v1/runs' && call.init?.method === 'POST')
      expect(localRunPosts).toHaveLength(1)
      expect(JSON.parse(String(localRunPosts[0].init?.body ?? '{}'))).toMatchObject({ goal: '继续检查本地项目' })
    })
  })

  it('offers a retry confirmation after binding a workspace for a workspace failure', async () => {
    const localData = new LocalConversationStore('shejane-local:user-1')
    await localData.save({
      id: 'conv-workspace-failure',
      title: '工作区失败任务',
      archived: false,
      createdAt: '2026-05-10T00:00:00.000Z',
      updatedAt: '2026-05-10T00:00:01.000Z',
      messages: [
        { id: 'msg-user-workspace', role: 'user', content: '读取项目里的配置', createdAt: '2026-05-10T00:00:00.000Z', status: 'done' },
        {
          id: 'msg-assistant-workspace',
          role: 'assistant',
          content: 'path outside authorized workspace',
          createdAt: '2026-05-10T00:00:01.000Z',
          status: 'error',
          runId: 'local-run-workspace',
          runOrigin: 'local',
          agentEvents: [
            {
              type: 'run.failed',
              label: 'path outside authorized workspace · 需要你处理',
              failureCategory: 'workspace',
              failureActionKind: 'user_action',
            },
          ],
        },
      ],
    })
    const calls = mockFetch('user')
    window.shejaneDesktop = {
      platform: 'darwin',
      localHost: {
        baseURL: 'http://127.0.0.1:17371',
        session: 'desktop',
      },
      selectWorkspaceDirectory: vi.fn().mockResolvedValue('/tmp/fixed-workspace'),
    }

    render(<App />)
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Test User' } })
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'user@example.com' } })
    fireEvent.change(screen.getByLabelText('密码', { exact: true }), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByText('创建账号'))
    await awaitSignedIn()
    await selectConversationForTest('工作区失败任务', 'path outside authorized workspace')

    await clickFailureAction('选择工作区')

    expect(await screen.findByText('当前对话已绑定工作区：fixed-workspace，可重试刚才的任务')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))

    await waitFor(() => {
      const localRunPosts = calls.filter((call) => call.url === 'http://127.0.0.1:17371/local/v1/runs' && call.init?.method === 'POST')
      expect(localRunPosts).toHaveLength(1)
      expect(JSON.parse(String(localRunPosts[0].init?.body ?? '{}'))).toMatchObject({
        goal: '读取项目里的配置',
        workspace_path: '/tmp/fixed-workspace',
      })
    })
  })

  it('binds recovery workspaces to the failed conversation when the user navigates during selection', async () => {
    const localData = new LocalConversationStore('shejane-local:runtime:local-owner')
    await localData.save({
      id: 'conv-workspace-failure',
      title: '工作区失败任务',
      archived: false,
      createdAt: '2026-05-10T00:00:00.000Z',
      updatedAt: '2026-05-10T00:00:01.000Z',
      messages: [
        { id: 'msg-user-workspace', role: 'user', content: '读取项目里的配置', createdAt: '2026-05-10T00:00:00.000Z', status: 'done' },
        {
          id: 'msg-assistant-workspace',
          role: 'assistant',
          content: 'path outside authorized workspace',
          createdAt: '2026-05-10T00:00:01.000Z',
          status: 'error',
          runId: 'local-run-workspace',
          runOrigin: 'local',
          agentEvents: [
            {
              type: 'run.failed',
              label: 'path outside authorized workspace · 需要你处理',
              failureCategory: 'workspace',
              failureActionKind: 'user_action',
            },
          ],
        },
      ],
    })
    await localData.save({
      id: 'conv-other',
      title: '其它对话',
      archived: false,
      createdAt: '2026-05-10T00:00:02.000Z',
      updatedAt: '2026-05-10T00:00:03.000Z',
      messages: [
        { id: 'msg-user-other', role: 'user', content: '普通任务', createdAt: '2026-05-10T00:00:02.000Z', status: 'done' },
        { id: 'msg-assistant-other', role: 'assistant', content: '普通回答', createdAt: '2026-05-10T00:00:03.000Z', status: 'done', runOrigin: 'cloud' },
      ],
    })
    mockFetch('user')
    let resolveWorkspace!: (path: string) => void
    const workspaceSelection = new Promise<string>((resolve) => {
      resolveWorkspace = resolve
    })
    window.shejaneDesktop = {
      platform: 'darwin',
      localHost: {
        baseURL: 'http://127.0.0.1:17371',
        session: 'desktop',
      },
      selectWorkspaceDirectory: vi.fn().mockReturnValue(workspaceSelection),
    }

    render(<App />)
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Test User' } })
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'user@example.com' } })
    fireEvent.change(screen.getByLabelText('密码', { exact: true }), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByText('创建账号'))
    await awaitSignedIn()
    await selectConversationForTest('工作区失败任务', 'path outside authorized workspace')

    await clickFailureAction('选择工作区')
    await selectConversationForTest('其它对话', '普通回答')
    await act(async () => {
      resolveWorkspace('/tmp/fixed-workspace')
      await workspaceSelection
    })

    await waitFor(async () => {
      expect((await localData.get('conv-workspace-failure'))?.workspace?.path).toBe('/tmp/fixed-workspace')
    })
    expect((await localData.get('conv-other'))?.workspace).toBeUndefined()
  })

  it('offers a retry confirmation after opening diagnostics for a configuration failure', async () => {
    const localData = new LocalConversationStore('shejane-local:user-1')
    await localData.save({
      id: 'conv-config-failure',
      title: '配置失败任务',
      archived: false,
      createdAt: '2026-05-10T00:00:00.000Z',
      updatedAt: '2026-05-10T00:00:01.000Z',
      messages: [
        { id: 'msg-user-config', role: 'user', content: '检查模型配置', createdAt: '2026-05-10T00:00:00.000Z', status: 'done' },
        {
          id: 'msg-assistant-config',
          role: 'assistant',
          content: 'missing API key',
          createdAt: '2026-05-10T00:00:01.000Z',
          status: 'error',
          runId: 'local-run',
          runOrigin: 'local',
          agentEvents: [
            {
              type: 'run.failed',
              label: 'missing API key · 需要你处理',
              failureCategory: 'configuration',
              failureActionKind: 'user_action',
            },
          ],
        },
      ],
    })
    const calls = mockFetch('user')
    window.shejaneDesktop = {
      platform: 'darwin',
      localHost: {
        baseURL: 'http://127.0.0.1:17371',
        session: 'desktop',
      },
    }

    render(<App />)
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Test User' } })
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'user@example.com' } })
    fireEvent.change(screen.getByLabelText('密码', { exact: true }), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByText('创建账号'))
    await awaitSignedIn()
    await selectConversationForTest('配置失败任务', 'missing API key')

    await clickFailureAction('查看诊断')

    expect(await screen.findByText('任务诊断：local-run')).toBeInTheDocument()
    expect(await screen.findByText('诊断已打开，修复配置后可重试刚才的任务')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
    expect(calls.filter((call) => call.url === 'http://127.0.0.1:17371/local/v1/runs' && call.init?.method === 'POST')).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: '重试' }))

    await waitFor(() => {
      const localRunPosts = calls.filter((call) => call.url === 'http://127.0.0.1:17371/local/v1/runs' && call.init?.method === 'POST')
      expect(localRunPosts).toHaveLength(1)
      expect(JSON.parse(String(localRunPosts[0].init?.body ?? '{}'))).toMatchObject({ goal: '检查模型配置' })
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
        session: 'desktop',
      },
    }

    render(<App />)
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Test User' } })
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
    const localData = new LocalConversationStore('shejane-local:runtime:local-owner')
    const calls = mockFetch('user', { localRunStream })
    window.shejaneDesktop = {
      platform: 'darwin',
      localHost: {
        baseURL: 'http://127.0.0.1:17371',
        session: 'desktop',
      },
    }

    render(<App />)
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Test User' } })
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'user@example.com' } })
    fireEvent.change(screen.getByLabelText('密码', { exact: true }), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByText('创建账号'))
    await awaitSignedIn()

    typeComposer('要删除的问题')
    fireEvent.click(screen.getByText('发送'))
    expect((await screen.findAllByText('要删除的问题')).length).toBeGreaterThan(0)
    await waitFor(() => {
      expect(calls.some((call) => call.url.endsWith('/local/v1/runs/local-run/stream'))).toBe(true)
    })
    act(() => {
      localRunStream.emit({ id: 'del-1', event_type: 'llm.delta', payload: { content: '要删除的回答' } })
      localRunStream.emit({ id: 'del-2', event_type: 'run.completed', payload: { final: '要删除的回答' } })
      localRunStream.done()
    })
    await settleStreamRender()
    await waitFor(async () => {
      const saved = (await localData.list()).find((conversation) =>
        conversation.messages.some((message) => message.content === '要删除的回答'),
      )
      expect(saved?.messages.at(-1)).toMatchObject({ content: '要删除的回答', status: 'done' })
    })
    fireEvent.click(await screen.findByRole('button', { name: '要删除的问题' }))
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
      localHost: { baseURL: 'http://127.0.0.1:17371', session: 'desktop' },
    }

    render(<App />)
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Test User' } })
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
      localHost: { baseURL: 'http://127.0.0.1:17371', session: 'desktop' },
    }

    render(<App />)
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Test User' } })
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
        session: 'desktop',
      },
    }

    render(<App />)
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Test User' } })
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
        session: 'desktop',
      },
      selectWorkspaceDirectory: vi.fn().mockResolvedValue('/tmp/picked-workspace'),
    }

    render(<App />)
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Test User' } })
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

  it('uses the Advanced max history turns setting before creating a local run', async () => {
    const localData = new LocalConversationStore('shejane-local:runtime:local-owner')
    const priorMessages = Array.from({ length: 26 }, (_, index) => ({
      id: `msg-history-${index}`,
      role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
      content: `历史消息 ${index}`,
      createdAt: `2026-05-10T00:${String(index).padStart(2, '0')}:00.000Z`,
      status: 'done' as const,
    }))
    await localData.save({
      id: 'conv-history-cap',
      title: '历史任务',
      archived: false,
      createdAt: '2026-05-10T00:00:00.000Z',
      updatedAt: '2026-05-10T00:26:00.000Z',
      messages: priorMessages,
    })
    localStorage.setItem(
      'shejane.agentSettings.v7',
      JSON.stringify({ memory: 'on', skills: 'on', mcp: 'on', mcpDisabled: [], advanced: {} }),
    )
    const calls = mockFetch('user')
    window.shejaneDesktop = {
      platform: 'darwin',
      localHost: {
        baseURL: 'http://127.0.0.1:17371',
        session: 'desktop',
      },
    }

    render(<App />)
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Test User' } })
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'user@example.com' } })
    fireEvent.change(screen.getByLabelText('密码', { exact: true }), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByText('创建账号'))

    await awaitSignedIn()
    fireEvent.click(await screen.findByRole('button', { name: '历史任务' }))
    typeComposer('继续处理')
    fireEvent.click(screen.getByText('发送'))

    await waitFor(() => {
      const body = calls
        .filter((call) => call.url === 'http://127.0.0.1:17371/local/v1/runs' && call.init?.method === 'POST')
        .map((call) => JSON.parse(call.init?.body as string))
        .at(-1)
      expect(body).toMatchObject({ goal: '继续处理' })
      expect(body.history).toHaveLength(26)
      expect(body.history[0].content).toBe('历史消息 0')
      expect(body.history.at(-1).content).toBe('历史消息 25')
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
        session: 'desktop',
      },
    }

    render(<App />)
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Test User' } })
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
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Test User' } })
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
        session: 'desktop',
      },
      selectWorkspaceDirectory,
    }

    render(<App />)
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Test User' } })
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

// Account/billing/agent settings now live on the full 设置 page (the old
// account dropdown is gone). Clicking 设置 navigates there.
async function openAccountMenu(): Promise<void> {
  const trigger = await awaitSignedIn()
  fireEvent.click(trigger)
}

async function selectConversationForTest(title: string, readyText: string): Promise<void> {
  void readyText
  fireEvent.click(await screen.findByRole('button', { name: title }))
  await waitFor(() => {
    const toolbarTitle = document.querySelector('.chat-toolbar-title')?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
    expect(toolbarTitle).toContain(title)
  })
}

async function clickFailureAction(label: string): Promise<void> {
  let buttons = screen.queryAllByRole('button', { name: label })
  let action = buttons.find((button) => button.closest('.agent-progress-actions'))
  if (!action) {
    const expand = screen.queryAllByRole('button', { name: '展开详情' }).find((button) =>
      button.closest('.agent-progress-notice-card'),
    )
    expect(expand).toBeTruthy()
    fireEvent.click(expand!)
    buttons = await screen.findAllByRole('button', { name: label })
    action = buttons.find((button) => button.closest('.agent-progress-actions'))
  }
  expect(action).toBeTruthy()
  fireEvent.click(action!)
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
	    localSchedules?: Array<{
	      id: string
	      goal: string
	      status: string
	      run_at: string
	      result_text?: string
	      error_message?: string
	      run_id?: string
	      created_at: string
	      updated_at: string
	    }>
	    agentStream?: DeferredAgentStream
	    localRunStream?: DeferredAgentStream
	    localThreadTerminal?: { content: string; status: 'completed' | 'failed'; eventType: 'run.completed' | 'run.failed' }
	    localSessionResponses?: Array<{ status?: number; body: Record<string, unknown> }>
	    localRunCreateFailures?: number
	    questionAnswerFailures?: number
	    localRunCreateGate?: Promise<void>
	    requireRunCancelBeforeThreadDelete?: boolean
	    runtimeThreads?: Array<Record<string, unknown>>
	    runtimeThreadSnapshots?: Record<string, Record<string, unknown>>
	    emailVerified?: boolean
	    balance?: WalletBalance | (() => WalletBalance)
	  } = {},
	) {
	  const calls: Array<{ url: string; init?: RequestInit }> = []
	  let workspaces = options.workspaces ?? []
	  const localRuns = options.localRuns ?? []
	  const localSchedules = options.localSchedules ?? []
	  const localSessionResponses = [...(options.localSessionResponses ?? [])]
	  let localRunCreateFailures = options.localRunCreateFailures ?? 0
	  let questionAnswerFailures = options.questionAnswerFailures ?? 0
	  let localRunCanceled = false
	  let uploadCounter = 0
	  const uploadedDocuments = new Map<string, Record<string, unknown>>()
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
    if (url === 'http://127.0.0.1:17371/local/v1/runtime') {
      const gatewayConnected = calls.some(
        (call) => call.url === 'http://127.0.0.1:17371/local/v1/session' && call.init?.method === 'POST',
      )
      return new Response(
        JSON.stringify({
          protocol_version: 1,
          runtime_version: 'test',
          capabilities: ['agent.run', 'agent.stream', 'hitl'],
          model_provider_configured: true,
          gateway_provider_configured: gatewayConnected,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    if (url === 'http://127.0.0.1:17371/local/v1/models') {
      return new Response(
        JSON.stringify({
          models: [{
            spec: 'local:ollama:qwen3:8b',
            model_id: 'qwen3:8b',
            display_name: 'Qwen 3 8B',
            provider_id: 'ollama',
            provider_name: 'Local Ollama',
            tool_calling: true,
            streaming: true,
            max_input_tokens: 32768,
            available: true,
          }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
	    if (url === 'http://127.0.0.1:17371/local/v1/session' && init?.method === 'POST') {
	      const nextSessionResponse = localSessionResponses.shift()
	      if (nextSessionResponse) {
	        return new Response(JSON.stringify(nextSessionResponse.body), {
	          status: nextSessionResponse.status ?? 200,
	          headers: { 'Content-Type': 'application/json' },
	        })
	      }
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
      await options.localRunCreateGate
      if (localRunCreateFailures > 0) {
        localRunCreateFailures -= 1
        throw new TypeError('connection reset')
      }
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
    if (url === 'http://127.0.0.1:17371/local/v1/commands' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body ?? '{}')) as {
        type?: string
        command_id?: string
        run_id?: string
        question_id?: string
      }
      if (body.type === 'question.answer') {
        if (questionAnswerFailures > 0) {
          questionAnswerFailures -= 1
          throw new TypeError('connection reset')
        }
        return new Response(JSON.stringify({
          type: body.type,
          command_id: body.command_id,
          question_id: body.question_id,
          run_id: 'local-run',
          answered: true,
          resumed: true,
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      localRunCanceled = true
      return new Response(JSON.stringify({
        type: body.type,
        command_id: body.command_id,
        run_id: body.run_id,
        canceled: true,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (url === 'http://127.0.0.1:17371/local/v1/threads') {
      return new Response(JSON.stringify({ threads: options.runtimeThreads ?? [], cursor: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (url.startsWith('http://127.0.0.1:17371/local/v1/threads/changes')) {
      return new Response(JSON.stringify({ changes: [], cursor: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (url.startsWith('http://127.0.0.1:17371/local/v1/threads/') && init?.method === 'DELETE') {
      if (options.requireRunCancelBeforeThreadDelete && !localRunCanceled) {
        return new Response(JSON.stringify({ detail: 'thread has an unsettled run' }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ version: 1 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (url.startsWith('http://127.0.0.1:17371/local/v1/threads/') && init?.method === 'GET') {
      const requestedThreadID = decodeURIComponent(url.split('/').at(-1) ?? '')
      const runtimeSnapshot = options.runtimeThreadSnapshots?.[requestedThreadID]
      if (runtimeSnapshot) {
        return new Response(JSON.stringify(runtimeSnapshot), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      const terminal = options.localThreadTerminal
      if (!terminal) return new Response(JSON.stringify({ detail: 'thread not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } })
      const runCall = [...calls].reverse().find((call) => call.url.endsWith('/local/v1/runs') && call.init?.method === 'POST')
      const body = JSON.parse(String(runCall?.init?.body ?? '{}')) as Record<string, string>
      const threadID = body.thread_id
      const now = '2026-07-12T00:00:02Z'
      return new Response(JSON.stringify({
        thread: { id: threadID, title: body.thread_title, metadata: body.thread_metadata ?? {}, version: 2, created_at: now, updated_at: now },
        items: [
          { id: 'runtime-user', thread_id: threadID, run_id: 'local-run', client_id: body.client_message_id, item_type: 'user_message', status: 'completed', content: body.user_input, metadata: body.user_item_metadata ?? {}, position: 1, version: 1, created_at: now, updated_at: now },
          { id: 'runtime-assistant', thread_id: threadID, run_id: 'local-run', client_id: body.assistant_message_id, item_type: 'assistant_message', status: terminal.status, content: terminal.content, metadata: {}, position: 2, version: 2, created_at: now, updated_at: now, completed_at: now },
        ],
        runs: [{ id: 'local-run', goal: body.goal, user_input: body.user_input, status: terminal.status, thread_id: threadID, assistant_item_id: 'runtime-assistant', history_json: '[]', settings_json: '{}', metadata_json: '{}', created_at: now, updated_at: now }],
        events: [{ id: 'runtime-event', run_id: 'local-run', seq: 1, event_type: terminal.eventType, payload: terminal.eventType === 'run.completed' ? { final_text: terminal.content } : { error: terminal.content }, created_at: now }],
        cursor: 2,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (url.startsWith('http://127.0.0.1:17371/local/v1/schedules/')) {
      const schedule = localSchedules[0] ?? {
        id: 'sched-notified',
        goal: 'scheduled',
        status: 'completed',
        run_at: '2026-06-13T10:00:00Z',
        created_at: '2026-06-13T09:00:00Z',
        updated_at: '2026-06-13T10:01:00Z',
      }
      return new Response(
        JSON.stringify({ ...schedule, notified_at: '2026-06-13T10:02:00Z' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    if (url.startsWith('http://127.0.0.1:17371/local/v1/schedules')) {
      return new Response(JSON.stringify({ schedules: localSchedules }), { status: 200, headers: { 'Content-Type': 'application/json' } })
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
    if (url.endsWith('/api/v1/auth/logout')) {
      return jsonResponse({ code: 0, message: 'ok', data: null })
    }
    if (url.endsWith('/api/v1/auth/email/verify-request')) {
      return jsonResponse({ code: 0, message: 'ok', data: { sent: true } })
    }
    if (url.endsWith('/api/v1/auth/email/verify-confirm')) {
      return jsonResponse({ code: 0, message: 'ok', data: { verified: true } })
    }
    if (url.endsWith('/api/v1/billing/balance')) {
      const wallet = typeof options.balance === 'function' ? options.balance() : options.balance ?? balance
      return jsonResponse({ code: 0, message: 'ok', data: wallet })
    }
    if (url.endsWith('/api/v1/billing/checkout/options')) {
      return jsonResponse({
        code: 0,
        message: 'ok',
        data: {
          currency: 'usd',
          min_amount: 1,
          max_amount: 500,
          credits_per_usd: 1_127_250,
          currency_per_credit: 0.000006,
          usd_cny_rate: 6.7635,
          presets: [
            { amount: 1, credits: 1_127_250 },
            { amount: 10, credits: 11_272_500 },
            { amount: 20, credits: 22_545_000 },
            { amount: 50, credits: 56_362_500 },
          ],
          amount_presets: [
            { amount: 1, credits: 1_127_250 },
            { amount: 10, credits: 11_272_500 },
            { amount: 20, credits: 22_545_000 },
            { amount: 50, credits: 56_362_500 },
          ],
          credit_presets: [
            { amount: 1, credits: 1_127_250 },
            { amount: 5, credits: 5_636_250 },
            { amount: 9, credits: 10_145_250 },
          ],
        },
      })
    }
    if (url.endsWith('/api/v1/billing/activities')) {
      return jsonResponse({
        code: 0,
        message: 'ok',
        data: [
          {
            id: 'tx:signup',
            kind: 'ledger',
            reserved_credits: 0,
            settled_credits: 0,
            released_credits: 0,
            net_credits: 0,
            llm_calls: [],
            tool_calls: [],
            transactions: [
              {
                id: 'tx-signup',
                wallet_id: 'wallet-1',
                type: 'signup_grant',
                amount: 1000,
                monthly_used_after: 0,
                extra_balance_after: 1000,
                description: 'signup bonus',
                created_at: '2026-06-10T00:00:00Z',
              },
            ],
            created_at: '2026-06-10T00:00:00Z',
            updated_at: '2026-06-10T00:00:00Z',
          },
        ],
      })
    }
    if (url.endsWith('/api/v1/billing/transactions')) {
      return jsonResponse({
        code: 0,
        message: 'ok',
        data: [
          {
            id: 'tx-signup',
            wallet_id: 'wallet-1',
            type: 'signup_grant',
            amount: 1000,
            monthly_used_after: 0,
            extra_balance_after: 1000,
            description: 'signup bonus',
            created_at: '2026-06-10T00:00:00Z',
          },
        ],
      })
    }
    if (url.endsWith('/api/v1/billing/checkout')) {
      return jsonResponse({
        code: 0,
        message: 'ok',
        data: {
          checkout_url: 'https://stripe.example.com/checkout/sess_test',
          stripe_checkout_session_id: 'cs_test',
          amount: 1,
          currency: 'usd',
          credits: 1_127_250,
          checkout_mode: 'amount',
          usd_cny_rate: 6.7635,
        },
      })
    }
    if (url.endsWith('/api/v1/models')) {
      return jsonResponse({
        code: 0,
        message: 'ok',
        data: {
          models: [
            { id: 'gpt-4o', label: 'GPT-4o', vendor: 'ChatGPT', capability_tier: 'max', priority: 100 },
            { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', vendor: 'DeepSeek', capability_tier: 'fast', priority: 90 },
          ],
        },
      })
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
      uploadCounter += 1
      const body = JSON.parse(String(init?.body ?? '{}')) as { filename?: string; content_type?: string; size_bytes?: number }
      const id = uploadCounter === 1 ? 'doc-upload' : `doc-upload-${uploadCounter}`
      const originalName = body.filename || 'brief.docx'
      const contentType = body.content_type || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      const documentRecord = {
        id,
        user_id: `${role}-1`,
        original_name: originalName,
        content_type: contentType,
        size_bytes: body.size_bytes ?? 5,
        status: 'uploading',
        source_object_key: `documents/user/${id}/source`,
        expires_at: '2026-05-17T00:00:00Z',
        created_at: '2026-05-10T00:00:00Z',
        updated_at: '2026-05-10T00:00:00Z',
      }
      uploadedDocuments.set(id, documentRecord)
      return jsonResponse({
        code: 0,
        message: 'ok',
        data: {
          document: documentRecord,
          upload: {
            method: 'PUT',
            url: 'https://s3.example.com/upload',
            headers: { 'Content-Type': contentType },
            expires_at: '2026-05-10T01:00:00Z',
          },
        },
      })
    }
    if (url === 'https://s3.example.com/upload') {
      return new Response(null, { status: 200 })
    }
    const completeMatch = url.match(/\/api\/v1\/documents\/([^/]+)\/complete$/)
    if (completeMatch) {
      const id = decodeURIComponent(completeMatch[1])
      const documentRecord = uploadedDocuments.get(id) ?? {
        id,
        user_id: `${role}-1`,
        original_name: 'brief.docx',
        content_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        size_bytes: 5,
        status: 'uploading',
        source_object_key: `documents/user/${id}/source.docx`,
        expires_at: '2026-05-17T00:00:00Z',
        created_at: '2026-05-10T00:00:00Z',
        updated_at: '2026-05-10T00:00:00Z',
      }
      return jsonResponse({
        code: 0,
        message: 'ok',
        data: {
          ...documentRecord,
          status: 'ready',
          text_object_key: `documents/user/${id}/extracted.txt`,
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
