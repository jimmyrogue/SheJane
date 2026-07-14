import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'
import { LocalConversationStore } from './shared/local-data/localConversations'

describe('desktop shell', () => {
  beforeEach(() => {
    window.localStorage.clear()
    indexedDB = new IDBFactory()
    Object.defineProperty(window, 'shejaneDesktop', {
      configurable: true,
      value: {
        platform: 'darwin',
        localHost: { baseURL: 'http://127.0.0.1:17371', session: 'desktop', ready: false },
      },
    })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Runtime offline')))
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('opens the local desktop shell without an account gate', async () => {
    render(<App />)

    expect(await screen.findAllByText('新对话')).not.toHaveLength(0)
    expect(screen.queryByText('登录')).not.toBeInTheDocument()
    expect(screen.queryByText('注册')).not.toBeInTheDocument()
  })

  it('does not expose purchase or usage-billing actions', async () => {
    render(<App />)

    await screen.findAllByText('新对话')
    expect(screen.queryByText('充值')).not.toBeInTheDocument()
    expect(screen.queryByText('消费记录')).not.toBeInTheDocument()
  })

  it('keeps the sidebar expand control available outside the chat view', async () => {
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '设置' }))
    fireEvent.click(screen.getByRole('button', { name: '收起侧栏' }))

    expect(screen.getByRole('button', { name: '展开侧栏' })).toBeInTheDocument()
  })

  it('opens model settings from the empty composer model state', async () => {
    render(<App />)

    const configureModels = await screen.findByRole('button', { name: '配置模型' })
    expect(configureModels).not.toHaveAttribute('aria-haspopup')
    fireEvent.click(configureModels)

    expect(await screen.findByRole('heading', { name: '模型供应商' })).toBeInTheDocument()
  })

  it('lets an unsent chat clear its selected workspace', async () => {
    const selectWorkspaceDirectory = vi.fn()
      .mockResolvedValueOnce('/tmp/client-a')
      .mockResolvedValueOnce('/tmp/client-b')
    Object.defineProperty(window, 'shejaneDesktop', {
      configurable: true,
      value: {
        platform: 'darwin',
        localHost: { baseURL: 'http://127.0.0.1:17371', session: 'desktop', ready: true },
        selectWorkspaceDirectory,
      },
    })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/local/v1/workspaces') && init?.method === 'POST') {
        const path = JSON.parse(String(init.body)).path as string
        const label = path.split('/').pop() ?? path
        return new Response(JSON.stringify({
          id: `workspace-${label}`,
          path,
          label,
          created_at: '2026-07-14T00:00:00.000Z',
          last_used_at: '2026-07-14T00:00:00.000Z',
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      throw new Error('Runtime offline')
    }))
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '添加项目' }))
    fireEvent.click(await screen.findByRole('button', { name: '更换路径：client-a' }))
    fireEvent.click(await screen.findByRole('button', { name: '移除路径：client-b' }))

    expect(await screen.findByRole('button', { name: '添加项目' })).toBeInTheDocument()
    expect(selectWorkspaceDirectory).toHaveBeenCalledTimes(2)
  })

  it('clears workspace metadata from an existing chat', async () => {
    const store = new LocalConversationStore('shejane-local:runtime:local-owner')
    await store.save({
      id: 'conversation-1',
      title: '客户A',
      archived: false,
      createdAt: '2026-07-14T00:00:00.000Z',
      updatedAt: '2026-07-14T00:00:00.000Z',
      project: { name: '客户A' },
      workspace: { path: '/tmp/client-a', label: 'client-a', authorized: true },
      messages: [],
    })
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '移除路径：客户A' }))

    expect(await screen.findByRole('button', { name: '添加项目' })).toBeInTheDocument()
    expect((await store.get('conversation-1'))?.workspace).toBeUndefined()
    expect((await store.get('conversation-1'))?.project).toBeUndefined()
  })

  it('adds files from the native attachment picker', async () => {
    const selectAttachmentFiles = vi.fn().mockResolvedValue(['/tmp/brief.pdf'])
    Object.defineProperty(window, 'shejaneDesktop', {
      configurable: true,
      value: {
        platform: 'darwin',
        localHost: { baseURL: 'http://127.0.0.1:17371', session: 'desktop', ready: true },
        selectAttachmentFiles,
      },
    })
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '添加附件' }))

    expect(await screen.findByText('brief.pdf')).toBeInTheDocument()
    expect(selectAttachmentFiles).toHaveBeenCalledTimes(1)
  })
})
