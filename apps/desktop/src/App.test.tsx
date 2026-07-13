import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'

describe('desktop shell', () => {
  beforeEach(() => {
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
})
