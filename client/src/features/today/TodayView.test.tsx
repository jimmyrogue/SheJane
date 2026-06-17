import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LocalHostConfig, LocalTodoItem } from '@/shared/local-host/client'
import { TodayView } from './TodayView'

const localHostConfig: LocalHostConfig = { baseURL: 'http://127.0.0.1:17371', token: 'local-token' }

function localTodo(overrides: Partial<LocalTodoItem> = {}): LocalTodoItem {
  return {
    id: 'todo-lark-1',
    provider: 'lark',
    priority: 'now',
    status: 'open',
    title: '确认 Windows 打包清单',
    summary: 'Windows 用户需要内置 lark-cli.exe 的打包清单。',
    suggested_action: 'review',
    due_at: null,
    confidence: 0.88,
    extraction_provider: 'rules',
    evidence_preview: '请今天确认 Windows 打包清单',
    source_id: 'source-lark-1',
    source_message_ids: ['message-lark-1'],
    created_at: '2026-06-15T00:00:00Z',
    updated_at: '2026-06-15T00:00:00Z',
    ...overrides,
  }
}

describe('TodayView', () => {
  afterEach(cleanup)

  it('renders the prototype priority groups when no local host config is provided', () => {
    render(<TodayView />)
    expect(screen.getByText('现在回', { selector: '.today-group-name' })).toBeInTheDocument()
    expect(screen.getByText('今天内', { selector: '.today-group-name' })).toBeInTheDocument()
    expect(screen.getByText('稍后处理', { selector: '.today-group-name' })).toBeInTheDocument()
    expect(screen.getByText('只需知道', { selector: '.today-group-name' })).toBeInTheDocument()
  })

  it('keeps each todo row focused on useful actions', async () => {
    const openTodo = localTodo({
      priority: 'later',
      suggested_action: 'reply',
      title: '明天下午之前交一份 lark cli的连接优化方案',
      due_at: '2026-06-16T18:00:00+08:00',
    })
    const listTodos = vi.fn().mockResolvedValue([openTodo])

    render(
      <TodayView
        localHostConfig={localHostConfig}
        api={{ listTodos }}
      />,
    )

    const row = (await screen.findByText('明天下午之前交一份 lark cli的连接优化方案')).closest('.today-row') as HTMLElement
    expect(screen.queryByText('可放一放')).not.toBeInTheDocument()
    expect(within(row).queryByRole('button', { name: '明天提醒' })).not.toBeInTheDocument()
    expect(within(row).queryByText('回复草稿')).not.toBeInTheDocument()
    expect(within(row).queryByRole('button', { name: '看原文' })).not.toBeInTheDocument()
    expect(within(row).getByText('截止 6 月 16 日 18:00')).toBeInTheDocument()
    expect(within(row).getByRole('button', { name: '引用到对话' })).toBeInTheDocument()
    expect(within(row).getByRole('button', { name: '忽略' })).toBeInTheDocument()
  })

  it('toggles a todo complete/incomplete', () => {
    render(<TodayView />)
    const row = screen.getByText('Q3 预算的数字今天上午要，先给个初版也行').closest('.today-row') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: '标记为完成' }))
    expect(within(row).getByRole('button', { name: '标记为未完成' })).toBeInTheDocument()
  })

  it('quotes an open todo back to chat', () => {
    const onQuoteToChat = vi.fn()
    render(<TodayView onQuoteToChat={onQuoteToChat} />)
    const row = screen.getByText('团队 6 月考勤异常 2 条，需要你确认').closest('.today-row') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: '引用到对话' }))
    expect(onQuoteToChat).toHaveBeenCalledWith('团队 6 月考勤异常 2 条，需要你确认')
  })

  it('loads Lark todos from the local host and persists completion state', async () => {
    const openTodo = localTodo()
    const completedTodo = localTodo({ status: 'completed' })
    const listTodos = vi.fn().mockResolvedValue([openTodo])
    const updateTodo = vi.fn().mockResolvedValue(completedTodo)

    render(
      <TodayView
        localHostConfig={localHostConfig}
        api={{ listTodos, updateTodo }}
      />,
    )

    const row = (await screen.findByText('确认 Windows 打包清单')).closest('.today-row') as HTMLElement
    expect(screen.queryByText('Q3 预算的数字今天上午要，先给个初版也行')).not.toBeInTheDocument()

    fireEvent.click(within(row).getByRole('button', { name: '标记为完成' }))

    await waitFor(() => {
      expect(updateTodo).toHaveBeenCalledWith('todo-lark-1', { status: 'completed' }, localHostConfig)
    })
    expect(within(row).getByRole('button', { name: '标记为未完成' })).toBeInTheDocument()
  })

  it('quotes a local todo through local-host before sending it to chat', async () => {
    const openTodo = localTodo()
    const listTodos = vi.fn().mockResolvedValue([openTodo])
    const updateTodo = vi.fn()
    const quoteTodo = vi.fn().mockResolvedValue({
      todo_id: openTodo.id,
      text: '确认 Windows 打包清单\n来源：请今天确认 [email] 的打包清单',
    })
    const onQuoteToChat = vi.fn()

    render(
      <TodayView
        localHostConfig={localHostConfig}
        api={{ listTodos, updateTodo, quoteTodo }}
        onQuoteToChat={onQuoteToChat}
      />,
    )

    const row = (await screen.findByText('确认 Windows 打包清单')).closest('.today-row') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: '引用到对话' }))

    await waitFor(() => {
      expect(quoteTodo).toHaveBeenCalledWith('todo-lark-1', {}, localHostConfig)
    })
    expect(onQuoteToChat).toHaveBeenCalledWith('确认 Windows 打包清单\n来源：请今天确认 [email] 的打包清单')
  })

  it('persists dismiss for local todos', async () => {
    const openTodo = localTodo()
    const listTodos = vi.fn().mockResolvedValue([openTodo])
    const updateTodo = vi
      .fn()
      .mockResolvedValueOnce(localTodo({ status: 'dismissed' }))

    render(
      <TodayView
        localHostConfig={localHostConfig}
        api={{ listTodos, updateTodo }}
      />,
    )

    let row = (await screen.findByText('确认 Windows 打包清单')).closest('.today-row') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: '忽略' }))
    await waitFor(() => {
      expect(updateTodo).toHaveBeenCalledWith('todo-lark-1', { status: 'dismissed' }, localHostConfig)
    })
  })
})
